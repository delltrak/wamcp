// ============================================================
// WA MCP — Status/Stories Zod Schemas
// ============================================================

import { z } from "zod";
import { isValidStatusRecipient } from "../utils/validation.js";

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
