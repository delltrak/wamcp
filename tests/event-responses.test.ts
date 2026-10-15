import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  BufferJSON,
  proto,
  type BaileysEventMap,
  type WASocket,
  type WAMessage,
  type WAMessageKey,
} from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { sqlite } from "../src/db/client.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import { registerEventTools } from "../src/tools/event.tools.js";

const ACCOUNT_ID = "5500000000002@s.whatsapp.net";
const RESPONDER_ID = "5500000000009@s.whatsapp.net";
const RESPONDER_LID = "9000000000009@lid";
const UNRESOLVED_RESPONDER_ID = "5500000000011@s.whatsapp.net";
const UNRESOLVED_RESPONDER_LID = "9000000000011@lid";
const EVENT_CREATOR_ID = "5500000000010@s.whatsapp.net";
const EVENT_CREATOR_LID = "9000000000010@lid";
const GROUP_ID = "120363000000000001@g.us";

type EventResponsePayload = {
  eventCreationMessageKey: WAMessageKey;
  encPayload: Uint8Array;
  encIv: Uint8Array;
};

function encryptEventResponse(
  messageSecret: Uint8Array,
  eventMessageId: string,
  eventCreatorJid: string,
  responderJid: string,
  response: proto.Message.EventResponseMessage,
  eventKey: WAMessageKey,
): EventResponsePayload {
  const sign = Buffer.concat([
    Buffer.from(eventMessageId),
    Buffer.from(eventCreatorJid),
    Buffer.from(responderJid),
    Buffer.from("Event Response"),
    Buffer.from([1]),
  ]);
  const key0 = createHmac("sha256", Buffer.alloc(32)).update(messageSecret).digest();
  const encryptionKey = createHmac("sha256", key0).update(sign).digest();
  const iv = randomBytes(12);
  const aad = Buffer.from(`${eventMessageId}\u0000${responderJid}`);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(aad);
  const encoded = proto.Message.EventResponseMessage.encode(response).finish();
  const encrypted = Buffer.concat([cipher.update(encoded), cipher.final(), cipher.getAuthTag()]);
  return {
    eventCreationMessageKey: eventKey,
    encPayload: encrypted,
    encIv: iv,
  };
}

function eventMessage(
  id: string,
  chatId: string,
  key: WAMessageKey,
  messageSecret: Uint8Array,
): WAMessage {
  return {
    key: { ...key, id, remoteJid: chatId },
    message: {
      eventMessage: { name: "Planning", startTime: 1_800_000_000 },
      messageContextInfo: { messageSecret },
    },
    messageTimestamp: 1_800_000_000,
  } as WAMessage;
}

function encryptedResponseMessage(
  id: string,
  chatId: string,
  responderKey: WAMessageKey,
  encrypted: EventResponsePayload,
): WAMessage {
  return {
    key: { ...responderKey, id, remoteJid: chatId, fromMe: false },
    message: { encEventResponseMessage: encrypted },
    messageTimestamp: 1_800_000_123,
  } as WAMessage;
}

