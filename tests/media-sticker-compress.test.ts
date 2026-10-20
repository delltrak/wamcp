import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WASocket } from "@whiskeysockets/baileys";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import {
  getMediaCompressionSettings,
  getWebPInfo,
  MediaService,
  shouldCompressOutgoingMedia,
} from "../src/services/media.js";
import { SendImageSchema, SendVideoSchema } from "../src/schemas/messaging.schema.js";
import { registerMessagingTools } from "../src/tools/messaging.tools.js";
import * as audioTools from "../src/tts/audio.js";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const ffprobeAvailable = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
const compressionEnvKeys = [
  "WA_MEDIA_COMPRESS",
  "WA_MEDIA_IMAGE_MAX_EDGE",
  "WA_MEDIA_IMAGE_QUALITY",
  "WA_MEDIA_VIDEO_MAX_EDGE",
  "WA_MEDIA_VIDEO_CRF",
] as const;

function restoreCompressionEnv(original: Record<string, string | undefined>): void {
  for (const key of compressionEnvKeys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearCompressionEnv(): void {
  for (const key of compressionEnvKeys) delete process.env[key];
}

function jpeg(size = 8): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(size, 1)]);
}

function fakeMp4(): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.write("ftyp", 4, "ascii");
  return buffer;
}

function webp512(): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = 0;
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(512, 6);
  payload.writeUInt16LE(512, 8);
  const chunk = Buffer.alloc(8 + payload.length);
  chunk.write("VP8 ", 0, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), chunk]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function registerTools(enqueueMessage = vi.fn()) {
  const tools = new Map<string, (params: unknown) => Promise<unknown>>();
  const server = {
    registerTool(name: string, _config: unknown, handler: (params: unknown) => Promise<unknown>) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  registerMessagingTools(
    server,
    { getInstanceChannel: () => "baileys", getAdapter: () => ({}) } as never,
    { enqueueMessage } as never,
  );
  return tools;
}

describe("outgoing media compression settings", () => {
  const original = Object.fromEntries(compressionEnvKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    restoreCompressionEnv(original);
    vi.restoreAllMocks();
  });

  it("keeps compression off unless the env or the call opts in, and hd wins", () => {
    clearCompressionEnv();
    expect(getMediaCompressionSettings()).toMatchObject({
      enabled: false,
      imageMaxEdge: 600,
      imageQuality: 75,
      videoMaxEdge: 720,
      videoCrf: 28,
    });
    expect(shouldCompressOutgoingMedia()).toBe(false);
    expect(shouldCompressOutgoingMedia({ compress: true })).toBe(true);
    expect(shouldCompressOutgoingMedia({ compress: false })).toBe(false);

    process.env.WA_MEDIA_COMPRESS = "TRUE";
    expect(shouldCompressOutgoingMedia()).toBe(true);
    expect(shouldCompressOutgoingMedia({ compress: false })).toBe(false);
    expect(shouldCompressOutgoingMedia({ hd: true })).toBe(false);
    expect(shouldCompressOutgoingMedia({ hd: true, compress: true })).toBe(false);
  });

  it("rejects invalid compression settings", () => {
    expect(() => getMediaCompressionSettings({ WA_MEDIA_COMPRESS: "yes" })).toThrow(
      /Invalid WA_MEDIA_COMPRESS/,
    );
    expect(() => getMediaCompressionSettings({ WA_MEDIA_IMAGE_QUALITY: "0" })).toThrow(
      /Invalid WA_MEDIA_IMAGE_QUALITY/,
    );
    expect(() => getMediaCompressionSettings({ WA_MEDIA_VIDEO_CRF: "52" })).toThrow(
      /Invalid WA_MEDIA_VIDEO_CRF/,
    );
    expect(() => getMediaCompressionSettings({ WA_MEDIA_IMAGE_MAX_EDGE: "15" })).toThrow(
      /Invalid WA_MEDIA_IMAGE_MAX_EDGE/,
    );
  });

  it("leaves an image unchanged when compression does not shrink it", async () => {
    const runner = vi.spyOn(audioTools, "runFfmpegCommand").mockResolvedValue(jpeg(80));
    const input = jpeg(4).toString("base64");

    await expect(new MediaService().prepareOutgoingImage(input)).resolves.toEqual({
      compressed: false,
      input,
    });
    expect(runner.mock.calls[0]?.[1]).toContain(
      "scale='min(600,iw)':'min(600,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos",
    );
    expect(runner.mock.calls[0]?.[1]).toContain("9");
  });

  it("returns a smaller JPEG and uses the configured edge and quality", async () => {
    process.env.WA_MEDIA_IMAGE_MAX_EDGE = "320";
    process.env.WA_MEDIA_IMAGE_QUALITY = "100";
    const output = jpeg(2);
    const runner = vi.spyOn(audioTools, "runFfmpegCommand").mockResolvedValue(output);
    const input = jpeg(40).toString("base64");

    await expect(new MediaService().prepareOutgoingImage(input)).resolves.toEqual({
      compressed: true,
      data: output,
      mimeType: "image/jpeg",
    });
    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args).toContain(
      "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos",
    );
    expect(args).toContain("2");
  });

  it("returns a smaller MP4 using the configured CRF and edge", async () => {
    process.env.WA_MEDIA_VIDEO_MAX_EDGE = "480";
    process.env.WA_MEDIA_VIDEO_CRF = "30";
    const output = fakeMp4();
    const runner = vi.spyOn(audioTools, "runFfmpegCommand").mockResolvedValue(output);
    const input = Buffer.concat([fakeMp4(), Buffer.alloc(32)]).toString("base64");

    await expect(new MediaService().prepareOutgoingVideo(input)).resolves.toEqual({
      compressed: true,
      data: output,
      mimeType: "video/mp4",
    });
    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("libx264");
    expect(args).toContain("30");
    expect(args).toContain(
      "scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    );
  });

  it("converts a short MP4 to an animated sticker and can flatten it", async () => {
    const output = webp512();
    const runner = vi.spyOn(audioTools, "runFfmpegCommand").mockResolvedValue(output);
    const service = new MediaService();
    const input = fakeMp4().toString("base64");

    await expect(service.prepareSticker(input)).resolves.toMatchObject({
      data: output,
      animated: true,
    });
    expect(runner.mock.calls[0]?.[1]).toContain("libwebp_anim");
    expect(runner.mock.calls[0]?.[1]).toContain("10");

    await expect(service.prepareSticker(input, false)).resolves.toMatchObject({
      animated: false,
    });
    expect(runner.mock.calls[1]?.[1]).toContain("libwebp");
    expect(runner.mock.calls[1]?.[1]).not.toContain("libwebp_anim");
  });
});

