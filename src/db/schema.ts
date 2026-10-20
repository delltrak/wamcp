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
  lastDisconnectReason: text("last_disconnect_reason"),
  lastDisconnectStatusCode: integer("last_disconnect_status_code"),
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
        "event",
        "album",
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
      enum: ["received", "sent", "delivered", "read", "played", "revoked"],
    })
      .notNull()
      .default("received"),
    timestamp: integer("timestamp").notNull(),
    pushName: text("push_name"),
    rawData: text("raw_data"),
    starred: integer("starred").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.id] }),
    index("idx_messages_chat").on(table.instanceId, table.chatId, table.timestamp),
    index("idx_messages_timestamp").on(table.instanceId, table.timestamp),
  ],
);

// ============================================================
// STATUS AUDIENCES
// Recipients for sent status stories, used to distribute revocations
// ============================================================
export const statusAudiences = sqliteTable(
  "status_audiences",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    recipientJids: text("recipient_jids").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.messageId] })],
);

// Participant-level delivery information, including viewers of status stories.
export const messageReceipts = sqliteTable(
  "message_receipts",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    messageId: text("message_id").notNull(),
    participant: text("participant").notNull(),
    status: text("status", { enum: ["delivered", "read", "played"] }).notNull(),
    timestamp: integer("timestamp").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.chatId, table.messageId, table.participant] }),
    index("idx_message_receipts_message").on(table.instanceId, table.chatId, table.messageId),
  ],
);

export const messageReactions = sqliteTable(
  "message_reactions",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    messageId: text("message_id").notNull(),
    participant: text("participant").notNull(),
    emoji: text("emoji").notNull(),
    timestamp: integer("timestamp").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.chatId, table.messageId, table.participant] }),
    index("idx_message_reactions_message").on(table.instanceId, table.chatId, table.messageId),
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
    nameSource: text("name_source"),
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
// GROUP MEMBER LABELS
// Latest labels observed from WhatsApp group protocol messages
// ============================================================
export const groupMemberLabels = sqliteTable(
  "group_member_labels",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    groupJid: text("group_jid").notNull(),
    participantJid: text("participant_jid").notNull(),
    memberLabel: text("member_label"),
    labelTimestamp: integer("label_timestamp").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.groupJid, table.participantJid] })],
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
// BUSINESS LABELS
// ============================================================
export const labels = sqliteTable(
  "labels",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    id: text("label_id").notNull(),
    name: text("name").notNull(),
    color: integer("color").notNull(),
    deleted: integer("deleted").notNull().default(0),
    predefinedId: text("predefined_id"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.id] })],
);

export const labelAssociations = sqliteTable(
  "label_associations",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    labelId: text("label_id").notNull(),
    type: text("association_type", { enum: ["chat", "message"] }).notNull(),
    chatId: text("chat_id").notNull(),
    messageId: text("message_id").notNull().default(""),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.instanceId, table.labelId, table.type, table.chatId, table.messageId],
    }),
    index("idx_label_associations_chat").on(table.instanceId, table.chatId, table.type),
    index("idx_label_associations_message").on(
      table.instanceId,
      table.chatId,
      table.messageId,
      table.type,
    ),
  ],
);

export const eventResponses = sqliteTable(
  "event_responses",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    eventMessageId: text("event_message_id").notNull(),
    chatId: text("chat_id").notNull(),
    responder: text("responder").notNull(),
    response: text("response").notNull(),
    timestamp: integer("timestamp"),
    extraGuestCount: integer("extra_guest_count"),
    responseMessageId: text("response_message_id"),
    rawData: text("raw_data"),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.eventMessageId, table.responder] }),
    index("idx_event_responses_chat").on(table.instanceId, table.chatId, table.eventMessageId),
  ],
);

export const pendingPollVotes = sqliteTable(
  "pending_poll_votes",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    pollMessageId: text("poll_message_id").notNull(),
    voteMessageId: text("vote_message_id").notNull(),
    rawData: text("raw_data").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.pollMessageId, table.voteMessageId] }),
    index("idx_pending_poll_votes_poll").on(table.instanceId, table.pollMessageId),
  ],
);

// ============================================================
// SCHEDULED MESSAGES
// One-shot and recurring outbound sends. Lives in the existing database file.
// Runtime DDL declares millisecond timestamps and seq as BIGINT (64-bit on
// both SQLite and Postgres). Drizzle's SQLite integer column is that same
// 64-bit storage; migration 0004 spells those columns as bigint.
// ============================================================
export const scheduledMessages = sqliteTable(
  "scheduled_messages",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    recipient: text("recipient").notNull(),
    messageType: text("message_type", {
      enum: ["text", "image", "video", "audio", "document", "sticker"],
    }).notNull(),
    payloadJson: text("payload_json").notNull(),
    timezone: text("timezone").notNull(),
    recurrence: text("recurrence", {
      enum: ["once", "daily", "weekly", "monthly"],
    }).notNull(),
    scheduledAt: integer("scheduled_at").notNull(),
    nextRunAt: integer("next_run_at").notNull(),
    weekdaysJson: text("weekdays_json"),
    dayOfMonth: integer("day_of_month"),
    endAt: integer("end_at"),
    occurrenceLimit: integer("occurrence_limit"),
    occurrenceCount: integer("occurrence_count").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    status: text("status", {
      enum: ["active", "paused", "running", "completed", "cancelled", "failed", "skipped"],
    }).notNull(),
    leaseToken: text("lease_token"),
    leaseUntil: integer("lease_until"),
    lastRunAt: integer("last_run_at"),
    lastJobId: text("last_job_id"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    seq: integer("seq").notNull().default(0),
  },
  (table) => [
    index("idx_scheduled_messages_due_v2").on(
      table.status,
      table.nextRunAt,
      table.createdAt,
      table.seq,
    ),
    index("idx_scheduled_messages_instance").on(table.instanceId, table.status),
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
