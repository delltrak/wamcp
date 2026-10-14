import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeToWhatsAppVoiceNote, WHATSAPP_VOICE_MIME_TYPE } from "../src/tts/audio.js";
import { getTtsConfig, type TtsConfig } from "../src/tts/config.js";
import { ElevenLabsProvider } from "../src/tts/elevenlabs.js";
import type { TtsAudio, TtsProvider } from "../src/tts/provider.js";
import { chunkText, TtsService } from "../src/tts/service.js";
import { SendVoiceSchema, TtsPreviewSchema } from "../src/schemas/tts.schema.js";

function config(overrides: Partial<TtsConfig> = {}): TtsConfig {
  return {
    enabled: true,
    provider: "elevenlabs",
    apiKey: "unit-test-only-placeholder",
    defaultVoiceId: "test-voice-id",
    modelId: "eleven_v3",
    languageCode: undefined,
    outputFormat: "opus_48000_64",
    maxChars: 5000,
    concurrency: 2,
    baseUrl: "https://api.elevenlabs.io",
    timeoutMs: 5000,
    ...overrides,
  };
}

describe("ElevenLabsProvider", () => {
  it("posts the configured model, language, settings, and chunk context", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(Buffer.from("OggS-audio"), {
        headers: { "content-type": "audio/ogg; codecs=opus" },
      }),
    );
    const provider = new ElevenLabsProvider(
      config({ baseUrl: "https://api.eu.residency.elevenlabs.io/v1/" }),
      { fetch: fetchMock },
    );

    const result = await provider.synthesize("Hello there", {
      voiceId: "created-voice-id",
      modelId: "eleven_v4_turbo",
      languageCode: "en",
      voiceSettings: {
        stability: 0.4,
        similarityBoost: 0.8,
        style: 0.2,
        speed: 1.1,
        useSpeakerBoost: true,
      },
      previousText: "Before",
      nextText: "After",
    });

    expect(result).toEqual({
      audio: Buffer.from("OggS-audio"),
      mimeType: "audio/ogg; codecs=opus",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(
      "https://api.eu.residency.elevenlabs.io/v1/text-to-speech/created-voice-id?output_format=opus_48000_64",
    );
    expect(new Headers(init?.headers).get("xi-api-key")).toBe("unit-test-only-placeholder");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "Hello there",
      model_id: "eleven_v4_turbo",
      language_code: "en",
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
        style: 0.2,
        speed: 1.1,
        use_speaker_boost: true,
      },
      previous_text: "Before",
      next_text: "After",
    });
  });

  it("maps credential, voice, and quota failures without exposing request data", async () => {
    const cases = [
      [401, /invalid.*api key/i],
      [404, /voice/i],
      [422, /voice/i],
      [402, /quota/i],
      [429, /quota|rate limit/i],
    ] as const;

    for (const [status, message] of cases) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private response body", { status }));
      const provider = new ElevenLabsProvider(config(), {
        fetch: fetchMock,
        maxAttempts: 1,
      });
      const error = await provider
        .synthesize("private text that must not appear in errors", { voiceId: "bad-voice-id" })
        .then(
          () => new Error("expected request to fail"),
          (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
        );
      expect(error.message).toMatch(message);
      expect(error.message).not.toContain("private text");
      expect(error.message).not.toContain("private response body");
      expect(error.message).not.toContain("unit-test-only-placeholder");
    }
  });

  it("retries only 429 and 5xx responses with jittered backoff", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(Buffer.from("OggS-audio")));
    const sleep = vi.fn(async () => {});
    const provider = new ElevenLabsProvider(config(), {
      fetch: fetchMock,
      sleep,
      random: () => 0,
    });

    await provider.synthesize("Hello", { voiceId: "test-voice-id" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);

    const rateLimitFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response(Buffer.from("OggS-audio")));
    const rateLimitProvider = new ElevenLabsProvider(config(), {
      fetch: rateLimitFetch,
      sleep,
      random: () => 0,
    });
    await rateLimitProvider.synthesize("Hello", { voiceId: "test-voice-id" });
    expect(rateLimitFetch).toHaveBeenCalledTimes(2);

    const badRequestFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 400 }));
    const noRetryProvider = new ElevenLabsProvider(config(), {
      fetch: badRequestFetch,
      sleep,
    });
    await expect(noRetryProvider.synthesize("Hello", { voiceId: "test-voice-id" })).rejects.toThrow(
      "HTTP 400",
    );
    expect(badRequestFetch).toHaveBeenCalledTimes(1);
  });

  it("cancels response bodies before retrying and before returning a final error", async () => {
    const retryCancel = vi.fn();
    const retryResponse = new Response(new ReadableStream({ cancel: retryCancel }), {
      status: 503,
    });
    const retryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(retryResponse)
      .mockResolvedValueOnce(new Response(Buffer.from("OggS-audio")));
    const retryProvider = new ElevenLabsProvider(config(), {
      fetch: retryFetch,
      sleep: async () => {},
      random: () => 0,
    });
    await retryProvider.synthesize("Hello", { voiceId: "test-voice-id" });
    expect(retryCancel).toHaveBeenCalledOnce();

    const errorCancel = vi.fn();
    const errorResponse = new Response(new ReadableStream({ cancel: errorCancel }), {
      status: 400,
    });
    const errorProvider = new ElevenLabsProvider(config(), {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(errorResponse),
      maxAttempts: 1,
    });
    await expect(errorProvider.synthesize("Hello", { voiceId: "test-voice-id" })).rejects.toThrow(
      "HTTP 400",
    );
    expect(errorCancel).toHaveBeenCalledOnce();
  });

  it("honors Retry-After seconds and HTTP dates, clamped to 30 seconds", async () => {
    const cases = [
      ["2", 2000],
      [new Date(Date.now() + 5_000).toUTCString(), undefined],
      ["90", 30_000],
    ] as const;

    for (const [retryAfter, expected] of cases) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("", { status: 503, headers: { "retry-after": retryAfter } }),
        )
        .mockResolvedValueOnce(new Response(Buffer.from("OggS-audio")));
      const sleep = vi.fn(async () => {});
      const provider = new ElevenLabsProvider(config(), {
        fetch: fetchMock,
        sleep,
        random: () => 0,
      });
      await provider.synthesize("Hello", { voiceId: "test-voice-id" });
      const delay = sleep.mock.calls[0]?.[0];
      expect(delay).toBeDefined();
      if (expected !== undefined) expect(delay).toBe(expected);
      if (retryAfter !== "2" && retryAfter !== "90") {
        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(5000);
      }
    }
  });

  it("rejects oversized synthesis responses from Content-Length and streamed bodies", async () => {
    const contentLengthCancel = vi.fn();
    const contentLengthProvider = new ElevenLabsProvider(config(), {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new ReadableStream({ cancel: contentLengthCancel }), {
          headers: { "content-length": "4" },
        }),
      ),
      maxResponseBytes: 3,
    });
    await expect(
      contentLengthProvider.synthesize("Hello", { voiceId: "test-voice-id" }),
    ).rejects.toThrow(/maximum allowed size of 3 bytes/i);
    expect(contentLengthCancel).toHaveBeenCalledOnce();

    const streamCancel = vi.fn();
    const streamingProvider = new ElevenLabsProvider(config(), {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              controller.enqueue(new Uint8Array([3, 4]));
            },
            cancel: streamCancel,
          }),
        ),
      ),
      maxResponseBytes: 3,
    });
    await expect(
      streamingProvider.synthesize("Hello", { voiceId: "test-voice-id" }),
    ).rejects.toThrow(/maximum allowed size of 3 bytes/i);
    expect(streamCancel).toHaveBeenCalledOnce();
  });

  it("lists provider and Voice Design voices by their normal voice IDs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          voices: [
            { voice_id: "design-voice-id", name: "Created voice", category: "generated" },
            { voice_id: "library-voice-id", name: "Library voice", category: "premade" },
          ],
        }),
      ),
    );
    const voices = await new ElevenLabsProvider(config(), { fetch: fetchMock }).listVoices();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.elevenlabs.io/v1/voices");
    expect(voices).toEqual([
      { voiceId: "design-voice-id", name: "Created voice", category: "generated" },
      { voiceId: "library-voice-id", name: "Library voice", category: "premade" },
    ]);
  });
});

