import { AND, Record } from "@mail/core/common/record";
import { prettifyMessageContent } from "@mail/utils/common/format";
import { compareDatetime, nearestGreaterThanOrEqual } from "@mail/utils/common/misc";
import { rpc } from "@web/core/network/rpc";
import { router } from "@web/core/browser/router";

import { _t } from "@web/core/l10n/translation";
import { pyToJsLocale } from "@web/core/l10n/utils";
import { user } from "@web/core/user";
import { Deferred } from "@web/core/utils/concurrency";

/**
 * @typedef SuggestedRecipient
 * @property {string} email
 * @property {import("models").Persona|false} persona
 * @property {string} lang
 * @property {string} reason
 * @property {boolean} checked
 */

export class Thread extends Record {
    static id = AND("model", "id");
    /** @type {Object.<string, import("models").Thread>} */
    static records = {};
    /** @returns {import("models").Thread} */
    static get(data) {
        return super.get(data);
    }
    /**
     * @param {string} localId
     * @returns {string}
     */
    static localIdToActiveId(localId) {
        if (!localId) {
            return undefined;
        }
        // Transform "Thread,<model> AND <id>" to "<model>_<id>""
        return localId.split(",").slice(1).join("_").replace(" AND ", "_");
    }
    /** @returns {import("models").Thread|import("models").Thread[]} */
    static insert(data) {
        return super.insert(...arguments);
    }
    static new(data) {
        const thread = super.new(data);
        Record.onChange(thread, ["state"], () => {
            if (thread.state !== "closed" && !this.store.env.services.ui.isSmall) {
                this.store.ChatWindow.insert({
                    folded: thread.state === "folded",
                    thread,
                });
            }
        });
        return thread;
    }
    static async getOrFetch(data) {
        return this.get(data);
    }

