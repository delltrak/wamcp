// ============================================================
// WA MCP — Channel Abstraction Types
// ============================================================

// Connection status for an instance
export type ConnectionStatus = "connected" | "disconnected" | "connecting" | "qr_pending";

// Channel type
export type ChannelType = "baileys" | "cloud";

// Presence status
export type PresenceStatus =
  "typing" | "composing" | "recording" | "paused" | "available" | "unavailable";

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
  | "sticker"
  | "event"
  | "album";

export interface BusinessLabel {
  id: string;
  name: string;
  color: number;
  deleted: boolean;
  predefinedId?: string;
}

export interface CatalogProductFields {
  name: string;
  retailerId?: string;
  url?: string;
  description: string;
  price: number;
  currency: string;
  isHidden?: boolean;
  images: string[];
}

export interface NewsletterReactionCount {
  code: string;
  count: number;
}

export interface NewsletterPost {
  id: string;
  serverId: string;
  timestamp: number | null;
  type: string | null;
  text: string | null;
  views: number | null;
  reactions: NewsletterReactionCount[];
}

export interface NewsletterPostsPage {
  posts: NewsletterPost[];
  pagination: {
    oldestServerId: string | null;
    newestServerId: string | null;
    after: number | null;
  };
}

export interface CatalogProductCreateInput extends CatalogProductFields {
  originCountryCode?: string;
}

export type CatalogProductUpdateInput = CatalogProductFields;

export interface MessageSearchOptions {
  query: string;
  from?: number;
  to?: number;
  sender?: string;
  chatId?: string;
  limit: number;
  offset: number;
}

export interface EventResponse {
  participant: string;
  responder: string;
  phone?: string;
  status: EventResponseStatus;
  response: string;
  timestamp: number | null;
  messageId: string | null;
  extraGuestCount?: number;
  unknownReason?: EventResponseUnknownReason;
  recoverable?: boolean;
  attemptedCombinations?: number;
}

export interface PollOptionResult {
  name: string;
  count: number;
  voters: string[];
}

export interface PollResults {
  chatId: string;
  messageId: string;
  question: string;
  options: PollOptionResult[];
  totalVotes: number;
  totalVoters: number;
}

export interface GroupJoinRequest {
  jid: string;
  attributes: Record<string, string>;
}

export type EventResponseStatus = "GOING" | "NOT_GOING" | "MAYBE" | "UNKNOWN";

export type EventResponseUnknownReason =
  | "missing_payload"
  | "missing_event_secret"
  | "decrypt_failed"
  | "decrypt_failed_all_candidates"
  | "unrecognized_response";

export interface SendEventOptions {
  to: string;
  name: string;
  description?: string;
  start: string;
  end?: string;
  locationText?: string;
  callType?: "voice" | "video";
  quotedMessageId?: string;
}

/** A display-safe action exposed by a business template or interactive message. */
export interface MessageButton {
  type: string;
  text: string;
  url?: string;
  id?: string;
  phone?: string;
}

// Message delivery status
export type MessageDeliveryStatus =
  "received" | "sent" | "delivered" | "read" | "played" | "revoked";

// Participant action in groups
export type ParticipantAction = "add" | "remove" | "promote" | "demote";

// Privacy setting values exposed by Baileys.
export type PrivacyValue = "all" | "contacts" | "contact_blacklist" | "none";
export type OnlinePrivacyValue = "all" | "match_last_seen";
export type ReadReceiptsPrivacyValue = "all" | "none";
export type GroupAddPrivacyValue = "all" | "contacts" | "contact_blacklist";
export type CallPrivacyValue = "all" | "known";
export type DefaultDisappearingModeDuration = 0 | 86400 | 604800 | 7776000;

export type PrivacyUpdate =
  | { setting: "lastSeen"; value: PrivacyValue }
  | { setting: "online"; value: OnlinePrivacyValue }
  | { setting: "profilePic"; value: PrivacyValue }
  | { setting: "status"; value: PrivacyValue }
  | { setting: "readReceipts"; value: ReadReceiptsPrivacyValue }
  | { setting: "groupAdd"; value: GroupAddPrivacyValue }
  | { setting: "calls"; value: CallPrivacyValue }
  | { setting: "defaultDisappearingMode"; value: DefaultDisappearingModeDuration };

// ---- Message Content Types ----

export interface TextContent {
  type: "text";
  text: string;
  quotedMessageId?: string;
  mentions?: string[];
  mentionAll?: boolean;
}

export interface ImageContent {
  type: "image";
  image: string; // URL or base64
  caption?: string;
  quotedMessageId?: string;
  mentions?: string[];
}

export interface VideoContent {
  type: "video";
  video: string; // URL or base64
  caption?: string;
  gifPlayback?: boolean;
  ptv?: boolean;
  quotedMessageId?: string;
  mentions?: string[];
}

