import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { BufferJSON, type WAMessage, type WASocket } from "@whiskeysockets/baileys";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { db } from "../src/db/client.js";
import { instances, messages } from "../src/db/schema.js";
import { WHATSAPP_VOICE_MIME_TYPE } from "../src/tts/audio.js";
import { eq } from "drizzle-orm";

const pttHarness = vi.hoisted(() => ({
  preparePttAudio: vi.fn(async (audio: Uint8Array, mimeType?: string) => ({
    audio,
    mimeType: mimeType ?? "audio/ogg; codecs=opus",
    seconds: 4,
    waveform: new Uint8Array(64).fill(42),
  })),
}));

vi.mock("../src/tts/waveform.js", () => ({
  preparePttAudio: pttHarness.preparePttAudio,
}));

const SOURCE_CHAT = "5511888888888@s.whatsapp.net";
const DESTINATION = "5511777777777@s.whatsapp.net";

function sourceMessage(id: string, content: Record<string, unknown>, fromMe = false): WAMessage {
  return {
    key: { id, remoteJid: SOURCE_CHAT, fromMe },
    message: content as WAMessage["message"],
    messageTimestamp: 1_700_000_000,
    pushName: "Stored sender",
  } as WAMessage;
}

function audioMessage(ptt: boolean): Record<string, unknown> {
  return {
    audioMessage: {
      url: "https://mmg.whatsapp.net/audio",
      directPath: "/v/t62.7117-24/audio",
      mediaKey: Buffer.from("media-key-bytes"),
      fileSha256: Buffer.from("file-sha-bytes"),
      fileEncSha256: Buffer.from("file-enc-sha-bytes"),
      fileLength: 1024,
      seconds: 4,
      ptt,
      waveform: Buffer.alloc(64, 42),
      mimetype: "audio/ogg; codecs=opus",
    },
  };
}

function mediaCases(): Array<{ label: string; type: string; content: Record<string, unknown> }> {
  return [
    {
      label: "image",
      type: "image",
      content: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/image",
          directPath: "/v/t62.7118-24/image",
          mediaKey: Buffer.from("image-key"),
          fileSha256: Buffer.from("image-sha"),
          fileEncSha256: Buffer.from("image-enc-sha"),
          fileLength: 512,
          mimetype: "image/jpeg",
          caption: "image caption",
        },
      },
    },
    {
      label: "video",
      type: "video",
      content: {
        videoMessage: {
          url: "https://mmg.whatsapp.net/video",
          directPath: "/v/t62.7161-24/video",
          mediaKey: Buffer.from("video-key"),
          fileSha256: Buffer.from("video-sha"),
          fileEncSha256: Buffer.from("video-enc-sha"),
          fileLength: 2048,
          seconds: 8,
          mimetype: "video/mp4",
          caption: "video caption",
        },
      },
    },
    {
      label: "document",
      type: "document",
      content: {
        documentMessage: {
          url: "https://mmg.whatsapp.net/document",
          directPath: "/v/t62.7119-24/document",
          mediaKey: Buffer.from("document-key"),
          fileSha256: Buffer.from("document-sha"),
          fileEncSha256: Buffer.from("document-enc-sha"),
          fileLength: 4096,
          mimetype: "application/pdf",
          fileName: "document.pdf",
        },
      },
    },
    {
      label: "sticker",
      type: "sticker",
      content: {
        stickerMessage: {
          url: "https://mmg.whatsapp.net/sticker",
          directPath: "/v/t62.7118-24/sticker",
          mediaKey: Buffer.from("sticker-key"),
          fileSha256: Buffer.from("sticker-sha"),
          fileEncSha256: Buffer.from("sticker-enc-sha"),
          fileLength: 256,
          mimetype: "image/webp",
        },
      },
    },
    { label: "PTT audio", type: "audio", content: audioMessage(true) },
    { label: "non-PTT audio", type: "audio", content: audioMessage(false) },
  ];
}

