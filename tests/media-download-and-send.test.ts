import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WASocket } from "@whiskeysockets/baileys";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import {
  getWebPInfo,
  MediaService,
  mediaResponseToBuffer,
  sanitizeMediaFileName,
} from "../src/services/media.js";
import * as audioTools from "../src/tts/audio.js";
import { MEDIA_LIMITS } from "../src/constants.js";
import { registerMessagingTools } from "../src/tools/messaging.tools.js";
import { DownloadMediaSchema, SendGifSchema } from "../src/schemas/messaging.schema.js";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const ffprobeAvailable = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

function registerTools(adapter: Record<string, unknown>, enqueueMessage = vi.fn()) {
  const tools = new Map<string, (params: unknown) => Promise<unknown>>();
  const server = {
    registerTool(name: string, _config: unknown, handler: (params: unknown) => Promise<unknown>) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  const instanceManager = {
    getInstanceChannel: () => "baileys",
    getAdapter: () => adapter,
  };
  registerMessagingTools(server, instanceManager as never, { enqueueMessage } as never);
  return tools;
}

function responseBody(response: unknown): Record<string, unknown> {
  const result = response as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function gifFixture(): Buffer {
  return execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=duration=0.6:size=30x15:rate=5",
    "-f",
    "gif",
    "pipe:1",
  ]);
}

function webPChunk(kind: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + data.length + (data.length % 2));
  chunk.write(kind, 0, "ascii");
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  return chunk;
}