export interface StickerContent {
  type: "sticker";
  sticker: string; // WebP base64
  animated?: boolean;
  quotedMessageId?: string;
}

export interface AudioContent {
  type: "audio";
  audio: string; // URL or base64
  ptt?: boolean; // voice note
  mimeType?: string;
  quotedMessageId?: string;
  mentions?: string[];
}

export interface DocumentContent {
  type: "document";
  document: string; // URL or base64
  fileName: string;
  mimeType: string;
  mentions?: string[];
}

export interface ButtonsContent {
  type: "buttons";
  text: string;
  footer?: string;
  buttons: Array<{ id: string; text: string }>;
}

export interface ListContent {
  type: "list";
  text: string;
  footer?: string;
  buttonText: string;
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;
}

export interface LocationContent {
  type: "location";
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
  isLive?: boolean;
  accuracyInMeters?: number;
  comment?: string;
}

export interface ContactCard {
  name: string;
  phone: string;
}

export type ContactContent =
  | { type: "contact"; contactName: string; contactPhone: string }
  | { type: "contact"; contacts: ContactCard[] };

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

export interface MessageReceipt {
  participant: string;
  status: "delivered" | "read" | "played";
  timestamp: number;
}

export interface MessageReaction {
  participant: string;
  emoji: string;
  timestamp: number;
}

export type MessageContent =
  | TextContent
  | ImageContent
  | VideoContent
  | StickerContent
  | AudioContent
  | DocumentContent
  | LocationContent
  | ContactContent
  | PollContent
  | ReactionContent
  | ButtonsContent
  | ListContent;

// ---- Response Types ----

export interface MessageResponse {
  messageId: string;
  timestamp: number;
  status: "queued" | "sent";
}

export interface LinkPreviewOptions {
  title?: string;
  description?: string;
  thumbnail?: string;
}

export interface GroupResponse {
  groupId: string;
  inviteCode?: string;
}

export interface CreateGroupFromGroupResponse {
  groupId: string;
  addedCount: number;
  failedParticipants: string[];
}

