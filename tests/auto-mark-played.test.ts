import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceManager } from "../src/services/instance-manager.js";
import {
  loadAutoMarkPlayedConfig,
  markTranscribedAudioPlayed,
} from "../src/services/auto-mark-played.js";
import { transcribeIncomingAudioIfConfigured } from "../src/services/incoming-audio-transcription.js";
import { TranscriptionService } from "../src/services/transcription.js";
import type { NormalizedMessageEvent } from "../src/types/channel.types.js";

const ENV_KEY = "WA_AUTO_MARK_PLAYED";

describe("auto mark played", () => {
  const previous = process.env[ENV_KEY];

  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  });

  it("stays off unless WA_AUTO_MARK_PLAYED=true and rejects other values", () => {
    delete process.env[ENV_KEY];
    expect(loadAutoMarkPlayedConfig()).toEqual({ enabled: false });

    process.env[ENV_KEY] = "false";
    expect(loadAutoMarkPlayedConfig().enabled).toBe(false);

    process.env[ENV_KEY] = "true";
    expect(loadAutoMarkPlayedConfig().enabled).toBe(true);

    process.env[ENV_KEY] = "yes";
    expect(() => loadAutoMarkPlayedConfig()).toThrow(
      "Invalid WA_AUTO_MARK_PLAYED; expected true or false",
    );
  });

  it("does not send a receipt while disabled, for own audio, or when the receipt fails", async () => {
    delete process.env[ENV_KEY];
    const disabled = vi.fn(async () => undefined);
    await markTranscribedAudioPlayed(() => ({ markPlayedMessage: disabled }), "audio-1");
    expect(disabled).not.toHaveBeenCalled();

    process.env[ENV_KEY] = "true";
    const ownAudio = vi.fn(async () => undefined);
    await markTranscribedAudioPlayed(() => ({ markPlayedMessage: ownAudio }), "audio-own", {
      isFromMe: true,
    });
    expect(ownAudio).not.toHaveBeenCalled();

    const failed = vi.fn(async () => {
      throw new Error("socket down");
    });
    await expect(
      markTranscribedAudioPlayed(() => ({ markPlayedMessage: failed }), "audio-2", {
        chatId: "5511999999999@s.whatsapp.net",
      }),
    ).resolves.toBeUndefined();
    expect(failed).toHaveBeenCalledWith("audio-2", "5511999999999@s.whatsapp.net");
  });
});

describe("incoming transcription played receipt", () => {
  const keys = ["WA_TRANSCRIPTION_ENABLED", "WA_TRANSCRIPTION_API_KEY", "WA_AUTO_MARK_PLAYED"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function voiceEvent(): NormalizedMessageEvent {
    return {
      instanceId: "inst_audio",
      chatId: "5511999999999@s.whatsapp.net",
      message: {
        id: "voice-incoming",
        sender: "5511888888888@s.whatsapp.net",
        timestamp: 1_700_000_000,
        type: "audio",
        content: null,
        mediaUrl: null,
        quotedMessageId: null,
        isFromMe: false,
      },
    };
  }

  it("returns the transcription before the played receipt finishes", async () => {
    process.env.WA_TRANSCRIPTION_ENABLED = "true";
    process.env.WA_TRANSCRIPTION_API_KEY = "unit-test-key";
    process.env.WA_AUTO_MARK_PLAYED = "true";
    vi.spyOn(TranscriptionService.prototype, "transcribe").mockResolvedValue({ text: "hello" });
    let releaseReceipt: () => void = () => undefined;
    const markPlayedMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseReceipt = resolve;
        }),
    );
    const manager = {
      getAdapter: () => ({
        downloadMessageAudio: vi.fn(async () => ({
          data: Buffer.from("audio"),
          mimeType: "audio/ogg",
        })),
        markPlayedMessage,
      }),
    } as unknown as InstanceManager;

    const text = await transcribeIncomingAudioIfConfigured(manager, "inst_audio", voiceEvent());

    expect(text).toBe("hello");
    expect(markPlayedMessage).toHaveBeenCalledWith(
      "voice-incoming",
      "5511999999999@s.whatsapp.net",
    );
    releaseReceipt();
    await Promise.resolve();
  });
});
