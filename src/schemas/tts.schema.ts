import { z } from "zod";

const voiceOptions = {
  voiceId: z.string().min(1).optional().describe("Provider voice ID"),
  modelId: z.string().min(1).optional().describe("Provider model ID override"),
  languageCode: z.string().min(1).optional().describe("Optional language code"),
  stability: z.number().min(0).max(1).optional().describe("Voice stability from 0 to 1"),
  similarityBoost: z.number().min(0).max(1).optional().describe("Similarity boost from 0 to 1"),
  style: z.number().min(0).max(1).optional().describe("Style exaggeration from 0 to 1"),
  speed: z.number().min(0.7).max(1.2).optional().describe("Speech speed from 0.7 to 1.2"),
  useSpeakerBoost: z.boolean().optional().describe("Enable speaker boost"),
};

const synthesisOptionsSchema = z.object(voiceOptions).strict();

export const SendVoiceSchema = synthesisOptionsSchema
  .extend({
    instanceId: z.string().min(1).describe("The Baileys instance to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    text: z.string().min(1).max(65536).describe("Text to synthesize into a voice note"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
  })
  .strict();

export const TtsPreviewSchema = synthesisOptionsSchema
  .extend({
    text: z.string().min(1).max(65536).describe("Text to synthesize into a preview"),
  })
  .strict();

export const TtsListVoicesSchema = z.object({}).strict();
