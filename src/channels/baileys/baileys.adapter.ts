// ============================================================
// WA MCP — Baileys Channel Adapter
// Full implementation of ChannelAdapter using
// @whiskeysockets/baileys for the WhatsApp Web protocol.
// ============================================================

import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  generateForwardMessageContent,
  generateWAMessageFromContent,
  type WASocket,
  type WAMessage,
  type AnyMessageContent,
  type MiscMessageGenerationOptions,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import type { ChannelAdapter, ChannelEventHandler } from "../channel.interface.js";
import type {
  ConnectionStatus,
  MessageContent,
  MessageResponse,
  GroupResponse,
  NumberExistsResponse,
  BusinessProfile,
  ProfileInfo,
  PrivacySettings,
  PrivacySetting,
  PrivacyValue,
  Contact,
  Chat,
  Message,
  GroupMetadata,
  ChatModification,
  GroupModification,
  ParticipantAction,
  StatusContent,
  CloudCredentials,
  ChannelEvent,
  ChannelEventPayload,
} from "../../types/channel.types.js";
import { useSqliteAuthState, clearAuthState } from "./baileys.auth.js";
import { getWaVersion } from "./baileys.version.js";
import {
  normalizeMessagesUpsert,
  normalizeMessagesUpdate,
  normalizeMessagesDelete,
  normalizeMessagesReaction,
  normalizeMessageEdit,
  normalizePresenceUpdate,
  normalizeGroupsUpdate,
  normalizeGroupParticipantsUpdate,
  normalizeContactsUpdate,
  normalizeConnectionUpdate,
  normalizeCallEvent,
} from "./baileys.events.js";
import {
  DEFAULT_AUTO_RECONNECT,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
} from "../../constants.js";

const logger = pino({ name: "baileys-adapter" });

export class BaileysAdapter implements ChannelAdapter {
  private sock: WASocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private qrCode: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private saveCreds: (() => Promise<void>) | null = null;

  private readonly autoReconnect: boolean;
  private readonly listeners = new Map<ChannelEvent, Set<ChannelEventHandler<ChannelEvent>>>();

  constructor(private readonly instanceId: string) {
    this.autoReconnect = process.env.WA_AUTO_RECONNECT !== "false" && DEFAULT_AUTO_RECONNECT;
  }

  // ---- Private helpers ----

  private getSock(): WASocket {
    if (!this.sock || this.status !== "connected") {
      throw new Error("Instance not connected");
    }
    return this.sock;
  }

  private normalizeJid(input: string): string {
    if (input.includes("@")) return input;
    const cleaned = input.replace(/[^0-9]/g, "");
    return `${cleaned}@s.whatsapp.net`;
  }

  private resolveMedia(input: string): { url: string } | Buffer {
    if (input.startsWith("http://") || input.startsWith("https://")) {
      return { url: input };
    }
    return Buffer.from(input, "base64");
  }

