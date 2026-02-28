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
    businessId: z.string().optional().describe("Meta Business ID (optional)"),
  })
  .strict();
