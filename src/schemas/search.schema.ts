import { z } from "zod";

export const SearchMessagesSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to search"),
    query: z.string().trim().min(1).max(500).describe("Text substring to search, case-insensitive"),
    from: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Inclusive ISO datetime lower bound"),
    to: z.iso.datetime({ offset: true }).optional().describe("Inclusive ISO datetime upper bound"),
    sender: z.string().min(1).optional().describe("Exact sender JID or stored sender ID"),
    chatId: z
      .string()
      .min(5)
      .optional()
      .describe("Limit results to one chat; omit to search all chats"),
    limit: z.number().int().min(1).max(100).default(20).describe("Page size (default 20, max 100)"),
    offset: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .default(0)
      .describe("Result offset for pagination"),
  })
  .refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
    message: "from must be earlier than or equal to to",
    path: ["from"],
  })
  .strict();
