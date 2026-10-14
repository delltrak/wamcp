export interface TtsConfig {
  enabled: boolean;
  provider: string;
  apiKey?: string;
  defaultVoiceId?: string;
  modelId: string;
  languageCode?: string;
  outputFormat: string;
  maxChars: number;
  baseUrl: string;
  timeoutMs: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getTtsConfig(env: NodeJS.ProcessEnv = process.env): TtsConfig {
  return {
    enabled: ["true", "1", "yes"].includes((env.WA_TTS_ENABLED ?? "").trim().toLowerCase()),
    provider: env.WA_TTS_PROVIDER?.trim().toLowerCase() || "elevenlabs",
    apiKey: env.WA_TTS_API_KEY?.trim() || undefined,
    defaultVoiceId: env.WA_TTS_DEFAULT_VOICE_ID?.trim() || undefined,
    modelId: env.WA_TTS_MODEL?.trim() || "eleven_v3",
    languageCode: env.WA_TTS_LANGUAGE?.trim() || undefined,
    outputFormat: env.WA_TTS_OUTPUT_FORMAT?.trim() || "opus_48000_64",
    maxChars: positiveInteger(env.WA_TTS_MAX_CHARS, 5000),
    baseUrl: env.WA_TTS_BASE_URL?.trim().replace(/\/+$/, "") || "https://api.elevenlabs.io",
    timeoutMs: positiveInteger(env.WA_TTS_TIMEOUT_MS, 60_000),
  };
}
