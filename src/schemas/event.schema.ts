import { z } from "zod";

export const SendEventSchema = z
  .object({
    instanceId: z.string().min(1),
    to: z.string().min(5),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4096).optional(),
    start: z.iso.datetime({ offset: true }).describe("ISO datetime including a timezone offset"),
    end: z.iso.datetime({ offset: true }).optional(),
    locationText: z.string().trim().min(1).max(256).optional(),
    callType: z.enum(["voice", "video"]).optional(),
    quotedMessageId: z.string().min(1).optional(),
  })
  .refine((value) => !value.end || Date.parse(value.end) > Date.parse(value.start), {
    message: "end must be later than start",
    path: ["end"],
  })
  .refine((value) => !(value.locationText && value.callType), {
    message: "Choose a location or a voice/video call link, not both",
    path: ["locationText"],
  })
  .strict();

export const GetEventResponsesSchema = z
  .object({
    instanceId: z.string().min(1),
    chatId: z.string().min(5),
    eventMessageId: z.string().min(1),
  })
  .strict();
