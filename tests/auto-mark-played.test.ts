import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadAutoMarkPlayedConfig,
  markTranscribedAudioPlayed,
} from "../src/services/auto-mark-played.js";

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
      markTranscribedAudioPlayed(() => ({ markPlayedMessage: failed }), "audio-2"),
    ).resolves.toBeUndefined();
    expect(failed).toHaveBeenCalledWith("audio-2");
  });
});