    /** @type {number} */
    id;
    /** @type {string} */
    uuid;
    /** @type {string} */
    model;
    allMessages = Record.many("Message", {
        inverse: "thread",
    });
    /** @type {boolean} */
    areAttachmentsLoaded = false;
    attachments = Record.many("Attachment", {
        /**
         * @param {import("models").Attachment} a1
         * @param {import("models").Attachment} a2
         */
        sort: (a1, a2) => (a1.id < a2.id ? 1 : -1),
    });
    activeRtcSession = Record.one("RtcSession");
    get canLeave() {
        return (
            ["channel", "group"].includes(this.channel_type) &&
            !this.message_needaction_counter &&
            !this.group_based_subscription
        );
    }
    get canUnpin() {
        return this.channel_type === "chat" && this.importantCounter === 0;
    }
    channelMembers = Record.many("ChannelMember", {
        onDelete: (r) => r.delete(),
        sort: (m1, m2) => m1.id - m2.id,
    });
    typingMembers = Record.many("ChannelMember", { inverse: "threadAsTyping" });
    otherTypingMembers = Record.many("ChannelMember", {
        /** @this {import("models").Thread} */
        compute() {
            return this.typingMembers.filter((member) => !member.persona?.eq(this.store.self));
        },
    });
    hasOtherMembersTyping = Record.attr(false, {
        /** @this {import("models").Thread} */
        compute() {
            return this.otherTypingMembers.length > 0;
        },
    });
    rtcSessions = Record.many("RtcSession", {
        /** @this {import("models").Thread} */
        onDelete(r) {
            this.store.env.services["discuss.rtc"].deleteSession(r.id);
        },
    });
    rtcInvitingSession = Record.one("RtcSession", {
        /** @this {import("models").Thread} */
        onAdd(r) {
            this.rtcSessions.add(r);
            this.store.discuss.ringingThreads.add(this);
        },
        /** @this {import("models").Thread} */
        onDelete(r) {
            this.store.discuss.ringingThreads.delete(this);
        },
    });
    toggleBusSubscription = Record.attr(false, {
        compute() {
            return (
                this.model === "discuss.channel" &&
                this.selfMember?.memberSince >= this.store.env.services.bus_service.startedAt
            );
        },
        onUpdate() {
            this.store.updateBusSubscription();
        },
    });
    invitedMembers = Record.many("ChannelMember");
    composer = Record.one("Composer", {
        compute: () => ({}),
        inverse: "thread",
        onDelete: (r) => r.delete(),
    });
    correspondent = Record.one("ChannelMember", {
        compute() {
            return this.computeCorrespondent();
        },
    });
    counter = 0;
    counter_bus_id = 0;
    /** @type {string} */
    custom_channel_name;
    /** @type {string} */
    description;
    displayToSelf = Record.attr(false, {
        compute() {
            return (
                this.is_pinned ||
                (["channel", "group"].includes(this.channel_type) && this.hasSelfAsMember)
            );
        },
        onUpdate() {
            this.onPinStateUpdated();
        },
    });
    followers = Record.many("Follower", {
        /** @this {import("models").Thread} */
        onAdd(r) {
            r.thread = this;
        },
        onDelete: (r) => r.delete(),
    });
    selfFollower = Record.one("Follower", {
        /** @this {import("models").Thread} */
        onAdd(r) {
            r.thread = this;
        },
        onDelete: (r) => r.delete(),
    });
    /** @type {integer|undefined} */
    followersCount;
    isAdmin = false;
    loadOlder = false;
    loadNewer = false;
    get importantCounter() {
        if (this.model === "mail.box") {
            return this.counter;
        }
        if (this.isChatChannel) {
            return this.message_unread_counter || this.message_needaction_counter;
        }
        return this.message_needaction_counter;
    }
    isCorrespondentOdooBot = Record.attr(undefined, {
        compute() {
            return this.correspondent?.persona.eq(this.store.odoobot);
        },
    });
    isDisplayed = Record.attr(false, {
        compute() {
            if (this.store.discuss.isActive && !this.store.env.services.ui.isSmall) {
                return this.eq(this.store.discuss.thread);
            }
            return this.store.ChatWindow.get({ thread: this })?.isOpen;
        },
        onUpdate() {
            if (this.selfMember && !this.isDisplayed) {
                this.selfMember.syncUnread = true;
            }
        },
    });
    isLoadingAttachments = false;
    isLoadedDeferred = new Deferred();
    isLoaded = Record.attr(false, {
        /** @this {import("models").Thread} */
        onUpdate() {
            if (this.isLoaded) {
                this.isLoadedDeferred.resolve();
            } else {
                const def = this.isLoadedDeferred;
                this.isLoadedDeferred = new Deferred();
                this.isLoadedDeferred.then(() => def.resolve());
            }
        },
    });
    is_pinned = Record.attr(undefined, {
        /** @this {import("models").Thread} */
        onUpdate() {
            this.onPinStateUpdated();
        },
    });
    mainAttachment = Record.one("Attachment");
    memberCount = 0;
    message_needaction_counter = 0;
    message_needaction_counter_bus_id = 0;
    message_unread_counter = 0;
    message_unread_counter_bus_id = 0;
    /**
     * Contains continuous sequence of messages to show in message list.
     * Messages are ordered from older to most recent.
     * There should not be any hole in this list: there can be unknown
     * messages before start and after end, but there should not be any
     * unknown in-between messages.
     *
     * Content should be fetched and inserted in a controlled way.
     */
    messages = Record.many("Message");
    /** @type {string} */
    modelName;
    /** @type {string} */
    module_icon;
    /**
     * Contains messages received from the bus that are not yet inserted in
     * `messages` list. This is a temporary storage to ensure nothing is lost
     * when fetching newer messages.
     */
    pendingNewMessages = Record.many("Message");
    needactionMessages = Record.many("Message", {
        inverse: "threadAsNeedaction",
        sort: (message1, message2) => message1.id - message2.id,
    });
    /** @type {string} */
    name;
    selfMember = Record.one("ChannelMember", {
        inverse: "threadAsSelf",
    });
    /** @type {'open' | 'folded' | 'closed'} */
    state;
    status = "new";
    /**
     * Stored scoll position of thread from top in ASC order.
     *
     * @type {number|'bottom'}
     */
    scrollTop = "bottom";
    showOnlyVideo = false;
    transientMessages = Record.many("Message");
    discussAppCategory = Record.one("DiscussAppCategory", {
        compute() {
            return this._computeDiscussAppCategory();
        },
    });
    /** @type {string} */
    defaultDisplayMode;
    scrollUnread = true;
    suggestedRecipients = Record.attr([], {
        onUpdate() {
            for (const recipient of this.suggestedRecipients) {
                if (recipient.checked === undefined) {
                    recipient.checked = true;
                }
                recipient.persona = recipient.partner_id
                    ? { type: "partner", id: recipient.partner_id }
                    : false;
            }
        },
    });
    hasLoadingFailed = false;
    canPostOnReadonly;
    /** @type {luxon.DateTime} */
    last_interest_dt = Record.attr(undefined, { type: "datetime" });
    /** @type {luxon.DateTime} */
    lastInterestDt = Record.attr(undefined, {
        type: "datetime",
        compute() {
            const selfMemberLastInterestDt = this.selfMember?.last_interest_dt;
            const lastInterestDt = this.last_interest_dt;
            return compareDatetime(selfMemberLastInterestDt, lastInterestDt) > 0
                ? selfMemberLastInterestDt
                : lastInterestDt;
        },
    });
    /** @type {Boolean} */
    is_editable;
    /**
     * This field is used for channels only.
     * false means using the custom_notifications from user settings.
     *
     * @type {false|"all"|"mentions"|"no_notif"}
     */
    custom_notifications = false;
    /** @type {luxon.DateTime} */
    mute_until_dt = Record.attr(undefined, { type: "datetime" });
    /** @type {Boolean} */
    isLocallyPinned = Record.attr(false, {
        onUpdate() {
            this.onPinStateUpdated();
        },
    });
    /** @type {"not_fetched"|"pending"|"fetched"} */
    fetchMembersState = "not_fetched";

