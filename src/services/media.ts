// ============================================================
// WA MCP — Media Handling Service
// ============================================================

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_MEDIA_CACHE_MAX_MB } from "../constants.js";
import { validateMediaUrl, validateBase64Size } from "../utils/validation.js";

const MEDIA_DIR = "data/media";

export interface MediaBufferOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

function sizeLabel(maxBytes: number): string {
  return maxBytes < 1024 * 1024 ? `${maxBytes} bytes` : `${Math.round(maxBytes / 1024 / 1024)} MB`;
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
      assertMaxBytes(contentLength, maxBytes);
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
    return mediaResponseToBuffer(response, options.maxBytes);
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

  /** Auto-detect URL vs base64, return Buffer */
  async getMediaBuffer(input: string, options: MediaBufferOptions = {}): Promise<Buffer> {
    if (input.startsWith("https://")) {
      return this.downloadMedia(input, options);
    }
    if (input.startsWith("http://")) {
      throw new Error("Media URLs must use HTTPS");
    }
    if (input.startsWith("file://") || input.startsWith("data:")) {
      throw new Error("file:// and data: URLs are not allowed");
    }
    return this.decodeBase64Media(input, options.maxBytes);
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
