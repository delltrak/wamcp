import { spawn } from "node:child_process";
import { MAX_BASE64_MEDIA_BYTES } from "../constants.js";
import type { TtsAudio } from "./provider.js";

export const WHATSAPP_VOICE_MIME_TYPE = "audio/ogg; codecs=opus";
export const DEFAULT_FFMPEG_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_FFMPEG_OUTPUT_BYTES = MAX_BASE64_MEDIA_BYTES;
const STDERR_TAIL_MAX_BYTES = 2 * 1024;
const FFMPEG_FORMAT_ARGS = [
  "-vn",
  "-ac",
  "1",
  "-ar",
  "48000",
  "-c:a",
  "libopus",
  "-b:a",
  "64k",
  "-application",
  "voip",
  "-f",
  "ogg",
  "pipe:1",
];

export type FfmpegRunner = (
  chunks: Buffer[],
  executable: string,
  timeoutMs: number,
  maxOutputBytes?: number,
) => Promise<Buffer>;

export function resolveFfmpegExecutable(): string {
  return process.env.WA_TTS_FFMPEG_PATH?.trim() || "ffmpeg";
}

export function resolveFfmpegTimeoutMs(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_FFMPEG_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_FFMPEG_TIMEOUT_MS;
}

export function isOggContainer(audio: Buffer): boolean {
  return audio.length >= 4 && audio.subarray(0, 4).toString("ascii") === "OggS";
}

export async function normalizeToWhatsAppVoiceNote(
  chunks: TtsAudio[],
  executable = resolveFfmpegExecutable(),
  runFfmpeg: FfmpegRunner = transcodeWithFfmpeg,
  timeoutMs = resolveFfmpegTimeoutMs(process.env.WA_TTS_TIMEOUT_MS),
): Promise<TtsAudio> {
  if (chunks.length === 0) throw new Error("TTS provider returned no audio chunks.");
  if (chunks.length === 1 && isOggContainer(chunks[0]!.audio)) {
    return { audio: chunks[0]!.audio, mimeType: WHATSAPP_VOICE_MIME_TYPE };
  }

  try {
    const audio = await runFfmpeg(
      chunks.map((chunk) => chunk.audio),
      executable,
      timeoutMs,
    );
    if (!isOggContainer(audio)) {
      throw new Error("ffmpeg did not produce an OGG container.");
    }
    return { audio, mimeType: WHATSAPP_VOICE_MIME_TYPE };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "ffmpeg is required to convert TTS audio to WhatsApp OGG/Opus. Install ffmpeg or set WA_TTS_FFMPEG_PATH.",
        { cause: error },
      );
    }
    if (error instanceof Error && error.message.includes("ffmpeg")) throw error;
    throw new Error(
      "Could not convert TTS audio to WhatsApp OGG/Opus. Check that ffmpeg is installed.",
      { cause: error },
    );
  }
}

/** Convert arbitrary audio to the mono 48 kHz OGG/Opus format used for WhatsApp voice notes. */
export async function convertToWhatsAppVoiceNote(
  audio: Buffer,
  executable = resolveFfmpegExecutable(),
  runFfmpeg: FfmpegRunner = transcodeWithFfmpeg,
  timeoutMs = resolveFfmpegTimeoutMs(process.env.WA_TTS_TIMEOUT_MS),
): Promise<TtsAudio> {
  const converted = await runFfmpeg(
    [audio],
    executable,
    timeoutMs,
    DEFAULT_MAX_FFMPEG_OUTPUT_BYTES,
  );
  if (converted.length > DEFAULT_MAX_FFMPEG_OUTPUT_BYTES) {
    throw new Error(`ffmpeg output exceeded the ${DEFAULT_MAX_FFMPEG_OUTPUT_BYTES} byte limit.`);
  }
  if (!isOggContainer(converted)) {
    throw new Error("ffmpeg did not produce an OGG container.");
  }
  return { audio: converted, mimeType: WHATSAPP_VOICE_MIME_TYPE };
}