    _computeDiscussAppCategory() {
        if (["group", "chat"].includes(this.channel_type)) {
            return this.store.discuss.chats;
        }
        if (this.channel_type === "channel") {
            return this.store.discuss.channels;
        }
    }

    get accessRestrictedToGroupText() {
        if (!this.authorizedGroupFullName) {
            return false;
        }
        return _t('Access restricted to group "%(groupFullName)s"', {
            groupFullName: this.authorizedGroupFullName,
        });
    }

    get areAllMembersLoaded() {
        return this.memberCount === this.channelMembers.length;
    }

    get busChannel() {
        return `${this.model}_${this.id}`;
    }

    get followersFullyLoaded() {
        return (
            this.followersCount ===
            (this.selfFollower ? this.followers.length + 1 : this.followers.length)
        );
    }

    get attachmentsInWebClientView() {
        const attachments = this.attachments.filter(
            (attachment) => (attachment.isPdf || attachment.isImage) && !attachment.uploading
        );
        attachments.sort((a1, a2) => {
            return a2.id - a1.id;
        });
        return attachments;
    }

    get isUnread() {
        return this.message_unread_counter > 0 || this.needactionMessages.length > 0;
    }

    get typesAllowingCalls() {
        return ["chat", "channel", "group"];
    }

    get allowCalls() {
        return (
            this.typesAllowingCalls.includes(this.channel_type) &&
            !this.correspondent?.persona.eq(this.store.odoobot)
        );
    }

    get hasMemberList() {
        return ["channel", "group"].includes(this.channel_type);
    }

    get hasAttachmentPanel() {
        return this.model === "discuss.channel";
    }

    get isChatChannel() {
        return ["chat", "group"].includes(this.channel_type);
    }

    get displayName() {
        if (this.channel_type === "chat" && this.correspondent) {
            return this.custom_channel_name || this.correspondent.persona.nameOrDisplayName;
        }
        if (this.channel_type === "group" && !this.name) {
            const listFormatter = new Intl.ListFormat(user.lang && pyToJsLocale(user.lang), {
                type: "conjunction",
                style: "long",
            });
            return listFormatter.format(
                this.channelMembers.map((channelMember) => channelMember.persona.name)
            );
        }
        return this.name;
    }

    get correspondents() {
        return this.channelMembers.filter(({ persona }) => persona.notEq(this.store.self));
    }

    computeCorrespondent() {
        if (this.channel_type === "channel") {
            return undefined;
        }
        const correspondents = this.correspondents;
        if (correspondents.length === 1) {
            // 2 members chat.
            return correspondents[0];
        }
        if (correspondents.length === 0 && this.channelMembers.length === 1) {
            // Self-chat.
            return this.channelMembers[0];
        }
        return undefined;
    }

    get avatarUrl() {
        return this.module_icon ?? this.store.DEFAULT_AVATAR;
    }

    get allowDescription() {
        return ["channel", "group"].includes(this.channel_type);
    }

    get isTransient() {
        return !this.id || this.id < 0;
    }

    get lastEditableMessageOfSelf() {
        const editableMessagesBySelf = this.nonEmptyMessages.filter(
            (message) => message.isSelfAuthored && message.editable
        );
        if (editableMessagesBySelf.length > 0) {
            return editableMessagesBySelf.at(-1);
        }
        return null;
    }

