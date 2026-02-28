// ============================================================
// WA MCP — Contact Management Zod Schemas
// ============================================================

import { z } from "zod";

export const CheckNumberExistsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    phoneNumber: z.string().min(5).describe("Phone number to check (e.g. '5511999999999')"),
  })
  .strict();

export const BlockContactSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: z.string().min(5).describe("Contact JID to block"),
  })
  .strict();

export const UnblockContactSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: z.string().min(5).describe("Contact JID to unblock"),
  })
  .strict();

export const GetBusinessProfileSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: z.string().min(5).describe("Contact JID to fetch business profile for"),
  })
  .strict();

export const SearchContactSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    query: z.string().min(1).describe("Search term — matches name, notify name, or phone number"),
  })
  .strict();