describe("TtsService", () => {
  it("stays disabled or unconfigured without contacting the provider", async () => {
    const provider: TtsProvider = {
      synthesize: vi.fn(),
    };
    const disabled = new TtsService({ config: config({ enabled: false }), provider });
    expect(() => disabled.assertConfigured()).toThrow(/TTS is disabled/i);
    await expect(disabled.synthesize("Hello")).rejects.toThrow(/TTS is disabled/i);

    const unconfigured = new TtsService({ config: config({ apiKey: undefined }), provider });
    expect(() => unconfigured.assertConfigured()).toThrow(/WA_TTS_API_KEY/i);
    await expect(unconfigured.synthesize("Hello")).rejects.toThrow(/WA_TTS_API_KEY/i);
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it("reports missing voices and text above the configured limit", async () => {
    const provider: TtsProvider = { synthesize: vi.fn() };
    const missingVoice = new TtsService({
      config: config({ defaultVoiceId: undefined }),
      provider,
    });
    await expect(missingVoice.synthesize("Hello")).rejects.toThrow(/voice is configured/i);

    const limited = new TtsService({ config: config({ maxChars: 3 }), provider });
    await expect(limited.synthesize("four")).rejects.toThrow(/3 characters/i);
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it("counts astral symbols as one character in service and tool limits", async () => {
    const provider: TtsProvider = {
      synthesize: vi.fn(async () => ({ audio: Buffer.from("OggS-audio"), mimeType: "audio/ogg" })),
    };
    const limited = new TtsService({ config: config({ maxChars: 3 }), provider });
    await expect(limited.synthesize("🙂🙂🙂")).resolves.toMatchObject({
      mimeType: "audio/ogg; codecs=opus",
    });
    await expect(limited.synthesize("🙂🙂🙂🙂")).rejects.toThrow(/3 characters/i);

    const validVoiceInput = {
      instanceId: "instance",
      to: "12345",
      text: "🙂".repeat(65_536),
    };
    expect(SendVoiceSchema.safeParse(validVoiceInput).success).toBe(true);
    expect(
      SendVoiceSchema.safeParse({ ...validVoiceInput, text: `${validVoiceInput.text}🙂` }).success,
    ).toBe(false);
    expect(TtsPreviewSchema.safeParse({ text: "🙂".repeat(65_536) }).success).toBe(true);
    expect(TtsPreviewSchema.safeParse({ text: "🙂".repeat(65_537) }).success).toBe(false);
  });

  it("limits concurrent provider synthesis and ffmpeg work across calls", async () => {
    let activeOperations = 0;
    let maxActiveOperations = 0;
    const synthesize = vi.fn(async (): Promise<TtsAudio> => {
      activeOperations += 1;
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
      return { audio: Buffer.from("mp3-audio"), mimeType: "audio/mpeg" };
    });
    const converter = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeOperations -= 1;
      return Buffer.from("OggS-converted");
    });
    const services = Array.from(
      { length: 2 },
      () =>
        new TtsService({
          config: config({ concurrency: 2 }),
          provider: { synthesize },
          ffmpegRunner: converter,
        }),
    );

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        services[index % services.length]!.synthesize("Hello"),
      ),
    );
    expect(synthesize).toHaveBeenCalledTimes(5);
    expect(converter).toHaveBeenCalledTimes(5);
    expect(maxActiveOperations).toBe(2);
  });

  it("chunks without losing text and passes neighboring chunks for continuity", async () => {
    const text = "a ".repeat(2300);
    const parts = chunkText(text);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => Array.from(part).length <= 4500)).toBe(true);

    const synthesize = vi.fn(async (): Promise<TtsAudio> => ({
      audio: Buffer.from("OggS-chunk"),
      mimeType: "audio/ogg",
    }));
    const converter = vi.fn(async () => Buffer.from("OggS-joined-audio"));
    const service = new TtsService({
      config: config({ maxChars: 5000 }),
      provider: { synthesize },
      ffmpegRunner: converter,
    });

    const result = await service.synthesize(text, { voiceId: "test-voice-id" });
    expect(result).toEqual({
      audio: Buffer.from("OggS-joined-audio"),
      mimeType: WHATSAPP_VOICE_MIME_TYPE,
    });
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(synthesize.mock.calls[0]?.[1]).toMatchObject({ nextText: parts[1] });
    expect(synthesize.mock.calls[1]?.[1]).toMatchObject({ previousText: parts[0] });
    expect(converter).toHaveBeenCalledWith(
      [Buffer.from("OggS-chunk"), Buffer.from("OggS-chunk")],
      "ffmpeg",
      5000,
    );
  });

  it("keeps Unicode code points intact when splitting long text", () => {
    const text = "🙂".repeat(4501);
    const parts = chunkText(text);
    expect(parts.join("")).toBe(text);
    expect(parts.map((part) => Array.from(part).length)).toEqual([4500, 1]);
  });
});

