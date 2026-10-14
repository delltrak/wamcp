import { describe, expect, it, vi } from "vitest";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { WHATSAPP_VOICE_MIME_TYPE } from "../src/tts/audio.js";

describe("Baileys voice-note payload", () => {
  it("sends audio as PTT with the required OGG/Opus MIME type and quoted message", async () => {
    const socket = {
      sendMessage: vi.fn(async () => ({ key: { id: "sent-message" } })),
    };
    const adapter = new BaileysAdapter("test-instance");
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
