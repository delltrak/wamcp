// ============================================================
// WA MCP — Media Handling Service
// ============================================================

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_MEDIA_CACHE_MAX_MB, MEDIA_LIMITS } from "../constants.js";
import {
  DEFAULT_FFMPEG_TIMEOUT_MS,
  resolveFfmpegExecutable,
  runFfmpegCommand,
} from "../tts/audio.js";
import { validateMediaUrl, validateBase64Size } from "../utils/validation.js";

const MEDIA_DIR = process.env.WA_MEDIA_DIR?.trim() || "data/media";
export const DEFAULT_MEDIA_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MEDIA_DOWNLOAD_BASE64_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MEDIA_DOWNLOAD_DIR = "data/media-downloads";
const MAX_MEDIA_FILE_NAME_LENGTH = 120;
const GROUP_PROFILE_PICTURE_MAX_BYTES = 5 * 1024 * 1024;

export interface PreparedSticker {
  data: Buffer;
  animated: boolean;
}

export interface SavedMediaDownload {
  path: string;
  fileName: string;
  size: number;
}

type MediaInputFormat = "gif" | "webp" | "png" | "jpeg" | "mp4" | "unknown";

function mediaFfmpegExecutable(): string {
  return process.env.WA_MEDIA_FFMPEG_PATH?.trim() || resolveFfmpegExecutable();
}

function mediaFfmpegTimeoutMs(): number {
  const raw = process.env.WA_MEDIA_FFMPEG_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_FFMPEG_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_FFMPEG_TIMEOUT_MS;
}

export const DEFAULT_MEDIA_COMPRESS = false;
export const DEFAULT_MEDIA_IMAGE_MAX_EDGE = 600;
export const DEFAULT_MEDIA_IMAGE_QUALITY = 75;
export const DEFAULT_MEDIA_VIDEO_MAX_EDGE = 720;
export const DEFAULT_MEDIA_VIDEO_CRF = 28;
const STICKER_VIDEO_MAX_SECONDS = 10;
const MEDIA_EDGE_MIN = 16;
const MEDIA_EDGE_MAX = 4096;

export interface MediaCompressionSettings {
  enabled: boolean;
  imageMaxEdge: number;
  imageQuality: number;
  videoMaxEdge: number;
  videoCrf: number;
}

export interface OutgoingCompressionOptions {
  compress?: boolean;
  hd?: boolean;
}

export type PreparedOutgoingMedia =
  { compressed: false; input: string } | { compressed: true; data: Buffer; mimeType: string };

function parseBooleanSetting(value: string | undefined, key: string, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`Invalid ${key}; expected true or false`);
}