describe("WhatsApp audio normalization", () => {
  it("reuses a provider response only when it has the OGG magic bytes", async () => {
    const runFfmpeg = vi.fn(async () => Buffer.from("OggS-converted"));
    const ogg = await normalizeToWhatsAppVoiceNote(
      [{ audio: Buffer.from("OggS-opus"), mimeType: "audio/ogg" }],
      "mock-ffmpeg",
      runFfmpeg,
    );
    expect(ogg).toEqual({ audio: Buffer.from("OggS-opus"), mimeType: WHATSAPP_VOICE_MIME_TYPE });
    expect(runFfmpeg).not.toHaveBeenCalled();

    const converted = await normalizeToWhatsAppVoiceNote(
      [{ audio: Buffer.from("ID3-mp3"), mimeType: "audio/mpeg" }],
      "mock-ffmpeg",
      runFfmpeg,
    );
    expect(converted).toEqual({
      audio: Buffer.from("OggS-converted"),
      mimeType: WHATSAPP_VOICE_MIME_TYPE,
    });
    expect(runFfmpeg).toHaveBeenCalledWith([Buffer.from("ID3-mp3")], "mock-ffmpeg", 60_000);
  });

  it("re-encodes multiple OGG segments instead of byte-concatenating them", async () => {
    const runFfmpeg = vi.fn(async () => Buffer.from("OggS-re-encoded"));
    const chunks = [
      { audio: Buffer.from("OggS-first"), mimeType: "audio/ogg" },
      { audio: Buffer.from("OggS-second"), mimeType: "audio/ogg" },
    ];
    await normalizeToWhatsAppVoiceNote(chunks, "mock-ffmpeg", runFfmpeg);
    expect(runFfmpeg).toHaveBeenCalledWith(
      chunks.map((chunk) => chunk.audio),
      "mock-ffmpeg",
      60_000,
    );
  });

  it("kills ffmpeg on timeout and includes a sanitized stderr tail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tts-ffmpeg-"));
    const executable = join(directory, "fake-ffmpeg");
    const pidPath = join(directory, "pid");
    const script = `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(pidPath)}\nprintf 'begin-marker' >&2\nprintf '%3000s' '' | tr ' ' x >&2\nprintf '\\033[31mfinal-marker\\033[0m' >&2\nexec sleep 30\n`;
    await writeFile(executable, script, { mode: 0o755 });

    try {
      const error = await normalizeToWhatsAppVoiceNote(
        [{ audio: Buffer.from("ID3-audio"), mimeType: "audio/mpeg" }],
        executable,
        undefined,
        1000,
      ).then(
        () => new Error("expected ffmpeg timeout"),
        (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
      );
      expect(error.message).toMatch(/ffmpeg timed out after 1000 ms/i);
      expect(error.message).toContain("final-marker");
      expect(error.message).not.toContain("begin-marker");
      expect(error.message).not.toContain("\u001b");

      const pid = Number(await readFile(pidPath, "utf8"));
      let exited = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch {
          exited = true;
          break;
        }
      }
      expect(exited).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("explains how to install ffmpeg when it cannot be found", async () => {
    const missingFfmpeg = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    await expect(
      normalizeToWhatsAppVoiceNote(
        [{ audio: Buffer.from("ID3-mp3"), mimeType: "audio/mpeg" }],
        "missing-ffmpeg",
        async () => Promise.reject(missingFfmpeg),
      ),
    ).rejects.toThrow(/Install ffmpeg or set WA_TTS_FFMPEG_PATH/i);
  });
});

