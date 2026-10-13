// ============================================================
// WA MCP — Audio Transcription Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { MediaService } from "../services/media.js";
import { TranscriptionService } from "../services/transcription.js";
import { TranscribeAudioSchema } from "../schemas/transcription.schema.js";
import { toolSuccess } from "../types/mcp.types.js";
import { createRequestLogger } from "../utils/logger.js";
import { handleToolError } from "../utils/tool-handler.js";

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
        let mimeType = params.mimeType ?? "audio/ogg";

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
          audio = await mediaService.getMediaBuffer(params.audio!, {
            maxBytes: transcriptionService.maxBytes,
            timeoutMs: transcriptionService.timeoutMs,
          });
        }

        const result = await transcriptionService.transcribe(audio, mimeType);
        log.info({ duration: Date.now() - start, bytes: audio.length }, "Audio transcribed");
        return toolSuccess({ text: result.text });
      } catch (err) {
        return handleToolError("wa_transcribe_audio", err, params.instanceId);
      }
    },
  );
}