describe("send tools keep the original media unless compression is enabled", () => {
  const original = Object.fromEntries(compressionEnvKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    restoreCompressionEnv(original);
  });

  it("queues the original image and video by default", async () => {
    clearCompressionEnv();
    const queued: unknown[] = [];
    const enqueueMessage = vi.fn(async (_instanceId: string, _to: string, content: unknown) => {
      queued.push(content);
      return { status: "queued", jobId: "job" };
    });
    const tools = registerTools(enqueueMessage);
    const image = "https://example.com/photo.jpg";
    const video = "https://example.com/clip.mp4";

    await tools.get("wa_send_image")!(
      SendImageSchema.parse({ instanceId: "inst_test", to: "5511999999999", image }),
    );
    await tools.get("wa_send_video")!(
      SendVideoSchema.parse({ instanceId: "inst_test", to: "5511999999999", video }),
    );

    expect(queued[0]).toMatchObject({ type: "image", image });
    expect(queued[0]).not.toHaveProperty("compress");
    expect(queued[1]).toMatchObject({ type: "video", video });
    expect(queued[1]).not.toHaveProperty("compress");
  });

  it("lets hd skip compression even when the env and compress flag ask for it", async () => {
    process.env.WA_MEDIA_COMPRESS = "true";
    const queued: unknown[] = [];
    const enqueueMessage = vi.fn(async (_instanceId: string, _to: string, content: unknown) => {
      queued.push(content);
      return { status: "queued", jobId: "job" };
    });
    const tools = registerTools(enqueueMessage);

    await tools.get("wa_send_image")!(
      SendImageSchema.parse({
        instanceId: "inst_test",
        to: "5511999999999",
        image: "aGVsbG8=",
        compress: true,
        hd: true,
      }),
    );
    await tools.get("wa_send_video")!(
      SendVideoSchema.parse({
        instanceId: "inst_test",
        to: "5511999999999",
        video: "aGVsbG8=",
        compress: true,
      }),
    );

    expect(queued[0]).not.toHaveProperty("compress");
    expect(queued[1]).toMatchObject({ type: "video", compress: true });
  });

  it("reports an invalid compression env from the send tool", async () => {
    process.env.WA_MEDIA_COMPRESS = "yes";
    const tools = registerTools();
    const response = await tools.get("wa_send_image")!(
      SendImageSchema.parse({
        instanceId: "inst_test",
        to: "5511999999999",
        image: "aGVsbG8=",
      }),
    );

    expect(response).toMatchObject({ isError: true });
  });
});