describe("TTS configuration", () => {
  it("uses provider-agnostic defaults while remaining disabled", () => {
    const config = getTtsConfig({});
    expect(config).toMatchObject({
      enabled: false,
      provider: "elevenlabs",
      modelId: "eleven_v3",
      outputFormat: "opus_48000_64",
      maxChars: 5000,
      concurrency: 2,
    });
  });

  it("validates the provider URL scheme and defaults concurrency to two", () => {
    expect(getTtsConfig({}).concurrency).toBe(2);
    expect(getTtsConfig({ TTS_CONCURRENCY: "4" }).concurrency).toBe(4);
    expect(getTtsConfig({ TTS_CONCURRENCY: "0" }).concurrency).toBe(2);
    expect(getTtsConfig({ WA_TTS_BASE_URL: "http://localhost:5000" }).baseUrl).toBe(
      "http://localhost:5000",
    );
    expect(getTtsConfig({ WA_TTS_BASE_URL: "http://127.0.0.1:5000" }).baseUrl).toBe(
      "http://127.0.0.1:5000",
    );
    expect(() => getTtsConfig({ WA_TTS_BASE_URL: "http://example.com" })).toThrow(
      /Invalid WA_TTS_BASE_URL.*HTTPS/i,
    );
    expect(() => new ElevenLabsProvider(config({ baseUrl: "http://example.com" }))).toThrow(
      /Invalid WA_TTS_BASE_URL.*HTTPS/i,
    );
  });
});