function webPFile(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function vp8WebP(width: number, height: number, payloadSize = 10): Buffer {
  const payload = Buffer.alloc(Math.max(10, payloadSize));
  payload[0] = 0; // key frame
  payload.writeUInt8(0x9d, 3);
  payload.writeUInt8(0x01, 4);
  payload.writeUInt8(0x2a, 5);
  payload.writeUInt16LE(width & 0x3fff, 6);
  payload.writeUInt16LE(height & 0x3fff, 8);
  return webPFile(webPChunk("VP8 ", payload));
}

function vp8lWebP(width: number, height: number, payloadSize = 5): Buffer {
  const payload = Buffer.alloc(Math.max(5, payloadSize));
  payload[0] = 0x2f;
  payload.writeUInt32LE(((height - 1) << 14) | (width - 1), 1);
  return webPFile(webPChunk("VP8L", payload));
}

function animatedWebP(width: number, height: number, frameSize = 16): Buffer {
  const extended = Buffer.alloc(10);
  extended[0] = 0x02; // animation flag
  extended.writeUIntLE(width - 1, 4, 3);
  extended.writeUIntLE(height - 1, 7, 3);
  return webPFile(webPChunk("VP8X", extended), webPChunk("ANMF", Buffer.alloc(frameSize)));
}

describe("media conversions and received media downloads", () => {
  const originalDownloadDirectory = process.env.WA_MEDIA_DOWNLOAD_DIR;
  const originalMaxBytes = process.env.WA_MEDIA_DOWNLOAD_MAX_BYTES;
  const originalFfmpegPath = process.env.WA_MEDIA_FFMPEG_PATH;
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalDownloadDirectory === undefined) delete process.env.WA_MEDIA_DOWNLOAD_DIR;
    else process.env.WA_MEDIA_DOWNLOAD_DIR = originalDownloadDirectory;
    if (originalMaxBytes === undefined) delete process.env.WA_MEDIA_DOWNLOAD_MAX_BYTES;
    else process.env.WA_MEDIA_DOWNLOAD_MAX_BYTES = originalMaxBytes;
    if (originalFfmpegPath === undefined) delete process.env.WA_MEDIA_FFMPEG_PATH;
    else process.env.WA_MEDIA_FFMPEG_PATH = originalFfmpegPath;
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
    "converts PNG to a 512x512 WebP sticker",
    async () => {
      const ppm = Buffer.concat([
        Buffer.from("P6\n120 60\n255\n"),
        Buffer.alloc(120 * 60 * 3, 255),
      ]);
      const png = execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          "pipe:0",
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "pipe:1",
        ],
        { input: ppm },
      );
      const sticker = await new MediaService().prepareSticker(png.toString("base64"));

      expect(sticker.animated).toBe(false);
      expect(sticker.data.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(sticker.data.subarray(8, 12).toString("ascii")).toBe("WEBP");
      const dimensions = execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height",
          "-of",
          "csv=s=x:p=0",
          "-i",
          "pipe:0",
        ],
        { input: sticker.data, encoding: "utf8" },
      );
      expect(dimensions.trim()).toBe("512x512");
      const passthrough = await new MediaService().prepareSticker(sticker.data.toString("base64"));
      expect(passthrough.data).toEqual(sticker.data);
    },
  );

  it("parses dimensions from simple VP8 and VP8L WebP headers", () => {
    expect(getWebPInfo(vp8WebP(320, 240))).toMatchObject({
      animated: false,
      width: 320,
      height: 240,
    });
    expect(getWebPInfo(vp8lWebP(640, 480))).toMatchObject({
      animated: false,
      width: 640,
      height: 480,
    });
  });

  it("transcodes a non-512 static WebP through the scale and pad pipeline", async () => {
    const source = vp8WebP(320, 240);
    const output = vp8lWebP(512, 512);
    const runner = vi.spyOn(audioTools, "runFfmpegCommand").mockResolvedValue(output);

    const sticker = await new MediaService().prepareSticker(source.toString("base64"));

    expect(sticker).toMatchObject({ data: output, animated: false });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![1]).toContain(
      "scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba",
    );
    expect(runner.mock.calls[0]![4]).toBe(MEDIA_LIMITS.stickerStatic);
  });

  it("normalizes WebP when dimensions cannot be read and passes 512x512 WebP through", async () => {
    const unknownDimensions = webPFile(webPChunk("VP8 ", Buffer.from([0, 1])));
    const output = vp8lWebP(512, 512);
    const runner = vi.spyOn(audioTools, "runFfmpegCommand").mockResolvedValue(output);
    const service = new MediaService();

    const normalized = await service.prepareSticker(unknownDimensions.toString("base64"));
    const passthroughInput = vp8WebP(512, 512);
    const passthrough = await service.prepareSticker(passthroughInput.toString("base64"));

    expect(normalized.data).toEqual(output);
    expect(passthrough.data).toEqual(passthroughInput);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("rejects an animated WebP unless its canvas is 512x512", async () => {
    const runner = vi.spyOn(audioTools, "runFfmpegCommand");

    await expect(
      new MediaService().prepareSticker(animatedWebP(320, 240).toString("base64")),
    ).rejects.toThrow("Animated WebP stickers must be 512x512; send a GIF to convert it");
    expect(runner).not.toHaveBeenCalled();
  });

  it("applies the 100 KB static and 500 KB animated WebP pass-through limits", async () => {
    const service = new MediaService();
    const oversizedStatic = vp8WebP(512, 512, 150 * 1024);
    const animated150Kb = animatedWebP(512, 512, 150 * 1024);

    await expect(service.prepareSticker(oversizedStatic.toString("base64"))).rejects.toThrow(
      "Static sticker",
    );
    await expect(service.prepareSticker(animated150Kb.toString("base64"))).resolves.toMatchObject({
      data: animated150Kb,
      animated: true,
    });
  });

  it("retries oversized static conversion once at lower quality", async () => {
    const tooLarge = Buffer.alloc(MEDIA_LIMITS.stickerStatic + 1);
    const output = vp8lWebP(512, 512);
    const runner = vi
      .spyOn(audioTools, "runFfmpegCommand")
      .mockResolvedValueOnce(tooLarge)
      .mockResolvedValueOnce(output);

    const sticker = await new MediaService().prepareSticker(vp8WebP(320, 240).toString("base64"));

    expect(sticker.data).toEqual(output);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0]![1]).toContain("75");
    expect(runner.mock.calls[1]![1]).toContain("50");
    expect(runner.mock.calls[0]![4]).toBe(MEDIA_LIMITS.stickerStatic);
    expect(runner.mock.calls[1]![4]).toBe(MEDIA_LIMITS.stickerStatic);
  });

  it.skipIf(!ffmpegAvailable)("converts animated GIF input to animated WebP", async () => {
    const sticker = await new MediaService().prepareSticker(gifFixture().toString("base64"));
    let hasAnimationFrame = false;
    for (let offset = 12; offset + 8 <= sticker.data.length;) {
      const kind = sticker.data.subarray(offset, offset + 4).toString("ascii");
      const length = sticker.data.readUInt32LE(offset + 4);
      if (kind === "ANMF") hasAnimationFrame = true;
      offset += 8 + length + (length % 2);
    }
    expect(sticker.animated).toBe(true);
    expect(hasAnimationFrame).toBe(true);
    const passthrough = await new MediaService().prepareSticker(sticker.data.toString("base64"));
    expect(passthrough).toMatchObject({ data: sticker.data, animated: true });
  });

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
    "normalizes GIF videos to silent H.264 MP4 with even dimensions",
    async () => {
      const mp4 = await new MediaService().convertGifToMp4(gifFixture().toString("base64"));
      const details = execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=format_name:stream=codec_type,codec_name,pix_fmt,width,height",
          "-of",
          "json",
          "-i",
          "pipe:0",
        ],
        { input: mp4, encoding: "utf8" },
      );
      const probe = JSON.parse(details) as {
        streams: Array<{
          codec_type: string;
          codec_name: string;
          pix_fmt: string;
          width: number;
          height: number;
        }>;
        format: { format_name: string };
      };
      expect(probe.format.format_name).toContain("mp4");
      expect(probe.streams).toHaveLength(1);
      expect(probe.streams[0]).toMatchObject({
        codec_type: "video",
        codec_name: "h264",
        pix_fmt: "yuv420p",
      });
      expect(probe.streams[0]!.width % 2).toBe(0);
      expect(probe.streams[0]!.height % 2).toBe(0);
    },
  );

  it("sets gifPlayback on the queued video content", async () => {
    const queued: unknown[] = [];
    const enqueueMessage = vi.fn(async (_instanceId: string, _to: string, content: unknown) => {
      queued.push(content);
      return { status: "queued", jobId: "gif-job" };
    });
    vi.spyOn(MediaService.prototype, "convertGifToMp4").mockResolvedValue(Buffer.from("mock mp4"));
    const tools = registerTools({}, enqueueMessage);

    await tools.get("wa_send_gif")!(
      SendGifSchema.parse({ instanceId: "inst_test", to: "5511999999999", gif: "R0lGODlh" }),
    );

    expect(queued[0]).toMatchObject({
      type: "video",
      video: Buffer.from("mock mp4").toString("base64"),
      gifPlayback: true,
    });
  });

  it("passes gifPlayback through to the Baileys video payload", async () => {
    const sendMessage = vi.fn(async (..._args: Parameters<WASocket["sendMessage"]>) => ({
      key: { id: "gif-message" },
    }));
    const socket = {
      user: { id: "5511999999999@s.whatsapp.net" },
      sendMessage,
    } as unknown as WASocket;
    const adapter = new BaileysAdapter("inst_test");
    Object.assign(adapter, { sock: socket, status: "connected" });

    await adapter.sendMessage("5511888888888", {
      type: "video",
      video: Buffer.from("mp4").toString("base64"),
      gifPlayback: true,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      gifPlayback: true,
      video: Buffer.from("mp4"),
    });
  });

  it("uploads a prepared sticker before sending it through Cloud API", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        requests.push({ url, init });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () =>
            url.endsWith("/media")
              ? { id: "uploaded-sticker" }
              : { messages: [{ id: "cloud-sticker-message" }] },
        } as Response;
      }),
    );
    const adapter = new CloudApiAdapter("inst_cloud");
    await adapter.setCredentials({ accessToken: "test-token", phoneNumberId: "phone-123" });
    const sticker = vp8WebP(512, 512);

    await adapter.sendMessage("5511888888888", {
      type: "sticker",
      sticker: sticker.toString("base64"),
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[1]!.url).toContain("/messages");
    expect(JSON.parse(String(requests[1]!.init.body))).toMatchObject({
      type: "sticker",
      sticker: { id: "uploaded-sticker" },
    });
  });

  it("enforces static and animated sticker limits on the Cloud API path", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () =>
            url.endsWith("/media")
              ? { id: "uploaded-sticker" }
              : { messages: [{ id: "cloud-sticker-message" }] },
        } as Response;
      }),
    );
    const adapter = new CloudApiAdapter("inst_cloud_limits");
    await adapter.setCredentials({ accessToken: "test-token", phoneNumberId: "phone-123" });

    await expect(
      adapter.sendMessage("5511888888888", {
        type: "sticker",
        sticker: vp8WebP(512, 512, 150 * 1024).toString("base64"),
      }),
    ).rejects.toThrow("Static sticker exceeds the 102400 bytes WhatsApp sticker limit");
    expect(requests).toHaveLength(0);

    await expect(
      adapter.sendMessage("5511888888888", {
        type: "sticker",
        sticker: animatedWebP(512, 512, 150 * 1024).toString("base64"),
      }),
    ).resolves.toMatchObject({ status: "sent" });
    expect(requests).toHaveLength(2);

    await expect(
      adapter.sendMessage("5511888888888", {
        type: "sticker",
        sticker: animatedWebP(512, 512, MEDIA_LIMITS.stickerAnimated + 1).toString("base64"),
      }),
    ).rejects.toThrow("512000 byte WhatsApp sticker limit");
    expect(requests).toHaveLength(2);
  });

  it("aborts a response stream when it exceeds its byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    await expect(mediaResponseToBuffer(new Response(body), 4)).rejects.toThrow("maximum size");
    expect(cancelled).toBe(true);
  });

  it("returns base64 media and applies the smaller mode limit", async () => {
    process.env.WA_MEDIA_DOWNLOAD_MAX_BYTES = "8";
    const data = Buffer.from("small");
    const adapter = {
      downloadMessageMedia: vi.fn(
        async (_messageId: string, _chatId: string | undefined, maxBytes: number) => {
          expect(maxBytes).toBe(8);
          return { data, mimeType: "text/plain", fileName: "small.txt" };
        },
      ),
    };
    const tools = registerTools(adapter);
    const response = await tools.get("wa_download_media")!(
      DownloadMediaSchema.parse({
        instanceId: "inst_test",
        messageId: "message-1",
        mode: "base64",
      }),
    );
    const body = responseBody(response);

    expect(body).toMatchObject({
      mode: "base64",
      path: null,
      mimeType: "text/plain",
      fileName: "small.txt",
      size: data.length,
      base64: data.toString("base64"),
    });
  });

  it("rejects downloaded media above the configured maximum", async () => {
    process.env.WA_MEDIA_DOWNLOAD_MAX_BYTES = "4";
    const adapter = {
      downloadMessageMedia: vi.fn(async () => ({
        data: Buffer.from("five!"),
        mimeType: "text/plain",
      })),
    };
    const tools = registerTools(adapter);
    const response = await tools.get("wa_download_media")!(
      DownloadMediaSchema.parse({ instanceId: "inst_test", messageId: "too-large" }),
    );

    expect(adapter.downloadMessageMedia).toHaveBeenCalledWith("too-large", undefined, 4, 60_000);
    expect(response).toMatchObject({ isError: true });
  });

  it("uses a smaller fixed cap for base64 mode", () => {
    process.env.WA_MEDIA_DOWNLOAD_MAX_BYTES = String(20 * 1024 * 1024);
    const media = new MediaService();
    expect(media.getMediaDownloadMaxBytes("file")).toBe(20 * 1024 * 1024);
    expect(media.getMediaDownloadMaxBytes("base64")).toBe(5 * 1024 * 1024);
  });

  it("sanitizes traversal names and writes only inside the configured directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wamcp-media-download-"));
    temporaryDirectories.push(directory);
    process.env.WA_MEDIA_DOWNLOAD_DIR = directory;
    const data = Buffer.from("pdf bytes");
    const tools = registerTools({
      downloadMessageMedia: async () => ({
        data,
        mimeType: "application/pdf",
        fileName: "../../outside.pdf",
      }),
    });
    const response = await tools.get("wa_download_media")!(
      DownloadMediaSchema.parse({ instanceId: "inst_test", messageId: "message-2" }),
    );
    const body = responseBody(response);
    const savedPath = String(body.path);

    expect(body.fileName).toBe("outside.pdf");
    expect(resolve(dirname(savedPath))).toBe(resolve(directory));
    expect(basename(savedPath)).not.toContain("..");
    expect(await readFile(savedPath)).toEqual(data);
    expect(existsSync(join(dirname(directory), "outside.pdf"))).toBe(false);
  });

  it("removes controls and caps sanitized filenames", () => {
    const unsafe = `../report\u0000\n${"x".repeat(160)}.pdf`;
    const safe = sanitizeMediaFileName(unsafe);
    expect(safe).not.toContain("..");
    expect(safe).not.toMatch(/[\\/\u0000-\u001f\u007f]/);
    expect(safe.length).toBeLessThanOrEqual(120);
    expect(safe.endsWith(".pdf")).toBe(true);
    expect(sanitizeMediaFileName(`.${"x".repeat(160)}`).length).toBeLessThanOrEqual(120);
  });
});
