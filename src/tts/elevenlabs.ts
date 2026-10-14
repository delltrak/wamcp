import { validateTtsBaseUrl, type TtsConfig } from "./config.js";
import type { TtsAudio, TtsProvider, TtsSynthesizeOptions, TtsVoice } from "./provider.js";

interface ElevenLabsVoice {
  voice_id?: unknown;
  name?: unknown;
  category?: unknown;
  description?: unknown;
  labels?: unknown;
}

interface ElevenLabsVoiceList {
  voices?: unknown;
}

export interface ElevenLabsDependencies {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  maxResponseBytes?: number;
}

export const DEFAULT_MAX_TTS_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 30_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function endpointBase(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - Date.now()), MAX_RETRY_AFTER_MS);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort; the provider error remains the useful failure.
  }
}

function responseTooLargeError(maxBytes: number): Error {
  return new Error(
    `ElevenLabs audio response exceeded the maximum allowed size of ${maxBytes} bytes.`,
  );
}

async function readAudioResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (Number.isSafeInteger(length) && length > maxBytes) {
      await cancelResponseBody(response);
      throw responseTooLargeError(maxBytes);
    }
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size limit is still enforced if stream cancellation fails.
        }
        throw responseTooLargeError(maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function mapResponseError(status: number): Error {
  if (status === 401)
    return new Error("Invalid ElevenLabs API key (HTTP 401). Check WA_TTS_API_KEY.");
  if (status === 404 || status === 422) {
    return new Error(
      "ElevenLabs could not find that voice or rejected its voice ID (HTTP 404/422). Check the voice ID.",
    );
  }
  if (status === 402 || status === 429) {
    return new Error(
      "ElevenLabs quota or rate limit reached. Check your plan and usage, then retry.",
    );
  }
  return new Error(`ElevenLabs request failed (HTTP ${status}).`);
}

function voiceFromResponse(value: ElevenLabsVoice): TtsVoice | undefined {
  if (typeof value.voice_id !== "string" || typeof value.name !== "string") return undefined;
  return {
    voiceId: value.voice_id,
    name: value.name,
    ...(typeof value.category === "string" ? { category: value.category } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(value.labels && typeof value.labels === "object"
      ? { labels: value.labels as Record<string, string> }
      : {}),
  };
}

export class ElevenLabsProvider implements TtsProvider {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly maxResponseBytes: number;
  private readonly baseUrl: string;

  constructor(
    private readonly config: TtsConfig,
    dependencies: ElevenLabsDependencies = {},
  ) {
    this.fetchFn = dependencies.fetch ?? ((...args) => fetch(...args));
    this.sleep = dependencies.sleep ?? delay;
    this.random = dependencies.random ?? Math.random;
    this.maxAttempts = dependencies.maxAttempts ?? 3;
    this.maxResponseBytes = dependencies.maxResponseBytes ?? DEFAULT_MAX_TTS_RESPONSE_BYTES;
    this.baseUrl = endpointBase(validateTtsBaseUrl(config.baseUrl));
  }

  async synthesize(text: string, opts: TtsSynthesizeOptions): Promise<TtsAudio> {
    const voiceId = encodeURIComponent(opts.voiceId);
    const url = new URL(`${this.baseUrl}/text-to-speech/${voiceId}`);
    url.searchParams.set("output_format", this.config.outputFormat);

    const voiceSettings = opts.voiceSettings;
    const body: Record<string, unknown> = {
      text,
      model_id: opts.modelId ?? this.config.modelId,
    };
    const languageCode = opts.languageCode ?? this.config.languageCode;
    if (languageCode) body.language_code = languageCode;
    if (voiceSettings && Object.keys(voiceSettings).length > 0) {
      body.voice_settings = {
        ...(voiceSettings.stability !== undefined ? { stability: voiceSettings.stability } : {}),
        ...(voiceSettings.similarityBoost !== undefined
          ? { similarity_boost: voiceSettings.similarityBoost }
          : {}),
        ...(voiceSettings.style !== undefined ? { style: voiceSettings.style } : {}),
        ...(voiceSettings.speed !== undefined ? { speed: voiceSettings.speed } : {}),
        ...(voiceSettings.useSpeakerBoost !== undefined
          ? { use_speaker_boost: voiceSettings.useSpeakerBoost }
          : {}),
      };
    }
    if (opts.previousText) body.previous_text = opts.previousText;
    if (opts.nextText) body.next_text = opts.nextText;

    const response = await this.requestWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      audio: await readAudioResponse(response, this.maxResponseBytes),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async listVoices(): Promise<TtsVoice[]> {
    const response = await this.requestWithRetry(new URL(`${this.baseUrl}/voices`), {
      method: "GET",
    });
    const result = (await response.json()) as ElevenLabsVoiceList;
    if (!Array.isArray(result.voices)) {
      throw new Error("ElevenLabs voice list response was missing its voices array.");
    }
    return result.voices
      .filter((voice): voice is ElevenLabsVoice => Boolean(voice) && typeof voice === "object")
      .map(voiceFromResponse)
      .filter((voice): voice is TtsVoice => Boolean(voice));
  }

  private async requestWithRetry(url: URL, init: RequestInit): Promise<Response> {
    if (!this.config.apiKey) {
      throw new Error("TTS not configured. Set WA_TTS_ENABLED=true and WA_TTS_API_KEY.");
    }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers)),
            "xi-api-key": this.config.apiKey,
          },
          signal: AbortSignal.timeout(this.config.timeoutMs),
          redirect: "error",
        });
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new Error(`ElevenLabs request timed out after ${this.config.timeoutMs} ms.`, {
            cause: error,
          });
        }
        throw new Error("ElevenLabs request failed before a response was received.", {
          cause: error,
        });
      }

      if (response.ok) return response;

      const shouldRetry = response.status === 429 || response.status >= 500;
      const retryAfter =
        response.status === 429 || response.status === 503
          ? parseRetryAfter(response.headers.get("retry-after"))
          : undefined;
      await cancelResponseBody(response);
      if (shouldRetry && attempt < this.maxAttempts) {
        const backoff = retryAfter ?? Math.min(1000 * 2 ** (attempt - 1), 8000);
        const waitTime =
          retryAfter === undefined ? Math.round(backoff * (0.5 + this.random())) : backoff;
        await this.sleep(waitTime);
        continue;
      }
      throw mapResponseError(response.status);
    }

    throw new Error("ElevenLabs request failed after retries.");
  }
}
