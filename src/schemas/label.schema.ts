import { z } from "zod";

export const ListLabelsSchema = z
  .object({
    instanceId: z.string().min(1),
    includeDeleted: z.boolean().default(false),
  })
  .strict();

export const CreateLabelSchema = z
  .object({
    instanceId: z.string().min(1),
    name: z.string().trim().min(1).max(128),
    color: z.number().int().min(0).max(19).describe("WhatsApp label color ID (0-19)"),
  })
  .strict();

export const EditLabelSchema = z
  .object({
    instanceId: z.string().min(1),
    labelId: z.string().min(1),
    name: z.string().trim().min(1).max(128).optional(),
    color: z.number().int().min(0).max(19).optional(),
  })
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    message: "Provide a new name or color",
  })
  .strict();

export const DeleteLabelSchema = z
  .object({ instanceId: z.string().min(1), labelId: z.string().min(1) })
  .strict();

export const ChatLabelSchema = z
  .object({
    instanceId: z.string().min(1),
    chatId: z.string().min(5),
    labelId: z.string().min(1),
  })
  .strict();

export const MessageLabelSchema = z
  .object({
    instanceId: z.string().min(1),
    chatId: z.string().min(5),
    messageId: z.string().min(1),
    labelId: z.string().min(1),
  })
  .strict();
