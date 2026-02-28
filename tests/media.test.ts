import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// We test MediaService methods by instantiating it in a temp directory.
// The MediaService constructor checks/creates MEDIA_DIR at "data/media".
// We mock the fetch function and filesystem operations as needed.

describe("MediaService", () => {
  const TEST_MEDIA_DIR = "data/media";

  // Clean up before/after to avoid leftover test files
  afterEach(() => {
    // Only clean test files we may have created
    try {
      if (existsSync(TEST_MEDIA_DIR)) {
        const files = require("node:fs").readdirSync(TEST_MEDIA_DIR);
        for (const f of files) {
          if (f.startsWith("test-")) {
            rmSync(join(TEST_MEDIA_DIR, f), { force: true });
          }
        }
      }
    } catch {
      // ignore cleanup errors
    }
  });

  describe("decodeBase64Media", () => {
    it("decodes base64 string to a Buffer", async () => {
      // Import dynamically to avoid side effects during module load
      const { MediaService } = await import("../src/services/media.js");
      const media = new MediaService();

      const original = "Hello, World!";
      const base64 = Buffer.from(original).toString("base64");
      const result = media.decodeBase64Media(base64);

      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe(original);
    });

    it("handles empty base64 string", async () => {
      const { MediaService } = await import("../src/services/media.js");
      const media = new MediaService();

      const result = media.decodeBase64Media("");
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(0);
    });
  });

  describe("downloadMedia URL validation", () => {
    it("rejects non-HTTPS URLs (ftp)", async () => {
      const { MediaService } = await import("../src/services/media.js");
      const media = new MediaService();

      await expect(media.downloadMedia("ftp://example.com/file")).rejects.toThrow(
        "Invalid media URL",
      );
    });

    it("rejects data URIs", async () => {
      const { MediaService } = await import("../src/services/media.js");
      const media = new MediaService();

      await expect(media.downloadMedia("data:image/png;base64,abc")).rejects.toThrow(
        "Invalid media URL",
      );
    });

    it("rejects http URLs (HTTPS only)", async () => {
      const { MediaService } = await import("../src/services/media.js");
      const media = new MediaService();

      await expect(media.downloadMedia("http://example.com/image.jpg")).rejects.toThrow(
        "Invalid media URL",
      );
    });

    it("accepts https URLs", async () => {
      const { MediaService } = await import("../src/services/media.js");
      const media = new MediaService();

      // Mock fetch to avoid real network call
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await media.downloadMedia("https://example.com/image.jpg");
      expect(result).toBeInstanceOf(Buffer);
      expect(mockFetch).toHaveBeenCalledWith("https://example.com/image.jpg");

      vi.unstubAllGlobals();
    });

    it("throws on failed download", async () => {
      const { MediaService } = await import("../src/services/media.js");
      const media = new MediaService();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(media.downloadMedia("https://example.com/missing.jpg")).rejects.toThrow(
        "Failed to download media",
      );

      vi.unstubAllGlobals();
    });
  });

  describe("getMediaBuffer", () => {
    it("uses downloadMedia for http URLs", async () => {
      const { MediaService } = await import("../src/services/media.js");
      const media = new MediaService();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await media.getMediaBuffer("https://example.com/file.bin");
      expect(result).toBeInstanceOf(Buffer);
      expect(mockFetch).toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("uses decodeBase64Media for non-URL strings", async () => {
      const { MediaService } = await import("../src/services/media.js");
      const media = new MediaService();

      const base64 = Buffer.from("test data").toString("base64");
      const result = await media.getMediaBuffer(base64);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe("test data");
    });
  });

  describe("cacheMedia", () => {
    it("returns a file path in the media directory", async () => {
      const { MediaService } = await import("../src/services/media.js");
      const media = new MediaService();

      const buffer = Buffer.from("test content");
      const path = await media.cacheMedia(buffer, ".txt");

      expect(path).toMatch(/^data\/media\//);
      expect(path).toMatch(/\.txt$/);
      expect(existsSync(path)).toBe(true);

      // Clean up
      rmSync(path, { force: true });
    });

    it("uses .bin as default extension", async () => {
      const { MediaService } = await import("../src/services/media.js");
      const media = new MediaService();

      const buffer = Buffer.from("binary data");
      const path = await media.cacheMedia(buffer);

      expect(path).toMatch(/\.bin$/);
      expect(existsSync(path)).toBe(true);

      rmSync(path, { force: true });
    });
  });
});
