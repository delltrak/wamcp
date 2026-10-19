import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { WASocket, WAMessage, WAMessageKey } from "@whiskeysockets/baileys";
import { eq } from "drizzle-orm";
import { BaileysAdapter, AppStateNotSyncedError } from "../src/channels/baileys/baileys.adapter.js";
import {
  AppStateResyncLogObserver,
  observeAppStateResyncLogs,
} from "../src/channels/baileys/app-state-write-safety.js";
import { db } from "../src/db/client.js";
import { instances, messages } from "../src/db/schema.js";

const PN_JID = "5511999990000@s.whatsapp.net";
const LID_JID = "1999990000@lid";
const APP_STATE_KEY_ID = "metadata-only-test-key-id";
const originalEnv = {
  appState: process.env.WA_APP_STATE_WRITES_ENABLED,
  group: process.env.WA_GROUP_WRITES_ENABLED,
  interval: process.env.WA_APP_STATE_MIN_INTERVAL_MS,
};
const createdInstances = new Set<string>();

interface AdapterOptions {
  appStateKeyId?: string | null;
  keyPresent?: boolean;
  version?: number | null;
  hashLength?: number;
  onResync?: (observer: AppStateResyncLogObserver) => void;
}

function makeConnectedAdapter(options: AdapterOptions = {}) {
  const instanceId = `app_state_${randomUUID()}`;
  createdInstances.add(instanceId);
  const now = Date.now();
  db.insert(instances)
    .values({ id: instanceId, name: "test", createdAt: now, updatedAt: now })
    .run();

  const versionState =
    options.version === null
      ? undefined
      : {
          version: options.version ?? 3,
          hash: new Uint8Array(options.hashLength ?? 128),
          indexValueMap: {},
        };
  const keyId = "appStateKeyId" in options ? options.appStateKeyId : APP_STATE_KEY_ID;
  const keys = {
    get: vi.fn(async (type: string, ids: string[]) => {
      if (type === "app-state-sync-key") {
        return options.keyPresent === false ? {} : { [ids[0]!]: { keyData: new Uint8Array(32) } };
      }
      if (type === "app-state-sync-version" && versionState) {
        return { [ids[0]!]: versionState };
      }
      return {};
    }),
    set: vi.fn(async () => {}),
  };

  const adapter = new BaileysAdapter(instanceId);
  const observer = (adapter as unknown as { appStateResyncLogObserver: AppStateResyncLogObserver })
    .appStateResyncLogObserver;
  const chatModify = vi.fn(async () => {
    if (versionState) versionState.version += 1;
  });
  const resyncAppState = vi.fn(async () => {
    options.onResync?.(observer);
  });
  const socket = {
    user: { id: PN_JID, lid: LID_JID },
    ws: { isOpen: true },
    authState: { creds: { myAppStateKeyId: keyId }, keys },
    signalRepository: {
      lidMapping: {
        getPNForLID: vi.fn(async (jid: string) => (jid === LID_JID ? PN_JID : null)),
        getLIDForPN: vi.fn(async (jid: string) => (jid === PN_JID ? LID_JID : null)),
      },
    },
    resyncAppState,
    chatModify,
    readMessages: vi.fn(async () => {}),
    groupCreate: vi.fn(async () => ({ id: "120363000000000000@g.us" })),
  } as unknown as WASocket;
  Object.assign(adapter, { sock: socket, status: "connected" });
  return { adapter, instanceId, socket, observer, chatModify, resyncAppState, keys, versionState };
}

function insertMessage(
  instanceId: string,
  input: { id: string; chatId: string; timestamp: number; rawData: string | null },
): void {
  db.insert(messages)
    .values({
      id: input.id,
      instanceId,
      chatId: input.chatId,
      senderId: "sender",
      type: "text",
      content: "stored message",
      status: "received",
      timestamp: input.timestamp,
      rawData: input.rawData,
    })
    .run();
}

function rawMessage(key: WAMessageKey, timestamp: number): string {
  const message: WAMessage = {
    key,
    messageTimestamp: timestamp,
    message: { conversation: "stored message" },
  };
  return JSON.stringify(message);
}

beforeEach(() => {
  delete process.env.WA_APP_STATE_WRITES_ENABLED;
  delete process.env.WA_GROUP_WRITES_ENABLED;
  process.env.WA_APP_STATE_MIN_INTERVAL_MS = "0";
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalEnv.appState === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
  else process.env.WA_APP_STATE_WRITES_ENABLED = originalEnv.appState;
  if (originalEnv.group === undefined) delete process.env.WA_GROUP_WRITES_ENABLED;
  else process.env.WA_GROUP_WRITES_ENABLED = originalEnv.group;
  if (originalEnv.interval === undefined) delete process.env.WA_APP_STATE_MIN_INTERVAL_MS;
  else process.env.WA_APP_STATE_MIN_INTERVAL_MS = originalEnv.interval;
});

