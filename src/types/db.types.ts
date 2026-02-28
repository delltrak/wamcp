// ============================================================
// WA MCP — Database Entity Type Helpers
// ============================================================

import type {
  ChannelType,
  ConnectionStatus,
  MessageDeliveryStatus,
  MessageType,
} from "./channel.types.js";

// Instance entity
export interface InstanceEntity {
  id: string;
  name: string;
  channel: ChannelType;
  phoneNumber: string | null;
  status: ConnectionStatus;
  waVersion: string | null;
  cloudAccessToken: string | null;
  cloudPhoneNumberId: string | null;
  cloudBusinessId: string | null;
  createdAt: number;
  updatedAt: number;
  lastConnected: number | null;
  lastDisconnected: number | null;
}

// Auth key entity
export interface AuthKeyEntity {
  instanceId: string;
  keyId: string;
  keyData: string;
}

// Message entity
export interface MessageEntity {
  id: string;
  instanceId: string;
  chatId: string;
  senderId: string;
  type: MessageType;
  content: string | null;
  mediaUrl: string | null;
  mediaLocal: string | null;
  mediaMimetype: string | null;
  quotedId: string | null;
  isFromMe: boolean;
  isForwarded: boolean;
  status: MessageDeliveryStatus;
  timestamp: number;
  rawData: string | null;
}

// Processed message entity (dedup)
export interface ProcessedMessageEntity {
  messageId: string;
  instanceId: string;
  processedAt: number;
}

// Contact entity
export interface ContactEntity {
  instanceId: string;
  jid: string;
  name: string | null;
  notifyName: string | null;
  phone: string | null;
  profilePicUrl: string | null;
  isBusiness: boolean;
  isBlocked: boolean;
  updatedAt: number;
}

// Group cache entity
export interface GroupCacheEntity {
  instanceId: string;
  jid: string;
  subject: string | null;
  description: string | null;
  ownerJid: string | null;
  participants: string; // JSON
  participantCount: number;
  isAnnounce: boolean;
  isLocked: boolean;
  ephemeralDuration: number | null;
  inviteCode: string | null;
  createdAt: number | null;
  updatedAt: number;
}

// Chat entity
export interface ChatEntity {
  instanceId: string;
  jid: string;
  name: string | null;
  isGroup: boolean;
  unreadCount: number;
  isPinned: boolean;
  isMuted: boolean;
  muteUntil: number | null;
  isArchived: boolean;
  lastMessageId: string | null;
  lastMessageAt: number | null;
  updatedAt: number;
}

// WA version cache entity
export interface WaVersionCacheEntity {
  id: number;
  versionJson: string;
  fetchedAt: number;
  isLatest: boolean;
}

// Queue stats entity
export interface QueueStatsEntity {
  instanceId: string;
  messagesSent: number;
  messagesFailed: number;
  lastSentAt: number | null;
  rateLimitedUntil: number | null;
}