    get needactionCounter() {
        return this.isChatChannel ? this.message_unread_counter : this.message_needaction_counter;
    }

    newestMessage = Record.one("Message", {
        inverse: "threadAsNewest",
        compute() {
            return this.messages.findLast((msg) => !msg.isEmpty);
        },
    });

    firstUnreadMessage = Record.one("Message", {
        /** @this {import("models").Thread} */
        compute() {
            if (!this.selfMember) {
                return null;
            }
            const messages = this.nonEmptyMessages;
            const separator = this.selfMember.localNewMessageSeparator;
            if (separator === 0 && !this.loadOlder) {
                return messages[0];
            }
            if (!separator || messages.length === 0 || messages.at(-1).id < separator) {
                return null;
            }
            // try to find a perfect match according to the member's separator
            let message = this.store.Message.get({ id: separator });
            if (!message || this.notEq(message.thread) || message.isEmpty) {
                message = nearestGreaterThanOrEqual(messages, separator, (msg) => msg.id);
            }
            return message;
        },
    });

    get newestPersistentMessage() {
        return this.messages.findLast((msg) => Number.isInteger(msg.id));
    }

    newestPersistentAllMessages = Record.many("Message", {
        compute() {
            const allPersistentMessages = this.allMessages.filter((message) =>
                Number.isInteger(message.id)
            );
            allPersistentMessages.sort((m1, m2) => m2.id - m1.id);
            return allPersistentMessages;
        },
    });

    newestPersistentOfAllMessage = Record.one("Message", {
        compute() {
            return this.newestPersistentAllMessages[0];
        },
    });

    newestPersistentNotEmptyOfAllMessage = Record.one("Message", {
        compute() {
            return this.newestPersistentAllMessages.find((message) => !message.isEmpty);
        },
    });

    get oldestPersistentMessage() {
        return this.messages.find((msg) => Number.isInteger(msg.id));
    }

    onPinStateUpdated() {}

    get hasSelfAsMember() {
        return Boolean(this.selfMember);
    }

    hasSeenFeature = Record.attr(false, {
        /** @this {import("models").Thread} */
        compute() {
            return this.store.channel_types_with_seen_infos.includes(this.channel_type);
        },
    });

    get invitationLink() {
        if (!this.uuid || this.channel_type === "chat") {
            return undefined;
        }
        return `${window.location.origin}/chat/${this.id}/${this.uuid}`;
    }

    get isEmpty() {
        return !this.messages.some((message) => !message.isEmpty);
    }

    offlineMembers = Record.many("ChannelMember", {
        /** @this {import("models").Thread} */
        compute() {
            return this.channelMembers.filter((member) => member.persona?.im_status !== "online");
        },
        sort: (m1, m2) => (m1.persona?.name < m2.persona?.name ? -1 : 1),
    });

    get nonEmptyMessages() {
        return this.messages.filter((message) => !message.isEmpty);
    }

    get persistentMessages() {
        return this.messages.filter((message) => !message.is_transient);
    }

    get prefix() {
        return this.isChatChannel ? "@" : "#";
    }

    /** @type {undefined|number[]} */
    lastMessageSeenByAllId = Record.attr(undefined, {
        compute() {
            if (!this.hasSeenFeature) {
                return;
            }
            const otherMembers = this.channelMembers.filter((member) =>
                member.persona.notEq(this.store.self)
            );
            if (otherMembers.length === 0) {
                return;
            }
            const otherLastSeenMessageIds = otherMembers
                .filter((member) => member.seen_message_id)
                .map((member) => member.seen_message_id.id);
            if (otherLastSeenMessageIds.length === 0) {
                return;
            }
            return Math.min(...otherLastSeenMessageIds);
        },
    });

    lastSelfMessageSeenByEveryone = Record.one("Message", {
        compute() {
            if (!this.lastMessageSeenByAllId) {
                return false;
            }
            let res;
            // starts from most recent persistent messages to find early
            for (let i = this.persistentMessages.length - 1; i >= 0; i--) {
                const message = this.persistentMessages[i];
                if (!message.isSelfAuthored) {
                    continue;
                }
                if (message.id > this.lastMessageSeenByAllId) {
                    continue;
                }
                res = message;
                break;
            }
            return res;
        },
    });

