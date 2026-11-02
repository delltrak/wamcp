// ============================================================
// WA MCP — Status/Stories Zod Schemas
// ============================================================

import { z } from "zod";
import {
  MAX_GROUP_STATUS_CAPTION_LENGTH,
  MAX_GROUP_STATUS_MEDIA_CHARS,
} from "../channels/baileys/group-status.js";
import { isValidGroupId } from "../utils/group-jid.js";
import { isValidStatusRecipient } from "../utils/validation.js";

const GROUP_STATUS_FONTS = new Set([0, 1, 2, 6, 7, 8, 9, 10]);

const statusJidListSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .refine(isValidStatusRecipient, "Expected an individual WhatsApp phone number or JID"),
  )
  .optional()
  .describe(
    "Optional status audience. Use individual phone numbers or user JIDs; the account's own JID is always added.",
  );

export const SendTextStatusSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    text: z.string().min(1).describe("Status text content"),
    statusJidList: statusJidListSchema,
    backgroundColor: z
      .string()
      .trim()
      .regex(/^#?(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Expected RGB or ARGB hex color")
      .optional()
      .describe("RGB or ARGB hex color (for example '#FF5733' or '#FFFF5733')"),
    font: z.number().int().min(0).max(5).optional().describe("Font style (0-5)"),
  })
  .strict();

export const SendImageStatusSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    image: z.string().min(1).describe("Image URL or base64-encoded data"),
    statusJidList: statusJidListSchema,
    caption: z.string().optional().describe("Image caption"),
  })
  .strict();

export const SendVideoStatusSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    video: z.string().min(1).describe("Video URL or base64-encoded data"),
    statusJidList: statusJidListSchema,
    caption: z.string().optional().describe("Video caption"),
  })
  .strict();

export const GetStatusViewersSchema = z
  .object({
    instanceId: z.string().min(1),
    messageId: z.string().min(1).describe("Message ID returned when the status story was sent"),
  })
  .strict();

export const SendGroupStatusSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: z
      .string()
      .trim()
      .min(1)
      .refine(isValidGroupId, "Expected a WhatsApp group ID or a JID ending in @g.us")
      .describe("Group whose members can see this status, as a group ID or a @g.us JID"),
    type: z.enum(["text", "image", "video"]).describe("text, image, or video"),
    text: z.string().min(1).optional().describe("Text body. Required when type is text"),
    media: z
      .string()
      .min(1)
      .max(MAX_GROUP_STATUS_MEDIA_CHARS)
      .optional()
      .describe("HTTPS URL or base64 image or video. Required when type is image or video"),
    caption: z
      .string()
      .max(MAX_GROUP_STATUS_CAPTION_LENGTH)
      .optional()
      .describe("Caption for an image or video status"),
    backgroundColor: z
      .string()
      .trim()
      .regex(/^#?(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Expected RGB or ARGB hex color")
      .optional()
      .describe("Text background as #RRGGBB or #AARRGGBB. Defaults to #233E4F"),
    font: z
      .number()
      .int()
      .refine((value) => GROUP_STATUS_FONTS.has(value), "Expected FontType 0, 1, 2, or 6-10")
      .optional()
      .describe(
        "WhatsApp FontType: 0 SYSTEM, 1 SYSTEM_TEXT, 2 FB_SCRIPT, 6 SYSTEM_BOLD, 7 MORNINGBREEZE_REGULAR, 8 CALISTOGA_REGULAR, 9 EXO2_EXTRABOLD, 10 COURIERPRIME_BOLD. Defaults to 6",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "text" && value.text === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: "text is required when type is text",
      });
    }
    if (value.type !== "text" && value.media === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["media"],
        message: "media is required when type is image or video",
      });
    }
    if (value.type === "text" && value.media !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["media"],
        message: "media applies only to image or video",
      });
    }
    if (value.type === "text" && value.caption !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["caption"],
        message: "caption applies only to image or video",
      });
    }
    if (value.type !== "text" && value.backgroundColor !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["backgroundColor"],
        message: "backgroundColor applies only to text",
      });
    }
    if (value.type !== "text" && value.font !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["font"],
        message: "font applies only to text",
      });
    }
  });
