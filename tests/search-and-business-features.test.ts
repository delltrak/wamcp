import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  proto,
  type BaileysEventMap,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import { sqlite } from "../src/db/client.js";
import { searchStoredMessages } from "../src/services/message-search.js";
import { normalizeEventWebhookPayload } from "../src/services/event-webhook.js";

const CHAT_ID = "5500000000001@s.whatsapp.net";
const ACCOUNT_ID = "5500000000002@s.whatsapp.net";

function memorySearchDb(): Database.Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE messages (
      id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      media_url TEXT,
      media_mimetype TEXT,
      quoted_id TEXT,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      is_forwarded INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'received',
      timestamp INTEGER NOT NULL,
      starred INTEGER NOT NULL DEFAULT 0
    )
  `);
  return database;
}

function seedSearchMessage(
  database: Database.Database,
  message: {
    id: string;
    content: string;
    timestamp: number;
    sender?: string;
    chatId?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO messages
       (id, instance_id, chat_id, sender_id, type, content, timestamp)
       VALUES (?, 'search-instance', ?, ?, 'text', ?, ?)`,
    )
    .run(
      message.id,
      message.chatId ?? CHAT_ID,
      message.sender ?? ACCOUNT_ID,
      message.content,
      message.timestamp,
    );
}

describe("local message search", () => {
  it("matches case-insensitive substrings and treats LIKE wildcards literally", () => {
    const database = memorySearchDb();
    seedSearchMessage(database, {
      id: "literal",
      content: "Contains 100%_done\\today",
      timestamp: 10,
    });
    seedSearchMessage(database, {
      id: "wildcard",
      content: "Contains 100XYdoneXtoday",
      timestamp: 11,
    });

    const result = searchStoredMessages(database, "search-instance", {
      query: "%_done\\",
      limit: 10,
      offset: 0,
    });

    expect(result.messages.map((message) => message.id)).toEqual(["literal"]);
    database.close();
  });

  it("applies inclusive date, sender, and chat filters with stable newest-first offset pages", () => {
    const database = memorySearchDb();
    seedSearchMessage(database, { id: "same-a", content: "HELLO", timestamp: 20 });
    seedSearchMessage(database, { id: "same-z", content: "hello again", timestamp: 20 });
    seedSearchMessage(database, {
      id: "other-sender",
      content: "hello",
      timestamp: 21,
      sender: "5500000000003@s.whatsapp.net",
    });
    seedSearchMessage(database, {
      id: "other-chat",
      content: "hello",
      timestamp: 22,
      chatId: "5500000000004@s.whatsapp.net",
    });

    const first = searchStoredMessages(database, "search-instance", {
      query: "hello",
      from: 20,
      to: 20,
      sender: ACCOUNT_ID,
      chatId: CHAT_ID,
      limit: 1,
      offset: 0,
    });
    const second = searchStoredMessages(database, "search-instance", {
      query: "hello",
      from: 20,
      to: 20,
      sender: ACCOUNT_ID,
      chatId: CHAT_ID,
      limit: 1,
      offset: 1,
    });

    expect(first.messages.map((message) => message.id)).toEqual(["same-z"]);
    expect(first).toMatchObject({ hasMore: true, nextOffset: 1 });
    expect(second.messages.map((message) => message.id)).toEqual(["same-a"]);
    expect(second).toMatchObject({ hasMore: false, nextOffset: null });
    database.close();
  });
});

