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
    chatId: z.string().min(5).describe("Chat JID to retrieve messages from (e.g. 5511999999999@s.whatsapp.net)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Maximum number of messages to return (default 50, max 100)"),
  })
  .strict();
