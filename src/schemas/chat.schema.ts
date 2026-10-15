// ============================================================
// WA MCP — Chat Management Zod Schemas
// ============================================================

import { z } from "zod";

export const ArchiveChatSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID to archive or unarchive"),
    archive: z.boolean().describe("true to archive, false to unarchive"),
  })
  .strict();

export const PinChatSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID to pin or unpin"),
    pin: z.boolean().describe("true to pin, false to unpin"),
  })
  .strict();

export const MuteChatSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID to mute or unmute"),
    mute: z.boolean().describe("true to mute, false to unmute"),
    muteUntil: z
      .number()
      .optional()
      .describe("Unix timestamp (ms) when the mute expires (required if mute=true)"),
  })
  .strict();

export const DeleteChatSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID to delete"),
  })
  .strict();

export const ClearChatSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID to clear all messages from"),
  })
  .strict();

export const GetMessagesSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z
      .string()
      .min(5)
      .describe("Chat JID to retrieve messages from (e.g. 5511999999999@s.whatsapp.net)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Maximum number of messages to return (default 50, max 100)"),
  })
  .strict();

export const ListChatsSchema = z
  .object({ instanceId: z.string().min(1).describe("The instance ID") })
  .strict();

export const MarkChatUnreadSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID to mark unread"),
  })
  .strict();

export const StarMessageSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID containing the message"),
    messageId: z.string().min(1).describe("Message ID to star or unstar"),
    star: z.boolean().describe("true to star, false to unstar"),
  })
  .strict();

export const FetchMessageHistorySchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID whose older messages should be fetched"),
    count: z.number().int().min(1).max(100).default(50),
    timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
  })
  .strict();