    onlineMembers = Record.many("ChannelMember", {
        /** @this {import("models").Thread} */
        compute() {
            return this.channelMembers.filter((member) => member.persona.im_status === "online");
        },
        sort: (m1, m2) => {
            const m1HasRtc = Boolean(m1.rtcSession);
            const m2HasRtc = Boolean(m2.rtcSession);
            if (m1HasRtc === m2HasRtc) {
                /**
                 * If raisingHand is falsy, it gets an Infinity value so that when
                 * we sort by [oldest/lowest-value]-first, falsy values end up last.
                 */
                const m1RaisingValue = m1.rtcSession?.raisingHand || Infinity;
                const m2RaisingValue = m2.rtcSession?.raisingHand || Infinity;
                if (m1HasRtc && m1RaisingValue !== m2RaisingValue) {
                    return m1RaisingValue - m2RaisingValue;
                } else {
                    return m1.persona.name?.localeCompare(m2.persona.name) ?? 1;
                }
            } else {
                return m2HasRtc - m1HasRtc;
            }
        },
    });

    get unknownMembersCount() {
        return this.memberCount - this.channelMembers.length;
    }

    get videoCount() {
        return Object.values(this.store.RtcSession.records).filter((session) => session.hasVideo)
            .length;
    }

    executeCommand(command, body = "") {
        return this.store.env.services.orm.call(
            "discuss.channel",
            command.methodName,
            [[this.id]],
            { body }
        );
    }

    async fetchChannelMembers() {
        if (this.fetchMembersState === "pending") {
            return;
        }
        const previousState = this.fetchMembersState;
        this.fetchMembersState = "pending";
        const known_member_ids = this.channelMembers.map((channelMember) => channelMember.id);
        let results;
        try {
            results = await rpc("/discuss/channel/members", {
                channel_id: this.id,
                known_member_ids: known_member_ids,
            });
        } catch (e) {
            this.fetchMembersState = previousState;
            throw e;
        }
        this.fetchMembersState = "fetched";
        this.update(results);
    }

    /** @param {{after: Number, before: Number}} */
    async fetchMessages({ after, around, before } = {}) {
        this.status = "loading";
        if (!["mail.box", "discuss.channel"].includes(this.model) && !this.id) {
            this.isLoaded = true;
            return [];
        }
        try {
            // ordered messages received: newest to oldest
            const { messages: rawMessages } = await rpc(this.getFetchRoute(), {
                ...this.getFetchParams(),
                limit:
                    !around && around !== 0 ? this.store.FETCH_LIMIT : this.store.FETCH_LIMIT * 2,
                after,
                around,
                before,
            });
            const messages = this.store.Message.insert(rawMessages.reverse(), { html: true });
            this.isLoaded = true;
            return messages;
        } catch (e) {
            this.hasLoadingFailed = true;
            throw e;
        } finally {
            this.status = "ready";
        }
    }

    /** @param {"older"|"newer"} epoch */
    async fetchMoreMessages(epoch = "older") {
        if (
            this.status === "loading" ||
            (epoch === "older" && !this.loadOlder) ||
            (epoch === "newer" && !this.loadNewer)
        ) {
            return;
        }
        const before = epoch === "older" ? this.oldestPersistentMessage?.id : undefined;
        const after = epoch === "newer" ? this.newestPersistentMessage?.id : undefined;
        try {
            const fetched = await this.fetchMessages({ after, before });
            if (
                (after !== undefined && !this.messages.some((message) => message.id === after)) ||
                (before !== undefined && !this.messages.some((message) => message.id === before))
            ) {
                // there might have been a jump to message during RPC fetch.
                // Abort feeding messages as to not put holes in message list.
                return;
            }
            const alreadyKnownMessages = new Set(this.messages.map(({ id }) => id));
            const messagesToAdd = fetched.filter(
                (message) => !alreadyKnownMessages.has(message.id)
            );
            if (epoch === "older") {
                this.messages.unshift(...messagesToAdd);
            } else {
                this.messages.push(...messagesToAdd);
            }
            if (fetched.length < this.store.FETCH_LIMIT) {
                if (epoch === "older") {
                    this.loadOlder = false;
                } else if (epoch === "newer") {
                    this.loadNewer = false;
                    const missingMessages = this.pendingNewMessages.filter(
                        ({ id }) => !alreadyKnownMessages.has(id)
                    );
                    if (missingMessages.length > 0) {
                        this.messages.push(...missingMessages);
                        this.messages.sort((m1, m2) => m1.id - m2.id);
                    }
                }
            }
            this._enrichMessagesWithTransient();
        } catch {
            // handled in fetchMessages
        }
        this.pendingNewMessages = [];
    }

