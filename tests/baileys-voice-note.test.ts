import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { db } from "../src/db/client.js";
import { instances, messages } from "../src/db/schema.js";
import { WHATSAPP_VOICE_MIME_TYPE } from "../src/tts/audio.js";
import { eq } from "drizzle-orm";

describe("Baileys voice-note payload", () => {
  let instanceId: string;

  beforeEach(async () => {
    instanceId = `voice_note_${randomUUID()}`;
    const now = Date.now();
    (await db.insert(instances)
      .values({ id: instanceId, name: "voice note test", createdAt: now, updatedAt: now })
      .run());
    (await db.insert(messages)
      .values({
        id: "quoted-message",
        instanceId,
        chatId: "0000000000000@s.whatsapp.net",
        senderId: "5511999999999@s.whatsapp.net",
        type: "text",
        content: "Quoted message",
        isFromMe: 0,
        status: "received",
        timestamp: now,
      })
      .run());
  });

  afterEach(async () => {
    (await db.delete(instances).where(eq(instances.id, instanceId)).run());
  });

  it("sends audio as PTT with the required OGG/Opus MIME type and quoted message", async () => {
    const socket = {
      sendMessage: vi.fn(async () => ({ key: { id: "sent-message" } })),
    };
    const adapter = new BaileysAdapter(instanceId);
    Object.assign(adapter, { sock: socket, status: "connected" });
    const audio = Buffer.from("OggS-voice-note");

    await adapter.sendMessage("0000000000000", {
      type: "audio",
      audio: audio.toString("base64"),
      ptt: true,
      mimeType: WHATSAPP_VOICE_MIME_TYPE,
      quotedMessageId: "quoted-message",
    });

    expect(socket.sendMessage).toHaveBeenCalledWith(
      "0000000000000@s.whatsapp.net",
      {
        audio,
        ptt: true,
        mimetype: "audio/ogg; codecs=opus",
      },
      expect.objectContaining({
        quoted: expect.objectContaining({
          key: expect.objectContaining({ id: "quoted-message" }),
        }),
      }),
    );
  });
});
