// ============================================================
// WA MCP — Contact Management Zod Schemas
// ============================================================

import { z } from "zod";
import { isValidStatusRecipient } from "../utils/validation.js";

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

export const ResyncContactsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The existing WhatsApp instance ID"),
  })
  .strict();

export const ListBlockedContactsSchema = z
  .object({ instanceId: z.string().min(1).describe("The instance ID") })
  .strict();

export const GetContactAboutSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: z
      .string()
      .trim()
      .refine(isValidStatusRecipient, "Expected an individual WhatsApp phone number or JID")
      .describe("Private contact phone number or JID"),
  })
  .strict();

export const SaveContactSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: z
      .string()
      .trim()
      .refine(isValidStatusRecipient, "Expected an individual WhatsApp phone number or JID")
      .describe("Contact phone number or JID to save"),
    fullName: z.string().trim().min(1).max(128).describe("Contact full display name"),
    firstName: z.string().trim().min(1).max(64).optional().describe("Optional contact first name"),
    username: z.string().trim().min(1).max(64).optional().describe("Optional WhatsApp username"),
    saveOnPrimaryAddressbook: z
      .boolean()
      .optional()
      .describe("Whether to also save the contact in the primary phone address book"),
  })
  .strict();

export const RemoveContactSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: z
      .string()
      .trim()
      .refine(isValidStatusRecipient, "Expected an individual WhatsApp phone number or JID")
      .describe("Contact phone number or JID to remove from WhatsApp app state"),
  })
  .strict();

export const GetDisappearingDurationSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jids: z
      .array(
        z
          .string()
          .trim()
          .refine(isValidStatusRecipient, "Expected an individual WhatsApp phone number or JID"),
      )
      .min(1)
      .max(50)
      .describe("Contact phone numbers or JIDs to query default disappearing duration for (1-50)"),
  })
  .strict();