describe("safe app-state writes", () => {
  it("observes collection failures through Baileys logger child instances", async () => {
    const observer = new AppStateResyncLogObserver();
    const logger = observeAppStateResyncLogs(pino({ level: "silent" }), observer);

    const result = await observer.capture("regular_low", async () => {
      logger.child({}).warn({ name: "regular_low" }, "failed to sync regular_low, giving up");
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "Baileys reported that the collection failed to sync",
    });
  });

  it("refuses a patch when the current app-state key ID is missing", async () => {
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
    const { adapter, chatModify, resyncAppState } = makeConnectedAdapter({ appStateKeyId: null });

    await expect(adapter.modifyChat(PN_JID, { action: "pin" })).rejects.toMatchObject({
      code: "app_state_not_synced",
      collection: "regular_low",
    });
    expect(resyncAppState).not.toHaveBeenCalled();
    expect(chatModify).not.toHaveBeenCalled();
  });

  it("refuses a patch when the current app-state key is not retrievable", async () => {
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
    const { adapter, chatModify } = makeConnectedAdapter({ keyPresent: false });

    await expect(adapter.modifyChat(PN_JID, { action: "pin" })).rejects.toBeInstanceOf(
      AppStateNotSyncedError,
    );
    expect(chatModify).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing version", version: null },
    { label: "zero version", version: 0 },
  ])("refuses a patch with a $label", async ({ version }) => {
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
    const { adapter, chatModify } = makeConnectedAdapter({ version });

    await expect(adapter.modifyChat(PN_JID, { action: "pin" })).rejects.toMatchObject({
      code: "app_state_not_synced",
    });
    expect(chatModify).not.toHaveBeenCalled();
  });

  it("refuses a patch when the stored collection hash is not 128 bytes", async () => {
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
    const { adapter, chatModify } = makeConnectedAdapter({ hashLength: 64 });

    await expect(adapter.modifyChat(PN_JID, { action: "pin" })).rejects.toMatchObject({
      code: "app_state_not_synced",
    });
    expect(chatModify).not.toHaveBeenCalled();
  });

  it.each([
    "regular_low blocked on missing key from v3, parking after attempts",
    "failed to sync regular_low from v3, giving up",
    "LTHash verification failed, skipping remaining patches",
  ])("refuses a patch when resync reports '%s'", async (logMessage) => {
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
    const { adapter, chatModify } = makeConnectedAdapter({
      onResync: (observer) => observer.observe([{ name: "regular_low" }, logMessage]),
    });

    await expect(adapter.modifyChat(PN_JID, { action: "pin" })).rejects.toMatchObject({
      code: "app_state_not_synced",
      collection: "regular_low",
    });
    expect(chatModify).not.toHaveBeenCalled();
  });

  it("refuses a patch when resync throws", async () => {
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
    const { adapter, chatModify, socket } = makeConnectedAdapter();
    (socket.resyncAppState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("test transport failure"),
    );

    await expect(adapter.modifyChat(PN_JID, { action: "pin" })).rejects.toMatchObject({
      code: "app_state_not_synced",
      reason: "Baileys resync threw an error",
    });
    expect(chatModify).not.toHaveBeenCalled();
  });

  it("patches an in-sync collection and resyncs after success", async () => {
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
    const { adapter, chatModify, resyncAppState, keys } = makeConnectedAdapter();

    await adapter.modifyChat(PN_JID, { action: "pin" });

    expect(chatModify).toHaveBeenCalledOnce();
    expect(resyncAppState).toHaveBeenCalledTimes(2);
    expect(keys.set).not.toHaveBeenCalled();
  });

  it("serializes writes and spaces their starts by the configured interval", async () => {
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
    process.env.WA_APP_STATE_MIN_INTERVAL_MS = "1500";
    vi.useFakeTimers();
    const { adapter, socket, versionState } = makeConnectedAdapter();
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    (socket.chatModify as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      starts.push(Date.now());
      await Promise.resolve();
      inFlight -= 1;
      if (versionState) versionState.version += 1;
    });

    await adapter.modifyChat(PN_JID, { action: "pin" });
    const secondWrite = adapter.modifyChat(PN_JID, { action: "unpin" });
    await vi.advanceTimersByTimeAsync(1499);
    expect(socket.chatModify as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await secondWrite;

    expect(maxInFlight).toBe(1);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1500);
  });
});

