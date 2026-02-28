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
  NormalizedMessageEvent,
  MessageDeliveryStatus,
} from "../../types/channel.types.js";
import { useSqliteAuthState, clearAuthState } from "./baileys.auth.js";
import { getWaVersion } from "./baileys.version.js";
import { db } from "../../db/client.js";
import { contacts as contactsTable, messages as messagesTable } from "../../db/schema.js";
import { eq, and, like, or, desc } from "drizzle-orm";
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
  normalizeLidInMessage,
  extractMessageType,
  extractTextContent,
  extractQuotedMessageId,
  getChatJid,
  getSenderJid,
} from "./baileys.events.js";
import {
  DEFAULT_AUTO_RECONNECT,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
} from "../../constants.js";
import { createChildLogger } from "../../utils/logger.js";

const logger = createChildLogger({ service: "baileys-adapter" });

type ContactCache = { id: string; name?: string; notify?: string; verifiedName?: string; phoneNumber?: string; lid?: string };

export class BaileysAdapter implements ChannelAdapter {
  private sock: WASocket | null = null;
  private contactCache = new Map<string, ContactCache>();
  private status: ConnectionStatus = "disconnected";
  private qrCode: string | null = null;
  private pairingPhone: string | null = null;
  private pairingCodeValue: string | null = null;
  private pairingCodeResolver: ((code: string | null) => void) | null = null;
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

  /** Resolve a PN JID from a LID using the signal repository mapping */
  async resolvePn(lidOrPn: string): Promise<string> {
    if (!lidOrPn.endsWith("@lid") || !this.sock) return lidOrPn;
    const pn = await this.sock.signalRepository.lidMapping.getPNForLID(lidOrPn);
    return pn ?? lidOrPn;
  }

  private resolveMedia(input: string): { url: string } | Buffer {
    if (input.startsWith("https://")) {
      return { url: input };
    }
    if (input.startsWith("http://")) {
      throw new Error("Media URLs must use HTTPS");
    }
    if (input.startsWith("file://") || input.startsWith("data:")) {
      throw new Error("file:// and data: URLs are not allowed");
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
      logger: logger.child({ instanceId: this.instanceId }) as unknown as import("pino").Logger,
      generateHighQualityLinkPreview: true,
      syncFullHistory: true,
      markOnlineOnConnect: false,
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
    if (this.status === "disconnected" || !this.sock) {
      throw new Error("Instance not connected");
    }

    // Already have the code cached
    if (this.pairingCodeValue) {
      return this.pairingCodeValue;
    }

    // QR event already fired before this call — request pairing code immediately
    if (this.qrCode && this.sock) {
      await new Promise((r) => setTimeout(r, 1000));
      const code = await this.sock.requestPairingCode(phone);
      this.pairingCodeValue = code ?? null;
      return this.pairingCodeValue;
    }

    // QR event hasn't fired yet — register phone and wait for it (30s timeout)
    this.pairingPhone = phone;
    return new Promise<string | null>((resolve, reject) => {
      this.pairingCodeResolver = resolve;
      setTimeout(() => {
        this.pairingCodeResolver = null;
        reject(new Error("Pairing code timeout — QR event did not fire within 30s"));
      }, 30000);
    });
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

  async getContacts(search?: string): Promise<Contact[]> {
    // Flush in-memory cache into DB (contacts arrive via contacts.upsert event)
    if (this.contactCache.size > 0) {
      const now = Date.now();
      for (const c of this.contactCache.values()) {
        let lid: string | null = c.lid ?? null;
        const extractPhone = (jid: string): string => jid.split("@")[0].split(":")[0];

        let phone: string | null;
        if (c.phoneNumber) {
          phone = extractPhone(c.phoneNumber);
        } else if (c.id.endsWith("@lid")) {
          lid = c.id;
          try {
            const pn = await this.resolvePn(c.id);
            phone = pn !== c.id ? extractPhone(pn) : null;
          } catch {
            phone = null;
          }
        } else {
          phone = extractPhone(c.id);
        }

        db.insert(contactsTable)
          .values({
            instanceId: this.instanceId,
            jid: c.id,
            name: c.name ?? null,
            notifyName: c.notify ?? null,
            phone,
            lid,
            isBusiness: c.verifiedName ? 1 : 0,
            isBlocked: 0,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [contactsTable.instanceId, contactsTable.jid],
            set: { name: c.name ?? null, notifyName: c.notify ?? null, phone, lid, updatedAt: now },
          })
          .run();
      }
      this.contactCache.clear();
    }

    let rows;
    if (search) {
      // Split query into words and match any word against any field
      const words = search.trim().split(/\s+/).filter(Boolean);
      const wordConditions = words.map((w) =>
        or(
          like(contactsTable.name, `%${w}%`),
          like(contactsTable.notifyName, `%${w}%`),
          like(contactsTable.phone, `%${w}%`),
          like(contactsTable.lid, `%${w}%`),
        ),
      );
      rows = db
        .select()
        .from(contactsTable)
        .where(and(eq(contactsTable.instanceId, this.instanceId), or(...wordConditions)))
        .all();
    } else {
      rows = db
        .select()
        .from(contactsTable)
        .where(eq(contactsTable.instanceId, this.instanceId))
        .all();
    }

    return rows.map((r) => ({
      jid: r.jid,
      name: r.name ?? r.notifyName ?? null,
      notifyName: r.notifyName ?? null,
      phone: r.phone ?? null,
      profilePicUrl: r.profilePicUrl ?? null,
      isBusiness: r.isBusiness === 1,
      isBlocked: r.isBlocked === 1,
    }));
  }

  async getChats(): Promise<Chat[]> {
    return [];
  }

  async getMessages(chatId: string, limit = 50): Promise<Message[]> {
    const rows = db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.instanceId, this.instanceId),
          eq(messagesTable.chatId, chatId),
        ),
      )
      .orderBy(desc(messagesTable.timestamp))
      .limit(limit)
      .all();