  private generateVCard(name: string, phone: string): string {
    const cleaned = phone.replace(/[^0-9]/g, "");
    return [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${name}`,
      `TEL;type=CELL;waid=${cleaned}:+${cleaned}`,
      "END:VCARD",
    ].join("\n");
  }

  private makeQuotedStub(remoteJid: string, messageId: string): WAMessage {
    return {
      key: { remoteJid, id: messageId, fromMe: false },
    } as WAMessage;
  }

  private getMeJid(): string {
    const meJid = this.sock?.user?.id;
    if (!meJid) throw new Error("Not authenticated");
    return meJid;
  }

  // ---- Lifecycle ----

  async connect(): Promise<void> {
    if (this.sock) {
      logger.warn({ instanceId: this.instanceId }, "Already connected or connecting");
      return;
    }

    this.status = "connecting";

    const { state, saveCreds } = await useSqliteAuthState(this.instanceId);
    this.saveCreds = saveCreds;

    const { version } = await getWaVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger: logger.child({ instanceId: this.instanceId }) as ReturnType<typeof pino>,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    this.sock = sock;
    this.bindEvents(sock);
  }

  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.status = "disconnected";
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  // ---- Authentication ----

  async getQrCode(): Promise<string | null> {
    return this.qrCode;
  }

  async getPairingCode(phone: string): Promise<string | null> {
    const sock = this.getSock();
    const code = await sock.requestPairingCode(phone);
    return code;
  }

  async setCredentials(_creds: CloudCredentials): Promise<void> {
    throw new Error("setCredentials is only available for Cloud API instances");
  }

  // ---- Messaging ----

  async sendMessage(to: string, content: MessageContent): Promise<MessageResponse> {
    const sock = this.getSock();
    const jid = this.normalizeJid(to);
    let msg: AnyMessageContent;
    const opts: MiscMessageGenerationOptions = {};

    switch (content.type) {
      case "text":
        msg = { text: content.text };
        if (content.quotedMessageId) {
          opts.quoted = this.makeQuotedStub(jid, content.quotedMessageId);
        }
        break;
      case "image":
        msg = { image: this.resolveMedia(content.image), caption: content.caption };
        if (content.quotedMessageId) {
          opts.quoted = this.makeQuotedStub(jid, content.quotedMessageId);
        }
        break;
      case "video":
        msg = { video: this.resolveMedia(content.video), caption: content.caption };
        if (content.quotedMessageId) {
          opts.quoted = this.makeQuotedStub(jid, content.quotedMessageId);
        }
        break;
      case "audio":
        msg = {
          audio: this.resolveMedia(content.audio),
          ptt: content.ptt ?? false,
          mimetype: "audio/ogg; codecs=opus",
        };
        break;
      case "document":
        msg = {
          document: this.resolveMedia(content.document),
          fileName: content.fileName,
          mimetype: content.mimeType,
        };
        break;
      case "location":
        msg = {
          location: {
            degreesLatitude: content.latitude,
            degreesLongitude: content.longitude,
            name: content.name,
            address: content.address,
          },
        };
        break;
      case "contact":
        msg = {
          contacts: {
            displayName: content.contactName,
            contacts: [{ vcard: this.generateVCard(content.contactName, content.contactPhone) }],
          },
        };
        break;
      case "poll":
        msg = {
          poll: {
            name: content.question,
            values: content.options,
            selectableCount: content.multiSelect ? 0 : 1,
          },
        };
        break;
      case "reaction":
        throw new Error("Use sendReaction() for reactions");
      default:
        throw new Error(`Unsupported message type: ${(content as MessageContent).type}`);
    }

    const result = await sock.sendMessage(jid, msg, opts);
    return { messageId: result?.key.id ?? "", timestamp: Date.now(), status: "sent" };
  }

  async editMessage(chatId: string, msgId: string, newText: string): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    await sock.sendMessage(jid, {
      text: newText,
      edit: { remoteJid: jid, id: msgId, fromMe: true },
    } as AnyMessageContent);
  }

  async deleteMessage(chatId: string, msgId: string): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    await sock.sendMessage(jid, {
      delete: { remoteJid: jid, id: msgId, fromMe: true },
    });
  }

  async forwardMessage(to: string, msgId: string, fromChat: string): Promise<MessageResponse> {
    const sock = this.getSock();
    const toJid = this.normalizeJid(to);
    const fromJid = this.normalizeJid(fromChat);

    // Use the store or load message; for now forward with minimal message stub
    const stubMsg: WAMessage = {
      key: { remoteJid: fromJid, id: msgId, fromMe: false },
      message: { conversation: "" },
    } as WAMessage;

    const forwardContent = generateForwardMessageContent(stubMsg, false);
    const meJid = this.getMeJid();
    const generatedMsg = generateWAMessageFromContent(toJid, forwardContent, { userJid: meJid });

    await sock.relayMessage(toJid, generatedMsg.message!, {
      messageId: generatedMsg.key.id!,
    });

    return { messageId: generatedMsg.key.id ?? "", timestamp: Date.now(), status: "sent" };
  }

  async sendReaction(chatId: string, msgId: string, emoji: string): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    await sock.sendMessage(jid, {
      react: { text: emoji, key: { remoteJid: jid, id: msgId } },
    });
  }

  async pinMessage(chatId: string, msgId: string, pin: boolean): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    const pinMsg = {
      pin: { remoteJid: jid, id: msgId, fromMe: true },
      type: pin ? 1 : 0,
      time: pin ? 604800 : undefined,
    };
    await sock.sendMessage(jid, pinMsg as unknown as AnyMessageContent);
  }

  async sendViewOnce(to: string, media: string, type: "image" | "video"): Promise<MessageResponse> {
    const sock = this.getSock();
    const jid = this.normalizeJid(to);
    const resolved = this.resolveMedia(media);

    const msg: AnyMessageContent =
      type === "image" ? { image: resolved, viewOnce: true } : { video: resolved, viewOnce: true };

    const result = await sock.sendMessage(jid, msg);
    return { messageId: result?.key.id ?? "", timestamp: Date.now(), status: "sent" };
  }

  async sendLinkPreview(to: string, text: string, _url: string): Promise<MessageResponse> {
    const sock = this.getSock();
    const jid = this.normalizeJid(to);
    const result = await sock.sendMessage(jid, { text });
    return { messageId: result?.key.id ?? "", timestamp: Date.now(), status: "sent" };
  }

  // ---- Presence ----

  async sendPresence(
    chatId: string,
    presenceStatus: "composing" | "recording" | "paused" | "available" | "unavailable",
  ): Promise<void> {
    const sock = this.getSock();
    await sock.sendPresenceUpdate(presenceStatus, this.normalizeJid(chatId));
  }

  async markRead(chatId: string, messageIds: string[]): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    const keys = messageIds.map((id) => ({ remoteJid: jid, id }));
    await sock.readMessages(keys);
  }

  // ---- Chats ----

  async modifyChat(chatId: string, modification: ChatModification): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);

    switch (modification.action) {
      case "archive":
        await sock.chatModify({ archive: true, lastMessages: [] }, jid);
        break;
      case "unarchive":
        await sock.chatModify({ archive: false, lastMessages: [] }, jid);
        break;
      case "pin":
        await sock.chatModify({ pin: true }, jid);
        break;
      case "unpin":
        await sock.chatModify({ pin: false }, jid);
        break;
      case "mute":
        await sock.chatModify(
          { mute: modification.muteUntil ?? Date.now() + 8 * 60 * 60 * 1000 },
          jid,
        );
        break;
      case "unmute":
        await sock.chatModify({ mute: null }, jid);
        break;
      case "delete":
        await sock.chatModify({ delete: true, lastMessages: [] }, jid);
        break;
      case "clear":
        await sock.chatModify({ clear: true, lastMessages: [] }, jid);
        break;
    }
  }

  // ---- Groups ----

  async createGroup(name: string, participants: string[]): Promise<GroupResponse> {
    const sock = this.getSock();
    const jids = participants.map((p) => this.normalizeJid(p));
    const result = await sock.groupCreate(name, jids);
    return { groupId: result.id, inviteCode: undefined };
  }

  async modifyGroup(groupId: string, modification: GroupModification): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(groupId);

    switch (modification.action) {
      case "updateSubject":
        await sock.groupUpdateSubject(jid, String(modification.value ?? ""));
        break;
      case "updateDescription":
        await sock.groupUpdateDescription(jid, String(modification.value ?? ""));
        break;
      case "updateSettings":
        await sock.groupSettingUpdate(
          jid,
          modification.value === "announcement" ? "announcement" : "not_announcement",
        );
        break;
      case "leave":
        await sock.groupLeave(jid);
        break;
      case "revokeInvite":
        await sock.groupRevokeInvite(jid);
        break;
      case "toggleEphemeral": {
        const duration = typeof modification.value === "number" ? modification.value : 0;
        await sock.sendMessage(jid, { disappearingMessagesInChat: duration });
        break;
      }
    }
  }

  async modifyParticipants(
    groupId: string,
    participants: string[],
    action: ParticipantAction,
  ): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(groupId);
    const jids = participants.map((p) => this.normalizeJid(p));
    await sock.groupParticipantsUpdate(jid, jids, action);
  }

  async getGroupMetadata(groupId: string): Promise<GroupMetadata> {
    const sock = this.getSock();
    const jid = this.normalizeJid(groupId);
    const meta = await sock.groupMetadata(jid);

    return {
      jid: meta.id,
      subject: meta.subject,
      description: meta.desc ?? null,
      ownerJid: meta.owner ?? null,
      participants: meta.participants.map((p) => ({
        jid: p.id,
        isAdmin: p.admin === "admin" || p.admin === "superadmin",
        isSuperAdmin: p.admin === "superadmin",
      })),
      participantCount: meta.participants.length,
      isAnnounce: meta.announce ?? false,
      isLocked: meta.restrict ?? false,
      ephemeralDuration: meta.ephemeralDuration ?? null,
      inviteCode: null,
      createdAt: meta.creation ?? null,
    };
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    const sock = this.getSock();
    const code = await sock.groupInviteCode(this.normalizeJid(groupId));
    return code ?? "";
  }

  async joinGroup(inviteCode: string): Promise<string> {
    const sock = this.getSock();
    const groupId = await sock.groupAcceptInvite(inviteCode);
    return groupId ?? "";
  }

  async handleJoinRequest(
    groupId: string,
    participantJid: string,
    action: "approve" | "reject",
  ): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(groupId);
    const participant = this.normalizeJid(participantJid);
    await sock.groupRequestParticipantsUpdate(jid, [participant], action);
  }

  // ---- Contacts ----

  async checkNumberExists(phone: string): Promise<NumberExistsResponse> {
    const sock = this.getSock();
    const jid = this.normalizeJid(phone);
    const results = await sock.onWhatsApp(jid);
    const result = results?.[0];
    return { exists: !!result?.exists, jid: result?.jid ?? null };
  }

  async blockContact(jid: string): Promise<void> {
    const sock = this.getSock();
    await sock.updateBlockStatus(this.normalizeJid(jid), "block");
  }

  async unblockContact(jid: string): Promise<void> {
    const sock = this.getSock();
    await sock.updateBlockStatus(this.normalizeJid(jid), "unblock");
  }

  async getBlocklist(): Promise<string[]> {
    const sock = this.getSock();
    const list = await sock.fetchBlocklist();
    return list.filter((jid): jid is string => jid !== undefined);
  }

  async getBusinessProfile(jid: string): Promise<BusinessProfile | null> {
    const sock = this.getSock();
    const profile = await sock.getBusinessProfile(this.normalizeJid(jid));
    if (!profile) return null;
    return {
      name: profile.wid ?? "",
      description: profile.description ?? undefined,
      category: profile.category ?? undefined,
      website: profile.website?.[0] ?? undefined,
      email: profile.email ?? undefined,
      address: profile.address ?? undefined,
    };
  }

  // ---- Profile ----

  async updateProfilePicture(image: Buffer): Promise<void> {
    const sock = this.getSock();
    await sock.updateProfilePicture(this.getMeJid(), image);
  }

  async removeProfilePicture(): Promise<void> {
    const sock = this.getSock();
    await sock.removeProfilePicture(this.getMeJid());
  }

  async updateProfileName(name: string): Promise<void> {
    const sock = this.getSock();
    await sock.updateProfileName(name);
  }

  async updateProfileStatus(statusText: string): Promise<void> {
    const sock = this.getSock();
    await sock.updateProfileStatus(statusText);
  }

  async updatePrivacy(setting: PrivacySetting, value: PrivacyValue): Promise<void> {
    const sock = this.getSock();
    // Baileys has separate privacy update methods per setting
    switch (setting) {
      case "lastSeen":
        await sock.updateLastSeenPrivacy(
          value as "all" | "contacts" | "contact_blacklist" | "none",
        );
        break;
      case "online":
        await sock.updateOnlinePrivacy(value as "all" | "match_last_seen");
        break;
      case "profilePic":
        await sock.updateProfilePicturePrivacy(
          value as "all" | "contacts" | "contact_blacklist" | "none",
        );
        break;
      case "status":
        await sock.updateStatusPrivacy(value as "all" | "contacts" | "contact_blacklist" | "none");
        break;
      case "readReceipts":
        await sock.updateReadReceiptsPrivacy(value as "all" | "none");
        break;
      case "groupAdd":
        await sock.updateGroupsAddPrivacy(value as "all" | "contacts" | "contact_blacklist");
        break;
    }
  }

  async getPrivacySettings(): Promise<PrivacySettings> {
    const sock = this.getSock();
    const settings = await sock.fetchPrivacySettings(true);
    return {
      lastSeen: (settings.last as PrivacyValue) ?? "contacts",
      online: (settings.online as PrivacyValue) ?? "all",
      profilePic: (settings.profile as PrivacyValue) ?? "contacts",
      status: (settings.status as PrivacyValue) ?? "contacts",
      readReceipts: (settings.readreceipts as PrivacyValue) ?? "all",
      groupAdd: (settings.groupadd as PrivacyValue) ?? "contacts",
    };
  }

  async getProfilePicture(jid: string): Promise<string | null> {
    const sock = this.getSock();
    try {
      const url = await sock.profilePictureUrl(this.normalizeJid(jid), "image");
      return url ?? null;
    } catch {
      return null;
    }
  }

  // ---- Status / Stories ----

  async sendStatus(content: StatusContent): Promise<void> {
    const sock = this.getSock();
    const statusJid = "status@broadcast";

    switch (content.type) {
      case "text":
        await sock.sendMessage(statusJid, {
          text: content.text ?? "",
          backgroundColor: content.backgroundColor,
          font: content.font,
        } as AnyMessageContent);
        break;
      case "image":
        await sock.sendMessage(statusJid, {
          image: this.resolveMedia(content.media ?? ""),
          caption: content.caption,
        });
        break;
      case "video":
        await sock.sendMessage(statusJid, {
          video: this.resolveMedia(content.media ?? ""),
          caption: content.caption,
        });
        break;
    }
  }

  // ---- Newsletter / Channels ----

  async newsletterFollow(jid: string): Promise<void> {
    const sock = this.getSock();
    await sock.newsletterFollow(jid);
  }

  async newsletterUnfollow(jid: string): Promise<void> {
    const sock = this.getSock();
    await sock.newsletterUnfollow(jid);
  }

  async newsletterSend(jid: string, text: string): Promise<MessageResponse> {
    const sock = this.getSock();
    const result = await sock.sendMessage(jid, { text });
    return { messageId: result?.key.id ?? "", timestamp: Date.now(), status: "sent" };
  }

  // ---- Calls ----

  async rejectCall(callId: string): Promise<void> {
    const sock = this.getSock();
    // rejectCall requires (callId, callFrom) — we pass empty string for callFrom
    // as we don't have the caller info in this context
    await sock.rejectCall(callId, "");
  }

  // ---- Data access ----

  async getContacts(): Promise<Contact[]> {
    return [];
  }

  async getChats(): Promise<Chat[]> {
    return [];
  }

  async getMessages(_chatId: string, _limit?: number): Promise<Message[]> {
    return [];
  }

  async getProfileInfo(): Promise<ProfileInfo> {
    const sock = this.getSock();
    const meJid = this.getMeJid();

    let pictureUrl: string | null = null;
    try {
      const url = await sock.profilePictureUrl(meJid, "image");
      pictureUrl = url ?? null;
    } catch {
      // no profile picture
    }

    return {
      name: sock.user?.name ?? "",
      status: "",
      pictureUrl,
    };
  }

  // ---- Events ----

  on<E extends ChannelEvent>(event: E, handler: ChannelEventHandler<E>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as ChannelEventHandler<ChannelEvent>);
  }

  off<E extends ChannelEvent>(event: E, handler: ChannelEventHandler<E>): void {
    this.listeners.get(event)?.delete(handler as ChannelEventHandler<ChannelEvent>);
  }

  // ---- Private event helpers ----

  private emit<E extends ChannelEvent>(event: E, payload: ChannelEventPayload[E]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload as ChannelEventPayload[ChannelEvent]);
        } catch (err) {
          logger.error({ err, event }, "Error in event handler");
        }
      }
    }
  }

  private bindEvents(sock: WASocket): void {
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = qr;
        this.status = "qr_pending";
      }

      if (connection === "open") {
        this.status = "connected";
        this.qrCode = null;
        this.reconnectAttempt = 0;
        logger.info({ instanceId: this.instanceId }, "Connected to WhatsApp");
      }

      if (connection === "close") {
        this.status = "disconnected";
        const boom = (lastDisconnect?.error as Boom)?.output;
        const statusCode = boom?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          logger.info({ instanceId: this.instanceId }, "Logged out, clearing auth");
          clearAuthState(this.instanceId);
          this.sock = null;
        } else if (this.autoReconnect) {
          this.scheduleReconnect();
        }
      }

      const normalized = normalizeConnectionUpdate(this.instanceId, update);
      if (normalized) {
        this.emit("connection.changed", normalized);
      }
    });

    sock.ev.on("creds.update", async () => {
      await this.saveCreds?.();
    });

    sock.ev.on("messages.upsert", (data) => {
      for (const msg of data.messages) {
        if (msg.message?.protocolMessage?.type === 14) {
          const editEvent = normalizeMessageEdit(this.instanceId, msg, msg.key.remoteJid ?? "");
          this.emit("message.edited", editEvent);
        }
      }

      const events = normalizeMessagesUpsert(this.instanceId, data);
      for (const event of events) {
        this.emit("message.received", event);
      }
    });

    sock.ev.on("messages.update", (updates) => {
      const events = normalizeMessagesUpdate(this.instanceId, updates);
      for (const event of events) {
        this.emit("message.updated", event);
      }
    });

    sock.ev.on("messages.delete", (data) => {
      const events = normalizeMessagesDelete(this.instanceId, data);
      for (const event of events) {
        this.emit("message.deleted", event);
      }
    });

    sock.ev.on("messages.reaction", (reactions) => {
      const events = normalizeMessagesReaction(this.instanceId, reactions);
      for (const event of events) {
        this.emit("message.reaction", event);
      }
    });

    sock.ev.on("presence.update", (data) => {
      const events = normalizePresenceUpdate(this.instanceId, data);
      for (const event of events) {
        this.emit("presence.updated", event);
      }
    });

    sock.ev.on("groups.update", (updates) => {
      const events = normalizeGroupsUpdate(this.instanceId, updates);
      for (const event of events) {
        this.emit("group.updated", event);
      }
    });

    sock.ev.on("group-participants.update", (data) => {
      const event = normalizeGroupParticipantsUpdate(this.instanceId, data);
      this.emit("group.participants_changed", event);
    });

    sock.ev.on("contacts.update", (contacts) => {
      const events = normalizeContactsUpdate(this.instanceId, contacts);
      for (const event of events) {
        this.emit("contact.updated", event);
      }
    });

    sock.ev.on("call", (calls) => {
      const events = normalizeCallEvent(this.instanceId, calls);
      for (const event of events) {
        this.emit("call.received", event);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      logger.error(
        { instanceId: this.instanceId, attempts: this.reconnectAttempt },
        "Max reconnect attempts reached",
      );
      return;
    }

    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY_MS,
    );

    this.reconnectAttempt++;
    logger.info(
      { instanceId: this.instanceId, attempt: this.reconnectAttempt, delayMs: delay },
      "Scheduling reconnect",
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        this.sock = null;
        await this.connect();
      } catch (err) {
        logger.error({ err, instanceId: this.instanceId }, "Reconnect failed");
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }
}
