import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { db } from "../src/db/client.js";
import { instances, messages } from "../src/db/schema.js";
import { MarkReadSchema } from "../src/schemas/messaging.schema.js";
import {
  getAutoReadMode,
  scheduleBaileysMessagesRead,
  scheduleFetchedMessagesRead,
  scheduleIncomingMessageRead,
} from "../src/services/auto-read.js";
import { logger } from "../src/utils/logger.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const previousAutoRead = process.env.WA_AUTO_READ;

async function flushBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("automatic read receipts", () => {
  beforeEach(() => {
    delete process.env.WA_AUTO_READ;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (previousAutoRead === undefined) delete process.env.WA_AUTO_READ;
    else process.env.WA_AUTO_READ = previousAutoRead;
    vi.restoreAllMocks();
  });

  it("defaults to off", async () => {
    const markRead = vi.fn().mockResolvedValue(undefined);
    const adapter = { markRead };

    expect(getAutoReadMode()).toBe("off");
    scheduleFetchedMessagesRead(
      adapter,
      "5511999999999@s.whatsapp.net",
      [{ id: "incoming", isFromMe: false }],
      "inst_test",
    );
    scheduleIncomingMessageRead(
      adapter,
      "5511999999999@s.whatsapp.net",
      "incoming",
      false,
      "inst_test",
    );
    expect(markRead).not.toHaveBeenCalled();
    await flushBackgroundWork();

    expect(markRead).not.toHaveBeenCalled();
  });

  it("on_fetch marks returned incoming messages only", async () => {
    process.env.WA_AUTO_READ = "on_fetch";
    const markRead = vi.fn().mockResolvedValue(undefined);

    scheduleFetchedMessagesRead(
      { markRead },
      "5511999999999@s.whatsapp.net",
      [
        { id: "incoming", isFromMe: false },
        { id: "outgoing", isFromMe: true },
      ],
      "inst_test",
    );
    scheduleIncomingMessageRead(
      { markRead },
      "5511999999999@s.whatsapp.net",
      "arriving",
      false,
      "inst_test",
    );
    expect(markRead).not.toHaveBeenCalled();
    await flushBackgroundWork();

    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith("5511999999999@s.whatsapp.net", ["incoming"], undefined);
  });

  it("on_receive marks incoming arrivals and skips outgoing and broadcast messages", async () => {
    process.env.WA_AUTO_READ = "on_receive";
    const markRead = vi.fn().mockResolvedValue(undefined);
    const adapter = { markRead };

    scheduleBaileysMessagesRead(
      adapter,
      "notify",
      [
        {
          key: {
            remoteJid: "120363000000000000@g.us",
            id: "group-incoming",
            fromMe: false,
            participant: "5511999999999@s.whatsapp.net",
          },
        },
        {
          key: {
            remoteJid: "5511999999999@s.whatsapp.net",
            id: "outgoing",
            fromMe: true,
          },
        },
        { key: { remoteJid: "status@broadcast", id: "status", fromMe: false } },
        { key: { remoteJid: "123@broadcast", id: "broadcast", fromMe: false } },
      ],
      "inst_test",
    );
    expect(markRead).not.toHaveBeenCalled();
    await flushBackgroundWork();

    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith(
      "120363000000000000@g.us",
      ["group-incoming"],
      "5511999999999@s.whatsapp.net",
    );
  });

  it("treats invalid configuration as off and warns", () => {
    process.env.WA_AUTO_READ = "always";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(getAutoReadMode()).toBe("off");
    expect(getAutoReadMode()).toBe("off");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not propagate read receipt failures", async () => {
    process.env.WA_AUTO_READ = "on_fetch";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const markRead = vi.fn().mockRejectedValue(new Error("receipt failed"));

    expect(() =>
      scheduleFetchedMessagesRead(
        { markRead },
        "5511999999999@s.whatsapp.net",
        [{ id: "incoming", isFromMe: false }],
        "inst_test",
      ),
    ).not.toThrow();
    await flushBackgroundWork();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), instanceId: "inst_test" }),
      "Automatic read receipt failed",
    );
  });
});