    return rows.map((r) => ({
      id: r.id,
      chatId: r.chatId,
      senderId: r.senderId,
      type: r.type as Message["type"],
      content: r.content,
      mediaUrl: r.mediaUrl,
      quotedMessageId: r.quotedId,
      isFromMe: r.isFromMe === 1,
      isForwarded: r.isForwarded === 1,
      status: r.status as Message["status"],
      timestamp: r.timestamp,
    }));
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

  // ---- Message Persistence ----

  private persistMessage(event: NormalizedMessageEvent): void {
    try {
      const { message, chatId, instanceId } = event;
      db.insert(messagesTable)
        .values({
          id: message.id,
          instanceId,
          chatId,
          senderId: message.sender,
          type: message.type,
          content: message.content,
          mediaUrl: message.mediaUrl,
          quotedId: message.quotedMessageId,
          isFromMe: message.isFromMe ? 1 : 0,
          isForwarded: 0,
          status: message.isFromMe ? "sent" : "received",
          timestamp: message.timestamp,
        })
        .onConflictDoUpdate({
          target: [messagesTable.instanceId, messagesTable.id],
          set: {
            content: message.content,
            status: message.isFromMe ? "sent" : "received",
          },
        })
        .run();
      logger.info(
        { instanceId, messageId: message.id, chatId, fromMe: message.isFromMe },
        "Message persisted to DB",
      );
    } catch (err) {
      logger.error({ err, messageId: event.message.id }, "Failed to persist message");
    }
  }

  private updateMessageStatus(messageId: string, status: MessageDeliveryStatus): void {
    try {
      db.update(messagesTable)
        .set({ status })
        .where(
          and(
            eq(messagesTable.instanceId, this.instanceId),
            eq(messagesTable.id, messageId),
          ),
        )
        .run();
    } catch (err) {
      logger.error({ err, messageId }, "Failed to update message status");
    }
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

        if (this.pairingPhone && sock) {
          // Evolution API pattern: call requestPairingCode inside the QR event, with a small delay
          setTimeout(async () => {
            try {
              const code = await sock.requestPairingCode(this.pairingPhone!);
              this.pairingCodeValue = code ?? null;
              if (this.pairingCodeResolver) {
                this.pairingCodeResolver(this.pairingCodeValue);
                this.pairingCodeResolver = null;
              }
              logger.info({ instanceId: this.instanceId, code }, "Pairing code generated");
            } catch (err) {
              logger.error({ instanceId: this.instanceId, err }, "Failed to generate pairing code");
              if (this.pairingCodeResolver) {
                this.pairingCodeResolver(null);
                this.pairingCodeResolver = null;
              }
            }
          }, 1000);
        }
      }