function parseIntegerSetting(
  value: string | undefined,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid ${key}; expected an integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${key}; expected an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function getMediaCompressionSettings(
  env: NodeJS.ProcessEnv = process.env,
): MediaCompressionSettings {
  return {
    enabled: parseBooleanSetting(
      env.WA_MEDIA_COMPRESS,
      "WA_MEDIA_COMPRESS",
      DEFAULT_MEDIA_COMPRESS,
    ),
    imageMaxEdge: parseIntegerSetting(
      env.WA_MEDIA_IMAGE_MAX_EDGE,
      "WA_MEDIA_IMAGE_MAX_EDGE",
      DEFAULT_MEDIA_IMAGE_MAX_EDGE,
      MEDIA_EDGE_MIN,
      MEDIA_EDGE_MAX,
    ),
    imageQuality: parseIntegerSetting(
      env.WA_MEDIA_IMAGE_QUALITY,
      "WA_MEDIA_IMAGE_QUALITY",
      DEFAULT_MEDIA_IMAGE_QUALITY,
      1,
      100,
    ),
    videoMaxEdge: parseIntegerSetting(
      env.WA_MEDIA_VIDEO_MAX_EDGE,
      "WA_MEDIA_VIDEO_MAX_EDGE",
      DEFAULT_MEDIA_VIDEO_MAX_EDGE,
      MEDIA_EDGE_MIN,
      MEDIA_EDGE_MAX,
    ),
    videoCrf: parseIntegerSetting(
      env.WA_MEDIA_VIDEO_CRF,
      "WA_MEDIA_VIDEO_CRF",
      DEFAULT_MEDIA_VIDEO_CRF,
      0,
      51,
    ),
  };
}

/** `hd: true` skips compression. An explicit `compress` flag overrides `WA_MEDIA_COMPRESS`. */
export function shouldCompressOutgoingMedia(
  options: OutgoingCompressionOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const settings = getMediaCompressionSettings(env);
  if (options.hd === true) return false;
  if (typeof options.compress === "boolean") return options.compress;
  return settings.enabled;
}

function mjpegQualityValue(quality: number): number {
  const clamped = Math.min(100, Math.max(1, quality));
  return Math.round(2 + ((100 - clamped) * 29) / 99);
}

function fitWithinEdgeFilter(maxEdge: number): string {
  return `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

function mediaDownloadMaxBytes(): number {
  return positiveEnvironmentInteger(
    process.env.WA_MEDIA_DOWNLOAD_MAX_BYTES,
    DEFAULT_MEDIA_DOWNLOAD_MAX_BYTES,
  );
}

function positiveEnvironmentInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim() || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMediaDownloadMaxBytes(mode: "file" | "base64" = "file"): number {
  const maxBytes = mediaDownloadMaxBytes();
  return mode === "base64" ? Math.min(maxBytes, DEFAULT_MEDIA_DOWNLOAD_BASE64_MAX_BYTES) : maxBytes;
}

export function sanitizeMediaFileName(fileName: string | undefined): string {
  let safeName = [...(fileName ?? "")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(code <= 0x1f || (code >= 0x7f && code <= 0x9f));
    })
    .join("")
    .replace(/[\\/]/g, "");
  safeName = safeName
    .replace(/\.\./g, "")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/g, "");
  if (!safeName) safeName = "media";
  if (safeName.length > MAX_MEDIA_FILE_NAME_LENGTH) {
    const extension = safeName.match(/\.[^.]+$/)?.[0] ?? "";
    if (extension.length >= MAX_MEDIA_FILE_NAME_LENGTH) {
      safeName = safeName.slice(0, MAX_MEDIA_FILE_NAME_LENGTH);
    } else {
      const base = extension ? safeName.slice(0, -extension.length) : safeName;
      safeName = `${base.slice(0, MAX_MEDIA_FILE_NAME_LENGTH - extension.length)}${extension}`;
    }
  }
  return safeName;
}

function detectMediaInputFormat(buffer: Buffer): MediaInputFormat {
  if (
    buffer.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))
  ) {
    return "gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
  return "unknown";
}

export function getWebPInfo(
  buffer: Buffer,
): { animated: boolean; width?: number; height?: number } | null {
  if (detectMediaInputFormat(buffer) !== "webp" || buffer.readUInt32LE(4) + 8 > buffer.length) {
    return null;
  }
  const declaredEnd = buffer.readUInt32LE(4) + 8;
  let offset = 12;
  let hasImage = false;
  let animationFlag = false;
  let hasAnimationFrame = false;
  let width: number | undefined;
  let height: number | undefined;

  while (offset + 8 <= declaredEnd) {
    const kind = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const content = offset + 8;
    const chunkEnd = content + chunkSize;
    if (chunkEnd > declaredEnd || chunkEnd > buffer.length) return null;

    if (kind === "VP8X") {
      if (chunkSize < 10) return null;
      animationFlag = (buffer[content]! & 0x02) !== 0;
      width = 1 + buffer.readUIntLE(content + 4, 3);
      height = 1 + buffer.readUIntLE(content + 7, 3);
    } else if (kind === "VP8 ") {
      hasImage = true;
      // A simple lossy WebP stores the dimensions in the first VP8 keyframe header.
      if (
        width === undefined &&
        chunkSize >= 10 &&
        (buffer[content]! & 0x01) === 0 &&
        buffer[content + 3] === 0x9d &&
        buffer[content + 4] === 0x01 &&
        buffer[content + 5] === 0x2a
      ) {
        width = buffer.readUInt16LE(content + 6) & 0x3fff;
        height = buffer.readUInt16LE(content + 8) & 0x3fff;
      }
    } else if (kind === "VP8L") {
      hasImage = true;
      // VP8L uses a one-byte signature followed by packed 14-bit width and height values.
      if (width === undefined && chunkSize >= 5 && buffer[content] === 0x2f) {
        const dimensions = buffer.readUInt32LE(content + 1);
        width = (dimensions & 0x3fff) + 1;
        height = ((dimensions >>> 14) & 0x3fff) + 1;
      }
    } else if (kind === "ANMF") {
      hasAnimationFrame = true;
      hasImage = true;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (offset !== declaredEnd || !hasImage) return null;
  return { animated: animationFlag && hasAnimationFrame, width, height };
}

function gifFrameCount(buffer: Buffer): number {
  if (detectMediaInputFormat(buffer) !== "gif" || buffer.length < 13) return 0;
  let offset = 13;
  const packed = buffer[10]!;
  if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);
  let frames = 0;

  const skipSubBlocks = (): boolean => {
    while (offset < buffer.length) {
      const length = buffer[offset++]!;
      if (length === 0) return true;
      offset += length;
    }
    return false;
  };

  while (offset < buffer.length) {
    const marker = buffer[offset++]!;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      if (offset >= buffer.length) return 0;
      offset += 1;
      if (!skipSubBlocks()) return 0;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > buffer.length) return 0;
    const imagePacked = buffer[offset + 8]!;
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
    if (offset >= buffer.length) return 0;
    offset += 1; // LZW minimum code size
    if (!skipSubBlocks()) return 0;
    frames += 1;
  }
  return frames;
}

function mediaExtension(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  const extensions: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "text/plain": ".txt",
  };
  return extensions[normalized ?? ""] ?? ".bin";
}

function defaultMediaFileName(messageId: string, mimeType: string): string {
  const safeId = sanitizeMediaFileName(messageId)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 48);
  return `${safeId || "media"}${mediaExtension(mimeType)}`;
}

function assertPathInsideDirectory(directory: string, filePath: string): void {
  const pathFromDirectory = relative(directory, filePath);
  if (
    !pathFromDirectory ||
    pathFromDirectory.startsWith(`..${sep}`) ||
    pathFromDirectory === ".." ||
    isAbsolute(pathFromDirectory)
  ) {
    throw new Error("Media download path must stay inside WA_MEDIA_DOWNLOAD_DIR");
  }
}

export interface MediaBufferOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export interface MediaBufferWithContentType {
  data: Buffer;
  contentType?: string;
}

function sizeLabel(maxBytes: number): string {
  return maxBytes < 1024 * 1024 ? `${maxBytes} bytes` : `${Math.round(maxBytes / 1024 / 1024)} MB`;
}

function stickerSizeLimit(animated: boolean): number {
  return animated ? MEDIA_LIMITS.stickerAnimated : MEDIA_LIMITS.stickerStatic;
}

function stickerSizeError(size: number, animated: boolean): Error {
  const kind = animated ? "animated" : "static";
  const limit = stickerSizeLimit(animated);
  return new Error(
    `${kind[0]!.toUpperCase()}${kind.slice(1)} sticker is ${size} bytes and exceeds the ${sizeLabel(limit)} WhatsApp sticker limit (${limit} bytes)`,
  );
}

function staticStickerFfmpegArgs(quality: number, scaleAndPad: string): string[] {
  return [
    "-i",
    "pipe:0",
    "-frames:v",
    "1",
    "-vf",
    `${scaleAndPad},format=rgba`,
    "-an",
    "-c:v",
    "libwebp",
    "-quality",
    String(quality),
    "-compression_level",
    "6",
    "-f",
    "webp",
    "pipe:1",
  ];
}

function animatedStickerFfmpegArgs(
  quality: number,
  fps: number,
  scaleAndPad: string,
  maxSeconds?: number,
): string[] {
  const args = ["-i", "pipe:0"];
  if (maxSeconds !== undefined) args.push("-t", String(maxSeconds));
  args.push(
    "-vf",
    `fps=${fps},${scaleAndPad},format=yuva420p`,
    "-an",
    "-c:v",
    "libwebp_anim",
    "-lossless",
    "0",
    "-q:v",
    String(quality),
    "-loop",
    "0",
    "-f",
    "webp",
    "pipe:1",
  );
  return args;
}

function assertMaxBytes(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new Error(`Media exceeds maximum size of ${sizeLabel(maxBytes)}`);
  }
}

export async function mediaResponseToBuffer(
  response: Response,
  maxBytes?: number,
): Promise<Buffer> {
  if (maxBytes !== undefined) {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 0) {
      if (contentLength > maxBytes) {
        try {
          await response.body?.cancel();
        } catch {
          // Size rejection remains the useful failure if the body cannot be cancelled.
        }
        assertMaxBytes(contentLength, maxBytes);
      }
    }

    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            assertMaxBytes(size, maxBytes);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      return Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        size,
      );
    }
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (maxBytes !== undefined) assertMaxBytes(buffer.length, maxBytes);
  return buffer;
}

export class MediaService {
  private readonly maxCacheBytes: number;

  constructor() {
    this.maxCacheBytes =
      parseInt(process.env.WA_MEDIA_CACHE_MAX_MB ?? String(DEFAULT_MEDIA_CACHE_MAX_MB), 10) *
      1024 *
      1024;
    if (!existsSync(MEDIA_DIR)) {
      mkdirSync(MEDIA_DIR, { recursive: true });
    }
  }

  /** Download media from an HTTPS URL (with SSRF protection) */
  async downloadMedia(url: string, options: MediaBufferOptions = {}): Promise<Buffer> {
    return (await this.downloadMediaWithContentType(url, options)).data;
  }

  private async downloadMediaWithContentType(
    url: string,
    options: MediaBufferOptions = {},
  ): Promise<MediaBufferWithContentType> {
    const urlError = validateMediaUrl(url);
    if (urlError) {
      throw new Error(`Invalid media URL: ${urlError}`);
    }
    const response = options.timeoutMs
      ? await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) })
      : await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download media: HTTP ${response.status}`);
    }
    return {
      data: await mediaResponseToBuffer(response, options.maxBytes),
      contentType: response.headers?.get("content-type") ?? undefined,
    };
  }

  /** Decode base64 media to a buffer (with size limit) */
  decodeBase64Media(base64: string, maxBytes?: number): Buffer {
    const sizeError = validateBase64Size(base64, maxBytes);
    if (sizeError) {
      throw new Error(sizeError);
    }
    const buffer = Buffer.from(base64, "base64");
    if (maxBytes !== undefined) assertMaxBytes(buffer.length, maxBytes);
    return buffer;
  }

  /** Auto-detect URL vs base64, optionally returning the HTTP Content-Type */
  async getMediaBuffer(
    input: string,
    options: MediaBufferOptions & { includeContentType: true },
  ): Promise<MediaBufferWithContentType>;
  async getMediaBuffer(input: string, options?: MediaBufferOptions): Promise<Buffer>;
  async getMediaBuffer(
    input: string,
    options: MediaBufferOptions & { includeContentType?: boolean } = {},
  ): Promise<Buffer | MediaBufferWithContentType> {
    let media: MediaBufferWithContentType;
    if (input.startsWith("https://")) {
      media = await this.downloadMediaWithContentType(input, options);
    } else if (input.startsWith("http://")) {
      throw new Error("Media URLs must use HTTPS");
    } else if (input.startsWith("file://") || input.startsWith("data:")) {
      throw new Error("file:// and data: URLs are not allowed");
    } else {
      media = { data: this.decodeBase64Media(input, options.maxBytes) };
    }

    return options.includeContentType ? media : media.data;
  }

  /** Convert supported images to WhatsApp sticker WebP. Correctly sized WebP files pass through. */
  async prepareSticker(input: string, animatedHint?: boolean): Promise<PreparedSticker> {
    const source = await this.getMediaBuffer(input, { maxBytes: MEDIA_LIMITS.image });
    const format = detectMediaInputFormat(source);
    let animated: boolean;
    let normalizeWebP = false;

    if (format === "webp") {
      const info = getWebPInfo(source);
      if (!info) throw new Error("Sticker input is not a valid WebP image");
      animated = info.animated;
      const limit = stickerSizeLimit(animated);
      if (source.length > limit) throw stickerSizeError(source.length, animated);

      if (info.width !== 512 || info.height !== 512) {
        if (animated) {
          throw new Error(
            "Animated WebP stickers must be 512x512; send a GIF or short MP4 to convert it",
          );
        }
        normalizeWebP = true;
      }
      if (!normalizeWebP) return { data: source, animated };
    } else {
      if (format !== "png" && format !== "jpeg" && format !== "gif" && format !== "mp4") {
        throw new Error("Sticker input must be PNG, JPG, GIF, MP4, or WebP media");
      }
      animated =
        format === "mp4"
          ? animatedHint !== false
          : format === "gif" && (animatedHint ?? gifFrameCount(source) > 1);
    }

    const scaleAndPad =
      "scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000";
    const limit = stickerSizeLimit(animated);
    const attempts: Array<{ quality: number; fps: number; maxSeconds?: number }> = animated
      ? format === "mp4"
        ? [
            { quality: 50, fps: 12, maxSeconds: STICKER_VIDEO_MAX_SECONDS },
            { quality: 35, fps: 10, maxSeconds: STICKER_VIDEO_MAX_SECONDS },
            { quality: 25, fps: 8, maxSeconds: STICKER_VIDEO_MAX_SECONDS },
          ]
        : [{ quality: 55, fps: 15 }]
      : [
          { quality: 75, fps: 0 },
          { quality: 50, fps: 0 },
        ];
    let converted: Buffer | undefined;
    let lastSizeError: Error | undefined;
    for (let attempt = 0; attempt < attempts.length; attempt += 1) {
      const current = attempts[attempt]!;
      const ffmpegArgs = animated
        ? animatedStickerFfmpegArgs(current.quality, current.fps, scaleAndPad, current.maxSeconds)
        : staticStickerFfmpegArgs(current.quality, scaleAndPad);
      try {
        converted = await runFfmpegCommand(
          [source],
          ffmpegArgs,
          mediaFfmpegExecutable(),
          mediaFfmpegTimeoutMs(),
          limit,
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new Error(
            "ffmpeg is required to convert this sticker. Install ffmpeg or set WA_MEDIA_FFMPEG_PATH.",
            { cause: error },
          );
        }
        if (error instanceof Error && /unknown encoder|encoder not found/i.test(error.message)) {
          const encoder = animated ? "libwebp_anim" : "libwebp";
          throw new Error(`ffmpeg lacks ${encoder} support required for stickers`, {
            cause: error,
          });
        }
        if (error instanceof Error && error.message.includes("output exceeded")) {
          lastSizeError = stickerSizeError(limit + 1, animated);
          converted = undefined;
          if (attempt < attempts.length - 1) continue;
          throw new Error(`Converted ${lastSizeError.message}`, { cause: error });
        }
        throw error;
      }

      if (converted.length <= limit) break;
      lastSizeError = stickerSizeError(converted.length, animated);
      converted = undefined;
      if (attempt < attempts.length - 1) continue;
      throw new Error(`Converted ${lastSizeError.message}`);
    }

    if (!converted) {
      throw new Error(
        `Converted ${lastSizeError?.message ?? stickerSizeError(limit + 1, animated).message}`,
      );
    }
    const info = getWebPInfo(converted);
    if (!info) throw new Error("ffmpeg did not produce a valid WebP sticker");
    if (info.width !== 512 || info.height !== 512) {
      throw new Error("ffmpeg did not produce a 512x512 WebP sticker");
    }
    if (converted.length > limit)
      throw new Error(`Converted ${stickerSizeError(converted.length, animated).message}`);
    return { data: converted, animated };
  }

  /** Convert supported image media to a square JPEG suitable for a group profile picture. */
  async prepareGroupProfilePicture(input: string): Promise<Buffer> {
    const source = await this.getMediaBuffer(input, { maxBytes: MEDIA_LIMITS.image });
    const format = detectMediaInputFormat(source);
    if (format !== "gif" && format !== "webp" && format !== "png" && format !== "jpeg") {
      throw new Error("Group picture input must be PNG, JPG, GIF, or WebP image media");
    }

    let converted: Buffer;
    try {
      converted = await runFfmpegCommand(
        [source],
        [
          "-i",
          "pipe:0",
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          "scale=640:640:force_original_aspect_ratio=increase:flags=lanczos,crop=640:640",
          "-an",
          "-c:v",
          "mjpeg",
          "-q:v",
          "3",
          "-f",
          "image2pipe",
          "pipe:1",
        ],
        mediaFfmpegExecutable(),
        mediaFfmpegTimeoutMs(),
        GROUP_PROFILE_PICTURE_MAX_BYTES,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(
          "ffmpeg is required to prepare group pictures. Install ffmpeg or set WA_MEDIA_FFMPEG_PATH.",
          { cause: error },
        );
      }
      if (error instanceof Error && error.message.includes("output exceeded")) {
        throw new Error(
          `Converted group picture exceeds the ${sizeLabel(GROUP_PROFILE_PICTURE_MAX_BYTES)} limit`,
          { cause: error },
        );
      }
      throw error;
    }

    if (converted.length < 3 || detectMediaInputFormat(converted) !== "jpeg") {
      throw new Error("ffmpeg did not produce a valid JPEG group picture");
    }
    assertMaxBytes(converted.length, GROUP_PROFILE_PICTURE_MAX_BYTES);
    return converted;
  }

  /** Convert a GIF or video input to a silent H.264 MP4 suitable for GIF playback. */
  async convertGifToMp4(input: string): Promise<Buffer> {
    const source = await this.getMediaBuffer(input, { maxBytes: MEDIA_LIMITS.video });
    const format = detectMediaInputFormat(source);
    if (format !== "gif" && format !== "mp4") {
      throw new Error("GIF input must be a GIF image or MP4 video");
    }

    let converted: Buffer;
    try {
      converted = await runFfmpegCommand(
        [source],
        [
          "-i",
          "pipe:0",
          "-map",
          "0:v:0",
          "-an",
          "-vf",
          "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0,format=yuv420p",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+frag_keyframe+empty_moov",
          "-f",
          "mp4",
          "pipe:1",
        ],
        mediaFfmpegExecutable(),
        mediaFfmpegTimeoutMs(),
        MEDIA_LIMITS.video,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(
          "ffmpeg is required to convert GIF media to MP4. Install ffmpeg or set WA_MEDIA_FFMPEG_PATH.",
          { cause: error },
        );
      }
      if (error instanceof Error && error.message.includes("output exceeded")) {
        throw new Error(`Converted GIF exceeds the ${MEDIA_LIMITS.video} byte video limit`, {
          cause: error,
        });
      }
      throw error;
    }

    if (converted.length < 12 || converted.subarray(4, 8).toString("ascii") !== "ftyp") {
      throw new Error("ffmpeg did not produce an MP4 video");
    }
    return converted;
  }

  /**
   * Re-encode an image so its longest edge and JPEG quality stay within the configured limits.
   * Returns the original input when the result is not smaller.
   */
  async prepareOutgoingImage(input: string): Promise<PreparedOutgoingMedia> {
    return this.compressOutgoingMedia(input, "image");
  }

  /**
   * Re-encode a video to H.264/AAC within the configured edge length and CRF.
   * Returns the original input when the result is not smaller.
   */
  async prepareOutgoingVideo(input: string): Promise<PreparedOutgoingMedia> {
    return this.compressOutgoingMedia(input, "video");
  }

  private async compressOutgoingMedia(
    input: string,
    kind: "image" | "video",
  ): Promise<PreparedOutgoingMedia> {
    const settings = getMediaCompressionSettings();
    const maxBytes = kind === "image" ? MEDIA_LIMITS.image : MEDIA_LIMITS.video;
    const source = await this.getMediaBuffer(input, { maxBytes });
    const format = detectMediaInputFormat(source);
    if (kind === "image") {
      if (format !== "jpeg" && format !== "png" && format !== "webp" && format !== "gif") {
        throw new Error("Compressed image input must be PNG, JPG, GIF, or WebP media");
      }
    } else if (format !== "mp4") {
      throw new Error("Compressed video input must be an MP4 video");
    }

    const args =
      kind === "image"
        ? [
            "-i",
            "pipe:0",
            "-frames:v",
            "1",
            "-vf",
            `${fitWithinEdgeFilter(settings.imageMaxEdge)}:flags=lanczos`,
            "-an",
            "-c:v",
            "mjpeg",
            "-q:v",
            String(mjpegQualityValue(settings.imageQuality)),
            "-f",
            "image2pipe",
            "pipe:1",
          ]
        : [
            "-i",
            "pipe:0",
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-vf",
            fitWithinEdgeFilter(settings.videoMaxEdge),
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            String(settings.videoCrf),
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+frag_keyframe+empty_moov",
            "-f",
            "mp4",
            "pipe:1",
          ];

    let converted: Buffer;
    try {
      converted = await runFfmpegCommand(
        [source],
        args,
        mediaFfmpegExecutable(),
        mediaFfmpegTimeoutMs(),
        maxBytes,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(
          `ffmpeg is required to compress ${kind} media. Install ffmpeg or set WA_MEDIA_FFMPEG_PATH.`,
          { cause: error },
        );
      }
      if (error instanceof Error && /unknown encoder|encoder not found/i.test(error.message)) {
        const encoder = kind === "image" ? "mjpeg" : "libx264";
        throw new Error(`ffmpeg lacks ${encoder} support required to compress ${kind} media`, {
          cause: error,
        });
      }
      if (error instanceof Error && error.message.includes("output exceeded")) {
        throw new Error(`Compressed ${kind} exceeds the ${maxBytes} byte limit`, { cause: error });
      }
      throw error;
    }

    if (kind === "image") {
      if (converted.length < 3 || detectMediaInputFormat(converted) !== "jpeg") {
        throw new Error("ffmpeg did not produce a JPEG image");
      }
      if (converted.length >= source.length) return { compressed: false, input };
      return { compressed: true, data: converted, mimeType: "image/jpeg" };
    }

    if (converted.length < 12 || converted.subarray(4, 8).toString("ascii") !== "ftyp") {
      throw new Error("ffmpeg did not produce an MP4 video");
    }
    if (converted.length >= source.length) return { compressed: false, input };
    return { compressed: true, data: converted, mimeType: "video/mp4" };
  }

  /** Store a download under the dedicated media directory with a generated, contained path. */
  async saveDownloadedMedia(data: Buffer, fileName: string): Promise<SavedMediaDownload> {
    const configuredDirectory = process.env.WA_MEDIA_DOWNLOAD_DIR?.trim();
    const requestedDirectory = resolve(configuredDirectory || DEFAULT_MEDIA_DOWNLOAD_DIR);
    await mkdir(requestedDirectory, { recursive: true });
    const directory = await realpath(requestedDirectory);
    const safeFileName = sanitizeMediaFileName(fileName);
    const filePath = resolve(directory, `${randomUUID()}-${safeFileName}`);
    assertPathInsideDirectory(directory, filePath);
    await writeFile(filePath, data, { flag: "wx", mode: 0o600 });
    return { path: filePath, fileName: safeFileName, size: data.length };
  }

  /** Return a safe fallback filename when a received media message has no original name. */
  getDownloadedMediaFileName(
    fileName: string | undefined,
    messageId: string,
    mimeType: string,
  ): string {
    return sanitizeMediaFileName(fileName || defaultMediaFileName(messageId, mimeType));
  }

  /** Current configured limit, exposed for the download tool and its response mode. */
  getMediaDownloadMaxBytes(mode: "file" | "base64" = "file"): number {
    return getMediaDownloadMaxBytes(mode);
  }

  /** Cache media buffer to disk, return local path */
  async cacheMedia(buffer: Buffer, extension = ".bin"): Promise<string> {
    const fileName = `${randomUUID()}${extension}`;
    const filePath = join(MEDIA_DIR, fileName);
    await writeFile(filePath, buffer);
    return filePath;
  }

  /** Remove files exceeding cache size limit (oldest first) */
  cleanup(): number {
    if (!existsSync(MEDIA_DIR)) return 0;

    const files = readdirSync(MEDIA_DIR)
      .map((name) => {
        const path = join(MEDIA_DIR, name);
        const stat = statSync(path);
        return { path, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    let totalSize = files.reduce((sum, f) => sum + f.size, 0);
    let removed = 0;

    for (const file of files) {
      if (totalSize <= this.maxCacheBytes) break;
      unlinkSync(file.path);
      totalSize -= file.size;
      removed++;
    }

    return removed;
  }
}