describe("adapters apply compression only when the queued message asks for it", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends the compressed image buffer from Baileys and leaves the default path alone", async () => {
    const compressed = jpeg(4);
    const prepare = vi
      .spyOn(MediaService.prototype, "prepareOutgoingImage")
      .mockResolvedValue({ compressed: true, data: compressed, mimeType: "image/jpeg" });
    const sendMessage = vi.fn(async () => ({ key: { id: "image-message" } }));
    const adapter = new BaileysAdapter("inst_test");
    Object.assign(adapter, {
      sock: { user: { id: "5511999999999@s.whatsapp.net" }, sendMessage } as unknown as WASocket,
      status: "connected",
    });

    await adapter.sendMessage("5511888888888", {
      type: "image",
      image: "https://example.com/photo.jpg",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      image: { url: "https://example.com/photo.jpg" },
    });

    await adapter.sendMessage("5511888888888", {
      type: "image",
      image: "https://example.com/photo.jpg",
      compress: true,
    });
    expect(sendMessage.mock.calls[1]?.[1]).toMatchObject({ image: compressed });
  });

  it("uploads a compressed video before the Cloud API send", async () => {
    const compressed = fakeMp4();
    vi.spyOn(MediaService.prototype, "prepareOutgoingVideo").mockResolvedValue({
      compressed: true,
      data: compressed,
      mimeType: "video/mp4",
    });
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
              ? { id: "uploaded-video" }
              : { messages: [{ id: "cloud-video" }] },
        } as Response;
      }),
    );
    const adapter = new CloudApiAdapter("inst_cloud_compress");
    await adapter.setCredentials({ accessToken: "test-token", phoneNumberId: "phone-123" });

    await adapter.sendMessage("5511888888888", {
      type: "video",
      video: "https://example.com/clip.mp4",
      compress: true,
    });

    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.url).toContain("/media");
    expect(JSON.parse(String(requests[1]?.init.body))).toMatchObject({
      type: "video",
      video: { id: "uploaded-video" },
    });
  });
});

describe.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
  "ffmpeg sticker and compression output",
  () => {
    const original = Object.fromEntries(compressionEnvKeys.map((key) => [key, process.env[key]]));

    afterEach(() => {
      restoreCompressionEnv(original);
    });

    it("converts a short MP4 into a 512x512 animated WebP within the sticker limit", async () => {
      const mp4 = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=duration=0.5:size=40x24:rate=8",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-movflags",
        "+frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "pipe:1",
      ]);
    const sticker = await new MediaService().prepareSticker(mp4.toString("base64"));
    const info = getWebPInfo(sticker.data);

    expect(sticker.animated).toBe(true);
    expect(info).toMatchObject({ animated: true, width: 512, height: 512 });
    expect(sticker.data.length).toBeLessThanOrEqual(500 * 1024);
  });

    it("makes a large image and video smaller while keeping them playable", async () => {
      clearCompressionEnv();
      const png = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=960x640:rate=1",
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
      ]);
      const image = await new MediaService().prepareOutgoingImage(png.toString("base64"));
      expect(image.compressed).toBe(true);
      if (!image.compressed) return;
      expect(image.data.length).toBeLessThan(png.length);
      expect(image.mimeType).toBe("image/jpeg");
      const imageSize = execFileSync(
        "ffprobe",
        ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", "-i", "pipe:0"],
        { input: image.data, encoding: "utf8" },
      );
      const [width, height] = imageSize.trim().split(",").map(Number);
      expect(Math.max(width!, height!)).toBeLessThanOrEqual(600);

      const video = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=duration=1:size=1280x720:rate=12",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-b:v",
        "4M",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "pipe:1",
      ]);
      const compressed = await new MediaService().prepareOutgoingVideo(video.toString("base64"));
      expect(compressed.compressed).toBe(true);
      if (!compressed.compressed) return;
      expect(compressed.data.length).toBeLessThan(video.length);
      const probe = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,codec_type,width,height",
            "-of",
            "json",
            "-i",
            "pipe:0",
          ],
          { input: compressed.data, encoding: "utf8" },
        ),
      ) as { streams: Array<{ codec_name: string; codec_type: string; width?: number }> };
      expect(probe.streams.map((stream) => stream.codec_name).sort()).toEqual(["aac", "h264"]);
      const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
      expect(videoStream?.width).toBeLessThanOrEqual(720);
    });
  },
);
