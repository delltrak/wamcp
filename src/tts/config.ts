export interface TtsConfig {
  enabled: boolean;
  provider: string;
  apiKey?: string;
  defaultVoiceId?: string;
  modelId: string;
  languageCode?: string;
  outputFormat: string;
  maxChars: number;
  concurrency: number;
  baseUrl: string;
  timeoutMs: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function validateTtsBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new Error(
      "Invalid WA_TTS_BASE_URL. Use an HTTPS URL, or HTTP on localhost/127.0.0.1 for local testing.",
      { cause: error },
    );
  }

  const isLocalHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    throw new Error(
      "Invalid WA_TTS_BASE_URL. Use an HTTPS URL, or HTTP on localhost/127.0.0.1 for local testing.",
    );
  }
  return baseUrl;
}

export function getTtsConfig(env: NodeJS.ProcessEnv = process.env): TtsConfig {
  const baseUrl = env.WA_TTS_BASE_URL?.trim().replace(/\/+$/, "") || "https://api.elevenlabs.io";
  return {
    enabled: ["true", "1", "yes"].includes((env.WA_TTS_ENABLED ?? "").trim().toLowerCase()),
    provider: env.WA_TTS_PROVIDER?.trim().toLowerCase() || "elevenlabs",
    apiKey: env.WA_TTS_API_KEY?.trim() || undefined,
    defaultVoiceId: env.WA_TTS_DEFAULT_VOICE_ID?.trim() || undefined,
    modelId: env.WA_TTS_MODEL?.trim() || "eleven_v3",
    languageCode: env.WA_TTS_LANGUAGE?.trim() || undefined,
    outputFormat: env.WA_TTS_OUTPUT_FORMAT?.trim() || "opus_48000_64",
    maxChars: positiveInteger(env.WA_TTS_MAX_CHARS, 5000),
    concurrency: positiveInteger(env.TTS_CONCURRENCY, 2),
    baseUrl: validateTtsBaseUrl(baseUrl),
    timeoutMs: positiveInteger(env.WA_TTS_TIMEOUT_MS, 60_000),
  };
}
