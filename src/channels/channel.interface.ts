// ============================================================
// WA MCP — Channel Adapter Interface
// All channel implementations (Baileys, Cloud API) must
// implement this interface to provide a unified API surface.
// ============================================================

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
} from "../types/channel.types.js";

// Typed event handler
export type ChannelEventHandler<E extends ChannelEvent = ChannelEvent> = (
  payload: ChannelEventPayload[E],
) => void;

export interface ChannelAdapter {
  // ---- Lifecycle ----
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;

  // ---- Authentication ----
  getQrCode(): Promise<string | null>;
  getPairingCode(phone: string): Promise<string | null>;
  setCredentials(creds: CloudCredentials): Promise<void>;

  // ---- Messaging ----
  sendMessage(to: string, content: MessageContent): Promise<MessageResponse>;
  editMessage(chatId: string, msgId: string, newText: string): Promise<void>;
  deleteMessage(chatId: string, msgId: string): Promise<void>;
  forwardMessage(to: string, msgId: string, fromChat: string): Promise<MessageResponse>;
  sendReaction(chatId: string, msgId: string, emoji: string): Promise<void>;
  pinMessage(chatId: string, msgId: string, pin: boolean): Promise<void>;
  sendViewOnce(to: string, media: string, type: "image" | "video"): Promise<MessageResponse>;
  sendLinkPreview(to: string, text: string, url: string): Promise<MessageResponse>;

  // ---- Presence ----
  sendPresence(
    chatId: string,
    status: "composing" | "recording" | "paused" | "available" | "unavailable",
  ): Promise<void>;
  markRead(chatId: string, messageIds: string[]): Promise<void>;

  // ---- Chats ----
  modifyChat(chatId: string, modification: ChatModification): Promise<void>;

  // ---- Groups ----
  createGroup(name: string, participants: string[]): Promise<GroupResponse>;
  modifyGroup(groupId: string, modification: GroupModification): Promise<void>;
  modifyParticipants(
    groupId: string,
    participants: string[],
    action: ParticipantAction,
  ): Promise<void>;
  getGroupMetadata(groupId: string): Promise<GroupMetadata>;
  getGroupInviteCode(groupId: string): Promise<string>;
  joinGroup(inviteCode: string): Promise<string>;
  handleJoinRequest(
    groupId: string,
    participantJid: string,
    action: "approve" | "reject",
  ): Promise<void>;

  // ---- Contacts ----
  checkNumberExists(phone: string): Promise<NumberExistsResponse>;
  blockContact(jid: string): Promise<void>;
  unblockContact(jid: string): Promise<void>;
  getBlocklist(): Promise<string[]>;
  getBusinessProfile(jid: string): Promise<BusinessProfile | null>;

  // ---- Profile ----
  updateProfilePicture(image: Buffer): Promise<void>;
  removeProfilePicture(): Promise<void>;
  updateProfileName(name: string): Promise<void>;
  updateProfileStatus(status: string): Promise<void>;
  updatePrivacy(setting: PrivacySetting, value: PrivacyValue): Promise<void>;
  getPrivacySettings(): Promise<PrivacySettings>;
  getProfilePicture(jid: string): Promise<string | null>;

  // ---- Status / Stories ----
  sendStatus(content: StatusContent): Promise<void>;

  // ---- Newsletter / Channels ----
  newsletterFollow(jid: string): Promise<void>;
  newsletterUnfollow(jid: string): Promise<void>;
  newsletterSend(jid: string, text: string): Promise<MessageResponse>;

  // ---- Calls ----
  rejectCall(callId: string): Promise<void>;

  // ---- Data access ----
  getContacts(search?: string): Promise<Contact[]>;
  getChats(): Promise<Chat[]>;
  getMessages(chatId: string, limit?: number): Promise<Message[]>;
  getProfileInfo(): Promise<ProfileInfo>;

  // ---- Events ----
  on<E extends ChannelEvent>(event: E, handler: ChannelEventHandler<E>): void;
  off<E extends ChannelEvent>(event: E, handler: ChannelEventHandler<E>): void;
}
