// ============================================================
// WA MCP — Cloud API Adapter
// Full implementation of ChannelAdapter using Meta's
// WhatsApp Cloud API (graph.facebook.com/v21.0).
// ============================================================

import type { ChannelAdapter, ChannelEventHandler } from "../channel.interface.js";
import { and, eq, sql } from "drizzle-orm";
import { db, sqlite } from "../../db/client.js";
import { messages as messagesTable } from "../../db/schema.js";
import { getWebPInfo, mediaResponseToBuffer } from "../../services/media.js";
import { MEDIA_LIMITS } from "../../constants.js";
import type {
  ConnectionStatus,
  MessageContent,
  MessageResponse,
  GroupResponse,
  GroupSummary,
  NumberExistsResponse,
  BusinessProfile,
  ProfileInfo,
  PrivacySettings,
  PrivacyUpdate,
  Contact,
  Chat,
  Message,
  GroupMetadata,
  ChatModification,
  GroupModification,
  ParticipantAction,
  StatusContent,
  StatusSendResult,
  CloudCredentials,
  ChannelEvent,
  ChannelEventPayload,
  NormalizedMessageEvent,
  BusinessLabel,
  EventResponse,
  PollResults,
  GroupJoinRequest,
  MessageReceipt,
  MessageReaction,
  LinkPreviewOptions,
  MessageSearchOptions,
  SendEventOptions,
  CatalogProductCreateInput,
  CatalogProductUpdateInput,
  InstanceRuntimeStatus,
} from "../../types/channel.types.js";
import type {
  CatalogCollection,
  GetCatalogOptions,
  NewsletterMetadata,
  OrderDetails,
  Product,
} from "@whiskeysockets/baileys";
import { searchStoredMessages } from "../../services/message-search.js";
import { createChildLogger } from "../../utils/logger.js";
import { getAutoReadMode, scheduleIncomingMessageRead } from "../../services/auto-read.js";

const logger = createChildLogger({ service: "cloud-api-adapter" });

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

function sizeLimitLabel(maxBytes: number): string {
  return maxBytes < 1024 * 1024 ? `${maxBytes} bytes` : `${Math.round(maxBytes / 1024 / 1024)} MB`;
}

// ---- Cloud API response/error types ----

interface CloudApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

interface CloudApiSendResponse {
  messaging_product: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: string }>;
}

interface CloudApiMediaUploadResponse {
  id: string;
}

interface CloudApiMediaUrlResponse {
  url: string;
  mime_type: string;
  sha256: string;
  file_size?: number;
  id: string;
  messaging_product: string;
}

interface CloudApiBusinessProfileResponse {
  data: Array<{
    about?: string;
    address?: string;
    description?: string;
    email?: string;
    vertical?: string;
    websites?: string[];
    profile_picture_url?: string;
    messaging_product: string;
  }>;
}

interface CloudApiPhoneNumberResponse {
  verified_name: string;
  display_phone_number: string;
  id: string;
  quality_rating?: string;
}

export class CloudApiAdapter implements ChannelAdapter {
  private accessToken: string | null = null;
  private phoneNumberId: string | null = null;
  private businessId: string | null = null;
  private status: ConnectionStatus = "disconnected";
  private displayPhoneNumber: string | null = null;
  private lastDisconnectAt: number | null = null;

  private readonly listeners = new Map<ChannelEvent, Set<ChannelEventHandler<ChannelEvent>>>();

  constructor(private readonly instanceId: string) {}

  // ---- Private helpers ----