      if (connection === "open") {
        this.status = "connected";
        this.qrCode = null;
        this.pairingPhone = null;
        this.pairingCodeValue = null;
        this.pairingCodeResolver = null;
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

    // creds.update is not buffered — use ev.on directly
    sock.ev.on("creds.update", async () => {
      await this.saveCreds?.();
    });

    const cacheContacts = (contacts: { id: string; name?: string; notify?: string; verifiedName?: string; phoneNumber?: string; lid?: string }[]) => {
      for (const c of contacts) {
        if (!c.id) continue;

        // When contact arrives as LID with a phoneNumber, use PN as primary key
        let primaryId = c.id;
        let lid = c.lid;
        if (c.id.endsWith("@lid") && c.phoneNumber) {
          lid = c.id;
          primaryId = c.phoneNumber;
        }

        const existing = this.contactCache.get(primaryId);
        // Preserve phonebook name (from app-state contactAction) if it differs from notify
        const existingHasPhonebookName = existing?.name && existing.name !== existing.notify;
        const newName = existingHasPhonebookName ? existing.name : (c.name ?? existing?.name);

        this.contactCache.set(primaryId, {
          id: primaryId,
          name: newName,
          notify: c.notify ?? existing?.notify,
          verifiedName: c.verifiedName ?? existing?.verifiedName,
          phoneNumber: c.phoneNumber ?? existing?.phoneNumber,
          lid: lid ?? existing?.lid,
        });
      }
    };

    // Use ev.process() to receive ALL buffered events after sync flush
    sock.ev.process((events) => {
      const eventKeys = Object.keys(events);
      if (eventKeys.length > 0) {
        logger.info({ instanceId: this.instanceId, events: eventKeys }, "ev.process fired");
      }

      // --- LID Mapping (v7+): store LID <-> PN mappings ---
      if (events["lid-mapping.update"]) {
        const mapping = events["lid-mapping.update"];
        logger.info({ instanceId: this.instanceId, lid: mapping.lid, pn: mapping.pn }, "LID mapping updated");
      }

      // --- Chats: extract phonebook names from chat metadata ---
      if (events["chats.upsert"]) {
        const namedChats = events["chats.upsert"].filter(
          (ch): ch is typeof ch & { id: string; name: string } =>
            !!ch.id && !!ch.name && !ch.id.endsWith("@g.us") && !ch.id.endsWith("@broadcast"),
        );
        if (namedChats.length > 0) {
          cacheContacts(namedChats.map((ch) => ({ id: ch.id, name: ch.name })));
          logger.info({ instanceId: this.instanceId, count: namedChats.length }, "Contacts cached from chat names (chats.upsert)");
        }
      }

      // --- Contacts (arrives buffered during initial sync) ---
      if (events["contacts.upsert"]) {
        const contacts = events["contacts.upsert"];
        cacheContacts(contacts);
        logger.info({ instanceId: this.instanceId, count: contacts.length }, "Contacts cached (upsert)");
      }

      if (events["contacts.update"]) {
        const normalized = normalizeContactsUpdate(this.instanceId, events["contacts.update"]);
        for (const event of normalized) this.emit("contact.updated", event);
      }

      // --- History sync: contacts arrive here during first sync ---
      if (events["messaging-history.set"]) {
        const { contacts = [], chats = [] } = events["messaging-history.set"];
        const filtered = contacts.filter((c) => c.id && (c.notify || c.name));
        if (filtered.length > 0) {
          cacheContacts(filtered.map((c) => ({
            id: c.id,
            name: c.name ?? c.notify,
            notify: c.notify,
            verifiedName: c.verifiedName,
            phoneNumber: c.phoneNumber,
            lid: c.lid,
          })));
          logger.info({ instanceId: this.instanceId, contacts: filtered.length, chats: chats.length }, "Contacts cached (history sync)");
        }

        // Extract contact names from chat list (may include phonebook names)
        const chatContacts = chats.filter(
          (ch): ch is typeof ch & { id: string; name: string } =>
            !!ch.id && !!ch.name && !ch.id.endsWith("@g.us") && !ch.id.endsWith("@broadcast"),
        );
        if (chatContacts.length > 0) {
          cacheContacts(chatContacts.map((ch) => ({
            id: ch.id,
            name: ch.name,
          })));
          logger.info({ instanceId: this.instanceId, chatContacts: chatContacts.length }, "Contacts cached from chat names");
        }
      }

      // --- Messages ---
      if (events["messages.upsert"]) {
        const data = events["messages.upsert"];
        logger.info(
          { instanceId: this.instanceId, type: data.type, count: data.messages.length },
          "messages.upsert event received",
        );
        for (const msg of data.messages) {
          normalizeLidInMessage(msg);

          if (msg.message?.protocolMessage?.type === 14) {
            const editEvent = normalizeMessageEdit(this.instanceId, msg, msg.key.remoteJid ?? "");
            this.emit("message.edited", editEvent);
            continue;
          }

          if (msg.pushName && msg.key.remoteJid && !msg.key.fromMe) {
            cacheContacts([{ id: msg.key.remoteJid, name: msg.pushName }]);
          }

          // Persist ALL messages (notify + append) to DB
          if (msg.key.id && msg.key.remoteJid && !msg.message?.protocolMessage) {
            const normalized: NormalizedMessageEvent = {
              instanceId: this.instanceId,
              chatId: getChatJid(msg),
              message: {
                id: msg.key.id,
                sender: getSenderJid(msg),
                timestamp:
                  typeof msg.messageTimestamp === "number"
                    ? msg.messageTimestamp
                    : Number(msg.messageTimestamp ?? 0),
                type: extractMessageType(msg),
                content: extractTextContent(msg),
                mediaUrl: null,
                quotedMessageId: extractQuotedMessageId(msg),
                isFromMe: msg.key.fromMe ?? false,
              },
            };
            this.persistMessage(normalized);
          }
        }

        // Emit events only for incoming notify-type messages (not our own sends)
        const notifyEvents = normalizeMessagesUpsert(this.instanceId, data);
        logger.info(
          { instanceId: this.instanceId, notifyCount: notifyEvents.length },
          "Notify messages for emission",
        );
        for (const event of notifyEvents) {
          this.emit("message.received", event);
        }
      }

      if (events["messages.update"]) {
        const normalized = normalizeMessagesUpdate(this.instanceId, events["messages.update"]);
        for (const event of normalized) {
          this.updateMessageStatus(event.messageId, event.status);
          this.emit("message.updated", event);
        }
      }

      if (events["messages.delete"]) {
        const normalized = normalizeMessagesDelete(this.instanceId, events["messages.delete"]);
        for (const event of normalized) this.emit("message.deleted", event);
      }

      if (events["messages.reaction"]) {
        const normalized = normalizeMessagesReaction(this.instanceId, events["messages.reaction"]);
        for (const event of normalized) this.emit("message.reaction", event);
      }

      // --- Presence ---
      if (events["presence.update"]) {
        const normalized = normalizePresenceUpdate(this.instanceId, events["presence.update"]);
        for (const event of normalized) this.emit("presence.updated", event);
      }

      // --- Groups ---
      if (events["groups.update"]) {
        const normalized = normalizeGroupsUpdate(this.instanceId, events["groups.update"]);
        for (const event of normalized) this.emit("group.updated", event);
      }

      if (events["group-participants.update"]) {
        const event = normalizeGroupParticipantsUpdate(this.instanceId, events["group-participants.update"]);
        this.emit("group.participants_changed", event);
      }

      // --- Calls ---
      if (events["call"]) {
        const normalized = normalizeCallEvent(this.instanceId, events["call"]);
        for (const event of normalized) this.emit("call.received", event);
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