    async fetchNewMessages() {
        if (
            this.status === "loading" ||
            (this.isLoaded && ["discuss.channel", "mail.box"].includes(this.model))
        ) {
            return;
        }
        const after = this.isLoaded ? this.newestPersistentMessage?.id : undefined;
        try {
            const fetched = await this.fetchMessages({ after });
            // feed messages
            // could have received a new message as notification during fetch
            // filter out already fetched (e.g. received as notification in the meantime)
            let startIndex;
            if (after === undefined) {
                startIndex = 0;
            } else {
                const afterIndex = this.messages.findIndex((message) => message.id === after);
                if (afterIndex === -1) {
                    // there might have been a jump to message during RPC fetch.
                    // Abort feeding messages as to not put holes in message list.
                    return;
                } else {
                    startIndex = afterIndex + 1;
                }
            }
            const alreadyKnownMessages = new Set(this.messages.map((m) => m.id));
            const filtered = fetched.filter(
                (message) =>
                    !alreadyKnownMessages.has(message.id) &&
                    (this.persistentMessages.length === 0 ||
                        message.id < this.oldestPersistentMessage.id ||
                        message.id > this.newestPersistentMessage.id)
            );
            this.messages.splice(startIndex, 0, ...filtered);
            Object.assign(this, {
                loadOlder:
                    after === undefined && fetched.length === this.store.FETCH_LIMIT
                        ? true
                        : after === undefined && fetched.length !== this.store.FETCH_LIMIT
                        ? false
                        : this.loadOlder,
            });
        } catch {
            // handled in fetchMessages
        }
    }

    getFetchParams() {
        if (this.model === "discuss.channel") {
            return { channel_id: this.id };
        }
        if (this.model === "mail.box") {
            return {};
        }
        return {
            thread_id: this.id,
            thread_model: this.model,
        };
    }

    getFetchRoute() {
        if (this.model === "discuss.channel") {
            return "/discuss/channel/messages";
        }
        if (this.model === "mail.box") {
            return `/mail/${this.id}/messages`;
        }
        return "/mail/thread/messages";
    }

    async leave() {
        await this.store.env.services.orm.call("discuss.channel", "action_unfollow", [this.id]);
        this.delete();
        const thread = this.store.discuss.channels.threads[0]
            ? this.store.discuss.channels.threads[0]
            : this.store.discuss.inbox;
        thread?.setAsDiscussThread();
    }

    /**
     * Get ready to jump to a message in a thread. This method will fetch the
     * messages around the message to jump to if required, and update the thread
     * messages accordingly.
     *
     * @param {import("models").Message} [messageId] if not provided, load around newest message
     */
    async loadAround(messageId) {
        if (
            this.status === "loading" ||
            (this.isLoaded && this.messages.some(({ id }) => id === messageId))
        ) {
            return;
        }
        try {
            this.isLoaded = false;
            this.scrollTop = undefined;
            this.messages = await this.fetchMessages({ around: messageId });
            this.isLoaded = true;
            this.loadNewer = messageId !== undefined ? true : false;
            this.loadOlder = true;
            const limit =
                !messageId && messageId !== 0 ? this.store.FETCH_LIMIT : this.store.FETCH_LIMIT * 2;
            if (this.messages.length < limit) {
                const olderMessagesCount = this.messages.filter(({ id }) => id < messageId).length;
                const newerMessagesCount = this.messages.filter(({ id }) => id > messageId).length;
                if (olderMessagesCount < limit / 2 - 1) {
                    this.loadOlder = false;
                }
                if (newerMessagesCount < limit / 2) {
                    this.loadNewer = false;
                }
            }
            this._enrichMessagesWithTransient();
        } catch {
            // handled in fetchMessages
        }
    }

    async markAllMessagesAsRead() {
        await this.store.env.services.orm.silent.call("mail.message", "mark_all_as_read", [
            [
                ["model", "=", this.model],
                ["res_id", "=", this.id],
            ],
        ]);
        this.message_needaction_counter = 0;
    }

    async markAsFetched() {
        await this.store.env.services.orm.silent.call("discuss.channel", "channel_fetched", [
            [this.id],
        ]);
    }