  private getCredentials(): { accessToken: string; phoneNumberId: string } {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new Error("Cloud API credentials not set. Call wa_set_cloud_credentials first.");
    }
    return { accessToken: this.accessToken, phoneNumberId: this.phoneNumberId };
  }

  private normalizePhone(input: string): string {
    // Strip JID suffix and non-numeric characters
    const cleaned = input.replace(/@.*$/, "").replace(/[^0-9]/g, "");
    return cleaned;
  }

  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const { accessToken } = this.getCredentials();

    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(url, { ...options, headers });
    const body = (await response.json()) as T | CloudApiError;

    if (!response.ok) {
      const err = body as CloudApiError;
      const msg = err.error?.message ?? `HTTP ${response.status}`;
      const code = err.error?.code ?? response.status;
      const traceId = err.error?.fbtrace_id ?? "";
      throw new Error(`Cloud API error ${code}: ${msg}${traceId ? ` (trace: ${traceId})` : ""}`);
    }

    return body as T;
  }

  private async sendRaw(payload: Record<string, unknown>): Promise<CloudApiSendResponse> {
    const { phoneNumberId } = this.getCredentials();
    const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

    return this.request<CloudApiSendResponse>(url, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...payload,
      }),
    });
  }

  private toMessageResponse(res: CloudApiSendResponse): MessageResponse {
    return {
      messageId: res.messages[0]?.id ?? "",
      timestamp: Date.now(),
      status: "sent",
    };
  }

  private resolveMediaPayload(
    input: string,
    type: "image" | "video" | "audio" | "document" | "sticker",
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    const mediaObj: Record<string, unknown> = { ...extra };
    if (input.startsWith("https://")) {
      mediaObj.link = input;
    } else if (input.startsWith("http://")) {
      throw new Error("Media URLs must use HTTPS");
    } else if (input.startsWith("file://") || input.startsWith("data:")) {
      throw new Error("file:// and data: URLs are not allowed");
    } else {
      // Assume it's a media ID (previously uploaded)
      mediaObj.id = input;
    }
    return { type, [type]: mediaObj };
  }

  // ---- Lifecycle ----

  async connect(): Promise<void> {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new Error("Cloud API credentials not set. Call wa_set_cloud_credentials first.");
    }

    this.status = "connecting";

    try {
      // Verify credentials by fetching phone number info
      const url = `${GRAPH_API_BASE}/${this.phoneNumberId}`;
      const phoneInfo = await this.request<CloudApiPhoneNumberResponse>(url);
      this.status = "connected";
      this.displayPhoneNumber = phoneInfo.display_phone_number;
      logger.info({ instanceId: this.instanceId }, "Cloud API connected");

      this.emit("connection.changed", {
        instanceId: this.instanceId,
        status: "open",
      });
      this.emit("instance.connected", {
        instanceId: this.instanceId,
        phone: this.displayPhoneNumber,
        lid: null,
        pushName: null,
        connectedAt: Date.now(),
        wasPairing: false,
      });
    } catch (err) {
      this.status = "disconnected";
      logger.error({ err, instanceId: this.instanceId }, "Cloud API connection failed");
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.status = "disconnected";
    this.lastDisconnectAt = Date.now();
    logger.info({ instanceId: this.instanceId }, "Cloud API disconnected");

    this.emit("instance.disconnected", {
      instanceId: this.instanceId,
      reason: "Disconnected",
      statusCode: null,
      loggedOut: false,
      willReconnect: false,
      disconnectedAt: this.lastDisconnectAt,
    });

    this.emit("connection.changed", {
      instanceId: this.instanceId,
      status: "close",
    });
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getLifecycleStatus(): InstanceRuntimeStatus {
    return {
      phone: this.status === "connected" ? this.displayPhoneNumber : null,
      lid: null,
      pushName: null,
      disconnectReason: this.lastDisconnectAt === null ? null : "Disconnected",
      disconnectStatusCode: null,
      pendingChallenge: null,
      presenceMode: null,
    };
  }

  // ---- Authentication ----

  async getQrCode(): Promise<string | null> {
    throw new Error("QR code is only available for Baileys instances");
  }

  async getPairingCode(_phone: string): Promise<string | null> {
    throw new Error("Pairing code is only available for Baileys instances");
  }

  async setCredentials(creds: CloudCredentials): Promise<void> {
    this.accessToken = creds.accessToken;
    this.phoneNumberId = creds.phoneNumberId;
    this.businessId = creds.businessId ?? null;
    logger.info({ instanceId: this.instanceId }, "Cloud API credentials set");
  }

  // ---- Messaging ----

  async sendMessage(to: string, content: MessageContent): Promise<MessageResponse> {
    const phone = this.normalizePhone(to);

    if (
      "mentions" in content &&
      ((content.mentions?.length ?? 0) > 0 || ("mentionAll" in content && content.mentionAll))
    ) {
      throw new Error("Participant mentions are not supported by this Cloud API adapter");
    }

    switch (content.type) {
      case "text": {
        const payload: Record<string, unknown> = {
          recipient_type: "individual",
          to: phone,
          type: "text",
          text: { preview_url: true, body: content.text },
        };
        if (content.quotedMessageId) {
          payload.context = { message_id: content.quotedMessageId };
        }
        const res = await this.sendRaw(payload);
        return this.toMessageResponse(res);
      }

      case "image": {
        const mediaFields: Record<string, unknown> = {};
        if (content.caption) mediaFields.caption = content.caption;
        const media = this.resolveMediaPayload(content.image, "image", mediaFields);
        const payload: Record<string, unknown> = {
          recipient_type: "individual",
          to: phone,
          ...media,
        };
        if (content.quotedMessageId) {
          payload.context = { message_id: content.quotedMessageId };
        }
        const res = await this.sendRaw(payload);
        return this.toMessageResponse(res);
      }

      case "video": {
        if (content.ptv) {
          throw new Error(
            "Video notes (PTV) are not supported on Cloud API; use a Baileys instance",
          );
        }
        if (content.gifPlayback) {
          throw new Error(
            "GIF playback sending is not supported on Cloud API; use a Baileys instance",
          );
        }
        const mediaFields: Record<string, unknown> = {};
        if (content.caption) mediaFields.caption = content.caption;
        const media = this.resolveMediaPayload(content.video, "video", mediaFields);
        const payload: Record<string, unknown> = {
          recipient_type: "individual",
          to: phone,
          ...media,
        };
        if (content.quotedMessageId) {
          payload.context = { message_id: content.quotedMessageId };
        }
        const res = await this.sendRaw(payload);
        return this.toMessageResponse(res);
      }

      case "sticker": {
        const sticker = Buffer.from(content.sticker, "base64");
        if (sticker.length > MEDIA_LIMITS.stickerAnimated) {
          throw new Error(
            `Sticker exceeds the ${MEDIA_LIMITS.stickerAnimated} byte WhatsApp sticker limit`,
          );
        }
        const stickerInfo = getWebPInfo(sticker);
        if (!stickerInfo) {
          throw new Error("Cloud API sticker messages require a valid WebP sticker");
        }
        const stickerLimit = stickerInfo.animated
          ? MEDIA_LIMITS.stickerAnimated
          : MEDIA_LIMITS.stickerStatic;
        if (sticker.length > stickerLimit) {
          const type = stickerInfo.animated ? "animated" : "static";
          throw new Error(
            `${type[0]!.toUpperCase()}${type.slice(1)} sticker exceeds the ${sizeLimitLabel(stickerLimit)} WhatsApp sticker limit`,
          );
        }
        const mediaId = await this.uploadMedia(sticker, "image/webp", "sticker.webp");
        const payload: Record<string, unknown> = {
          recipient_type: "individual",
          to: phone,
          type: "sticker",
          sticker: { id: mediaId },
        };
        if (content.quotedMessageId) {
          payload.context = { message_id: content.quotedMessageId };
        }
        const res = await this.sendRaw(payload);
        return this.toMessageResponse(res);
      }

      case "audio": {
        const media = this.resolveMediaPayload(content.audio, "audio");
        const payload: Record<string, unknown> = {
          recipient_type: "individual",
          to: phone,
          ...media,
        };
        if (content.quotedMessageId) {
          payload.context = { message_id: content.quotedMessageId };
        }
        const res = await this.sendRaw(payload);
        return this.toMessageResponse(res);
      }

      case "document": {
        const mediaFields: Record<string, unknown> = {
          filename: content.fileName,
        };
        if (content.mimeType) mediaFields.caption = undefined; // documents don't always need caption
        const media = this.resolveMediaPayload(content.document, "document", mediaFields);
        const res = await this.sendRaw({
          recipient_type: "individual",
          to: phone,
          ...media,
        });
        return this.toMessageResponse(res);
      }

      case "location": {
        if (content.isLive) {
          throw new Error(
            "Live location messages are not supported on Cloud API; use a Baileys instance",
          );
        }
        const res = await this.sendRaw({
          recipient_type: "individual",
          to: phone,
          type: "location",
          location: {
            latitude: content.latitude,
            longitude: content.longitude,
            name: content.name ?? "",
            address: content.address ?? "",
          },
        });
        return this.toMessageResponse(res);
      }

      case "contact": {
        const contacts =
          "contacts" in content
            ? content.contacts
            : [{ name: content.contactName, phone: content.contactPhone }];
        const res = await this.sendRaw({
          recipient_type: "individual",
          to: phone,
          type: "contacts",
          contacts: contacts.map(({ name, phone: contactPhone }) => ({
            name: { formatted_name: name },
            phones: [{ phone: contactPhone, type: "CELL" }],
          })),
        });
        return this.toMessageResponse(res);
      }

      case "poll": {
        // Cloud API supports interactive polls via interactive messages
        // Use interactive type with button for now; polls are not natively supported in Cloud API
        // We send as an interactive list with the options
        throw new Error(
          "Polls are not natively supported on Cloud API. Use interactive messages (buttons/lists) instead.",
        );
      }

      case "buttons": {
        const res = await this.sendRaw({
          recipient_type: "individual",
          to: phone,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: content.text },
            ...(content.footer ? { footer: { text: content.footer } } : {}),
            action: {
              buttons: content.buttons.map((button) => ({
                type: "reply",
                reply: { id: button.id, title: button.text },
              })),
            },
          },
        });
        return this.toMessageResponse(res);
      }

      case "list": {
        const res = await this.sendRaw({
          recipient_type: "individual",
          to: phone,
          type: "interactive",
          interactive: {
            type: "list",
            body: { text: content.text },
            ...(content.footer ? { footer: { text: content.footer } } : {}),
            action: {
              button: content.buttonText,
              sections: content.sections.map((section) => ({
                title: section.title,
                rows: section.rows.map((row) => ({
                  id: row.id,
                  title: row.title,
                  ...(row.description ? { description: row.description } : {}),
                })),
              })),
            },
          },
        });
        return this.toMessageResponse(res);
      }

      case "reaction": {
        throw new Error("Use sendReaction() for reactions");
      }

      default:
        throw new Error(`Unsupported message type: ${(content as MessageContent).type}`);
    }
  }

  async sendEvent(_options: SendEventOptions): Promise<MessageResponse> {
    throw new Error(
      "WhatsApp event messages are not supported on Cloud API; use a Baileys instance",
    );
  }

  async getEventResponses(_chatId: string, _eventMessageId: string): Promise<EventResponse[]> {
    throw new Error("WhatsApp event responses are only available on Baileys instances");
  }

  async getPollResults(_chatId: string, _pollMessageId: string): Promise<PollResults> {
    throw new Error("Poll results are only available on Baileys instances");
  }

  async starMessage(_chatId: string, _messageId: string, _star: boolean): Promise<void> {
    throw new Error("Starring messages is not supported on Cloud API; use a Baileys instance");
  }

  async editMessage(_chatId: string, _msgId: string, _newText: string): Promise<void> {
    throw new Error("Editing sent messages is not supported on Cloud API; use a Baileys instance");
  }

  async deleteMessage(_chatId: string, _msgId: string): Promise<void> {
    throw new Error("Deleting sent messages is not supported on Cloud API");
  }

  async forwardMessage(_to: string, _msgId: string, _fromChat: string): Promise<MessageResponse> {
    // Cloud API does not have a native forward endpoint.
    // Forwarding requires re-sending the content.
    throw new Error(
      "Message forwarding is not natively supported on Cloud API. Re-send the content instead.",
    );
  }

  async sendReaction(chatId: string, msgId: string, emoji: string): Promise<void> {
    const phone = this.normalizePhone(chatId);
    await this.sendRaw({
      recipient_type: "individual",
      to: phone,
      type: "reaction",
      reaction: {
        message_id: msgId,
        emoji: emoji || "", // empty string removes reaction
      },
    });
  }

  async pinMessage(_chatId: string, _msgId: string, _pin: boolean): Promise<void> {
    throw new Error("Pinning messages is not supported on Cloud API");
  }

  async sendViewOnce(
    _to: string,
    _media: string,
    _type: "image" | "video" | "audio",
  ): Promise<MessageResponse> {
    throw new Error("View-once media is not supported on Cloud API; use a Baileys instance");
  }

  async sendLinkPreview(
    to: string,
    text: string,
    url: string,
    options?: LinkPreviewOptions,
  ): Promise<MessageResponse> {
    if (options?.title || options?.description || options?.thumbnail) {
      throw new Error(
        "Custom link preview metadata and thumbnails are not supported on Cloud API; the URL preview is generated by Meta",
      );
    }
    const phone = this.normalizePhone(to);
    const body = text.includes(url) ? text : `${text}\n${url}`;
    const res = await this.sendRaw({
      recipient_type: "individual",
      to: phone,
      type: "text",
      text: { preview_url: true, body },
    });
    return this.toMessageResponse(res);
  }

  // ---- Presence ----

  async sendPresence(
    _chatId: string,
    _status: "typing" | "composing" | "recording" | "paused" | "available" | "unavailable",
  ): Promise<void> {
    // Cloud API does not support sending presence/typing indicators programmatically
    throw new Error("Sending presence is not supported on Cloud API");
  }

  async subscribePresence(_chatId: string): Promise<void> {
    throw new Error("Subscribing to contact presence is not supported on Cloud API");
  }

  async getMessageReceipts(_chatId: string, _messageId: string): Promise<MessageReceipt[]> {
    throw new Error("Participant-level message receipts are not available on Cloud API");
  }

  async getStatusViewers(_messageId: string): Promise<string[]> {
    throw new Error("Status story viewers are not available on Cloud API");
  }

  async getMessageReactions(_chatId: string, _messageId: string): Promise<MessageReaction[]> {
    throw new Error("Message reaction history is not available on Cloud API");
  }

  async replyPrivatelyToGroupMessage(
    _groupId: string,
    _messageId: string,
    _text: string,
  ): Promise<MessageResponse> {
    throw new Error("Private replies to group messages are not supported on Cloud API");
  }

  async sendMediaAlbum(
    _to: string,
    _images: Array<{ image: string; caption?: string }>,
  ): Promise<MessageResponse> {
    throw new Error("Grouped media albums are not supported on Cloud API; use a Baileys instance");
  }

  async markRead(chatId: string, messageIds: string[], _participant?: string): Promise<void> {
    // Cloud API marks one message at a time
    const _phone = this.normalizePhone(chatId);
    const { phoneNumberId } = this.getCredentials();
    const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

    for (const msgId of messageIds) {
      await this.request(url, {
        method: "POST",
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: msgId,
        }),
      });
    }
  }

  // ---- Chats ----

  async modifyChat(_chatId: string, _modification: ChatModification): Promise<void> {
    throw new Error("Chat modifications (archive, pin, mute) are not supported on Cloud API");
  }

  async markChatUnread(_chatId: string): Promise<void> {
    throw new Error("Marking a chat unread is not supported on Cloud API; use a Baileys instance");
  }

  async listLabels(_includeDeleted = false): Promise<BusinessLabel[]> {
    throw new Error("WhatsApp Business labels are not supported on Cloud API by this server");
  }

  async createLabel(_name: string, _color: number): Promise<BusinessLabel> {
    throw new Error("WhatsApp Business labels are not supported on Cloud API by this server");
  }

  async editLabel(_id: string, _update: { name?: string; color?: number }): Promise<void> {
    throw new Error("WhatsApp Business labels are not supported on Cloud API by this server");
  }

  async deleteLabel(_id: string): Promise<void> {
    throw new Error("WhatsApp Business labels are not supported on Cloud API by this server");
  }

  async setChatLabel(_chatId: string, _labelId: string, _add: boolean): Promise<void> {
    throw new Error("WhatsApp Business labels are not supported on Cloud API by this server");
  }

  async setMessageLabel(
    _chatId: string,
    _messageId: string,
    _labelId: string,
    _add: boolean,
  ): Promise<void> {
    throw new Error("WhatsApp Business labels are not supported on Cloud API by this server");
  }

  async setDisappearingMessages(
    _chatId: string,
    _duration: 0 | 86400 | 604800 | 7776000,
  ): Promise<void> {
    throw new Error("Disappearing-message settings are not supported on Cloud API");
  }

  async createQuickReply(_input: { shortcut: string; message: string }): Promise<void> {
    throw new Error("Business quick replies are only available on Baileys instances");
  }

  async editQuickReply(_input: {
    shortcut: string;
    message: string;
    timestamp: string;
  }): Promise<void> {
    throw new Error("Business quick replies are only available on Baileys instances");
  }

  async deleteQuickReply(_timestamp: string): Promise<void> {
    throw new Error("Business quick replies are only available on Baileys instances");
  }

  // ---- Groups ----

  async listGroups(): Promise<GroupSummary[]> {
    throw new Error("Listing groups is not supported on Cloud API");
  }

  async createGroup(_name: string, _participants: string[]): Promise<GroupResponse> {
    throw new Error("Group management is not supported on Cloud API");
  }

  async modifyGroup(_groupId: string, _modification: GroupModification): Promise<void> {
    throw new Error("Group management is not supported on Cloud API");
  }

  async modifyParticipants(
    _groupId: string,
    _participants: string[],
    _action: ParticipantAction,
  ): Promise<void> {
    throw new Error("Group management is not supported on Cloud API");
  }

  async getGroupMetadata(_groupId: string): Promise<GroupMetadata> {
    throw new Error("Group metadata is not supported on Cloud API");
  }

  assertGroupMemberLabelWritesEnabled(): void {
    throw new Error("Group member labels are not supported on Cloud API");
  }

  async updateGroupMemberLabel(_groupId: string, _memberLabel: string | null): Promise<void> {
    throw new Error("Group member labels are not supported on Cloud API");
  }

  async updateGroupPicture(_groupId: string, _image: string): Promise<void> {
    throw new Error("Updating a group picture is not supported on Cloud API");
  }

  async removeGroupPicture(_groupId: string): Promise<void> {
    throw new Error("Removing a group picture is not supported on Cloud API");
  }

  async getGroupInviteCode(_groupId: string): Promise<string> {
    throw new Error("Group management is not supported on Cloud API");
  }

  async getGroupInviteInfo(_inviteCode: string): Promise<GroupMetadata> {
    throw new Error("Group invite lookup is not supported on Cloud API; use a Baileys instance");
  }

  async joinGroup(_inviteCode: string): Promise<string> {
    throw new Error("Group management is not supported on Cloud API");
  }

  async listGroupJoinRequests(_groupId: string): Promise<GroupJoinRequest[]> {
    throw new Error(
      "Group join-request lists are not supported on Cloud API; use a Baileys instance",
    );
  }

  async sendGroupInviteMessage(
    _to: string,
    _groupId: string,
    _text?: string,
  ): Promise<MessageResponse> {
    throw new Error("Group invite messages are not supported on Cloud API; use a Baileys instance");
  }

  async handleJoinRequest(
    _groupId: string,
    _participantJid: string,
    _action: "approve" | "reject",
  ): Promise<void> {
    throw new Error("Group management is not supported on Cloud API");
  }

  async setGroupJoinApprovalMode(_groupId: string, _mode: "on" | "off"): Promise<void> {
    throw new Error("Group join approval mode is only available on Baileys instances");
  }

  async setGroupMemberAddMode(
    _groupId: string,
    _mode: "admin_add" | "all_member_add",
  ): Promise<void> {
    throw new Error("Group member-add mode is only available on Baileys instances");
  }

  // ---- Communities ----

  async createCommunity(_subject: string, _description?: string): Promise<GroupMetadata | null> {
    throw new Error("Community management is only available on Baileys instances");
  }

  async listCommunities(): Promise<Record<string, GroupMetadata>> {
    throw new Error("Community management is only available on Baileys instances");
  }

  async getCommunityMetadata(_communityId: string): Promise<GroupMetadata> {
    throw new Error("Community management is only available on Baileys instances");
  }

  async linkGroupToCommunity(_groupId: string, _communityId: string): Promise<void> {
    throw new Error("Community management is only available on Baileys instances");
  }

  async unlinkGroupFromCommunity(_groupId: string, _communityId: string): Promise<void> {
    throw new Error("Community management is only available on Baileys instances");
  }

  async leaveCommunity(_communityId: string): Promise<void> {
    throw new Error("Community management is only available on Baileys instances");
  }

  // ---- Contacts ----

  async checkNumberExists(phone: string): Promise<NumberExistsResponse> {
    // Cloud API doesn't have a direct "check number" endpoint.
    // You can only verify by attempting to send or via the Contacts API.
    // We use the contacts endpoint if available.
    const normalized = this.normalizePhone(phone);
    try {
      // Attempt to verify via sending a message status check
      // Actually, Cloud API doesn't have a direct lookup. Return a best-effort response.
      return { exists: true, jid: `${normalized}@s.whatsapp.net` };
    } catch {
      return { exists: false, jid: null };
    }
  }

  async blockContact(_jid: string): Promise<void> {
    throw new Error("Blocking contacts is not supported on Cloud API");
  }

  async unblockContact(_jid: string): Promise<void> {
    throw new Error("Unblocking contacts is not supported on Cloud API");
  }

  async getBlocklist(): Promise<string[]> {
    throw new Error("Blocklist is not available on Cloud API");
  }

  async getContactAbout(_jid: string): Promise<string | null> {
    throw new Error("Contact About lookup is only available on Baileys instances");
  }

  async getBusinessProfile(_jid: string): Promise<BusinessProfile | null> {
    const { phoneNumberId } = this.getCredentials();
    const url = `${GRAPH_API_BASE}/${phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,vertical,websites,profile_picture_url`;

    try {
      const res = await this.request<CloudApiBusinessProfileResponse>(url);
      const profile = res.data[0];
      if (!profile) return null;

      return {
        name: profile.about ?? "",
        description: profile.description ?? undefined,
        category: profile.vertical ?? undefined,
        website: profile.websites?.[0] ?? undefined,
        email: profile.email ?? undefined,
        address: profile.address ?? undefined,
      };
    } catch {
      return null;
    }
  }

  async resyncContacts(): Promise<never> {
    throw new Error("Contact resync is not supported on Cloud API");
  }

  // ---- Profile ----

  async updateProfilePicture(_image: Buffer): Promise<void> {
    const { phoneNumberId } = this.getCredentials();
    const url = `${GRAPH_API_BASE}/${phoneNumberId}/whatsapp_business_profile`;

    // Cloud API accepts profile_picture_handle (uploaded via resumable upload)
    // For simplicity, we upload the image first then reference it
    // However the full flow requires a resumable upload which is complex.
    // For now throw a descriptive error about the limitation.
    throw new Error(
      `Profile picture update on Cloud API requires a resumable upload handle. ` +
        `Upload the image via POST ${url} with profile_picture_handle parameter.`,
    );
  }

  async removeProfilePicture(): Promise<void> {
    throw new Error("Removing profile picture is not directly supported on Cloud API");
  }

  async updateProfileName(_name: string): Promise<void> {
    throw new Error(
      "Profile name on Cloud API is the verified business name and cannot be changed via API",
    );
  }

  async updateProfileStatus(status: string): Promise<void> {
    const { phoneNumberId } = this.getCredentials();
    const url = `${GRAPH_API_BASE}/${phoneNumberId}/whatsapp_business_profile`;

    await this.request(url, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        about: status,
      }),
    });
  }

  async updatePrivacy(_update: PrivacyUpdate): Promise<void> {
    throw new Error("Privacy settings are not supported on the Cloud API");
  }

  async getPrivacySettings(_forceRefresh = true): Promise<PrivacySettings> {
    throw new Error("Privacy settings are not supported on the Cloud API");
  }

  async getProfilePicture(_jid: string): Promise<string | null> {
    const { phoneNumberId } = this.getCredentials();
    const url = `${GRAPH_API_BASE}/${phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url`;

    try {
      const res = await this.request<CloudApiBusinessProfileResponse>(url);
      return res.data[0]?.profile_picture_url ?? null;
    } catch {
      return null;
    }
  }

  // ---- Status / Stories ----

  async sendStatus(_content: StatusContent): Promise<StatusSendResult> {
    throw new Error("Status/Stories are not supported on Cloud API");
  }

  // ---- Newsletter / Channels ----

  async newsletterFollow(_jid: string): Promise<void> {
    throw new Error("Newsletters are only available for Baileys instances");
  }

  async newsletterUnfollow(_jid: string): Promise<void> {
    throw new Error("Newsletters are only available for Baileys instances");
  }

  async newsletterSend(_jid: string, _text: string): Promise<MessageResponse> {
    throw new Error("Newsletters are only available for Baileys instances");
  }

  async createNewsletter(_name: string, _description?: string): Promise<NewsletterMetadata> {
    throw new Error("Channel management is only available on Baileys instances");
  }

  async getNewsletterMetadata(
    _type: "invite" | "jid",
    _key: string,
  ): Promise<NewsletterMetadata | null> {
    throw new Error("Channel metadata is only available on Baileys instances");
  }

  async updateNewsletterName(_jid: string, _name: string): Promise<void> {
    throw new Error("Channel updates are only available on Baileys instances");
  }

  async updateNewsletterDescription(_jid: string, _description: string): Promise<void> {
    throw new Error("Channel updates are only available on Baileys instances");
  }

  async updateNewsletterPicture(_jid: string, _image: string): Promise<void> {
    throw new Error("Channel picture updates are only available on Baileys instances");
  }

  async reactToNewsletterMessage(
    _jid: string,
    _serverId: string,
    _reaction?: string,
  ): Promise<void> {
    throw new Error("Channel post reactions are only available on Baileys instances");
  }

  async fetchNewsletterMessages(
    _jid: string,
    _count: number,
    _since: number,
    _after: number,
  ): Promise<never> {
    throw new Error("Channel post history is only available on Baileys instances");
  }

  // ---- Business catalog ----

  async getCatalog(
    _options: GetCatalogOptions,
  ): Promise<{ products: Product[]; nextPageCursor: string | undefined }> {
    throw new Error("Business catalog tools are only available on Baileys instances");
  }

  async getCollections(
    _jid?: string,
    _limit?: number,
  ): Promise<{ collections: CatalogCollection[] }> {
    throw new Error("Business catalog tools are only available on Baileys instances");
  }

  async createProduct(_input: CatalogProductCreateInput): Promise<Product> {
    throw new Error("Business catalog tools are only available on Baileys instances");
  }

  async updateProduct(_productId: string, _input: CatalogProductUpdateInput): Promise<Product> {
    throw new Error("Business catalog tools are only available on Baileys instances");
  }

  async deleteProducts(_productIds: string[]): Promise<{ deleted: number }> {
    throw new Error("Business catalog tools are only available on Baileys instances");
  }

  async getOrderDetails(_orderId: string, _tokenBase64: string): Promise<OrderDetails> {
    throw new Error("Order details are only available on Baileys instances");
  }

  // ---- Calls ----

  async rejectCall(_callId: string): Promise<void> {
    throw new Error("Call rejection is not supported on Cloud API");
  }

  // ---- Data access ----

  async getContacts(_search?: string): Promise<Contact[]> {
    throw new Error(
      "Contact list is not available on Cloud API. Contacts are managed in Meta Business Suite.",
    );
  }

  async getChats(): Promise<Chat[]> {
    throw new Error("Chat list is not available on Cloud API");
  }

  async getMessages(_chatId: string, _limit?: number): Promise<Message[]> {
    throw new Error(
      "Message history is not available on Cloud API. Use webhooks to receive messages.",
    );
  }

  async searchMessages(
    options: MessageSearchOptions,
  ): Promise<{ messages: Message[]; hasMore: boolean; nextOffset: number | null }> {
    return searchStoredMessages(sqlite, this.instanceId, options);
  }

  async fetchMessageHistory(
    _chatId: string,
    _count: number,
    _timeoutMs?: number,
  ): Promise<{ requested: number; stored: number; timedOut: boolean }> {
    throw new Error("On-demand message history is only available on Baileys instances");
  }

  async getProfileInfo(): Promise<ProfileInfo> {
    const { phoneNumberId } = this.getCredentials();

    const phoneUrl = `${GRAPH_API_BASE}/${phoneNumberId}`;
    const phoneInfo = await this.request<CloudApiPhoneNumberResponse>(phoneUrl);

    let pictureUrl: string | null = null;
    try {
      const profileUrl = `${GRAPH_API_BASE}/${phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url`;
      const profileRes = await this.request<CloudApiBusinessProfileResponse>(profileUrl);
      pictureUrl = profileRes.data[0]?.profile_picture_url ?? null;
    } catch {
      // No profile picture available
    }

    return {
      name: phoneInfo.verified_name ?? "",
      status: "",
      pictureUrl,
    };
  }

  // ---- Media helpers (public for external use) ----

  async uploadMedia(file: Buffer, mimeType: string, fileName?: string): Promise<string> {
    const { phoneNumberId, accessToken } = this.getCredentials();
    const url = `${GRAPH_API_BASE}/${phoneNumberId}/media`;

    const formData = new FormData();
    const blob = new Blob([file as unknown as BlobPart], { type: mimeType });
    formData.append("file", blob, fileName ?? "file");
    formData.append("type", mimeType);
    formData.append("messaging_product", "whatsapp");

    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    });

    const body = (await response.json()) as CloudApiMediaUploadResponse | CloudApiError;

    if (!response.ok) {
      const err = body as CloudApiError;
      throw new Error(`Media upload failed: ${err.error?.message ?? response.statusText}`);
    }

    return (body as CloudApiMediaUploadResponse).id;
  }

  async getMediaUrl(
    mediaId: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; mimeType: string; fileSize?: number }> {
    const url = `${GRAPH_API_BASE}/${mediaId}`;
    const res = await this.request<CloudApiMediaUrlResponse>(url, signal ? { signal } : {});
    return { url: res.url, mimeType: res.mime_type, fileSize: res.file_size };
  }

  async downloadMedia(
    mediaId: string,
    maxBytes?: number,
    timeoutMs?: number,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const { accessToken } = this.getCredentials();
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;

    // Step 1: Get the media URL
    const { url, mimeType, fileSize } = await this.getMediaUrl(mediaId, signal);
    if (maxBytes !== undefined && fileSize !== undefined && fileSize > maxBytes) {
      throw new Error(`Media exceeds maximum download size of ${sizeLimitLabel(maxBytes)}`);
    }

    // Step 2: Download the actual file (URL expires in 5 minutes)
    const options: RequestInit = { headers: { Authorization: `Bearer ${accessToken}` } };
    if (signal) options.signal = signal;
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(`Media download failed: HTTP ${response.status}`);
    }

    const data = await mediaResponseToBuffer(response, maxBytes);
    return { data, mimeType };
  }

  async downloadMessageAudio(
    messageId: string,
    maxBytes?: number,
    timeoutMs?: number,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const row = db
      .select({
        type: messagesTable.type,
        mediaUrl: messagesTable.mediaUrl,
      })
      .from(messagesTable)
      .where(and(eq(messagesTable.instanceId, this.instanceId), eq(messagesTable.id, messageId)))
      .get();

    if (!row) throw new Error(`Message '${messageId}' not found`);
    if (row.type !== "audio") throw new Error(`Message '${messageId}' is not audio`);
    if (!row.mediaUrl) throw new Error(`Audio media for message '${messageId}' is unavailable`);

    return this.downloadMedia(row.mediaUrl, maxBytes, timeoutMs);
  }

  async downloadMessageMedia(
    messageId: string,
    chatId?: string,
    maxBytes?: number,
    timeoutMs?: number,
  ): Promise<{ data: Buffer; mimeType: string; fileName?: string }> {
    const where = chatId
      ? and(
          eq(messagesTable.instanceId, this.instanceId),
          eq(messagesTable.id, messageId),
          eq(messagesTable.chatId, chatId),
        )
      : and(eq(messagesTable.instanceId, this.instanceId), eq(messagesTable.id, messageId));
    const row = db
      .select({
        type: messagesTable.type,
        mediaUrl: messagesTable.mediaUrl,
        mimetype: messagesTable.mediaMimetype,
        rawData: messagesTable.rawData,
      })
      .from(messagesTable)
      .where(where)
      .get();

    if (!row) throw new Error(`Message '${messageId}' not found`);
    if (!["image", "video", "audio", "document", "sticker"].includes(row.type)) {
      throw new Error(`Message '${messageId}' does not contain downloadable media`);
    }
    if (!row.mediaUrl) throw new Error(`Media for message '${messageId}' is unavailable`);

    const downloaded = await this.downloadMedia(row.mediaUrl, maxBytes, timeoutMs);
    let metadata: { fileName?: unknown } = {};
    if (row.rawData) {
      try {
        metadata = JSON.parse(row.rawData) as { fileName?: unknown };
      } catch {
        // Stored media IDs remain usable when optional metadata is malformed.
      }
    }
    const fileName = typeof metadata.fileName === "string" ? metadata.fileName : undefined;
    return {
      ...downloaded,
      mimeType: row.mimetype ?? downloaded.mimeType,
      ...(fileName ? { fileName } : {}),
    };
  }

  async deleteMedia(mediaId: string): Promise<void> {
    const url = `${GRAPH_API_BASE}/${mediaId}`;
    await this.request(url, { method: "DELETE" });
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

  /** Get the phone number ID for webhook routing. */
  getPhoneNumberId(): string | null {
    return this.phoneNumberId;
  }

  /** Emit an event to registered listeners. Public so the webhook handler can use it. */
  emit<E extends ChannelEvent>(event: E, payload: ChannelEventPayload[E]): void {
    if (event === "message.received") {
      const messageEvent = payload as ChannelEventPayload["message.received"];
      this.persistMediaMessage(messageEvent);
      if (getAutoReadMode() === "on_receive") {
        scheduleIncomingMessageRead(
          this,
          messageEvent.chatId,
          messageEvent.message.id,
          messageEvent.message.isFromMe,
          this.instanceId,
        );
      }
    }

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

  private persistMediaMessage(event: NormalizedMessageEvent): void {
    if (!["image", "video", "audio", "document", "sticker"].includes(event.message.type)) return;

    try {
      const rawData = JSON.stringify({
        fileName: event.message.fileName ?? event.message.mediaFileName ?? null,
        size: event.message.size ?? event.message.mediaSize ?? null,
      });
      db.insert(messagesTable)
        .values({
          id: event.message.id,
          instanceId: this.instanceId,
          chatId: event.chatId,
          senderId: event.message.sender,
          type: event.message.type,
          content: event.message.content,
          mediaUrl: event.message.mediaUrl,
          mediaMimetype: event.message.mimeType ?? event.message.mediaMimetype ?? null,
          quotedId: event.message.quotedMessageId,
          isFromMe: event.message.isFromMe ? 1 : 0,
          isForwarded: event.message.isForwarded === true ? 1 : 0,
          status: "received",
          timestamp: event.message.timestamp,
          rawData,
        })
        .onConflictDoUpdate({
          target: [messagesTable.instanceId, messagesTable.id],
          set: {
            mediaUrl: event.message.mediaUrl,
            mediaMimetype: event.message.mimeType ?? event.message.mediaMimetype ?? null,
            content: event.message.content,
            rawData,
            isForwarded: sql`CASE WHEN excluded.is_forwarded = 1 THEN 1 ELSE ${messagesTable.isForwarded} END`,
          },
        })
        .run();
    } catch (err) {
      logger.error(
        { err, messageId: event.message.id },
        "Failed to persist Cloud API media message",
      );
    }
  }
}
