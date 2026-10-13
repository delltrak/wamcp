// ============================================================
// WA MCP — Transcription Zod Schemas
// ============================================================

import { z } from "zod";

export const TranscribeAudioSchema = z
  .object({
    instanceId: z.string().min(1).optional().describe("Instance containing the audio message"),
    messageId: z.string().min(1).optional().describe("Incoming audio message ID to transcribe"),
    audio: z.string().min(1).optional().describe("HTTPS URL or base64-encoded audio data"),
    mimeType: z.string().min(1).optional().describe("MIME type for direct audio input"),
  })
  .strict()
  .refine((params) => Boolean(params.messageId) !== Boolean(params.audio), {
    message: "Provide exactly one of messageId or audio",
  })
  .refine((params) => !params.messageId || Boolean(params.instanceId), {
    message: "instanceId is required when messageId is provided",
  });