describe("BaileysAdapter.markRead", () => {
  let instanceId: string;

  beforeEach(() => {
    instanceId = `test_${randomUUID()}`;
    const now = Date.now();
    db.insert(instances)
      .values({ id: instanceId, name: "test", createdAt: now, updatedAt: now })
      .run();
  });

  afterEach(() => {
    db.delete(instances).where(eq(instances.id, instanceId)).run();
  });

  function connectedAdapter(): { adapter: BaileysAdapter; readMessages: ReturnType<typeof vi.fn> } {
    const adapter = new BaileysAdapter(instanceId);
    const readMessages = vi.fn().mockResolvedValue(undefined);
    Object.assign(adapter, { status: "connected", sock: { readMessages } });
    return { adapter, readMessages };
  }

  it("includes each group message participant and fromMe value from stored rows", async () => {
    const groupJid = "120363000000000000@g.us";
    db.insert(messages)
      .values([
        {
          id: "incoming-group",
          instanceId,
          chatId: groupJid,
          senderId: "5511888888888@s.whatsapp.net",
          type: "text",
          isFromMe: 0,
          status: "received",
          timestamp: 1,
        },
        {
          id: "outgoing-group",
          instanceId,
          chatId: groupJid,
          senderId: "5511999999999@s.whatsapp.net",
          type: "text",
          isFromMe: 1,
          status: "sent",
          timestamp: 2,
        },
      ])
      .run();
    const { adapter, readMessages } = connectedAdapter();

    await adapter.markRead(groupJid, ["incoming-group", "outgoing-group"]);

    expect(readMessages).toHaveBeenCalledWith([
      {
        remoteJid: groupJid,
        id: "incoming-group",
        participant: "5511888888888@s.whatsapp.net",
        fromMe: false,
      },
      {
        remoteJid: groupJid,
        id: "outgoing-group",
        participant: "5511999999999@s.whatsapp.net",
        fromMe: true,
      },
    ]);
  });

  it("keeps direct chat keys unchanged", async () => {
    const chatJid = "5511888888888@s.whatsapp.net";
    const { adapter, readMessages } = connectedAdapter();

    await adapter.markRead(chatJid, ["direct-message"]);

    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: chatJid, id: "direct-message" }]);
  });

  it("uses an explicitly supplied participant when a group message is not stored", async () => {
    const groupJid = "120363000000000000@g.us";
    const { adapter, readMessages } = connectedAdapter();

    await adapter.markRead(groupJid, ["unpersisted-message"], "5511888888888@s.whatsapp.net");

    expect(readMessages).toHaveBeenCalledWith([
      {
        remoteJid: groupJid,
        id: "unpersisted-message",
        participant: "5511888888888@s.whatsapp.net",
        fromMe: false,
      },
    ]);
  });

  it("uses stored group senders before the supplied participant fallback", async () => {
    const groupJid = "120363000000000000@g.us";
    db.insert(messages)
      .values([
        {
          id: "stored-group-one",
          instanceId,
          chatId: groupJid,
          senderId: "5511888888888@s.whatsapp.net",
          type: "text",
          isFromMe: 0,
          status: "received",
          timestamp: 1,
        },
        {
          id: "stored-group-two",
          instanceId,
          chatId: groupJid,
          senderId: "5511777777777@s.whatsapp.net",
          type: "text",
          isFromMe: 0,
          status: "received",
          timestamp: 2,
        },
      ])
      .run();
    const { adapter, readMessages } = connectedAdapter();

    await adapter.markRead(
      groupJid,
      ["stored-group-one", "stored-group-two", "unstored-group"],
      "5511999999999@s.whatsapp.net",
    );

    expect(readMessages).toHaveBeenCalledWith([
      {
        remoteJid: groupJid,
        id: "stored-group-one",
        participant: "5511888888888@s.whatsapp.net",
        fromMe: false,
      },
      {
        remoteJid: groupJid,
        id: "stored-group-two",
        participant: "5511777777777@s.whatsapp.net",
        fromMe: false,
      },
      {
        remoteJid: groupJid,
        id: "unstored-group",
        participant: "5511999999999@s.whatsapp.net",
        fromMe: false,
      },
    ]);
  });

  it("accepts an optional participant while preserving old mark-read inputs", () => {
    expect(
      MarkReadSchema.parse({
        instanceId: "inst_test",
        chatId: "120363000000000000@g.us",
        messageIds: ["message-id"],
      }),
    ).toMatchObject({ messageIds: ["message-id"] });
    expect(
      MarkReadSchema.parse({
        instanceId: "inst_test",
        chatId: "120363000000000000@g.us",
        messageIds: ["message-id"],
        participant: "5511888888888@s.whatsapp.net",
      }).participant,
    ).toBe("5511888888888@s.whatsapp.net");
  });
});
