// ============================================================
// WA MCP — Status/Stories Zod Schemas
// ============================================================

import { z } from "zod";

export const SendTextStatusSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    text: z.string().min(1).describe("Status text content"),
    backgroundColor: z.string().optional().describe("Background color hex code (e.g. '#FF5733')"),
    font: z.number().int().min(0).max(5).optional().describe("Font style (0-5)"),
  })
  .strict();

export const SendImageStatusSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    image: z.string().min(1).describe("Image URL or base64-encoded data"),
    caption: z.string().optional().describe("Image caption"),
  })
  .strict();

export const SendVideoStatusSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    video: z.string().min(1).describe("Video URL or base64-encoded data"),
    caption: z.string().optional().describe("Video caption"),
  })
  .strict();
