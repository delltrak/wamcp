// ============================================================
// WA MCP — Channel Abstraction Types
// ============================================================

// Connection status for an instance
export type ConnectionStatus = "connected" | "disconnected" | "connecting" | "qr_pending";

// Channel type
export type ChannelType = "baileys" | "cloud";

// Presence status
export type PresenceStatus = "composing" | "recording" | "paused" | "available" | "unavailable";

// Message types
export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "location"
  | "contact"
  | "poll"
  | "reaction"
  | "sticker";

// Message delivery status
export type MessageDeliveryStatus = "received" | "sent" | "delivered" | "read" | "played";

// Participant action in groups
export type ParticipantAction = "add" | "remove" | "promote" | "demote";

// Privacy setting keys
export type PrivacySetting =
  | "lastSeen"
  | "online"
  | "profilePic"
  | "status"
  | "readReceipts"
  | "groupAdd";

// Privacy setting values
export type PrivacyValue = "all" | "contacts" | "contact_blacklist" | "none";

// ---- Message Content Types ----

export interface TextContent {
  type: "text";
  text: string;
  quotedMessageId?: string;
}

export interface ImageContent {
  type: "image";
  image: string; // URL or base64
  caption?: string;
  quotedMessageId?: string;
}

export interface VideoContent {
  type: "video";
  video: string; // URL or base64
  caption?: string;
  quotedMessageId?: string;
}

export interface AudioContent {
  type: "audio";
  audio: string; // URL or base64
  ptt?: boolean; // voice note
}

export interface DocumentContent {
  type: "document";
  document: string; // URL or base64
  fileName: string;
  mimeType: string;
}

