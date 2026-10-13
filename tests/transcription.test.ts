import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionService } from "../src/services/transcription.js";

const ENV_KEYS = [
  "WA_TRANSCRIPTION_ENABLED",
  "WA_TRANSCRIPTION_API_KEY",
  "WA_TRANSCRIPTION_BASE_URL",
  "WA_TRANSCRIPTION_MODEL",
  "WA_TRANSCRIPTION_LANGUAGE",
  "WA_TRANSCRIPTION_MAX_MB",
  "WA_TRANSCRIPTION_TIMEOUT_MS",
] as const;

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

describe("TranscriptionService", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
  });

  it("stays disabled without configuration and reports a clear error", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new TranscriptionService();

    expect(service.isConfigured()).toBe(false);
    expect(() => service.assertConfigured()).toThrow(/transcription not configured/i);
    await expect(service.transcribe(Buffer.from("audio"))).rejects.toThrow(
      /transcription not configured/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts multipart audio to the configured OpenAI-compatible endpoint", async () => {
    process.env.WA_TRANSCRIPTION_ENABLED = "true";
    process.env.WA_TRANSCRIPTION_API_KEY = "unit-test-key";
    process.env.WA_TRANSCRIPTION_BASE_URL = "https://speech.example.test/v1/";
    process.env.WA_TRANSCRIPTION_MODEL = "test-whisper";
    process.env.WA_TRANSCRIPTION_LANGUAGE = "pt";
    process.env.WA_TRANSCRIPTION_TIMEOUT_MS = "5000";

    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: "hello from audio" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const service = new TranscriptionService();
    const result = await service.transcribe(Buffer.from("audio bytes"), "audio/ogg; codecs=opus");

    expect(result).toEqual({ text: "hello from audio" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://speech.example.test/v1/audio/transcriptions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer unit-test-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const form = init.body as FormData;
    expect(form.get("model")).toBe("test-whisper");
    expect(form.get("language")).toBe("pt");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(file.size).toBe(Buffer.byteLength("audio bytes"));
  });

  it("rejects audio larger than the configured limit before making a request", async () => {
    process.env.WA_TRANSCRIPTION_ENABLED = "true";
    process.env.WA_TRANSCRIPTION_API_KEY = "unit-test-key";
    process.env.WA_TRANSCRIPTION_MAX_MB = "1";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new TranscriptionService();

    await expect(service.transcribe(Buffer.alloc(1024 * 1024 + 1))).rejects.toThrow(
      /maximum transcription size of 1 MB/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an unsuccessful provider status without parsing provider details", async () => {
    process.env.WA_TRANSCRIPTION_ENABLED = "true";
    process.env.WA_TRANSCRIPTION_API_KEY = "unit-test-key";
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new TranscriptionService().transcribe(Buffer.from("audio"))).rejects.toThrow(
      "Transcription request failed: HTTP 503",
    );
  });
});
