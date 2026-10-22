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
