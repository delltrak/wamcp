import type { InstanceManager } from "./instance-manager.js";
import type { ChannelEventPayload } from "../types/channel.types.js";
import { TranscriptionService } from "./transcription.js";
import { createConcurrencyLimiter } from "../utils/concurrency.js";

interface SharedTranscriptionState {
  transcriptionService: TranscriptionService;
  limitTranscriptions: <T>(task: () => Promise<T>) => Promise<T>;
  inFlight: Map<string, Promise<string>>;
}

const transcriptionByInstanceManager = new WeakMap<InstanceManager, SharedTranscriptionState>();

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getSharedTranscriptionState(instanceManager: InstanceManager): SharedTranscriptionState {
  let state = transcriptionByInstanceManager.get(instanceManager);
  if (!state) {
    state = {
      transcriptionService: new TranscriptionService(),
      limitTranscriptions: createConcurrencyLimiter(
        positiveInteger(process.env.TRANSCRIPTION_CONCURRENCY, 2),
      ),
      inFlight: new Map(),
    };
    transcriptionByInstanceManager.set(instanceManager, state);
  }
  return state;
}

/**
 * Transcribe an incoming audio event when transcription is configured.
 * Notification and webhook listeners share the same in-flight work.
 */
export function transcribeIncomingAudioIfConfigured(
  instanceManager: InstanceManager,
  instanceId: string,
  messageEvent: ChannelEventPayload["message.received"],
): Promise<string> | undefined {
  const state = getSharedTranscriptionState(instanceManager);
  if (!state.transcriptionService.isConfigured()) return undefined;

  const key = JSON.stringify([instanceId, messageEvent.message.id]);
  const inFlight = state.inFlight.get(key);
  if (inFlight) return inFlight;

  const transcription = state.limitTranscriptions(async () => {
    const media = await instanceManager
      .getAdapter(instanceId)
      .downloadMessageAudio(
        messageEvent.message.id,
        state.transcriptionService.maxBytes,
        state.transcriptionService.timeoutMs,
      );
    const result = await state.transcriptionService.transcribe(media.data, media.mimeType);
    return result.text;
  });
  state.inFlight.set(key, transcription);
  const removeInFlight = () => {
    if (state.inFlight.get(key) === transcription) state.inFlight.delete(key);
  };
  void transcription.then(removeInFlight, removeInFlight);
  return transcription;
}
