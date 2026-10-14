import { describe, expect, it, vi } from "vitest";
import { normalizeToWhatsAppVoiceNote, WHATSAPP_VOICE_MIME_TYPE } from "../src/tts/audio.js";
import { getTtsConfig, type TtsConfig } from "../src/tts/config.js";
import { ElevenLabsProvider } from "../src/tts/elevenlabs.js";
import type { TtsAudio, TtsProvider } from "../src/tts/provider.js";
import { chunkText, TtsService } from "../src/tts/service.js";

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
    expect(runFfmpeg).toHaveBeenCalledWith([Buffer.from("ID3-mp3")], "mock-ffmpeg");
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
    );
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
    });
  });
});
