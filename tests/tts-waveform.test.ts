import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  calculateAudioWaveformAndDuration,
  computeAudioWaveformAndDuration,
  decodeAudioToPcm,
  preparePttAudio,
  WHATSAPP_WAVEFORM_SAMPLES,
  WAVEFORM_SAMPLE_RATE,
} from "../src/tts/waveform.js";
import { WHATSAPP_VOICE_MIME_TYPE } from "../src/tts/audio.js";

function pcmWithBucketLevels(levels: number[], samplesPerBucket = 500): Buffer {
  const pcm = Buffer.alloc(levels.length * samplesPerBucket * 2);
  levels.forEach((level, bucket) => {
    const start = bucket * samplesPerBucket;
    for (let sample = 0; sample < samplesPerBucket; sample += 1) {
      pcm.writeInt16LE(level, (start + sample) * 2);
    }
  });
  return pcm;
}

function oggOpusFixture(): Buffer {
  const audio = Buffer.alloc(28 + 19);
  audio.write("OggS", 0, "ascii");
  audio[26] = 1;
  audio[27] = 19;
  audio.write("OpusHead", 28, "ascii");
  return audio;
}

describe("PTT waveform metadata", () => {
  it("uses ffmpeg to decode mono 16 kHz signed PCM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ptt-waveform-"));
    const executable = join(directory, "mock-ffmpeg");
    const argsPath = join(directory, "args.txt");
    const pcmFixture = Buffer.from([0x01, 0x00, 0xff, 0x7f]);
    const script = `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsPath)}\ncat >/dev/null\nprintf '\\001\\000\\377\\177'\n`;
    await writeFile(executable, script, { mode: 0o755 });

    try {
      const decoded = await decodeAudioToPcm(Buffer.from("audio fixture"), executable, 5000);
      const args = (await readFile(argsPath, "utf8")).trim().split("\n");

      expect(decoded).toEqual(pcmFixture);
      expect(args).toEqual([
        "-i",
        "pipe:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "pipe:1",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("decodes through the configured ffmpeg runner and creates 64 normalized bars", async () => {
    const audio = Buffer.from("audio fixture");
    const levels = Array.from({ length: WHATSAPP_WAVEFORM_SAMPLES }, (_, index) => index * 400);
    const decodePcm = vi.fn(async () => pcmWithBucketLevels(levels));

    const result = await computeAudioWaveformAndDuration(audio, {
      executable: "mock-ffmpeg",
      timeoutMs: 321,
      decodePcm,
    });

    expect(decodePcm).toHaveBeenCalledWith(audio, "mock-ffmpeg", 321);
    expect(result.seconds).toBe(2);
    expect(result.waveform).toBeInstanceOf(Uint8Array);
    expect(result.waveform).toHaveLength(64);
    expect([...result.waveform]).toEqual(expect.arrayContaining([0, 100]));
    expect(Math.min(...result.waveform)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...result.waveform)).toBeLessThanOrEqual(100);
    expect(result.waveform[0]).toBe(0);
    expect(result.waveform[63]).toBe(100);
  });

  it("returns 64 zero bars for silence", () => {
    const pcm = Buffer.alloc(WAVEFORM_SAMPLE_RATE * 2 * 3);
    const result = calculateAudioWaveformAndDuration(pcm);

    expect(result.seconds).toBe(3);
    expect([...result.waveform]).toEqual(Array(64).fill(0));
  });

  it("rounds duration up to whole seconds and keeps a minimum duration of one", () => {
    const shorterThanOneSecond = Buffer.alloc((WAVEFORM_SAMPLE_RATE + 1) * 2);
    const short = Buffer.alloc(2);

    expect(calculateAudioWaveformAndDuration(shorterThanOneSecond).seconds).toBe(2);
    expect(calculateAudioWaveformAndDuration(short).seconds).toBe(1);
  });

  it("converts non-Opus audio to OGG/Opus before attaching metadata", async () => {
    const source = Buffer.from("mp3 fixture");
    const opus = Buffer.from("OggS mock OpusHead");
    const converted = vi.fn(async () => ({ audio: opus, mimeType: WHATSAPP_VOICE_MIME_TYPE }));
    const decodePcm = vi.fn(async () => Buffer.alloc(WAVEFORM_SAMPLE_RATE * 2));

    const result = await preparePttAudio(source, "audio/mpeg", {
      executable: "mock-ffmpeg",
      timeoutMs: 456,
      convertToOpus: converted,
      decodePcm,
    });

    expect(converted).toHaveBeenCalledWith(source, "mock-ffmpeg", 456);
    expect(decodePcm).toHaveBeenCalledWith(opus, "mock-ffmpeg", 456);
    expect(result).toMatchObject({
      audio: opus,
      mimeType: WHATSAPP_VOICE_MIME_TYPE,
      seconds: 1,
    });
    expect(result.waveform).toBeInstanceOf(Uint8Array);
    expect(result.waveform).toHaveLength(64);
  });

  it("sends non-Opus input without metadata when conversion fails", async () => {
    const source = Buffer.from("mp3 fixture");
    const convertToOpus = vi.fn(async () => {
      throw new Error("ffmpeg conversion failed");
    });

    const result = await preparePttAudio(source, "audio/mpeg", { convertToOpus });

    expect(result).toEqual({ audio: source, mimeType: "audio/mpeg" });
  });

  it("keeps converted Opus audio when waveform decoding fails", async () => {
    const opus = oggOpusFixture();
    const decodePcm = vi.fn(async () => {
      throw new Error("ffmpeg decode failed");
    });

    const result = await preparePttAudio(opus, undefined, { decodePcm });

    expect(result).toEqual({ audio: opus, mimeType: WHATSAPP_VOICE_MIME_TYPE });
  });
});
