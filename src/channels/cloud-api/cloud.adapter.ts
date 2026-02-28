// ============================================================
// WA MCP — Cloud API Adapter (STUB — Phase 4)
// Placeholder implementation. All methods throw
// "Cloud API not implemented — Phase 4".
// ============================================================

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
} from "../../types/channel.types.js";

const NOT_IMPLEMENTED = "Cloud API not implemented — Phase 4";

export class CloudApiAdapter implements ChannelAdapter {
  constructor(private readonly instanceId: string) {}

  async connect(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async disconnect(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  getStatus(): ConnectionStatus {
    return "disconnected";
  }

  async getQrCode(): Promise<string | null> {
    throw new Error("QR code is only available for Baileys instances");
  }
  async getPairingCode(_phone: string): Promise<string | null> {
    throw new Error("Pairing code is only available for Baileys instances");
  }
  async setCredentials(_creds: CloudCredentials): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async sendMessage(_to: string, _content: MessageContent): Promise<MessageResponse> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async editMessage(_chatId: string, _msgId: string, _newText: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async deleteMessage(_chatId: string, _msgId: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async forwardMessage(_to: string, _msgId: string, _fromChat: string): Promise<MessageResponse> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async sendReaction(_chatId: string, _msgId: string, _emoji: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async pinMessage(_chatId: string, _msgId: string, _pin: boolean): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async sendViewOnce(
    _to: string,
    _media: string,
    _type: "image" | "video",
  ): Promise<MessageResponse> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async sendLinkPreview(_to: string, _text: string, _url: string): Promise<MessageResponse> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async sendPresence(
    _chatId: string,
    _status: "composing" | "recording" | "paused" | "available" | "unavailable",
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async markRead(_chatId: string, _messageIds: string[]): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async modifyChat(_chatId: string, _modification: ChatModification): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async createGroup(_name: string, _participants: string[]): Promise<GroupResponse> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async modifyGroup(_groupId: string, _modification: GroupModification): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async modifyParticipants(
    _groupId: string,
    _participants: string[],
    _action: ParticipantAction,
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getGroupMetadata(_groupId: string): Promise<GroupMetadata> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getGroupInviteCode(_groupId: string): Promise<string> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async joinGroup(_inviteCode: string): Promise<string> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async handleJoinRequest(
    _groupId: string,
    _participantJid: string,
    _action: "approve" | "reject",
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async checkNumberExists(_phone: string): Promise<NumberExistsResponse> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async blockContact(_jid: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async unblockContact(_jid: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getBlocklist(): Promise<string[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getBusinessProfile(_jid: string): Promise<BusinessProfile | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async updateProfilePicture(_image: Buffer): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async removeProfilePicture(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async updateProfileName(_name: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async updateProfileStatus(_status: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async updatePrivacy(_setting: PrivacySetting, _value: PrivacyValue): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getPrivacySettings(): Promise<PrivacySettings> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getProfilePicture(_jid: string): Promise<string | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async sendStatus(_content: StatusContent): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async newsletterFollow(_jid: string): Promise<void> {
    throw new Error("Newsletters are only available for Baileys instances");
  }
  async newsletterUnfollow(_jid: string): Promise<void> {
    throw new Error("Newsletters are only available for Baileys instances");
  }
  async newsletterSend(_jid: string, _text: string): Promise<MessageResponse> {
    throw new Error("Newsletters are only available for Baileys instances");
  }

  async rejectCall(_callId: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getContacts(): Promise<Contact[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getChats(): Promise<Chat[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getMessages(_chatId: string, _limit?: number): Promise<Message[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getProfileInfo(): Promise<ProfileInfo> {
    throw new Error(NOT_IMPLEMENTED);
  }

  on<E extends ChannelEvent>(_event: E, _handler: ChannelEventHandler<E>): void {
    /* no-op */
  }
  off<E extends ChannelEvent>(_event: E, _handler: ChannelEventHandler<E>): void {
    /* no-op */
  }
}