export interface GroupSummary {
  jid: string;
  subject: string;
  description: string | null;
  participantCount: number;
  isAdmin: boolean;
  isSuperAdmin: boolean;
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

export interface ContactResyncResult {
  contactsBefore: number;
  contactsAfter: number;
  added: number;
  sources: {
    appState: {
      collections: Array<{
        collection: string;
        success: boolean;
        contactsAdded: number;
        error?: string;
      }>;
    };
    localStore: {
      chats: { candidates: number; contactsAdded: number; error?: string };
      messages: { candidates: number; contactsAdded: number; error?: string };
    };
  };
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
  labels?: BusinessLabel[];
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  type: MessageType;
  content: string | null;
  mediaUrl: string | null;
  mediaMimetype?: string | null;
  mediaFileName?: string | null;
  mediaSize?: number | null;
  mimeType?: string | null;
  fileName?: string | null;
  size?: number | null;
  buttons?: MessageButton[];
  rawType?: string;
  quotedMessageId: string | null;
  isFromMe: boolean;
  isForwarded: boolean;
  status: MessageDeliveryStatus;
  timestamp: number;
  starred?: boolean;
  labels?: BusinessLabel[];
}

export interface GroupMetadata {
  jid: string;
  subject: string;
  description: string | null;
  owner: string | null;
  ownerJid: string | null;
  creation: number | null;
  participants: GroupParticipant[];
  participantCount: number;
  size: number;
  announce: boolean;
  restrict: boolean;
  isAnnounce: boolean;
  isLocked: boolean;
  ephemeralDuration: number | null;
  inviteCode: string | null;
  createdAt: number | null;
}

export interface GroupParticipant {
  jid: string;
  role: "admin" | "superadmin" | "member";
  phone: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  memberLabel?: string;
}

export interface NormalizedGroupMemberLabelEvent {
  instanceId: string;
  groupId: string;
  participant: string;
  memberLabel: string | null;
  action: "set" | "removed";
  timestamp: number;
}

export interface PrivacySettings {
  lastSeen: PrivacyValue | (string & {});
  online: OnlinePrivacyValue | (string & {});
  profilePic: PrivacyValue | (string & {});
  /** About/profile text visibility, as exposed by Baileys' status privacy category. */
  status: PrivacyValue | (string & {});
  readReceipts: ReadReceiptsPrivacyValue | (string & {});
  groupAdd: GroupAddPrivacyValue | (string & {});
  calls: CallPrivacyValue | (string & {});
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
  statusJidList?: string[];
  backgroundColor?: string;
  font?: number;
}

export interface StatusSendResult {
  /** Baileys message ID; pass this to wa_get_status_viewers to list observed viewers. */
  messageId: string;
  recipientCount: number;
  omittedRecipientCount: number;
  warning?: string;
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
  /** LID for this chat when WhatsApp also supplied a phone JID. */
  chatLid?: string;
  /** Optional display metadata used by outgoing integrations. */
  chatName?: string | null;
  senderName?: string | null;
  isGroup?: boolean;
  chatLabels?: BusinessLabel[];
  message: {
    id: string;
    sender: string;
    /** LID for the sender when WhatsApp also supplied another sender JID. */
    senderLid?: string;
    timestamp: number;
    type: MessageType;
    content: string | null;
    mediaUrl: string | null;
    mediaMimetype?: string;
    mediaFileName?: string;
    mediaSize?: number;
    mediaCaption?: string;
    mimeType?: string;
    fileName?: string;
    size?: number;
    caption?: string;
    buttons?: MessageButton[];
    rawType?: string;
    transcription?: string;
    labels?: BusinessLabel[];
    quotedMessageId: string | null;
    isFromMe: boolean;
    isForwarded?: boolean;
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

export type InstanceAuthMethod = "pairing_code" | "qr";

export interface InstanceConnectedEvent {
  instanceId: string;
  phone: string | null;
  lid: string | null;
  pushName: string | null;
  connectedAt: number;
  wasPairing: boolean;
}

export interface InstanceDisconnectedEvent {
  instanceId: string;
  reason: string;
  statusCode: number | null;
  loggedOut: boolean;
  willReconnect: boolean;
  reconnectInMs?: number;
  disconnectedAt: number;
  offlineSinceMs?: number;
}

export interface InstanceAuthChallengeGeneratedEvent {
  instanceId: string;
  method: InstanceAuthMethod;
  generatedAt: number;
  expiresAt: number;
}

export interface InstanceAuthChallengeExpiredEvent {
  instanceId: string;
  method: InstanceAuthMethod;
  generatedAt: number;
  expiredAt: number;
}

export interface InstanceRuntimeStatus {
  phone: string | null;
  lid: string | null;
  pushName: string | null;
  disconnectReason: string | null;
  disconnectStatusCode: number | null;
  pendingChallenge: {
    method: InstanceAuthMethod;
    generatedAt: number;
    expiresAt: number;
  } | null;
  presenceMode: string | null;
}

export interface NormalizedCallEvent {
  instanceId: string;
  chatId: string;
  callerId: string;
  isVideo: boolean;
  isGroup?: boolean;
  callId: string;
  timestamp: number;
  status:
    | "offer"
    | "ringing"
    | "preaccept"
    | "transport"
    | "relaylatency"
    | "timeout"
    | "reject"
    | "accept"
    | "terminate";
}

export interface NormalizedLabelUpdateEvent {
  instanceId: string;
  action: "edited" | "associated" | "disassociated";
  label: BusinessLabel;
  chatId?: string;
  association?: {
    type: "chat" | "message";
    chatId: string;
    messageId?: string;
  };
}

export interface NormalizedEventResponseEvent {
  instanceId: string;
  chatId: string;
  eventMessageId: string;
  participant: string;
  responseMessageId: string | null;
  status: EventResponseStatus;
  timestamp: number | null;
  extraGuestCount?: number;
}

// Keep the runtime event list and compile-time union together so subscribers do not drift.
export const CHANNEL_EVENTS = [
  "message.received",
  "message.updated",
  "message.deleted",
  "message.reaction",
  "message.edited",
  "presence.updated",
  "chat.updated",
  "group.updated",
  "group.participants_changed",
  "group.member_label_changed",
  "contact.updated",
  "connection.changed",
  "instance.connected",
  "instance.disconnected",
  "instance.pairing_code_generated",
  "instance.qr_generated",
  "instance.pairing_expired",
  "instance.qr_expired",
  "call.received",
  "label.updated",
  "event.response",
] as const;

export type ChannelEvent = (typeof CHANNEL_EVENTS)[number];

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
  "group.member_label_changed": NormalizedGroupMemberLabelEvent;
  "contact.updated": NormalizedContactUpdateEvent;
  "connection.changed": NormalizedConnectionEvent;
  "instance.connected": InstanceConnectedEvent;
  "instance.disconnected": InstanceDisconnectedEvent;
  "instance.pairing_code_generated": InstanceAuthChallengeGeneratedEvent;
  "instance.qr_generated": InstanceAuthChallengeGeneratedEvent;
  "instance.pairing_expired": InstanceAuthChallengeExpiredEvent;
  "instance.qr_expired": InstanceAuthChallengeExpiredEvent;
  "call.received": NormalizedCallEvent;
  "label.updated": NormalizedLabelUpdateEvent;
  "event.response": NormalizedEventResponseEvent;
};