describe("Baileys business and message features", () => {
  const instanceId = `feature-test-${randomUUID()}`;
  let activeInstanceId: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (activeInstanceId) {
      sqlite.prepare("DELETE FROM instances WHERE id = ?").run(activeInstanceId);
      activeInstanceId = undefined;
    }
  });

  function enableAppStateWrites(): void {
    vi.stubEnv("WA_APP_STATE_WRITES_ENABLED", "true");
    vi.stubEnv("WA_APP_STATE_MIN_INTERVAL_MS", "0");
  }

  function createFixture(): { instanceId: string; adapter: BaileysAdapter } {
    const id = `${instanceId}-${randomUUID()}`;
    activeInstanceId = id;
    sqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, 'baileys', 'connected', 1, 1)",
      )
      .run(id, "Feature test instance");
    sqlite
      .prepare(
        `INSERT INTO chats (instance_id, jid, name, is_group, updated_at)
         VALUES (?, ?, 'Example chat', 0, 1)`,
      )
      .run(id, CHAT_ID);
    return { instanceId: id, adapter: new BaileysAdapter(id) };
  }

  function addStoredMessage(
    instanceId: string,
    id: string,
    options: {
      chatId?: string;
      sender?: string;
      fromMe?: boolean;
      timestamp?: number;
      rawData?: string;
    } = {},
  ): void {
    sqlite
      .prepare(
        `INSERT INTO messages
         (id, instance_id, chat_id, sender_id, type, content, media_url,
          is_from_me, status, timestamp, raw_data)
         VALUES (?, ?, ?, ?, 'text', ?, NULL, ?, 'received', ?, ?)`,
      )
      .run(
        id,
        instanceId,
        options.chatId ?? CHAT_ID,
        options.sender ?? ACCOUNT_ID,
        `Stored ${id}`,
        options.fromMe ? 1 : 0,
        options.timestamp ?? 100,
        options.rawData ?? null,
      );
  }

  function rawKeyMessage(
    chatId: string,
    id: string,
    fromMe: boolean,
    timestamp: number,
    participant?: string,
  ): string {
    const message: WAMessage = {
      key: { remoteJid: chatId, id, fromMe, ...(participant ? { participant } : {}) },
      messageTimestamp: timestamp,
      message: { conversation: `Stored ${id}` },
    };
    return JSON.stringify(message);
  }

  function installSocket(
    adapter: BaileysAdapter,
    extra: Record<string, unknown> = {},
  ): {
    socket: WASocket;
    processEvents: (events: Partial<BaileysEventMap>) => Promise<void> | void;
  } {
    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void> | void) | undefined;
    const appStateVersion = {
      version: 3,
      hash: new Uint8Array(128),
      indexValueMap: {},
    };
    const keyStore = {
      get: vi.fn(async (type: string, ids: string[]) => {
        if (type === "app-state-sync-key") {
          return { [ids[0]!]: { keyData: new Uint8Array(32) } };
        }
        if (type === "app-state-sync-version") return { [ids[0]!]: appStateVersion };
        return {};
      }),
      set: vi.fn(async () => {}),
    };
    const socket = {
      user: { id: ACCOUNT_ID, name: "Synthetic Business" },
      ws: { isOpen: true },
      authState: { creds: { myAppStateKeyId: "synthetic-app-state-key" }, keys: keyStore },
      resyncAppState: vi.fn().mockResolvedValue(undefined),
      getBusinessProfile: vi.fn().mockResolvedValue({ description: "Synthetic profile" }),
      addLabel: vi.fn().mockResolvedValue(undefined),
      addChatLabel: vi.fn().mockResolvedValue(undefined),
      removeChatLabel: vi.fn().mockResolvedValue(undefined),
      addMessageLabel: vi.fn().mockResolvedValue(undefined),
      removeMessageLabel: vi.fn().mockResolvedValue(undefined),
      chatModify: vi.fn(async () => {
        appStateVersion.version += 1;
      }),
      updateProfileName: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
      fetchMessageHistory: vi.fn().mockResolvedValue("history-request"),
      ev: {
        on: vi.fn(),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
          processEvents = handler;
          return vi.fn();
        }),
      },
      ...extra,
    } as unknown as WASocket;
    const privateAdapter = adapter as unknown as {
      sock: WASocket;
      status: "connected";
      bindEvents: (value: WASocket) => void;
    };
    privateAdapter.sock = socket;
    privateAdapter.status = "connected";
    privateAdapter.bindEvents(socket);
    return {
      socket,
      processEvents: (events) => {
        if (!processEvents) throw new Error("Baileys event processor was not registered");
        return processEvents(events);
      },
    };
  }

  it("creates, edits, deletes, and associates Business labels; label events reach chat listings", async () => {
    enableAppStateWrites();
    const { instanceId: id, adapter } = createFixture();
    const { socket, processEvents } = installSocket(adapter);

    const label = await adapter.createLabel("Follow up", 4);
    await adapter.editLabel(label.id, { name: "Priority", color: 5 });
    await adapter.setChatLabel(CHAT_ID, label.id, true);
    await adapter.setMessageLabel(CHAT_ID, "message-1", label.id, true);
    await adapter.setChatLabel(CHAT_ID, label.id, false);
    await adapter.setMessageLabel(CHAT_ID, "message-1", label.id, false);
    await adapter.deleteLabel(label.id);

    expect(socket.addLabel).toHaveBeenNthCalledWith(
      1,
      ACCOUNT_ID,
      expect.objectContaining({ name: "Follow up", color: 4, deleted: false }),
    );
    expect(socket.addLabel).toHaveBeenLastCalledWith(ACCOUNT_ID, { id: label.id, deleted: true });
    expect(socket.addChatLabel).toHaveBeenCalledWith(CHAT_ID, label.id);
    expect(socket.removeChatLabel).toHaveBeenCalledWith(CHAT_ID, label.id);
    expect(socket.addMessageLabel).toHaveBeenCalledWith(CHAT_ID, "message-1", label.id);
    expect(socket.removeMessageLabel).toHaveBeenCalledWith(CHAT_ID, "message-1", label.id);

    await processEvents({
      "labels.edit": { id: "synced-label", name: "Synced", color: 2, deleted: false },
      "labels.association": {
        type: "add",
        association: { type: "label_jid", chatId: CHAT_ID, labelId: "synced-label" },
      },
    });
    expect(await adapter.listLabels()).toContainEqual({
      id: "synced-label",
      name: "Synced",
      color: 2,
      deleted: false,
    });
    expect((await adapter.getChats())[0]?.labels).toContainEqual({
      id: "synced-label",
      name: "Synced",
      color: 2,
      deleted: false,
    });
    expect(id).toBe(activeInstanceId);
  });

  it("returns a clear error when a non-Business account attempts label operations", async () => {
    enableAppStateWrites();
    const { adapter } = createFixture();
    installSocket(adapter, { getBusinessProfile: vi.fn().mockResolvedValue(undefined) });
    await expect(adapter.createLabel("Follow up", 4)).rejects.toThrow(/Business account/);
  });

  it("marks chats unread with the reverse-chronological lastMessages range and stars stored messages", async () => {
    enableAppStateWrites();
    const { instanceId: id, adapter } = createFixture();
    const groupId = "120363000000000001@g.us";
    sqlite
      .prepare(
        "INSERT INTO chats (instance_id, jid, name, is_group, updated_at) VALUES (?, ?, 'Example group', 1, 1)",
      )
      .run(id, groupId);
    addStoredMessage(id, "earlier", {
      chatId: groupId,
      timestamp: 90,
      rawData: rawKeyMessage(groupId, "earlier", false, 90, ACCOUNT_ID),
    });
    addStoredMessage(id, "later", {
      chatId: groupId,
      timestamp: 100,
      rawData: rawKeyMessage(groupId, "later", false, 100, ACCOUNT_ID),
    });
    addStoredMessage(id, "outgoing", {
      fromMe: true,
      timestamp: 110,
      rawData: rawKeyMessage(CHAT_ID, "outgoing", true, 110),
    });
    const { socket } = installSocket(adapter);

    await adapter.markChatUnread(groupId);
    await adapter.starMessage(CHAT_ID, "outgoing", true);

    const call = vi.mocked(socket.chatModify).mock.calls[0];
    expect(call?.[0]).toMatchObject({
      markRead: false,
      lastMessages: [
        { key: { id: "later", participant: ACCOUNT_ID } },
        { key: { id: "earlier", participant: ACCOUNT_ID } },
      ],
    });
    expect(call?.[1]).toBe(groupId);
    expect(socket.chatModify).toHaveBeenLastCalledWith(
      {
        star: {
          messages: [{ remoteJid: CHAT_ID, id: "outgoing", fromMe: true }],
          star: true,
        },
      },
      CHAT_ID,
    );
    expect(
      sqlite
        .prepare("SELECT starred FROM messages WHERE instance_id = ? AND id = ?")
        .get(id, "outgoing"),
    ).toEqual({ starred: 1 });
  });

  it("blocks app-state writes by default before socket calls or local updates", async () => {
    const originalValue = process.env.WA_APP_STATE_WRITES_ENABLED;
    delete process.env.WA_APP_STATE_WRITES_ENABLED;
    try {
      const { instanceId: id, adapter } = createFixture();
      addStoredMessage(id, "starred-message");
      const { socket } = installSocket(adapter);
      const disabledError =
        "WhatsApp account, server, and app-state writes are disabled. Set WA_APP_STATE_WRITES_ENABLED=true to enable them.";

      await expect(adapter.starMessage(CHAT_ID, "starred-message", true)).rejects.toThrow(
        disabledError,
      );
      await expect(adapter.markChatUnread(CHAT_ID)).rejects.toThrow(disabledError);
      await expect(adapter.modifyChat(CHAT_ID, { action: "archive" })).rejects.toThrow(
        disabledError,
      );
      await expect(adapter.createLabel("Blocked", 4)).rejects.toThrow(disabledError);
      await expect(adapter.editLabel("label-1", { name: "Blocked" })).rejects.toThrow(
        disabledError,
      );
      await expect(adapter.deleteLabel("label-1")).rejects.toThrow(disabledError);
      await expect(adapter.setChatLabel(CHAT_ID, "label-1", true)).rejects.toThrow(disabledError);
      await expect(adapter.setChatLabel(CHAT_ID, "label-1", false)).rejects.toThrow(disabledError);
      await expect(
        adapter.setMessageLabel(CHAT_ID, "starred-message", "label-1", true),
      ).rejects.toThrow(disabledError);
      await expect(
        adapter.setMessageLabel(CHAT_ID, "starred-message", "label-1", false),
      ).rejects.toThrow(disabledError);
      await expect(adapter.updateProfileName("Blocked")).rejects.toThrow(disabledError);

      expect(socket.chatModify).not.toHaveBeenCalled();
      expect(socket.addLabel).not.toHaveBeenCalled();
      expect(socket.addChatLabel).not.toHaveBeenCalled();
      expect(socket.removeChatLabel).not.toHaveBeenCalled();
      expect(socket.addMessageLabel).not.toHaveBeenCalled();
      expect(socket.removeMessageLabel).not.toHaveBeenCalled();
      expect(socket.updateProfileName).not.toHaveBeenCalled();
      expect(socket.getBusinessProfile).not.toHaveBeenCalled();
      expect(
        sqlite
          .prepare("SELECT starred FROM messages WHERE instance_id = ? AND id = ?")
          .get(id, "starred-message"),
      ).toEqual({ starred: 0 });
      expect(sqlite.prepare("SELECT label_id FROM labels WHERE instance_id = ?").all(id)).toEqual(
        [],
      );
      expect(
        sqlite.prepare("SELECT label_id FROM label_associations WHERE instance_id = ?").all(id),
      ).toEqual([]);
    } finally {
      if (originalValue === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
      else process.env.WA_APP_STATE_WRITES_ENABLED = originalValue;
    }
  });

  it("passes app-state writes through when explicitly enabled", async () => {
    enableAppStateWrites();
    const { instanceId: id, adapter } = createFixture();
    addStoredMessage(id, "archive-row", {
      rawData: rawKeyMessage(CHAT_ID, "archive-row", false, 110),
    });
    const { socket } = installSocket(adapter);

    await adapter.modifyChat(CHAT_ID, { action: "archive" });
    await adapter.updateProfileName("Enabled name");

    expect(socket.chatModify).toHaveBeenCalledWith(
      {
        archive: true,
        lastMessages: [
          { key: { remoteJid: CHAT_ID, id: "archive-row", fromMe: false }, messageTimestamp: 100 },
        ],
      },
      CHAT_ID,
    );
    expect(socket.updateProfileName).toHaveBeenCalledWith("Enabled name");
  });

  it("sends quoted event messages and returns decrypted responses persisted from Baileys updates", async () => {
    const { instanceId: id, adapter } = createFixture();
    addStoredMessage(id, "quoted-message");
    const outgoing = {
      key: { id: "event-1", remoteJid: CHAT_ID, fromMe: true },
      message: {
        eventMessage: { name: "Planning", description: "Review", startTime: 1_800_000_000 },
      },
      messageTimestamp: 1_800_000_000,
    } as WAMessage;
    const { socket, processEvents } = installSocket(adapter, {
      sendMessage: vi.fn().mockResolvedValue(outgoing),
    });

    await adapter.sendEvent({
      to: CHAT_ID,
      name: "Planning",
      description: "Review",
      start: "2027-01-15T08:00:00.000Z",
      callType: "voice",
      quotedMessageId: "quoted-message",
    });
    await processEvents({
      "messages.update": [
        {
          key: { id: "event-1", remoteJid: CHAT_ID, fromMe: true },
          update: {
            eventResponses: [
              {
                eventResponseMessageKey: {
                  id: "response-1",
                  remoteJid: CHAT_ID,
                  participant: "5500000000009@s.whatsapp.net",
                },
                senderTimestampMs: 1_800_000_123,
                response: {
                  response: proto.Message.EventResponseMessage.EventResponseType.GOING,
                },
              },
            ],
          },
        },
      ],
    });

    expect(socket.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({
        event: expect.objectContaining({ name: "Planning", call: "audio" }),
      }),
      expect.objectContaining({
        quoted: expect.objectContaining({
          key: { remoteJid: CHAT_ID, id: "quoted-message", fromMe: false },
        }),
      }),
    );
    expect(await adapter.getEventResponses(CHAT_ID, "event-1")).toEqual([
      {
        participant: "5500000000009@s.whatsapp.net",
        responder: "5500000000009@s.whatsapp.net",
        phone: "5500000000009",
        status: "GOING",
        response: "GOING",
        timestamp: 1_800_000_123,
        messageId: "response-1",
      },
    ]);
    expect(
      sqlite
        .prepare("SELECT type, raw_data FROM messages WHERE instance_id = ? AND id = ?")
        .get(id, "event-1"),
    ).toMatchObject({ type: "event", raw_data: expect.any(String) });
  });

  it("anchors on-demand history at the oldest stored message and persists only new results", async () => {
    const { instanceId: id, adapter } = createFixture();
    addStoredMessage(id, "history-anchor", {
      timestamp: 50,
      rawData: JSON.stringify({
        key: { id: "history-anchor", remoteJid: CHAT_ID, fromMe: false },
        message: { conversation: "Anchor" },
        messageTimestamp: "50",
      }),
    });
    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void> | void) | undefined;
    const historyMessage: WAMessage = {
      key: { id: "history-new", remoteJid: CHAT_ID, fromMe: false },
      message: { conversation: "Older fetched text" },
      messageTimestamp: 40,
    };
    const socket = {
      user: { id: ACCOUNT_ID },
      ev: {
        on: vi.fn(),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
          processEvents = handler;
          return vi.fn();
        }),
      },
      fetchMessageHistory: vi.fn().mockImplementation(() => {
        setTimeout(() => {
          void processEvents?.({
            "messaging-history.set": {
              contacts: [],
              chats: [],
              messages: [historyMessage],
              syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
              peerDataRequestSessionId: "history-request",
            },
            "messaging-history.status": {
              syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
              status: "complete",
              explicit: true,
            },
          });
        }, 0);
        return Promise.resolve("history-request");
      }),
    } as unknown as WASocket;
    const privateAdapter = adapter as unknown as {
      sock: WASocket;
      status: "connected";
      bindEvents: (value: WASocket) => void;
    };
    privateAdapter.sock = socket;
    privateAdapter.status = "connected";
    privateAdapter.bindEvents(socket);

    const result = await adapter.fetchMessageHistory(CHAT_ID, 20, 1_000);

    expect(socket.fetchMessageHistory).toHaveBeenCalledWith(
      20,
      expect.objectContaining({ remoteJid: CHAT_ID, id: "history-anchor", fromMe: false }),
      50_000,
    );
    expect(result).toEqual({ requested: 20, stored: 1, timedOut: false });
    expect(await adapter.getMessages(CHAT_ID)).toContainEqual(
      expect.objectContaining({ id: "history-new", content: "Older fetched text" }),
    );
  });

  it("does not let a timed-out history session complete the next request", async () => {
    const { instanceId: id, adapter } = createFixture();
    addStoredMessage(id, "history-anchor", { timestamp: 50 });
    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void> | void) | undefined;
    const oldMessage: WAMessage = {
      key: { id: "late-history-message", remoteJid: CHAT_ID, fromMe: false },
      message: { conversation: "Late history" },
      messageTimestamp: 40,
    };
    const currentMessage: WAMessage = {
      key: { id: "current-history-message", remoteJid: CHAT_ID, fromMe: false },
      message: { conversation: "Current history" },
      messageTimestamp: 30,
    };
    const socket = {
      user: { id: ACCOUNT_ID },
      ev: {
        on: vi.fn(),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
          processEvents = handler;
          return vi.fn();
        }),
      },
      fetchMessageHistory: vi
        .fn()
        .mockResolvedValueOnce("old-session")
        .mockResolvedValueOnce("new-session"),
    } as unknown as WASocket;
    const privateAdapter = adapter as unknown as {
      sock: WASocket;
      status: "connected";
      bindEvents: (value: WASocket) => void;
    };
    privateAdapter.sock = socket;
    privateAdapter.status = "connected";
    privateAdapter.bindEvents(socket);

    const timedOut = await adapter.fetchMessageHistory(CHAT_ID, 20, 5);
    expect(timedOut).toEqual({ requested: 20, stored: 0, timedOut: true });

    const currentRequest = adapter.fetchMessageHistory(CHAT_ID, 20, 1_000);
    await Promise.resolve();
    await processEvents?.({
      "messaging-history.set": {
        contacts: [],
        chats: [],
        messages: [oldMessage],
        syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
        peerDataRequestSessionId: "old-session",
      },
      "messaging-history.status": {
        syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
        status: "complete",
        explicit: true,
      },
    });

    let currentRequestSettled = false;
    void currentRequest.then(() => {
      currentRequestSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(currentRequestSettled).toBe(false);

    await processEvents?.({
      "messaging-history.set": {
        contacts: [],
        chats: [],
        messages: [currentMessage],
        syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
        peerDataRequestSessionId: "new-session",
      },
      "messaging-history.status": {
        syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
        status: "complete",
        explicit: true,
      },
    });

    await expect(currentRequest).resolves.toEqual({ requested: 20, stored: 1, timedOut: false });
  });
});

