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
