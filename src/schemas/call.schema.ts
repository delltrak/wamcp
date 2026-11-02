// ============================================================
// WA MCP — Call Management Zod Schemas
// ============================================================

import { z } from "zod";

export const RejectCallSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    callId: z
      .string()
      .min(1)
      .describe("The call ID to reject (received via whatsapp/call.received notification)"),
    callFrom: z
      .string()
      .min(5)
      .optional()
      .describe("Caller JID from the call notification, if supplied"),
  })
  .strict();

export const CreateCallLinkSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    type: z
      .enum(["audio", "video"])
      .describe(
        "Call media. audio creates a voice link and video creates a video link. Baileys createCallLink accepts only these two values.",
      ),
    startTime: z
      .number()
      .int()
      .min(0)
      .max(4_000_000_000)
      .optional()
      .describe(
        "Optional Unix start time in seconds. When set, Baileys sends link_create/event@start_time. Omit it for a link with no scheduled start.",
      ),
  })
  .strict();
