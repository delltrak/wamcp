import { spawn } from "node:child_process";
import type { TtsAudio } from "./provider.js";

export const WHATSAPP_VOICE_MIME_TYPE = "audio/ogg; codecs=opus";
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

export type FfmpegRunner = (chunks: Buffer[], executable: string) => Promise<Buffer>;

export function isOggContainer(audio: Buffer): boolean {
  return audio.length >= 4 && audio.subarray(0, 4).toString("ascii") === "OggS";
}

export async function normalizeToWhatsAppVoiceNote(
  chunks: TtsAudio[],
  executable = process.env.WA_TTS_FFMPEG_PATH?.trim() || "ffmpeg",
  runFfmpeg: FfmpegRunner = transcodeWithFfmpeg,
): Promise<TtsAudio> {
  if (chunks.length === 0) throw new Error("TTS provider returned no audio chunks.");
  if (chunks.length === 1 && isOggContainer(chunks[0]!.audio)) {
    return { audio: chunks[0]!.audio, mimeType: WHATSAPP_VOICE_MIME_TYPE };
  }

  try {
    const audio = await runFfmpeg(
      chunks.map((chunk) => chunk.audio),
      executable,
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

function transcodeWithFfmpeg(chunks: Buffer[], executable: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
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
    child.stdout?.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
    child.stderr?.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(`ffmpeg exited with code ${code ?? "unknown"}.`));
    });

    chunks.forEach((chunk, index) => {
      const descriptor = inputFileDescriptors[index]!;
      const input = child.stdio[descriptor];
      if (input && "end" in input && typeof input.end === "function") {
        if ("on" in input && typeof input.on === "function") {
          input.on("error", () => {
            // An early ffmpeg exit can close its input pipe; the close handler reports failure.
          });
        }
        input.end(chunk);
      }
    });
  });
}
