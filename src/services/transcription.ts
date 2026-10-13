// ============================================================
// WA MCP — Pluggable Speech-to-Text Service
// ============================================================

import { MEDIA_LIMITS } from "../constants.js";

export interface TranscriptionResult {
  text: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function audioExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim();
  switch (normalized) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return "m4a";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/webm":
      return "webm";
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    default:
      return "ogg";
  }
}

export class TranscriptionService {
  readonly maxBytes: number;
  readonly timeoutMs: number;

  private readonly enabled: boolean;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly language: string | undefined;

  constructor() {
    this.enabled = ["true", "1", "yes"].includes(
      (process.env.WA_TRANSCRIPTION_ENABLED ?? "").toLowerCase(),
    );
    this.apiKey = process.env.WA_TRANSCRIPTION_API_KEY?.trim() || undefined;
    this.baseUrl =
      process.env.WA_TRANSCRIPTION_BASE_URL?.trim().replace(/\/+$/, "") ||
      "https://api.openai.com/v1";
    this.model = process.env.WA_TRANSCRIPTION_MODEL?.trim() || "whisper-1";
    this.language = process.env.WA_TRANSCRIPTION_LANGUAGE?.trim() || undefined;
    this.maxBytes =
      positiveInteger(process.env.WA_TRANSCRIPTION_MAX_MB, MEDIA_LIMITS.audio / 1024 / 1024) *
      1024 *
      1024;
    this.timeoutMs = positiveInteger(process.env.WA_TRANSCRIPTION_TIMEOUT_MS, 60_000);
  }

  isConfigured(): boolean {
    return this.enabled && Boolean(this.apiKey);
  }

  assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error(
        "Transcription not configured. Set WA_TRANSCRIPTION_ENABLED=true and WA_TRANSCRIPTION_API_KEY.",
      );
    }
  }

  async transcribe(audio: Buffer, mimeType = "audio/ogg"): Promise<TranscriptionResult> {
    this.assertConfigured();
    if (audio.length > this.maxBytes) {
      const maxMb = Math.round(this.maxBytes / 1024 / 1024);
      throw new Error(`Audio exceeds maximum transcription size of ${maxMb} MB`);
    }

    const form = new FormData();
    const normalizedMimeType = mimeType.split(";")[0]?.trim() || "audio/ogg";
    const blob = new Blob([audio as unknown as BlobPart], { type: normalizedMimeType });
    form.append("file", blob, `audio.${audioExtension(normalizedMimeType)}`);
    form.append("model", this.model);
    if (this.language) form.append("language", this.language);

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Transcription request failed: HTTP ${response.status}`);
    }

    const result = (await response.json()) as Partial<TranscriptionResult>;
    if (typeof result.text !== "string") {
      throw new Error("Transcription response did not include text");
    }
    return { text: result.text };
  }
}