describe("Cloud API unsupported operations and label webhooks", () => {
  it("returns explicit unsupported errors for Baileys-only features", async () => {
    const adapter = new CloudApiAdapter("cloud-feature-test");
    await expect(
      adapter.sendEvent({ to: CHAT_ID, name: "Event", start: "2027-01-15T08:00:00Z" }),
    ).rejects.toThrow("not supported on Cloud API");
    await expect(adapter.markChatUnread(CHAT_ID)).rejects.toThrow("not supported on Cloud API");
    await expect(adapter.listLabels()).rejects.toThrow("not supported on Cloud API");
    await expect(adapter.fetchMessageHistory(CHAT_ID, 10)).rejects.toThrow(
      "only available on Baileys instances",
    );
  });

  it("adds label and association fields to label change webhook events", () => {
    const payload = normalizeEventWebhookPayload("label.updated", "instance-1", {
      instanceId: "instance-1",
      action: "associated",
      chatId: CHAT_ID,
      label: { id: "label-1", name: "Follow up", color: 4, deleted: false },
      association: { type: "chat", chatId: CHAT_ID },
    });
    expect(payload).toMatchObject({
      event: "label.updated",
      chat: CHAT_ID,
      action: "associated",
      label: { id: "label-1", name: "Follow up", color: 4, deleted: false },
      association: { type: "chat", chatId: CHAT_ID },
    });
  });
});
