// ============================================================
// WA MCP — Audio Transcription Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { MediaService } from "../services/media.js";
import { TranscriptionService } from "../services/transcription.js";
import { TranscribeAudioSchema } from "../schemas/transcription.schema.js";
import {
  isAutoMarkPlayedEnabled,
  markTranscribedAudioPlayed,
} from "../services/auto-mark-played.js";
import { toolSuccess } from "../types/mcp.types.js";
import { createRequestLogger } from "../utils/logger.js";
import { handleToolError } from "../utils/tool-handler.js";

function responseMimeType(contentType: string | undefined): string | undefined {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (
    !normalized ||
    [
      "application/octet-stream",
      "application/x-octet-stream",
      "application/x-binary",
      "binary/octet-stream",
    ].includes(normalized)
  ) {
    return undefined;
  }
  return contentType?.trim();
}

function urlMimeType(input: string): string | undefined {
  try {
    const extension = new URL(input).pathname.split(".").pop()?.toLowerCase();
    switch (extension) {
      case "mp3":
        return "audio/mpeg";
      case "mp4":
      case "m4a":
        return "audio/mp4";
      case "wav":
        return "audio/wav";
      case "webm":
        return "audio/webm";
      case "ogg":
      case "oga":
      case "opus":
        return "audio/ogg";
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

export function registerTranscriptionTools(
  server: McpServer,
  instanceManager: InstanceManager,
): void {
  const transcriptionService = new TranscriptionService();
  const mediaService = new MediaService();

  server.registerTool(
    "wa_transcribe_audio",
    {
      description:
        "Transcribe an incoming audio message by instanceId and messageId, or transcribe direct HTTPS/base64 audio. Requires transcription to be configured.",
      inputSchema: TranscribeAudioSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_transcribe_audio", params.instanceId);
      const start = Date.now();
      try {
        transcriptionService.assertConfigured();

        let audio: Buffer;
        let mimeType = params.mimeType;

        if (params.messageId) {
          const adapter = instanceManager.getAdapter(params.instanceId!);
          const media = await adapter.downloadMessageAudio(
            params.messageId,
            transcriptionService.maxBytes,
            transcriptionService.timeoutMs,
          );
          audio = media.data;
          mimeType = params.mimeType ?? media.mimeType;
        } else {
          const media = await mediaService.getMediaBuffer(params.audio!, {
            maxBytes: transcriptionService.maxBytes,
            timeoutMs: transcriptionService.timeoutMs,
            includeContentType: true,
          });
          audio = media.data;
          mimeType =
            params.mimeType ??
            responseMimeType(media.contentType) ??
            urlMimeType(params.audio!) ??
            "audio/ogg";
        }

        const result = await transcriptionService.transcribe(audio, mimeType ?? "audio/ogg");
        const messageId = params.messageId;
        const instanceId = params.instanceId;
        if (messageId && instanceId && isAutoMarkPlayedEnabled()) {
          await markTranscribedAudioPlayed(() => instanceManager.getAdapter(instanceId), messageId);
        }
        log.info({ duration: Date.now() - start, bytes: audio.length }, "Audio transcribed");
        return toolSuccess({ text: result.text });
      } catch (err) {
        return handleToolError("wa_transcribe_audio", err, params.instanceId);
      }
    },
  );
}
