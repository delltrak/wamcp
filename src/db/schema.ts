// ============================================================
// WA MCP — Drizzle ORM Schema Definitions
// ============================================================

import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

// ============================================================
// INSTANCES
// Core entity: each instance = one WhatsApp number connection
// ============================================================
export const instances = sqliteTable("instances", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  channel: text("channel", { enum: ["baileys", "cloud"] })
    .notNull()
    .default("baileys"),
  phoneNumber: text("phone_number"),
  status: text("status", {
    enum: ["connected", "disconnected", "connecting", "qr_pending"],
  })
    .notNull()
    .default("disconnected"),
  waVersion: text("wa_version"),

  // Cloud API specific
  cloudAccessToken: text("cloud_access_token"),
  cloudPhoneNumberId: text("cloud_phone_number_id"),
  cloudBusinessId: text("cloud_business_id"),

  // Metadata
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastConnected: integer("last_connected"),
  lastDisconnected: integer("last_disconnected"),
});

// ============================================================
// AUTH KEYS
// Baileys session persistence (Signal protocol keys)
// ============================================================
export const authKeys = sqliteTable(
  "auth_keys",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    keyId: text("key_id").notNull(),
    keyData: text("key_data").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.keyId] }),
    index("idx_auth_keys_instance").on(table.instanceId),
  ],
);

// ============================================================
// MESSAGES
// Message store for agent context and history
// ============================================================
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").notNull(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    senderId: text("sender_id").notNull(),
    type: text("type", {
      enum: [
        "text",
        "image",
        "video",
        "audio",
        "document",
        "location",
        "contact",
        "poll",
        "reaction",
        "sticker",
      ],
    }).notNull(),
    content: text("content"),
    mediaUrl: text("media_url"),
    mediaLocal: text("media_local"),
    mediaMimetype: text("media_mimetype"),
    quotedId: text("quoted_id"),
    isFromMe: integer("is_from_me").notNull().default(0),
    isForwarded: integer("is_forwarded").notNull().default(0),
    status: text("status", {
      enum: ["received", "sent", "delivered", "read", "played"],
    })
      .notNull()
      .default("received"),
    timestamp: integer("timestamp").notNull(),
    rawData: text("raw_data"),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.id] }),
    index("idx_messages_chat").on(table.instanceId, table.chatId, table.timestamp),
    index("idx_messages_timestamp").on(table.instanceId, table.timestamp),
  ],
);

// ============================================================
// PROCESSED MESSAGES
// Deduplication: track which messages have been processed
// ============================================================
export const processedMessages = sqliteTable(
  "processed_messages",
  {
    messageId: text("message_id").notNull(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    processedAt: integer("processed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.messageId] })],
);

// ============================================================
// CONTACTS
// Cached contact information
// ============================================================
export const contacts = sqliteTable(
  "contacts",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    name: text("name"),
    notifyName: text("notify_name"),
    phone: text("phone"),
    lid: text("lid"),
    profilePicUrl: text("profile_pic_url"),
    isBusiness: integer("is_business").notNull().default(0),
    isBlocked: integer("is_blocked").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.jid] }),
    index("idx_contacts_phone").on(table.instanceId, table.phone),
    index("idx_contacts_lid").on(table.instanceId, table.lid),
  ],
);

// ============================================================
// GROUPS CACHE
// Cached group metadata
// ============================================================
export const groupsCache = sqliteTable(
  "groups_cache",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    subject: text("subject"),
    description: text("description"),
    ownerJid: text("owner_jid"),
    participants: text("participants").notNull().default("[]"),
    participantCount: integer("participant_count").notNull().default(0),
    isAnnounce: integer("is_announce").notNull().default(0),
    isLocked: integer("is_locked").notNull().default(0),
    ephemeralDuration: integer("ephemeral_duration"),
    inviteCode: text("invite_code"),
    createdAt: integer("created_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.jid] })],
);

// ============================================================
// CHATS
// Cached chat list with metadata
// ============================================================
export const chats = sqliteTable(
  "chats",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    name: text("name"),
    isGroup: integer("is_group").notNull().default(0),
    unreadCount: integer("unread_count").notNull().default(0),
    isPinned: integer("is_pinned").notNull().default(0),
    isMuted: integer("is_muted").notNull().default(0),
    muteUntil: integer("mute_until"),
    isArchived: integer("is_archived").notNull().default(0),
    lastMessageId: text("last_message_id"),
    lastMessageAt: integer("last_message_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.jid] }),
    index("idx_chats_recent").on(table.instanceId, table.lastMessageAt),
  ],
);

// ============================================================
// VERSION CACHE
// WhatsApp Web version auto-update (daily check)
// ============================================================
export const waVersionCache = sqliteTable("wa_version_cache", {
  id: integer("id").primaryKey().default(1),
  versionJson: text("version_json").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
  isLatest: integer("is_latest").notNull().default(1),
});

// ============================================================
// QUEUE STATS
// Track outbound message queue state for monitoring
// ============================================================
export const queueStats = sqliteTable("queue_stats", {
  instanceId: text("instance_id")
    .primaryKey()
    .references(() => instances.id, { onDelete: "cascade" }),
  messagesSent: integer("messages_sent").notNull().default(0),
  messagesFailed: integer("messages_failed").notNull().default(0),
  lastSentAt: integer("last_sent_at"),
  rateLimitedUntil: integer("rate_limited_until"),
});
