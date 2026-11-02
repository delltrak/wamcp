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

const CALL_LINK_START_SKEW_SECONDS = 60;

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
        "Optional Unix start time in seconds. When set, Baileys sends link_create/event@start_time. Must be at most 60 seconds in the past. Omit it for a link with no scheduled start.",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.startTime === undefined) return;
    const earliest = Math.floor(Date.now() / 1000) - CALL_LINK_START_SKEW_SECONDS;
    if (value.startTime < earliest) {
      ctx.addIssue({
        code: "custom",
        path: ["startTime"],
        message: "startTime must be no more than 60 seconds in the past",
      });
    }
  });
