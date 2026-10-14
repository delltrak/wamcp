import {
  convertToWhatsAppVoiceNote,
  DEFAULT_MAX_FFMPEG_OUTPUT_BYTES,
  isOggContainer,
  resolveFfmpegExecutable,
  resolveFfmpegTimeoutMs,
  runFfmpegCommand,
  WHATSAPP_VOICE_MIME_TYPE,
} from "./audio.js";
import type { TtsAudio } from "./provider.js";

export const WHATSAPP_WAVEFORM_SAMPLES = 64;
export const WAVEFORM_SAMPLE_RATE = 16_000;

const PCM_DECODER_ARGS = [
  "-vn",
  "-ac",
  "1",
  "-ar",
  String(WAVEFORM_SAMPLE_RATE),
  "-f",
  "s16le",
  "-acodec",
  "pcm_s16le",
  "pipe:1",
];

export interface AudioWaveformMetadata {
  seconds: number;
  waveform: Uint8Array;
}

export interface PreparedPttAudio extends AudioWaveformMetadata {
  audio: Buffer;
  mimeType: string;
}

export interface WaveformDependencies {
  executable?: string;
  timeoutMs?: number;
  decodePcm?: PcmDecoder;
  convertToOpus?: VoiceNoteConverter;
}

export type PcmDecoder = (audio: Buffer, executable: string, timeoutMs: number) => Promise<Buffer>;

export type VoiceNoteConverter = (
  audio: Buffer,
  executable: string,
  timeoutMs: number,
) => Promise<TtsAudio>;

const defaultVoiceNoteConverter: VoiceNoteConverter = (audio, executable, timeoutMs) =>
  convertToWhatsAppVoiceNote(audio, executable, undefined, timeoutMs);

function isOggOpus(audio: Buffer): boolean {
  if (!isOggContainer(audio) || audio.length < 28) return false;

  const segmentCount = audio[26]!;
  const bodyStart = 27 + segmentCount;
  if (bodyStart > audio.length) return false;

  let packetLength = 0;
  let packetComplete = false;
  for (let index = 0; index < segmentCount; index += 1) {
    const segmentLength = audio[27 + index]!;
    packetLength += segmentLength;
    if (segmentLength < 255) {
      packetComplete = true;
      break;
    }
  }

  if (!packetComplete || bodyStart + packetLength > audio.length || packetLength < 8) {
    return false;
  }
  return audio.subarray(bodyStart, bodyStart + 8).toString("ascii") === "OpusHead";
}

/** Decode any supported audio input to mono, signed 16-bit PCM at 16 kHz. */
export function decodeAudioToPcm(
  audio: Buffer,
  executable = resolveFfmpegExecutable(),
  timeoutMs = resolveFfmpegTimeoutMs(process.env.WA_TTS_TIMEOUT_MS),
): Promise<Buffer> {
  return runFfmpegCommand(
    [audio],
    ["-i", "pipe:0", ...PCM_DECODER_ARGS],
    executable,
    timeoutMs,
    DEFAULT_MAX_FFMPEG_OUTPUT_BYTES,
  );
}

export async function computeAudioWaveformAndDuration(
  audio: Buffer,
  dependencies: WaveformDependencies = {},
): Promise<AudioWaveformMetadata> {
  const pcm = await (dependencies.decodePcm ?? decodeAudioToPcm)(
    audio,
    dependencies.executable ?? resolveFfmpegExecutable(),
    dependencies.timeoutMs ?? resolveFfmpegTimeoutMs(process.env.WA_TTS_TIMEOUT_MS),
  );
  return calculateAudioWaveformAndDuration(pcm);
}

/** Calculate the PTT metadata from mono s16le PCM at 16 kHz. */
export function calculateAudioWaveformAndDuration(pcm: Buffer): AudioWaveformMetadata {
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) throw new Error("ffmpeg returned no audio samples.");

  const levels = new Float64Array(WHATSAPP_WAVEFORM_SAMPLES);
  for (let bucket = 0; bucket < WHATSAPP_WAVEFORM_SAMPLES; bucket += 1) {
    const start = Math.floor((bucket * sampleCount) / WHATSAPP_WAVEFORM_SAMPLES);
    const end = Math.floor(((bucket + 1) * sampleCount) / WHATSAPP_WAVEFORM_SAMPLES);
    if (end <= start) continue;

    let sumOfSquares = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const sample = pcm.readInt16LE(sampleIndex * 2);
      sumOfSquares += sample * sample;
    }
    levels[bucket] = Math.sqrt(sumOfSquares / (end - start));
  }

  const maximum = Math.max(...levels);
  const waveform = new Uint8Array(WHATSAPP_WAVEFORM_SAMPLES);
  if (maximum > 0) {
    for (let bucket = 0; bucket < levels.length; bucket += 1) {
      waveform[bucket] = Math.round((levels[bucket]! / maximum) * 100);
    }
  }

  return {
    seconds: Math.max(1, Math.ceil(sampleCount / WAVEFORM_SAMPLE_RATE)),
    waveform,
  };
}

export async function preparePttAudio(
  audio: Buffer,
  mimeType?: string,
  dependencies: WaveformDependencies = {},
): Promise<Partial<PreparedPttAudio> & Pick<PreparedPttAudio, "audio" | "mimeType">> {
  const executable = dependencies.executable ?? resolveFfmpegExecutable();
  const timeoutMs = dependencies.timeoutMs ?? resolveFfmpegTimeoutMs(process.env.WA_TTS_TIMEOUT_MS);
  const isOpus = isOggOpus(audio);
  let preparedAudio = audio;
  let preparedMimeType = mimeType ?? WHATSAPP_VOICE_MIME_TYPE;

  if (!isOpus) {
    try {
      const converted = await (dependencies.convertToOpus ?? defaultVoiceNoteConverter)(
        audio,
        executable,
        timeoutMs,
      );
      preparedAudio = converted.audio;
      preparedMimeType = converted.mimeType;
    } catch {
      return { audio, mimeType: preparedMimeType };
    }
  } else {
    preparedMimeType = WHATSAPP_VOICE_MIME_TYPE;
  }

  try {
    const metadata = await computeAudioWaveformAndDuration(preparedAudio, {
      executable,
      timeoutMs,
      decodePcm: dependencies.decodePcm,
    });
    return { audio: preparedAudio, mimeType: preparedMimeType, ...metadata };
  } catch {
    return { audio: preparedAudio, mimeType: preparedMimeType };
  }
}