    /**
     * @param {Object} [options]
     * @param {boolean} [options.sync] Whether to sync the unread message
     * state with the server values.
     */
    markAsRead({ sync } = {}) {
        const newestPersistentMessage = this.newestPersistentOfAllMessage;
        if (!newestPersistentMessage && !this.isLoaded) {
            this.isLoadedDeferred.then(() => new Promise(setTimeout)).then(() => this.markAsRead());
        }
        const alreadyReadBySelf = newestPersistentMessage?.isReadBySelf;
        if (this.selfMember) {
            this.selfMember.syncUnread = sync ?? this.selfMember.syncUnread;
            this.selfMember.seen_message_id = newestPersistentMessage;
        }
        if (newestPersistentMessage && this.selfMember && !alreadyReadBySelf) {
            rpc("/discuss/channel/mark_as_read", {
                channel_id: this.id,
                last_message_id: newestPersistentMessage.id,
                sync,
            }).catch((e) => {
                if (e.code !== 404) {
                    throw e;
                }
            });
        }
        if (this.message_needaction_counter > 0) {
            this.markAllMessagesAsRead();
        }
    }

    /** @param {string} data base64 representation of the binary */
    async notifyAvatarToServer(data) {
        await rpc("/discuss/channel/update_avatar", {
            channel_id: this.id,
            data,
        });
    }

    async notifyDescriptionToServer(description) {
        this.description = description;
        return this.store.env.services.orm.call(
            "discuss.channel",
            "channel_change_description",
            [[this.id]],
            { description }
        );
    }

    /**
     * Handle the notification of a new message based on the notification setting of the user.
     * Thread on mute:
     * 1. No longer see the unread status: the bold text disappears and the channel name fades out.
     * 2. Without sound + need action counter.

     * Thread Notification Type:
     * All messages:All messages sound + need action counter
     * Mentions:Only mention sounds + need action counter
     * Nothing: No sound + need action counter

     * @param {import("models").Message} message
     */
    notifyMessageToUser(message) {
        if (this.isCorrespondentOdooBot) {
            return;
        }
        const channel_notifications =
            this.custom_notifications || this.store.settings.channel_notifications;
        if (
            !this.mute_until_dt &&
            !this.store.settings.mute_until_dt &&
            (this.channel_type !== "channel" ||
                (this.channel_type === "channel" &&
                    (channel_notifications === "all" ||
                        (channel_notifications === "mentions" &&
                            message.recipients?.includes(this.store.self)))))
        ) {
            this.store.ChatWindow.insert({ thread: this });
            this.store.env.services["mail.out_of_focus"].notify(message, this);
        }
    }

    /**
     * @param {boolean} replaceNewMessageChatWindow
     * @param {Object} [options]
     */
    open(replaceNewMessageChatWindow, options) {
        this.setAsDiscussThread();
    }

    openChatWindow(replaceNewMessageChatWindow) {
        const chatWindow = this.store.ChatWindow.insert({
            folded: false,
            thread: this,
            replaceNewMessageChatWindow,
        });
        chatWindow.autofocus++;
        this.state = "open";
        chatWindow.notifyState();
        return chatWindow;
    }

    pin() {
        if (this.model !== "discuss.channel" || this.store.self.type !== "partner") {
            return;
        }
        this.is_pinned = true;
        return this.store.env.services.orm.silent.call(
            "discuss.channel",
            "channel_pin",
            [this.id],
            { pinned: true }
        );
    }

    /** @param {string} name */
    async rename(name) {
        const newName = name.trim();
        if (
            newName !== this.displayName &&
            ((newName && this.channel_type === "channel") ||
                this.channel_type === "chat" ||
                this.channel_type === "group")
        ) {
            if (this.channel_type === "channel" || this.channel_type === "group") {
                this.name = newName;
                await this.store.env.services.orm.call(
                    "discuss.channel",
                    "channel_rename",
                    [[this.id]],
                    { name: newName }
                );
            } else if (this.channel_type === "chat") {
                this.custom_channel_name = newName;
                await this.store.env.services.orm.call(
                    "discuss.channel",
                    "channel_set_custom_name",
                    [[this.id]],
                    { name: newName }
                );
            }
        }
    }

    addOrReplaceMessage(message, tmpMsg) {
        // The message from other personas (not self) should not replace the tmpMsg
        if (tmpMsg && tmpMsg.in(this.messages) && message.author.eq(this.store.self)) {
            this.messages.splice(this.messages.indexOf(tmpMsg), 1, message);
            return;
        }
        this.messages.add(message);
    }

