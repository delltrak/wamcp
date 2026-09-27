// ============================================================
// WA MCP — Media Handling Service
// ============================================================

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_MEDIA_CACHE_MAX_MB } from "../constants.js";
import { validateMediaUrl, validateBase64Size } from "../utils/validation.js";

/** Persisted under the wa-data volume at /app/data/media */
export const MEDIA_DIR = join(process.cwd(), "data", "media");

const MIMETYPE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/opus": ".opus",
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-excel": ".xls",
  "application/zip": ".zip",
  "image/webp-sticker": ".webp",
};

export function extensionForMimetype(mimetype: string | null | undefined): string {
  if (!mimetype) return ".bin";
  const base = mimetype.split(";")[0].trim().toLowerCase();
  if (MIMETYPE_EXT[base]) return MIMETYPE_EXT[base];
  if (base.startsWith("image/")) return ".jpg";
  if (base.startsWith("video/")) return ".mp4";
  if (base.startsWith("audio/")) return ".ogg";
  return ".bin";
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
  async downloadMedia(url: string): Promise<Buffer> {
    const urlError = validateMediaUrl(url);
    if (urlError) {
      throw new Error(`Invalid media URL: ${urlError}`);
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download media: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /** Decode base64 media to a buffer (with size limit) */
  decodeBase64Media(base64: string): Buffer {
    const sizeError = validateBase64Size(base64);
    if (sizeError) {
      throw new Error(sizeError);
    }
    return Buffer.from(base64, "base64");
  }

  /** Auto-detect URL vs base64, return Buffer */
  async getMediaBuffer(input: string): Promise<Buffer> {
    if (input.startsWith("https://")) {
      return this.downloadMedia(input);
    }
    if (input.startsWith("http://")) {
      throw new Error("Media URLs must use HTTPS");
    }
    if (input.startsWith("file://") || input.startsWith("data:")) {
      throw new Error("file:// and data: URLs are not allowed");
    }
    return this.decodeBase64Media(input);
  }

  /** Cache media buffer to disk, return local path */
  async cacheMedia(buffer: Buffer, extension = ".bin"): Promise<string> {
    const fileName = `${randomUUID()}${extension}`;
    const filePath = join(MEDIA_DIR, fileName);
    await writeFile(filePath, buffer);
    return filePath;
  }

  /**
   * Persist inbound/outbound message media under a stable path:
   * data/media/{instanceId}/{messageId}{ext}
   */
  async persistMessageMedia(
    buffer: Buffer,
    opts: { instanceId: string; messageId: string; mimetype?: string | null },
  ): Promise<{ path: string; size: number; mimetype: string | null }> {
    const safeInstance = opts.instanceId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeMsg = opts.messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const ext = extensionForMimetype(opts.mimetype);
    const filePath = join(MEDIA_DIR, safeInstance, `${safeMsg}${ext}`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    return { path: filePath, size: buffer.length, mimetype: opts.mimetype ?? null };
  }

  /** Remove files exceeding cache size limit (oldest first) */
  cleanup(): number {
    if (!existsSync(MEDIA_DIR)) return 0;

    const files: { path: string; size: number; mtimeMs: number }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path);
        else files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    };
    walk(MEDIA_DIR);

    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

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