describe("chat patch payloads", () => {
  beforeEach(() => {
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
  });

  it("uses a minimal raw-key range, seconds timestamps, and the raw PN/LID address", async () => {
    const { adapter, instanceId, chatModify } = makeConnectedAdapter();
    for (let index = 0; index < 5; index += 1) {
      const id = `unread-${index}`;
      const timestampSeconds = 1_700_000_100 - index;
      const key: WAMessageKey = {
        remoteJid: LID_JID,
        remoteJidAlt: PN_JID,
        id,
        fromMe: false,
        participant: "1999991111@lid",
      };
      insertMessage(instanceId, {
        id,
        chatId: PN_JID,
        timestamp: timestampSeconds * 1000,
        rawData: rawMessage(key, timestampSeconds),
      });
    }

    await adapter.markChatUnread(PN_JID);

    expect(chatModify).toHaveBeenCalledOnce();
    const [modification, patchJid] = chatModify.mock.calls[0] as unknown as [
      { markRead: boolean; lastMessages: Array<{ key: WAMessageKey; messageTimestamp: number }> },
      string,
    ];
    expect(patchJid).toBe(LID_JID);
    expect(modification.markRead).toBe(false);
    expect(modification.lastMessages).toHaveLength(3);
    expect(modification.lastMessages.map((message) => message.messageTimestamp)).toEqual([
      1_700_000_100, 1_700_000_099, 1_700_000_098,
    ]);
    expect(modification.lastMessages[0]?.key).toMatchObject({
      remoteJid: LID_JID,
      remoteJidAlt: PN_JID,
      participant: "1999991111@lid",
      fromMe: false,
    });
  });

  it("skips invalid rows and refuses mark-unread when no valid raw key remains", async () => {
    const { adapter, instanceId, chatModify } = makeConnectedAdapter();
    insertMessage(instanceId, {
      id: "unread-no-key",
      chatId: PN_JID,
      timestamp: 1_700_000_100_000,
      rawData: null,
    });

    await expect(adapter.markChatUnread(PN_JID)).rejects.toThrow(
      "no valid stored message key and timestamp",
    );
    expect(chatModify).not.toHaveBeenCalled();
  });

  it("uses the raw message key and raw address for star/unstar", async () => {
    const { adapter, instanceId, chatModify } = makeConnectedAdapter();
    const key: WAMessageKey = {
      remoteJid: LID_JID,
      remoteJidAlt: PN_JID,
      id: "star-message",
      fromMe: false,
      participant: "1999991111@lid",
    };
    insertMessage(instanceId, {
      id: key.id!,
      chatId: PN_JID,
      timestamp: 1_700_000_100_000,
      rawData: rawMessage(key, 1_700_000_100),
    });

    await adapter.starMessage(PN_JID, key.id!, true);

    expect(chatModify).toHaveBeenCalledOnce();
    expect(chatModify.mock.calls[0]?.[1]).toBe(LID_JID);
    expect(chatModify.mock.calls[0]?.[0]).toMatchObject({
      star: { messages: [key], star: true },
    });
  });

  it("refuses to star a message when its stored raw key is unavailable", async () => {
    const { adapter, instanceId, chatModify } = makeConnectedAdapter();
    insertMessage(instanceId, {
      id: "star-without-key",
      chatId: PN_JID,
      timestamp: 1_700_000_100_000,
      rawData: null,
    });

    await expect(adapter.starMessage(PN_JID, "star-without-key", true)).rejects.toThrow(
      "stored raw message key is unavailable",
    );
    expect(chatModify).not.toHaveBeenCalled();
  });

  it("uses a stored raw key for the read-receipt path when available", async () => {
    const { adapter, instanceId, socket } = makeConnectedAdapter();
    const key: WAMessageKey = {
      remoteJid: LID_JID,
      remoteJidAlt: PN_JID,
      id: "read-message",
      fromMe: false,
      participant: "1999991111@lid",
    };
    insertMessage(instanceId, {
      id: key.id!,
      chatId: PN_JID,
      timestamp: 1_700_000_100_000,
      rawData: rawMessage(key, 1_700_000_100),
    });

    await adapter.markRead(PN_JID, [key.id!]);

    expect(socket.readMessages).toHaveBeenCalledWith([key]);
  });

  it("uses safeChatModify for every direct chatModify call site", async () => {
    const source = await readFile(
      new URL("../src/channels/baileys/baileys.adapter.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/\bsock\.chatModify\s*\(/g)).toHaveLength(1);
  });
});

describe("group write opt-in", () => {
  it("allows group IQ operations with the group flag while app-state patches stay blocked", async () => {
    process.env.WA_GROUP_WRITES_ENABLED = "true";
    const { adapter, socket, chatModify } = makeConnectedAdapter();

    await expect(adapter.createGroup("A test group", [PN_JID])).resolves.toMatchObject({
      groupId: "120363000000000000@g.us",
    });
    await expect(adapter.modifyChat(PN_JID, { action: "pin" })).rejects.toThrow(
      "WA_APP_STATE_WRITES_ENABLED=true",
    );
    expect(socket.groupCreate).toHaveBeenCalledOnce();
    expect(chatModify).not.toHaveBeenCalled();
  });

  it("keeps both write gates disabled by default", async () => {
    const { adapter } = makeConnectedAdapter();

    await expect(adapter.modifyChat(PN_JID, { action: "pin" })).rejects.toThrow(
      "WA_APP_STATE_WRITES_ENABLED=true",
    );
    await expect(adapter.createGroup("A test group", [PN_JID])).rejects.toThrow(
      "WA_GROUP_WRITES_ENABLED=true",
    );
  });
});

afterEach(() => {
  for (const instanceId of createdInstances) {
    db.delete(instances).where(eq(instances.id, instanceId)).run();
  }
  createdInstances.clear();
});
