import { afterEach, describe, expect, it, vi } from "vitest";
import { initAuthCreds, makeWASocket, proto } from "@whiskeysockets/baileys";

const GROUP_JID = "120363000000000000@g.us";
const MEMBER_JID = "5500000000002:0@s.whatsapp.net";

vi.mock("ws", () => {
  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    static CLOSING = 2;
    static CONNECTING = 0;
    readyState = Socket.OPEN;
    setMaxListeners(): void {}
    on(): this {
      return this;
    }
    once(event: string, listener: () => void): this {
      if (event === "close") this.closeListener = listener;
      return this;
    }
    close(): void {
      this.readyState = Socket.CLOSED;
      this.closeListener?.();
    }
    send(_data: unknown, callback?: (error?: Error) => void): void {
      callback?.();
    }
    closeListener?: () => void;
  }
  return { default: Socket };
});

function traceLogger() {
  const sent: string[] = [];
  const logger = {
    level: "trace",
    trace(payload: { xml?: string }) {
      if (payload?.xml) sent.push(payload.xml);
    },
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    fatal(): void {},
    child(): typeof logger {
      return logger;
    },
  };
  return { logger, sent };
}

function groupStatusEnvelope(): proto.IMessage {
  return proto.Message.create({
    messageContextInfo: { messageSecret: Buffer.alloc(32, 4) },
    groupStatusMessageV2: {
      message: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/synthetic",
          mimetype: "image/jpeg",
          caption: "still",
          contextInfo: { isGroupStatus: true },
        },
      },
    },
  });
}

describe("Baileys group status retry patch", () => {
  const sockets: Array<{ end?: (error?: Error) => void }> = [];

  afterEach(() => {
    for (const socket of sockets) socket.end?.(undefined);
    sockets.length = 0;
  });

  it("adds the meta node and image mediatype when retrying the envelope to the whole group", async () => {
    const creds = initAuthCreds();
    creds.me = { id: "5500000000001:1@s.whatsapp.net", name: "synthetic" };
    const { logger, sent } = traceLogger();
    const sock = makeWASocket({
      auth: {
        creds,
        keys: {
          get: async (type: string, ids: string[]) => {
            if (type !== "sender-key-memory") return {};
            return Object.fromEntries(ids.map((id) => [id, { [MEMBER_JID]: true }]));
          },
          set: async () => {},
          transaction: async <T>(work: () => Promise<T> | T) => work(),
        },
      },
      logger: logger as never,
      printQRInTerminal: false,
      cachedGroupMetadata: async (jid: string) => ({
        id: jid,
        addressingMode: "pn" as const,
        participants: [{ id: MEMBER_JID, admin: null }],
      }),
      makeSignalRepository: () =>
        ({
          lidMapping: {
            getLIDForPN: async () => undefined,
            getPNForLID: async () => undefined,
            storeLIDPNMappings: async () => {},
          },
          encryptGroupMessage: async () => ({
            ciphertext: Buffer.from("cipher"),
            senderKeyDistributionMessage: Buffer.from("skdm"),
          }),
          encryptMessage: async () => ({ type: "pkmsg", ciphertext: Buffer.from("cipher") }),
          validateSession: async () => ({ exists: true, reason: "" }),
          hasSenderKey: async () => true,
        }) as never,
    });
    sockets.push(sock);

    await sock
      .relayMessage(GROUP_JID, groupStatusEnvelope(), { messageId: "RETRY-STATUS-1" })
      .catch((error: unknown) => {
        if (sent.length === 0) throw error;
      });

    const stanza = sent.find((xml) => xml.includes("RETRY-STATUS-1"));
    expect(stanza).toBeTruthy();
    expect(stanza).toContain("is_group_status='true'");
    expect(stanza).toContain("origin='group_status'");
    expect(stanza).toContain("mediatype='image'");

    sent.length = 0;
    await sock
      .relayMessage(GROUP_JID, groupStatusEnvelope(), {
        messageId: "RETRY-STATUS-2",
        participant: { jid: MEMBER_JID, count: 1 },
      })
      .catch((error: unknown) => {
        if (!sent.some((xml) => xml.includes("RETRY-STATUS-2"))) throw error;
      });
    const participantStanza = sent.find((xml) => xml.includes("RETRY-STATUS-2"));
    expect(participantStanza).toContain("is_group_status='true'");
    expect(participantStanza).toContain("participant=");
  });

  it("leaves a normal group relay without status meta or mediatype", async () => {
    const creds = initAuthCreds();
    creds.me = { id: "5500000000001:1@s.whatsapp.net", name: "synthetic" };
    const { logger, sent } = traceLogger();
    const sock = makeWASocket({
      auth: {
        creds,
        keys: {
          get: async (type: string, ids: string[]) => {
            if (type !== "sender-key-memory") return {};
            return Object.fromEntries(ids.map((id) => [id, { [MEMBER_JID]: true }]));
          },
          set: async () => {},
          transaction: async <T>(work: () => Promise<T> | T) => work(),
        },
      },
      logger: logger as never,
      printQRInTerminal: false,
      cachedGroupMetadata: async (jid: string) => ({
        id: jid,
        addressingMode: "pn" as const,
        participants: [{ id: MEMBER_JID, admin: null }],
      }),
      makeSignalRepository: () =>
        ({
          lidMapping: {
            getLIDForPN: async () => undefined,
            getPNForLID: async () => undefined,
            storeLIDPNMappings: async () => {},
          },
          encryptGroupMessage: async () => ({
            ciphertext: Buffer.from("cipher"),
            senderKeyDistributionMessage: Buffer.from("skdm"),
          }),
          encryptMessage: async () => ({ type: "pkmsg", ciphertext: Buffer.from("cipher") }),
          validateSession: async () => ({ exists: true, reason: "" }),
          hasSenderKey: async () => true,
        }) as never,
    });
    sockets.push(sock);

    await sock
      .relayMessage(GROUP_JID, { conversation: "hello" }, { messageId: "NORMAL-1" })
      .catch((error: unknown) => {
        if (!sent.some((xml) => xml.includes("NORMAL-1"))) throw error;
      });

    const stanza = sent.find((xml) => xml.includes("NORMAL-1"));
    expect(stanza).toBe(
      [
        "<message id='NORMAL-1' to='120363000000000000@g.us' type='text' addressing_mode='pn'>",
        "\t\t<enc v='2' type='skmsg'>",
        "\t\t\t636970686572",
        "\t\t</enc>",
        "</message>",
      ].join("\n"),
    );
  });
});
