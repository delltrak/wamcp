import { z } from "zod";

export const GetChannelCapabilitiesSchema = z
  .object({
    instanceId: z
      .string()
      .min(1)
      .describe("Existing instance whose channel capabilities to inspect"),
  })
  .strict();

export const AuthenticationTemplateOptionsSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Maximum Meta records to scan in this page (1–100)"),
    after: z
      .string()
      .min(1)
      .max(2048)
      .refine(
        (value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value),
        "Use nextCursor, not a pagination URL",
      )
      .optional()
      .describe("Opaque nextCursor from a previous page; never a pagination URL"),
    approvedOnly: z
      .boolean()
      .default(true)
      .describe(
        "Return only APPROVED authentication templates; false includes other approval states",
      ),
  })
  .strict();

export const ListAuthenticationTemplatesSchema = AuthenticationTemplateOptionsSchema.extend({
  instanceId: z
    .string()
    .min(1)
    .describe("Cloud API instance configured with a WhatsApp Business Account (WABA) ID"),
}).strict();

export const GetJobStatusSchema = z
  .object({
    instanceId: z.string().min(1).describe("Instance that originally queued this outbound job"),
    jobId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .describe("Exact jobId returned by a queued send; not the WhatsApp message ID"),
  })
  .strict();
