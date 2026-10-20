import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { TtsListVoicesSchema, TtsPreviewSchema, SendVoiceSchema } from "../schemas/tts.schema.js";
import { toolSuccess } from "../types/mcp.types.js";
import { createRequestLogger } from "../utils/logger.js";
import { handleToolError } from "../utils/tool-handler.js";
import { TtsService } from "../tts/service.js";
import type { TtsVoiceSettings } from "../tts/provider.js";

function voiceSettingsFrom(params: {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  useSpeakerBoost?: boolean;
}): TtsVoiceSettings {
  return {
    ...(params.stability !== undefined ? { stability: params.stability } : {}),
    ...(params.similarityBoost !== undefined ? { similarityBoost: params.similarityBoost } : {}),
    ...(params.style !== undefined ? { style: params.style } : {}),
    ...(params.speed !== undefined ? { speed: params.speed } : {}),
    ...(params.useSpeakerBoost !== undefined ? { useSpeakerBoost: params.useSpeakerBoost } : {}),
  };
}

export function registerTtsTools(
  server: McpServer,
  instanceManager: InstanceManager,
  messageQueue: MessageQueue,
  ttsService = new TtsService(),
): void {
  server.registerTool(
    "wa_send_voice",
    {
      description:
        "Synthesize text as an OGG/Opus WhatsApp voice note and queue it for a Baileys instance. TTS must be enabled and configured.",
      inputSchema: SendVoiceSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_voice", params.instanceId);
      const start = Date.now();
      let adapter: ReturnType<InstanceManager["getAdapter"]> | undefined;
      try {
        ttsService.assertConfigured();
        ttsService.assertTextWithinLimit(params.text);
        const voiceId = ttsService.resolveVoiceId(params.voiceId);
        const channel = await instanceManager.getInstanceChannel(params.instanceId);
        if (channel !== "baileys") {
          throw new Error(
            "Voice notes with push-to-talk are only supported for Baileys instances.",
          );
        }
        adapter = instanceManager.getAdapter(params.instanceId);
        try {
          await adapter.sendPresence(params.to, "recording");
        } catch {
          log.debug("Recording presence is unavailable; continuing with voice note generation");
        }

        const audio = await ttsService.synthesize(params.text, {
          voiceId,
          modelId: params.modelId,
          languageCode: params.languageCode,
          voiceSettings: voiceSettingsFrom(params),
        });
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "audio",
            audio: audio.audio.toString("base64"),
            ptt: true,
            mimeType: audio.mimeType,
            quotedMessageId: params.quotedMessageId,
          },
          channel,
        );
        log.info(
          { duration: Date.now() - start, bytes: audio.audio.length, to: params.to },
          "Voice note queued",
        );
        return toolSuccess({ ...result, ptt: true, mimeType: audio.mimeType });
      } catch (err) {
        return handleToolError("wa_send_voice", err, params.instanceId);
      } finally {
        if (adapter) {
          try {
            await adapter.sendPresence(params.to, "paused");
          } catch {
            // Presence is best-effort and must not fail the send operation.
          }
        }
      }
    },
  );

  server.registerTool(
    "wa_tts_list_voices",
    {
      description:
        "List voices available from the configured text-to-speech provider, including created Voice Design voices.",
      inputSchema: TtsListVoicesSchema,
    },
    async () => {
      try {
        return toolSuccess({ voices: await ttsService.listVoices() });
      } catch (err) {
        return handleToolError("wa_tts_list_voices", err);
      }
    },
  );

  server.registerTool(
    "wa_tts_preview",
    {
      description:
        "Synthesize a preview and return base64 audio without sending a WhatsApp message. TTS must be enabled and configured.",
      inputSchema: TtsPreviewSchema,
    },
    async (params) => {
      try {
        const audio = await ttsService.synthesize(params.text, {
          voiceId: params.voiceId,
          modelId: params.modelId,
          languageCode: params.languageCode,
          voiceSettings: voiceSettingsFrom(params),
        });
        return toolSuccess({ audio: audio.audio.toString("base64"), mimeType: audio.mimeType });
      } catch (err) {
        return handleToolError("wa_tts_preview", err);
      }
    },
  );
}