describe("Baileys message forwarding", () => {
  let instanceId: string;

  beforeEach(() => {
    instanceId = `forward_${randomUUID()}`;
    const now = Date.now();
    db.insert(instances)
      .values({ id: instanceId, name: "forward test", createdAt: now, updatedAt: now })
      .run();
    pttHarness.preparePttAudio.mockClear();
  });

  afterEach(() => {
    db.delete(instances).where(eq(instances.id, instanceId)).run();
  });

  function insertStoredMessage(id: string, type: string, rawData: string | null, content?: string) {
    db.insert(messages)
      .values({
        id,
        instanceId,
        chatId: SOURCE_CHAT,
        senderId: SOURCE_CHAT,
        type: type as "text" | "image" | "video" | "audio" | "document" | "sticker",
        content: content ?? null,
        isFromMe: 0,
        status: "received",
        timestamp: 1_700_000_000,
        rawData,
      })
      .run();
  }

  function createAdapter(sendMessage: WASocket["sendMessage"]) {
    const socket = {
      user: { id: "5511999999999@s.whatsapp.net" },
      sendMessage: vi.fn(sendMessage),
    } as unknown as WASocket;
    const adapter = new BaileysAdapter(instanceId);
    Object.assign(adapter, { sock: socket, status: "connected" });
    return { adapter, socket };
  }

  it.each(mediaCases())(
    "forwards $label with its original media proto",
    async ({ label, type, content }) => {
      const id = `stored-${label.replaceAll(" ", "-")}`;
      const original = sourceMessage(id, content);
      insertStoredMessage(id, type, JSON.stringify(original, BufferJSON.replacer));
      const { adapter, socket } = createAdapter(
        async () => ({ key: { id: "forwarded-id" } }) as WAMessage,
      );

      await expect(adapter.forwardMessage(DESTINATION, id, SOURCE_CHAT)).resolves.toMatchObject({
        messageId: "forwarded-id",
        status: "sent",
      });

      expect(socket.sendMessage).toHaveBeenCalledOnce();
      const forward = socket.sendMessage.mock.calls[0]?.[1] as { forward: WAMessage };
      expect(forward.forward.message).toEqual(content);
      expect(forward.forward.key).toMatchObject({ id, remoteJid: SOURCE_CHAT, fromMe: false });
      const mediaField = `${type}Message`;
      expect(
        (forward.forward.message as Record<string, Record<string, unknown>>)[mediaField],
      ).toBeDefined();
    },
  );

  it("round-trips PTT proto buffers from stored raw_data", async () => {
    const id = "stored-ptt-buffer-roundtrip";
    const original = sourceMessage(id, audioMessage(true));
    insertStoredMessage(id, "audio", JSON.stringify(original, BufferJSON.replacer));
    const { adapter, socket } = createAdapter(
      async () => ({ key: { id: "forwarded-id" } }) as WAMessage,
    );

    await adapter.forwardMessage(DESTINATION, id, SOURCE_CHAT);

    const forwarded = (socket.sendMessage.mock.calls[0]?.[1] as { forward: WAMessage }).forward;
    const audio = forwarded.message?.audioMessage;
    expect(audio?.ptt).toBe(true);
    expect(Buffer.isBuffer(audio?.mediaKey)).toBe(true);
    expect(Buffer.isBuffer(audio?.fileSha256)).toBe(true);
    expect(Buffer.isBuffer(audio?.fileEncSha256)).toBe(true);
    expect(Buffer.isBuffer(audio?.waveform)).toBe(true);
  });

  it("persists the full WAMessage returned by an outgoing PTT send", async () => {
    const outgoingId = "outgoing-ptt-stored";
    const outgoing = sourceMessage(outgoingId, audioMessage(true), true);
    outgoing.key.remoteJid = "5511777777777@s.whatsapp.net";
    const { adapter } = createAdapter(async () => outgoing);

    await adapter.sendMessage("5511777777", {
      type: "audio",
      audio: Buffer.from("source audio").toString("base64"),
      ptt: true,
      mimeType: WHATSAPP_VOICE_MIME_TYPE,
    });

    const stored = db
      .select({ rawData: messages.rawData, type: messages.type, isFromMe: messages.isFromMe })
      .from(messages)
      .where(eq(messages.id, outgoingId))
      .get();
    expect(stored).toMatchObject({ type: "audio", isFromMe: 1 });
    expect(stored?.rawData).toBeTruthy();
    const revived = JSON.parse(stored!.rawData!, BufferJSON.reviver) as WAMessage;
    expect(revived.pushName).toBe("Stored sender");
    expect(revived.message?.audioMessage?.ptt).toBe(true);
    expect(Buffer.isBuffer(revived.message?.audioMessage?.mediaKey)).toBe(true);
    expect(Buffer.isBuffer(revived.message?.audioMessage?.waveform)).toBe(true);
  });

  it("uses normalized stored text when an older row has no raw message", async () => {
    const id = "legacy-text-without-raw-data";
    insertStoredMessage(id, "text", null, "original text");
    const { adapter, socket } = createAdapter(
      async () => ({ key: { id: "forwarded-text" } }) as WAMessage,
    );

    await adapter.forwardMessage(DESTINATION, id, SOURCE_CHAT);

    expect(socket.sendMessage).toHaveBeenCalledWith(
      DESTINATION,
      expect.objectContaining({
        forward: expect.objectContaining({ message: { conversation: "original text" } }),
      }),
    );
  });

  it("returns an error and sends nothing when stored media content is unavailable", async () => {
    const id = "legacy-audio-without-content";
    insertStoredMessage(id, "audio", null);
    const { adapter, socket } = createAdapter(
      async () => ({ key: { id: "unexpected" } }) as WAMessage,
    );

    await expect(adapter.forwardMessage(DESTINATION, id, SOURCE_CHAT)).rejects.toThrow(
      "full content is unavailable",
    );
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it("does not send a partial media proto as a forward", async () => {
    const id = "partial-audio-content";
    const partialAudio = sourceMessage(id, {
      audioMessage: { ptt: true, mimetype: "audio/ogg; codecs=opus" },
    });
    insertStoredMessage(id, "audio", JSON.stringify(partialAudio, BufferJSON.replacer));
    const { adapter, socket } = createAdapter(
      async () => ({ key: { id: "unexpected" } }) as WAMessage,
    );

    await expect(adapter.forwardMessage(DESTINATION, id, SOURCE_CHAT)).rejects.toThrow(
      "full content is unavailable",
    );
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it("does not send an empty text proto as a forward", async () => {
    const id = "empty-text-content";
    insertStoredMessage(
      id,
      "text",
      JSON.stringify(sourceMessage(id, { conversation: "" }), BufferJSON.replacer),
    );
    const { adapter, socket } = createAdapter(
      async () => ({ key: { id: "unexpected" } }) as WAMessage,
    );

    await expect(adapter.forwardMessage(DESTINATION, id, SOURCE_CHAT)).rejects.toThrow(
      "full content is unavailable",
    );
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });
});
