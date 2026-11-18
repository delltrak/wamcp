import { z } from "zod";

export const SendEventSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    name: z.string().trim().min(1).max(200).describe("Event title"),
    description: z.string().max(4096).optional().describe("Optional event description"),
    start: z.iso.datetime({ offset: true }).describe("ISO datetime including a timezone offset"),
    end: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Optional ISO end datetime including a timezone offset"),
    locationText: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe("Optional location name or address"),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe("Optional GPS latitude for the event location"),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe("Optional GPS longitude for the event location"),
    callType: z
      .enum(["voice", "video"])
      .optional()
      .describe("Optional WhatsApp voice or video call link to create for the event"),
    extraGuestsAllowed: z.boolean().optional().describe("Whether attendees can bring extra guests"),
    isScheduleCall: z.boolean().optional().describe("Mark the event as a scheduled WhatsApp call"),
    quotedMessageId: z.string().min(1).optional().describe("Optional message ID to reply to"),
  })
  .refine((value) => !value.end || Date.parse(value.end) > Date.parse(value.start), {
    message: "end must be later than start",
    path: ["end"],
  })
  .refine((value) => !(value.locationText && value.callType), {
    message: "Choose a location or a voice/video call link, not both",
    path: ["locationText"],
  })
  .refine((value) => (value.latitude === undefined) === (value.longitude === undefined), {
    message: "latitude and longitude must be provided together",
    path: ["latitude"],
  })
  .strict();

export const CancelEventSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID containing the event message"),
    eventMessageId: z.string().min(1).describe("Message ID of the event to cancel"),
  })
  .strict();

export const GetEventResponsesSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID containing the event message"),
    eventMessageId: z.string().min(1).describe("Event creation message ID"),
  })
  .strict();
