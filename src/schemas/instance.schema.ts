// ============================================================
// WA MCP — Instance Management Zod Schemas
// ============================================================

import { z } from "zod";

export const CreateInstanceSchema = z
  .object({
    name: z.string().min(1).describe("Human-friendly instance name (e.g. 'support-bot')"),
    channel: z
      .enum(["baileys", "cloud"])
      .default("baileys")
      .describe("WhatsApp channel: baileys (Web protocol) or cloud (Meta Cloud API)"),
  })
  .strict();

export const ConnectInstanceSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to connect"),
  })
  .strict();

export const DisconnectInstanceSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to disconnect"),
  })
  .strict();

export const DeleteInstanceSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to permanently delete"),
  })
  .strict();

export const RestartInstanceSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to restart"),
  })
  .strict();

export const GetInstanceStatusSchema = z
  .object({
    instanceId: z
      .string()
      .min(1)
      .optional()
      .describe("The instance ID to inspect; omit to list all"),
  })
  .strict();

export const GetQrCodeSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to get QR code for (Baileys only)"),
  })
  .strict();

export const GetPairingCodeSchema = z
  .object({
    instanceId: z
      .string()
      .min(1)
      .describe("The instance ID to get pairing code for (Baileys only)"),
    phoneNumber: z.string().min(5).describe("Phone number to pair with (e.g. '5511999999999')"),
  })
  .strict();

export const SetCloudCredentialsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to configure (Cloud API only)"),
    accessToken: z.string().min(1).describe("Meta Cloud API access token"),
    phoneNumberId: z.string().min(1).describe("Meta Phone Number ID"),
    businessId: z
      .string()
      .optional()
      .describe(
        "WhatsApp Business Account (WABA) ID, not Business Portfolio ID; required for template discovery",
      ),
  })
  .strict();

export const SetInstanceWebhookSchema = z
  .object({
    instanceId: z.string().min(1).describe("Instance whose outgoing event webhook to replace"),
    url: z
      .string()
      .min(1)
      .describe(
        "HTTPS webhook URL. HTTP is accepted only when WA_EVENT_WEBHOOK_ALLOW_HTTP=true. Private and local hosts stay blocked.",
      ),
    authHeader: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional auth header name. Set it together with authValue. The value is stored and never returned.",
      ),
    authValue: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional auth header value. Stored for delivery and omitted from tool results, logs, and GET /health.",
      ),
    events: z
      .array(z.string())
      .optional()
      .describe(
        "Channel event names this instance forwards. Omit to inherit WA_EVENT_WEBHOOK_EVENTS. An empty list is rejected.",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.authHeader === undefined) !== (value.authValue === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["authHeader"],
        message: "authHeader and authValue must be set together",
      });
    }
  });

export const GetInstanceWebhookSchema = z
  .object({
    instanceId: z.string().min(1).describe("Instance whose outgoing event webhook to read"),
  })
  .strict();

export const DeleteInstanceWebhookSchema = z
  .object({
    instanceId: z.string().min(1).describe("Instance whose outgoing event webhook to remove"),
  })
  .strict();
