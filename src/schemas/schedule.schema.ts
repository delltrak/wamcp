// ============================================================
// WA MCP — Scheduled send Zod schemas
// ============================================================

import { z } from "zod";

const MentionsSchema = z
  .array(z.string().trim().min(5))
  .max(100)
  .optional()
  .describe("Participant phone numbers or JIDs to mention");

const TextContentSchema = z
  .object({
    type: z.literal("text").describe("Text message"),
    text: z.string().min(1).max(65536).describe("Message text"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
    mentions: MentionsSchema,
  })
  .strict();

const ImageContentSchema = z
  .object({
    type: z.literal("image").describe("Image message"),
    image: z.string().min(1).describe("HTTPS URL or base64 image"),
    caption: z.string().max(65536).optional().describe("Optional caption"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
    mentions: MentionsSchema,
  })
  .strict();

const VideoContentSchema = z
  .object({
    type: z.literal("video").describe("Video message"),
    video: z.string().min(1).describe("HTTPS URL or base64 video"),
    caption: z.string().max(65536).optional().describe("Optional caption"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
    mentions: MentionsSchema,
  })
  .strict();

const AudioContentSchema = z
  .object({
    type: z.literal("audio").describe("Audio message"),
    audio: z.string().min(1).describe("HTTPS URL or base64 audio"),
    ptt: z.boolean().optional().describe("Send as a voice note when true"),
    mimeType: z.string().optional().describe("Optional MIME type"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
    mentions: MentionsSchema,
  })
  .strict();

const DocumentContentSchema = z
  .object({
    type: z.literal("document").describe("Document message"),
    document: z.string().min(1).describe("HTTPS URL or base64 document"),
    fileName: z.string().min(1).describe("File name shown to the recipient"),
    mimeType: z.string().min(1).describe("Document MIME type"),
    mentions: MentionsSchema,
  })
  .strict();

const StickerContentSchema = z
  .object({
    type: z.literal("sticker").describe("Sticker message"),
    sticker: z.string().min(1).describe("HTTPS URL or base64 sticker"),
    animated: z.boolean().optional().describe("Hint that a GIF sticker should stay animated"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
  })
  .strict();

const ScheduleContentSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  VideoContentSchema,
  AudioContentSchema,
  DocumentContentSchema,
  StickerContentSchema,
]);

export const ScheduleMessageSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    scheduledAt: z
      .string()
      .min(1)
      .describe("First send time as an RFC3339 timestamp. Must be in the future"),
    timezone: z
      .string()
      .min(1)
      .default("America/Bahia")
      .describe(
        "IANA timezone used for daily, weekly, and monthly wall-clock times. Default America/Bahia",
      ),
    recurrence: z
      .enum(["once", "daily", "weekly", "monthly"])
      .default("once")
      .describe("once fires a single time. daily, weekly, and monthly repeat the wall clock"),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .optional()
      .describe("Weekly only. Unique days, 0 Sunday through 6 Saturday"),
    dayOfMonth: z
      .number()
      .int()
      .min(1)
      .max(31)
      .optional()
      .describe("Monthly only. Days past the end of a short month use the last day"),
    endAt: z
      .string()
      .optional()
      .describe("Optional RFC3339 instant after which no further occurrence is sent"),
    occurrenceLimit: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .optional()
      .describe("Stop after this many successful sends. One-time schedules accept only 1"),
    content: ScheduleContentSchema.describe("Text, or image, video, audio, document, or sticker"),
  })
  .strict();

export const ListScheduledSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance whose schedules to list"),
    status: z
      .enum(["active", "paused", "running", "completed", "cancelled", "failed", "skipped"])
      .optional()
      .describe("Filter by status. Omit to return every status"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Page size, from 1 to 100. Default 25"),
    offset: z.number().int().min(0).default(0).describe("Number of rows to skip. Default 0"),
  })
  .strict();

export const ScheduleIdSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance that owns the schedule"),
    scheduleId: z.string().min(1).describe("Schedule ID returned by wa_schedule_message"),
  })
  .strict();