describe("Baileys event responses", () => {
  const activeInstances = new Set<string>();

  afterEach(() => {
    for (const instanceId of activeInstances) {
      sqlite.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
    }
    activeInstances.clear();
    vi.unstubAllEnvs();
  });

  function createFixture() {
    vi.stubEnv("WA_AUTO_READ", "false");
    const instanceId = `event-response-test-${randomUUID()}`;
    activeInstances.add(instanceId);
    sqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, 'baileys', 'connected', 1, 1)",
      )
      .run(instanceId, "Synthetic event response test");

    const adapter = new BaileysAdapter(instanceId);
    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void> | void) | undefined;
    const socket = {
      user: { id: ACCOUNT_ID },
      signalRepository: {
        lidMapping: {
          getPNForLID: vi.fn(async (lid: string) => {
            if (lid === RESPONDER_LID) return RESPONDER_ID;
            if (lid === EVENT_CREATOR_LID) return EVENT_CREATOR_ID;
            return null;
          }),
        },
      },
      ev: {
        on: vi.fn(),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
          processEvents = handler;
          return vi.fn();
        }),
      },
    } as unknown as WASocket;
    const adapterInternals = adapter as unknown as {
      sock: WASocket;
      status: "connected";
      bindEvents: (sock: WASocket) => void;
    };
    adapterInternals.sock = socket;
    adapterInternals.status = "connected";
    adapterInternals.bindEvents(socket);

    return {
      instanceId,
      adapter,
      processEvents: async (events: Partial<BaileysEventMap>) => {
        if (!processEvents) throw new Error("Baileys event processor was not registered");
        await processEvents(events);
      },
    };
  }

  async function upsert(
    processEvents: (events: Partial<BaileysEventMap>) => Promise<void>,
    message: WAMessage,
  ): Promise<void> {
    await processEvents({
      "messages.upsert": { type: "notify", messages: [message] },
    } as Partial<BaileysEventMap>);
  }

  it("decrypts an RSVP after its event arrives and returns participant details and counts", async () => {
    const { instanceId, adapter, processEvents } = createFixture();
    const eventId = "private-event-1";
    const chatId = RESPONDER_ID;
    const messageSecret = Buffer.alloc(32, 0x42);
    const originalEventKey: WAMessageKey = {
      id: eventId,
      remoteJid: chatId,
      fromMe: true,
    };
    const responseTimestamp = 1_800_000_123_000;
    const encrypted = encryptEventResponse(
      messageSecret,
      eventId,
      ACCOUNT_ID,
      RESPONDER_ID,
      proto.Message.EventResponseMessage.create({
        response: proto.Message.EventResponseMessage.EventResponseType.GOING,
        timestampMs: responseTimestamp,
        extraGuestCount: 2,
      }),
      originalEventKey,
    );
    const responseMessage = encryptedResponseMessage(
      "private-response-1",
      chatId,
      { remoteJid: chatId },
      encrypted,
    );
    let emittedResponse: unknown;
    adapter.on("event.response", (payload) => {
      emittedResponse = payload;
    });

    await upsert(processEvents, responseMessage);

    const pending = sqlite
      .prepare(
        "SELECT response, raw_data FROM event_responses WHERE instance_id = ? AND event_message_id = ?",
      )
      .get(instanceId, eventId) as { response: string; raw_data: string };
    expect(pending.response).toBe("UNKNOWN");
    expect(JSON.parse(pending.raw_data)).toHaveProperty(
      "message.encEventResponseMessage.encPayload",
    );

    await upsert(processEvents, eventMessage(eventId, chatId, originalEventKey, messageSecret));

    const storedEventRawData = sqlite
      .prepare("SELECT raw_data FROM messages WHERE instance_id = ? AND id = ?")
      .get(instanceId, eventId) as { raw_data: string };
    const storedEvent = JSON.parse(storedEventRawData.raw_data, BufferJSON.reviver) as WAMessage;
    expect(storedEvent.message?.messageContextInfo?.messageSecret).toEqual(messageSecret);
    expect(emittedResponse).toMatchObject({
      eventMessageId: eventId,
      participant: RESPONDER_ID,
      status: "GOING",
      timestamp: responseTimestamp,
      extraGuestCount: 2,
    });

    const responses = await adapter.getEventResponses(chatId, eventId);
    expect(responses).toEqual([
      {
        participant: RESPONDER_ID,
        responder: RESPONDER_ID,
        phone: "5500000000009",
        status: "GOING",
        response: "GOING",
        timestamp: responseTimestamp,
        messageId: "private-response-1",
        extraGuestCount: 2,
      },
    ]);

    let registeredHandler:
      ((params: unknown) => Promise<{ content: Array<{ text?: string }> }>) | undefined;
    const server = {
      registerTool: (_name: string, _config: unknown, handler: unknown) => {
        registeredHandler = handler as typeof registeredHandler;
      },
    } as unknown as McpServer;
    registerEventTools(server, { getAdapter: () => adapter } as unknown as InstanceManager);
    const toolResponse = await registeredHandler?.({
      instanceId,
      chatId,
      eventMessageId: eventId,
    });
    const toolResult = JSON.parse(toolResponse?.content[0]?.text ?? "{}") as {
      count: number;
      counts: Record<string, number>;
      responses: unknown[];
    };
    expect(toolResult).toMatchObject({
      count: 1,
      counts: { GOING: 1, NOT_GOING: 0, MAYBE: 0, UNKNOWN: 0 },
      responses,
    });
  });

  it("resolves LID event creators and responders to their PN authors", async () => {
    const { adapter, processEvents } = createFixture();
    const eventId = "group-event-lid-authors";
    const messageSecret = Buffer.alloc(32, 0x24);
    const eventKey: WAMessageKey = {
      id: eventId,
      remoteJid: GROUP_ID,
      participant: EVENT_CREATOR_LID,
      fromMe: false,
    };
    const encrypted = encryptEventResponse(
      messageSecret,
      eventId,
      EVENT_CREATOR_ID,
      RESPONDER_ID,
      proto.Message.EventResponseMessage.create({
        response: proto.Message.EventResponseMessage.EventResponseType.MAYBE,
        timestampMs: 1_800_000_124_000,
      }),
      eventKey,
    );
    const responseKey: WAMessageKey = {
      remoteJid: GROUP_ID,
      participant: RESPONDER_LID,
    };

    await upsert(processEvents, eventMessage(eventId, GROUP_ID, eventKey, messageSecret));
    await upsert(
      processEvents,
      encryptedResponseMessage("group-response-lid", GROUP_ID, responseKey, encrypted),
    );

    await expect(adapter.getEventResponses(GROUP_ID, eventId)).resolves.toMatchObject([
      {
        participant: RESPONDER_ID,
        status: "MAYBE",
        response: "MAYBE",
        messageId: "group-response-lid",
      },
    ]);
  });

  it("uses participantAlt PN when an event response author LID has no mapping", async () => {
    const { instanceId, adapter, processEvents } = createFixture();
    const eventId = "group-event-unresolved-lid-author";
    const messageSecret = Buffer.alloc(32, 0x31);
    const eventKey: WAMessageKey = {
      id: eventId,
      remoteJid: GROUP_ID,
      fromMe: true,
    };
    const encrypted = encryptEventResponse(
      messageSecret,
      eventId,
      ACCOUNT_ID,
      UNRESOLVED_RESPONDER_ID,
      proto.Message.EventResponseMessage.create({
        response: proto.Message.EventResponseMessage.EventResponseType.GOING,
        timestampMs: 1_800_000_127_000,
      }),
      eventKey,
    );
    const responseKey: WAMessageKey = {
      remoteJid: GROUP_ID,
      participant: UNRESOLVED_RESPONDER_LID,
      participantAlt: UNRESOLVED_RESPONDER_ID,
    };

    await upsert(processEvents, eventMessage(eventId, GROUP_ID, eventKey, messageSecret));
    await upsert(
      processEvents,
      encryptedResponseMessage("group-response-unresolved-lid", GROUP_ID, responseKey, encrypted),
    );

    const stored = sqlite
      .prepare(
        "SELECT responder, response FROM event_responses WHERE instance_id = ? AND event_message_id = ?",
      )
      .get(instanceId, eventId) as { responder: string; response: string };
    expect(stored).toEqual({ responder: UNRESOLVED_RESPONDER_ID, response: "GOING" });
    await expect(adapter.getEventResponses(GROUP_ID, eventId)).resolves.toMatchObject([
      {
        participant: UNRESOLVED_RESPONDER_ID,
        status: "GOING",
        messageId: "group-response-unresolved-lid",
      },
    ]);
  });

  it("uses remoteJidAlt PN when an unresolved one-to-one author LID has no mapping", async () => {
    const { instanceId, adapter, processEvents } = createFixture();
    const eventId = "private-event-unresolved-lid-author";
    const messageSecret = Buffer.alloc(32, 0x32);
    const eventKey: WAMessageKey = {
      id: eventId,
      remoteJid: UNRESOLVED_RESPONDER_ID,
      fromMe: true,
    };
    const encrypted = encryptEventResponse(
      messageSecret,
      eventId,
      ACCOUNT_ID,
      UNRESOLVED_RESPONDER_ID,
      proto.Message.EventResponseMessage.create({
        response: proto.Message.EventResponseMessage.EventResponseType.MAYBE,
        timestampMs: 1_800_000_128_000,
      }),
      eventKey,
    );
    const responseKey: WAMessageKey = {
      remoteJid: UNRESOLVED_RESPONDER_LID,
      remoteJidAlt: UNRESOLVED_RESPONDER_ID,
    };

    await upsert(
      processEvents,
      eventMessage(eventId, UNRESOLVED_RESPONDER_ID, eventKey, messageSecret),
    );
    await upsert(
      processEvents,
      encryptedResponseMessage(
        "private-response-unresolved-lid",
        UNRESOLVED_RESPONDER_LID,
        responseKey,
        encrypted,
      ),
    );

    const stored = sqlite
      .prepare(
        "SELECT responder, response FROM event_responses WHERE instance_id = ? AND event_message_id = ?",
      )
      .get(instanceId, eventId) as { responder: string; response: string };
    expect(stored).toEqual({ responder: UNRESOLVED_RESPONDER_ID, response: "MAYBE" });
    await expect(
      adapter.getEventResponses(UNRESOLVED_RESPONDER_ID, eventId),
    ).resolves.toMatchObject([
      {
        participant: UNRESOLVED_RESPONDER_ID,
        status: "MAYBE",
        messageId: "private-response-unresolved-lid",
      },
    ]);
  });

  it("keeps only the latest response from each participant", async () => {
    const { adapter, processEvents } = createFixture();
    const eventId = "group-event-last-wins";
    const eventKey: WAMessageKey = {
      id: eventId,
      remoteJid: GROUP_ID,
      fromMe: true,
      participant: ACCOUNT_ID,
    };
    await upsert(processEvents, eventMessage(eventId, GROUP_ID, eventKey, Buffer.alloc(32, 5)));

    await processEvents({
      "messages.update": [
        {
          key: eventKey,
          update: {
            eventResponses: [
              {
                eventResponseMessageKey: {
                  id: "response-going",
                  remoteJid: GROUP_ID,
                  participant: RESPONDER_ID,
                },
                senderTimestampMs: 1_800_000_125_000,
                response: {
                  response: proto.Message.EventResponseMessage.EventResponseType.GOING,
                },
              },
              {
                eventResponseMessageKey: {
                  id: "response-not-going",
                  remoteJid: GROUP_ID,
                  participant: RESPONDER_ID,
                },
                senderTimestampMs: 1_800_000_126_000,
                response: {
                  response: proto.Message.EventResponseMessage.EventResponseType.NOT_GOING,
                },
              },
            ],
          },
        },
      ],
    } as Partial<BaileysEventMap>);

    const responses = await adapter.getEventResponses(GROUP_ID, eventId);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      participant: RESPONDER_ID,
      status: "NOT_GOING",
      timestamp: 1_800_000_126_000,
      messageId: "response-not-going",
    });
  });
});