    /** @param {string} body */
    async post(
        body,
        {
            attachments = [],
            isNote = false,
            parentId,
            mentionedChannels = [],
            mentionedPartners = [],
            cannedResponseIds,
        } = {}
    ) {
        let tmpMsg;
        attachments = [...attachments]; // to not lose them on composer clear
        const params = await this.store.getMessagePostParams({
            attachments,
            body,
            cannedResponseIds,
            isNote,
            mentionedChannels,
            mentionedPartners,
            thread: this,
        });
        const tmpId = this.store.getNextTemporaryId();
        params.context = { ...user.context, ...params.context, temporary_id: tmpId };
        if (parentId) {
            params.post_data.parent_id = parentId;
        }
        if (this.model !== "discuss.channel") {
            params.thread_id = this.id;
            params.thread_model = this.model;
        } else {
            const tmpData = {
                id: tmpId,
                attachments: attachments,
                res_id: this.id,
                model: "discuss.channel",
            };
            tmpData.author = this.store.self;
            if (parentId) {
                tmpData.parentMessage = this.store.Message.get(parentId);
            }
            const prettyContent = await prettifyMessageContent(
                body,
                this.store.getMentionsFromText(body, {
                    mentionedChannels,
                    mentionedPartners,
                })
            );
            tmpMsg = this.store.Message.insert(
                {
                    ...tmpData,
                    body: prettyContent,
                    isPending: true,
                    thread: this,
                    temporary_id: tmpId,
                },
                { html: true }
            );
            this.messages.push(tmpMsg);
            if (this.selfMember) {
                this.selfMember.syncUnread = true;
                this.selfMember.seen_message_id = tmpMsg;
                this.selfMember.new_message_separator = tmpMsg.id + 1;
            }
        }
        const data = await this.store.doMessagePost(params, tmpMsg);
        if (!data) {
            return;
        }
        if (data.id in this.store.Message.records) {
            data.temporary_id = null;
        }
        const message = this.store.Message.insert(data, { html: true });
        this.addOrReplaceMessage(message, tmpMsg);
        if (this.selfMember?.seen_message_id?.id < message.id) {
            this.selfMember.seen_message_id = message;
            this.selfMember.new_message_separator = message.id + 1;
        }
        // Only delete the temporary message now that seen_message_id is updated
        // to avoid flickering.
        tmpMsg?.delete();
        if (message.hasLink && this.store.hasLinkPreviewFeature) {
            rpc("/mail/link_preview", { message_id: data.id }, { silent: true });
        }
        return message;
    }

    /** @param {boolean} pushState */
    setAsDiscussThread(pushState) {
        if (pushState === undefined) {
            pushState = this.notEq(this.store.discuss.thread);
        }
        this.store.discuss.thread = this;
        const activeId =
            typeof this.id === "string" ? `mail.box_${this.id}` : `discuss.channel_${this.id}`;
        this.store.discuss.activeTab =
            !this.store.env.services.ui.isSmall || this.model === "mail.box"
                ? "main"
                : ["chat", "group"].includes(this.channel_type)
                ? "chat"
                : "channel";
        if (pushState) {
            router.pushState({ active_id: activeId });
        }
    }

    /** @param {number} index */
    async setMainAttachmentFromIndex(index) {
        this.mainAttachment = this.attachmentsInWebClientView[index];
        await this.store.env.services.orm.call("ir.attachment", "register_as_main_attachment", [
            this.mainAttachment.id,
        ]);
    }

    async unpin() {
        this.isLocallyPinned = false;
        if (this.eq(this.store.discuss.thread)) {
            router.replaceState({ active_id: undefined });
        }
        if (this.model === "discuss.channel" && this.is_pinned) {
            return this.store.env.services.orm.silent.call(
                "discuss.channel",
                "channel_pin",
                [this.id],
                { pinned: false }
            );
        }
    }

    /**
     * Following a load more or load around, listing of messages contains persistent messages.
     * Transient messages are missing, so this function puts known transient messages at the
     * right place in message list of thread.
     */
    _enrichMessagesWithTransient() {
        for (const message of this.transientMessages) {
            if (message.id < this.oldestPersistentMessage && !this.loadOlder) {
                this.messages.unshift(message);
            } else if (message.id > this.newestPersistentMessage && !this.loadNewer) {
                this.messages.push(message);
            } else {
                let afterIndex = this.messages.findIndex((msg) => msg.id > message.id);
                if (afterIndex === -1) {
                    afterIndex = this.messages.length + 1;
                }
                this.messages.splice(afterIndex - 1, 0, message);
            }
        }
    }
}

Thread.register();