function transcodeWithFfmpeg(
  chunks: Buffer[],
  executable: string,
  timeoutMs = resolveFfmpegTimeoutMs(process.env.WA_TTS_TIMEOUT_MS),
  maxOutputBytes?: number,
): Promise<Buffer> {
  const inputFileDescriptors = chunks.map((_, index) => (index === 0 ? 0 : index + 2));
  const args: string[] = [];
  for (const descriptor of inputFileDescriptors) args.push("-i", `pipe:${descriptor}`);

  if (chunks.length > 1) {
    const inputs = chunks.map((_, index) => `[${index}:a:0]`).join("");
    args.push(
      "-filter_complex",
      `${inputs}concat=n=${chunks.length}:v=0:a=1[out]`,
      "-map",
      "[out]",
    );
  }
  args.push(...FFMPEG_FORMAT_ARGS);
  return runFfmpegCommand(chunks, args, executable, timeoutMs, maxOutputBytes);
}

/** Run ffmpeg with stdin pipes, a timeout, and an optional bound on stdout size. */
export function runFfmpegCommand(
  chunks: Buffer[],
  args: string[],
  executable: string,
  timeoutMs = resolveFfmpegTimeoutMs(process.env.WA_TTS_TIMEOUT_MS),
  maxOutputBytes?: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inputFileDescriptors = chunks.map((_, index) => (index === 0 ? 0 : index + 2));
    const stdio: Array<"pipe" | "ignore"> = ["pipe", "pipe", "pipe"];
    for (let index = 1; index < chunks.length; index += 1) stdio.push("pipe");

    let child;
    try {
      child = spawn(executable, args, { stdio });
    } catch (error) {
      reject(error);
      return;
    }

    const output: Buffer[] = [];
    let outputBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let settled = false;
    let stopped = false;
    const clearTimer = (): void => clearTimeout(timeout);
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      reject(error);
    };
    const finishResolve = (audio: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolve(audio);
    };
    const timeout = setTimeout(() => {
      stopped = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Still reject with the timeout even if the child has already exited.
      }
      finishReject(
        new Error(appendStderrTail(`ffmpeg timed out after ${timeoutMs} ms.`, stderrTail)),
      );
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      const data = Buffer.from(chunk);
      outputBytes += data.length;
      if (maxOutputBytes !== undefined && outputBytes > maxOutputBytes) {
        stopped = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // The output size error remains the useful failure.
        }
        finishReject(new Error(`ffmpeg output exceeded the ${maxOutputBytes} byte limit.`));
        return;
      }
      output.push(data);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const data = Buffer.from(chunk);
      const combined = Buffer.concat([stderrTail, data]);
      stderrTail = combined.subarray(Math.max(0, combined.length - STDERR_TAIL_MAX_BYTES));
    });
    child.on("error", (error) => finishReject(error));
    child.on("close", (code) => {
      if (stopped || settled) return;
      if (code === 0) finishResolve(Buffer.concat(output));
      else {
        finishReject(
          new Error(appendStderrTail(`ffmpeg exited with code ${code ?? "unknown"}.`, stderrTail)),
        );
      }
    });

    const writeChunk = (descriptor: number, chunk: Buffer): void => {
      const input = child.stdio[descriptor];
      if (input && "end" in input && typeof input.end === "function") {
        if ("on" in input && typeof input.on === "function") {
          input.on("error", () => {
            // An early ffmpeg exit can close its input pipe; the close handler reports failure.
          });
        }
        input.end(chunk);
      }
    };
    if (chunks.length === 0) writeChunk(0, Buffer.alloc(0));
    chunks.forEach((chunk, index) => {
      writeChunk(inputFileDescriptors[index]!, chunk);
    });
  });
}

function appendStderrTail(message: string, stderrTail: Buffer): string {
  const rawTail = stderrTail.toString("utf8");
  let sanitizedTail = "";
  for (let index = 0; index < rawTail.length; index += 1) {
    const code = rawTail.charCodeAt(index);
    if (code === 0x1b) {
      if (rawTail[index + 1] === "[") {
        index += 2;
        while (index < rawTail.length) {
          const sequenceCode = rawTail.charCodeAt(index);
          if (sequenceCode >= 0x40 && sequenceCode <= 0x7e) break;
          index += 1;
        }
      } else if (index + 1 < rawTail.length) {
        index += 1;
      }
      continue;
    }
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      continue;
    }
    sanitizedTail += rawTail[index];
  }
  const tail = sanitizedTail.trim();
  return tail ? `${message} Stderr tail: ${tail}` : message;
}