export interface LocationContent {
  type: "location";
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export interface ContactContent {
  type: "contact";
  contactName: string;
  contactPhone: string;
}

export interface PollContent {
  type: "poll";
  question: string;
  options: string[];
  multiSelect?: boolean;
}

export interface ReactionContent {
  type: "reaction";
  emoji: string;
}

export type MessageContent =
  | TextContent
  | ImageContent
  | VideoContent
  | AudioContent
  | DocumentContent
  | LocationContent
  | ContactContent
  | PollContent
  | ReactionContent;

// ---- Response Types ----

export interface MessageResponse {
  messageId: string;
  timestamp: number;
  status: "queued" | "sent";
}

export interface GroupResponse {
  groupId: string;
  inviteCode?: string;
}

export interface NumberExistsResponse {
  exists: boolean;
  jid: string | null;
}

export interface BusinessProfile {
  name: string;
  description?: string;
  category?: string;
  website?: string;
  email?: string;
  address?: string;
}

export interface ProfileInfo {
  name: string;
  status: string;
  pictureUrl: string | null;
}

export interface Contact {
  jid: string;
  name: string | null;
  notifyName: string | null;
  phone: string | null;
  profilePicUrl: string | null;
  isBusiness: boolean;
  isBlocked: boolean;
}

export interface Chat {
  jid: string;
  name: string | null;
  isGroup: boolean;
  unreadCount: number;
  isPinned: boolean;
  isMuted: boolean;
  isArchived: boolean;
  lastMessageAt: number | null;
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  type: MessageType;
  content: string | null;
  mediaUrl: string | null;
  quotedMessageId: string | null;
  isFromMe: boolean;
  isForwarded: boolean;
  status: MessageDeliveryStatus;
  timestamp: number;
}

export interface GroupMetadata {
  jid: string;
  subject: string;
  description: string | null;
  ownerJid: string | null;
  participants: GroupParticipant[];
  participantCount: number;
  isAnnounce: boolean;
  isLocked: boolean;
  ephemeralDuration: number | null;
  inviteCode: string | null;
  createdAt: number | null;
}

export interface GroupParticipant {
  jid: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface PrivacySettings {
  lastSeen: PrivacyValue;
  online: PrivacyValue;
  profilePic: PrivacyValue;
  status: PrivacyValue;
  readReceipts: PrivacyValue;
  groupAdd: PrivacyValue;
}

// ---- Chat/Group Modification Types ----

export interface ChatModification {
  action: "archive" | "unarchive" | "pin" | "unpin" | "mute" | "unmute" | "delete" | "clear";
  muteUntil?: number;
}

export interface GroupModification {
  action:
    | "updateSubject"
    | "updateDescription"
    | "updateSettings"
    | "leave"
    | "revokeInvite"
    | "toggleEphemeral";
  value?: string | number | boolean;
}

export interface StatusContent {
  type: "text" | "image" | "video";
  text?: string;
  media?: string; // URL or base64
  caption?: string;
  backgroundColor?: string;
  font?: number;
}

export interface CloudCredentials {
  accessToken: string;
  phoneNumberId: string;
  businessId?: string;
}

// ---- Normalized Event Types ----

export interface NormalizedMessageEvent {
  instanceId: string;
  chatId: string;
  message: {
    id: string;
    sender: string;
    timestamp: number;
    type: MessageType;
    content: string | null;
    mediaUrl: string | null;
    quotedMessageId: string | null;
    isFromMe: boolean;
  };
}

export interface NormalizedMessageUpdateEvent {
  instanceId: string;
  chatId: string;
  messageId: string;
  status: MessageDeliveryStatus;
}

export interface NormalizedMessageDeleteEvent {
  instanceId: string;
  chatId: string;
  messageId: string;
  deletedBy: string;
}

export interface NormalizedMessageReactionEvent {
  instanceId: string;
  chatId: string;
  messageId: string;
  emoji: string;
  reactedBy: string;
}

export interface NormalizedMessageEditEvent {
  instanceId: string;
  chatId: string;
  messageId: string;
  newContent: string;
  editedAt: number;
}

export interface NormalizedPresenceEvent {
  instanceId: string;
  chatId: string;
  participant: string;
  status: PresenceStatus;
}

export interface NormalizedChatUpdateEvent {
  instanceId: string;
  chatId: string;
  changes: Record<string, unknown>;
}

export interface NormalizedGroupUpdateEvent {
  instanceId: string;
  groupId: string;
  changes: Record<string, unknown>;
}

export interface NormalizedGroupParticipantsEvent {
  instanceId: string;
  groupId: string;
  action: ParticipantAction;
  participants: string[];
}

export interface NormalizedContactUpdateEvent {
  instanceId: string;
  contactId: string;
  changes: Record<string, unknown>;
}

export interface NormalizedConnectionEvent {
  instanceId: string;
  status: "open" | "close" | "connecting";
  qrCode?: string;
  pairingCode?: string;
}

export interface NormalizedCallEvent {
  instanceId: string;
  callerId: string;
  isVideo: boolean;
  callId: string;
}

// Channel event names
export type ChannelEvent =
  | "message.received"
  | "message.updated"
  | "message.deleted"
  | "message.reaction"
  | "message.edited"
  | "presence.updated"
  | "chat.updated"
  | "group.updated"
  | "group.participants_changed"
  | "contact.updated"
  | "connection.changed"
  | "call.received";

// Event payload map
export type ChannelEventPayload = {
  "message.received": NormalizedMessageEvent;
  "message.updated": NormalizedMessageUpdateEvent;
  "message.deleted": NormalizedMessageDeleteEvent;
  "message.reaction": NormalizedMessageReactionEvent;
  "message.edited": NormalizedMessageEditEvent;
  "presence.updated": NormalizedPresenceEvent;
  "chat.updated": NormalizedChatUpdateEvent;
  "group.updated": NormalizedGroupUpdateEvent;
  "group.participants_changed": NormalizedGroupParticipantsEvent;
  "contact.updated": NormalizedContactUpdateEvent;
  "connection.changed": NormalizedConnectionEvent;
  "call.received": NormalizedCallEvent;
};
