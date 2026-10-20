import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { UnrecoverableError } from "bullmq";
import { WAMessageStubType, type WAMessage } from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { ChannelAdapter } from "../src/channels/channel.interface.js";
import { publishOwnDirectParticipantAdds } from "../src/channels/baileys/group-history-event.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import {
  chunkGroupHistoryDigest,
  formatGroupHistoryDigest,
  getGroupHistoryOnJoinCount,
  GROUP_HISTORY_EPHEMERAL_MESSAGE,
  GROUP_HISTORY_NOT_A_MEMBER_MESSAGE,
  isGroupHistoryOnJoinEnabled,
  isOwnGroupHistoryParticipant,
  isShareableGroupHistoryMessage,
  MAX_GROUP_HISTORY_CHUNKS,
  MAX_GROUP_HISTORY_LINE_CHARS,
  prepareGroupHistoryChunks,
  registerGroupHistoryOnJoin,
  type GroupHistorySendResult,
} from "../src/services/group-history.js";
import {
  assertGroupHistoryWritesEnabled,
  GroupHistoryWritesDisabledError,
} from "../src/utils/group-history-error.js";
import { registerGroupTools } from "../src/tools/group.tools.js";
import type { GroupMetadata, Message } from "../src/types/channel.types.js";

const INSTANCE_ID = "history-fixture";
const GROUP_JID = "120363000000000001@g.us";
const OWN_PN = "5511000000000@s.whatsapp.net";
const OWN_LID = "1000000000@lid";
const MEMBER_JID = "5511000000001@s.whatsapp.net";
const MEMBER_LID = "1000000001@lid";

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (params: unknown) => Promise<unknown>;
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ text?: string }>;
};

const cleanups: Array<() => void> = [];

function message(overrides: Partial<Message> & Pick<Message, "id" | "timestamp">): Message {
  return {
    id: overrides.id,
    chatId: GROUP_JID,
    senderId: MEMBER_JID,
    type: "text",
    content: null,
    mediaUrl: null,
    quotedMessageId: null,
    isFromMe: false,
    isForwarded: false,
    status: "received",
    timestamp: overrides.timestamp,
    ...overrides,
  };
}

function groupMetadata(overrides: Partial<GroupMetadata> = {}): GroupMetadata {
  return {
    jid: GROUP_JID,
    subject: "Local group title",
    description: null,
    owner: OWN_PN,
    ownerJid: OWN_PN,
    creation: null,
    participants: [
      {
        jid: OWN_PN,
        role: "admin",
        phone: "5511000000000",
        isAdmin: true,
        isSuperAdmin: false,
      },
      {
        jid: MEMBER_JID,
        role: "member",
        phone: "5511000000001",
        isAdmin: false,
        isSuperAdmin: false,
      },
    ],
    participantCount: 2,
    size: 2,
    announce: false,
    restrict: false,
    isAnnounce: false,
    isLocked: false,
    ephemeralDuration: null,
    inviteCode: null,
    createdAt: null,
    ...overrides,
  };
}

function createAdapter(overrides: Record<string, unknown> = {}): ChannelAdapter {
  return {
    getMessages: vi.fn(async () => [
      message({ id: "one", timestamp: 1_735_689_600, content: "hello" }),
    ]),
    getChats: vi.fn(async () => [
      {
        jid: GROUP_JID,
        name: "Local group title",
        isGroup: true,
        unreadCount: 0,
        isPinned: false,
        isMuted: false,
        isArchived: false,
        lastMessageAt: null,
      },
    ]),
    getContacts: vi.fn(async () => []),
    getGroupMetadata: vi.fn(async () => groupMetadata()),
    getLifecycleStatus: vi.fn(() => ({ phone: OWN_PN, lid: OWN_LID, pushName: "Account" })),
    ...overrides,
  } as unknown as ChannelAdapter;
}

function createQueue() {
  return {
    enqueueGroupHistoryMessage: vi.fn(async () => ({ status: "queued" as const, jobId: "job" })),
  } as unknown as MessageQueue & {
    enqueueGroupHistoryMessage: ReturnType<typeof vi.fn>;
  };
}

function registerTool(adapter: ChannelAdapter, queue: MessageQueue): RegisteredTool {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, options: unknown, handler: unknown) => {
      tools.set(name, {
        inputSchema: (options as { inputSchema: z.ZodType }).inputSchema,
        handler: handler as (params: unknown) => Promise<unknown>,
      });
    },
  } as unknown as McpServer;
  const manager = {
    getAdapter: vi.fn(() => adapter),
    getInstanceChannel: vi.fn(() => "baileys"),
  } as unknown as InstanceManager;
  registerGroupTools(server, manager, queue);
  const tool = tools.get("wa_send_group_history_to_member");
  if (!tool) throw new Error("Group history tool was not registered");
  return tool;
}

async function invoke(tool: RegisteredTool, params: Record<string, unknown>): Promise<ToolResult> {
  return (await tool.handler(tool.inputSchema.parse(params))) as ToolResult;
}

function responseData(result: ToolResult): GroupHistorySendResult {
  return JSON.parse(result.content[0]?.text ?? "{}") as GroupHistorySendResult;
}

function memoryClaim() {
  const seen = new Set<string>();
  return (instanceId: string, messageId: string) => {
    const key = `${instanceId}:${messageId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function sqliteClaim() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE group_history_sends (
      instance_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (instance_id, message_id)
    );
  `);
  const insert = sqlite.prepare(
    "INSERT OR IGNORE INTO group_history_sends (instance_id, message_id, sent_at) VALUES (?, ?, ?)",
  );
  return {
    sqlite,
    claim(instanceId: string, messageId: string) {
      return insert.run(instanceId, messageId, Date.now()).changes > 0;
    },
  };
}

function directAddStub(messageId = "stub-1"): WAMessage {
  return {
    key: {
      remoteJid: GROUP_JID,
      id: messageId,
      participant: OWN_LID,
      participantAlt: OWN_PN,
    },
    messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
    messageStubParameters: [JSON.stringify({ id: MEMBER_LID, phoneNumber: MEMBER_JID })],
  } as WAMessage;
}

function autoJoinFixture(claim = memoryClaim()) {
  const adapter = createAdapter({
    getGroupMetadata: vi.fn(async () =>
      groupMetadata({
        participants: [
          {
            jid: OWN_LID,
            role: "admin",
            phone: "5511000000000",
            isAdmin: true,
            isSuperAdmin: false,
          },
          {
            jid: MEMBER_LID,
            role: "member",
            phone: "5511000000001",
            isAdmin: false,
            isSuperAdmin: false,
          },
        ],
      }),
    ),
  });
  const queue = createQueue();
  const instanceManager = {
    getAdapter: vi.fn(() => adapter),
    getInstanceChannel: vi.fn(() => "baileys"),
  } as unknown as InstanceManager;
  cleanups.push(registerGroupHistoryOnJoin(instanceManager, queue, claim));
  return { adapter, queue };
}

beforeEach(() => {
  vi.stubEnv("WA_GROUP_WRITES_ENABLED", "true");
  vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN", "false");
  vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN_COUNT", "50");
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("wa_send_group_history_to_member", () => {
  it("returns the disabled error and uses an unrecoverable error when the group gate is off", async () => {
    vi.stubEnv("WA_GROUP_WRITES_ENABLED", "false");
    vi.stubEnv("WA_APP_STATE_WRITES_ENABLED", "true");
    const adapter = createAdapter();
    const queue = createQueue();
    const result = await invoke(registerTool(adapter, queue), {
      instanceId: INSTANCE_ID,
      groupJid: GROUP_JID,
      participant: MEMBER_JID,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("group history sharing is disabled");
    expect(queue.enqueueGroupHistoryMessage).not.toHaveBeenCalled();
    expect(() => assertGroupHistoryWritesEnabled()).toThrow(GroupHistoryWritesDisabledError);
    expect(() => assertGroupHistoryWritesEnabled()).toThrow(UnrecoverableError);
  });

  it("clamps counts below 25 and above 100, and reports the default 50", async () => {
    const adapter = createAdapter();
    const queue = createQueue();
    const tool = registerTool(adapter, queue);

    const below = await invoke(tool, {
      instanceId: INSTANCE_ID,
      groupJid: GROUP_JID,
      participant: "5511000000001",
      count: 10,
    });
    const above = await invoke(tool, {
      instanceId: INSTANCE_ID,
      groupJid: GROUP_JID,
      participant: MEMBER_JID,
      count: 150,
    });
    const defaults = await invoke(tool, {
      instanceId: INSTANCE_ID,
      groupJid: GROUP_JID,
      participant: MEMBER_JID,
    });

    expect(responseData(below)).toMatchObject({ requestedCount: 10, count: 25, clamped: true });
    expect(responseData(above)).toMatchObject({ requestedCount: 150, count: 100, clamped: true });
    expect(responseData(defaults)).toMatchObject({ requestedCount: 50, count: 50, clamped: false });
    expect(adapter.getMessages).toHaveBeenNthCalledWith(1, GROUP_JID, 25);
    expect(adapter.getMessages).toHaveBeenNthCalledWith(2, GROUP_JID, 100);
    expect(adapter.getMessages).toHaveBeenNthCalledWith(3, GROUP_JID, 50);
    expect(queue.enqueueGroupHistoryMessage).toHaveBeenCalledWith(
      INSTANCE_ID,
      "5511000000001@s.whatsapp.net",
      expect.any(String),
      "baileys",
    );
  });

  it("refuses a recipient who is not a current member", async () => {
    const adapter = createAdapter();
    const queue = createQueue();
    const result = await invoke(registerTool(adapter, queue), {
      instanceId: INSTANCE_ID,
      groupJid: GROUP_JID,
      participant: "5511000000009@s.whatsapp.net",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(GROUP_HISTORY_NOT_A_MEMBER_MESSAGE);
    expect(queue.enqueueGroupHistoryMessage).not.toHaveBeenCalled();
  });

  it("accepts a member by LID and sends the DM to the phone alias", async () => {
    const adapter = createAdapter({
      getGroupMetadata: vi.fn(async () =>
        groupMetadata({
          participants: [
            {
              jid: MEMBER_LID,
              role: "member",
              phone: "5511000000001",
              isAdmin: false,
              isSuperAdmin: false,
            },
          ],
        }),
      ),
    });
    const queue = createQueue();
    const result = await invoke(registerTool(adapter, queue), {
      instanceId: INSTANCE_ID,
      groupJid: GROUP_JID,
      participant: MEMBER_LID,
    });

    expect(result.isError).toBeUndefined();
    expect(queue.enqueueGroupHistoryMessage).toHaveBeenCalledWith(
      INSTANCE_ID,
      MEMBER_JID,
      expect.stringContaining("hello"),
      "baileys",
    );
  });

  it("refuses groups with disappearing messages", async () => {
    const adapter = createAdapter({
      getGroupMetadata: vi.fn(async () => groupMetadata({ ephemeralDuration: 86_400 })),
    });
    const queue = createQueue();
    const result = await invoke(registerTool(adapter, queue), {
      instanceId: INSTANCE_ID,
      groupJid: GROUP_JID,
      participant: MEMBER_JID,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(GROUP_HISTORY_EPHEMERAL_MESSAGE);
    expect(adapter.getMessages).not.toHaveBeenCalled();
    expect(queue.enqueueGroupHistoryMessage).not.toHaveBeenCalled();
  });

  it("skips revoked and view-once messages and widens the fetch to keep the requested count", async () => {
    const revoked = Array.from({ length: 30 }, (_, index) =>
      message({
        id: `revoked-${index}`,
        timestamp: 2_000 + index,
        content: `secret-${index}`,
        status: "revoked",
      }),
    );
    const hidden = message({
      id: "once",
      timestamp: 1_500,
      content: "view once secret",
      type: "image",
      viewOnce: true,
    });
    const visible = Array.from({ length: 25 }, (_, index) =>
      message({ id: `visible-${index}`, timestamp: index + 1, content: `visible-${index}` }),
    );
    const rows = [...revoked].reverse().concat(hidden, [...visible].reverse());
    const getMessages = vi.fn(async (_jid: string, limit: number) => rows.slice(0, limit));
    const adapter = createAdapter({ getMessages });
    const queue = createQueue();
    const result = await invoke(registerTool(adapter, queue), {
      instanceId: INSTANCE_ID,
      groupJid: GROUP_JID,
      participant: MEMBER_JID,
      count: 25,
    });

    expect(getMessages).toHaveBeenLastCalledWith(GROUP_JID, 100);
    expect(responseData(result).messagesIncluded).toBe(25);
    const sent = queue.enqueueGroupHistoryMessage.mock.calls
      .map((call) => call[2] as string)
      .join("\n");
    expect(sent).toContain("visible-0");
    expect(sent).not.toContain("secret-");
    expect(sent).not.toContain("view once secret");
    expect(isShareableGroupHistoryMessage(hidden)).toBe(false);
    expect(isShareableGroupHistoryMessage(revoked[0]!)).toBe(false);
  });

  it("truncates lines, caps the digest at 5 chunks, and notes the remainder", async () => {
    const messages = Array.from({ length: 12 }, (_, index) =>
      message({
        id: `line-${index}`,
        timestamp: index + 1,
        content: `m${index} ` + "x".repeat(80),
      }),
    );
    const prepared = prepareGroupHistoryChunks(
      {
        groupJid: GROUP_JID,
        groupName: "Equipe",
        messages,
        contacts: [],
        timeZone: "UTC",
      },
      { maxChars: 80, maxChunks: MAX_GROUP_HISTORY_CHUNKS, maxLineChars: 40 },
    );
    expect(prepared.chunks.length).toBeLessThanOrEqual(5);
    expect(prepared.chunks.length).toBeGreaterThan(1);
    expect(prepared.omittedMessages).toBeGreaterThan(0);
    expect(prepared.chunks[1]).toMatch(/^\(2\/\d+\)\n/);
    const body = prepared.chunks.join("\n");
    expect(body).toContain(`…mais ${prepared.omittedMessages}`);
    expect(body).toContain("m11 ");
    expect(body).not.toContain("m0 ");
    expect(body.indexOf(`…mais ${prepared.omittedMessages}`)).toBeLessThan(body.indexOf("m11 "));
    expect(body).not.toContain("x".repeat(80));
    for (const line of body.split("\n")) {
      if (line.startsWith("(")) continue;
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it("drops the oldest messages when the cap is hit and still sends the rest in chronological order", () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      message({
        id: `msg-${index}`,
        timestamp: 1_000 + index,
        content: `token-${index}`,
      }),
    );
    const prepared = prepareGroupHistoryChunks(
      {
        groupJid: GROUP_JID,
        groupName: "Equipe",
        messages: [...messages].reverse(),
        contacts: [],
        timeZone: "UTC",
      },
      { maxChars: 120, maxChunks: 2, maxLineChars: 400 },
    );

    expect(prepared.omittedMessages).toBeGreaterThan(0);
    expect(prepared.messagesIncluded).toBe(messages.length - prepared.omittedMessages);
    const body = prepared.chunks.join("\n");
    const firstKept = messages.length - prepared.messagesIncluded;
    const noteAt = body.indexOf(`…mais ${prepared.omittedMessages}`);
    const firstAt = body.indexOf(`token-${firstKept}`);
    const lastAt = body.indexOf("token-7");
    expect(noteAt).toBeGreaterThanOrEqual(0);
    expect(firstAt).toBeGreaterThan(noteAt);
    expect(lastAt).toBeGreaterThan(firstAt);
    expect(body).not.toContain("token-0");
    for (let index = 0; index < firstKept; index += 1) {
      expect(body).not.toContain(`token-${index}`);
    }
  });

  it("returns the chunks already queued when a later enqueue fails", async () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message({
        id: `wide-${index}`,
        timestamp: index + 1,
        content: "y".repeat(MAX_GROUP_HISTORY_LINE_CHARS),
      }),
    );
    const adapter = createAdapter({ getMessages: vi.fn(async () => messages) });
    const queue = createQueue();
    queue.enqueueGroupHistoryMessage
      .mockResolvedValueOnce({ status: "queued", jobId: "1" })
      .mockRejectedValueOnce(new Error("queue unavailable"));
    const result = await invoke(registerTool(adapter, queue), {
      instanceId: INSTANCE_ID,
      groupJid: GROUP_JID,
      participant: MEMBER_JID,
      count: 40,
    });

    expect(result.isError).toBeUndefined();
    expect(responseData(result).chunksSent).toBe(1);
    expect(responseData(result).note).toContain("1 trechos foram aceitos");
    const first = queue.enqueueGroupHistoryMessage.mock.calls[0]?.[2] as string;
    expect(first).toMatch(/^\(1\/\d+\)\n/);
  });

  it("returns a clear empty-history note and sends nothing", async () => {
    const adapter = createAdapter({ getMessages: vi.fn(async () => []) });
    const queue = createQueue();
    const result = await invoke(registerTool(adapter, queue), {
      instanceId: INSTANCE_ID,
      groupJid: GROUP_JID,
      participant: MEMBER_JID,
    });

    expect(responseData(result)).toMatchObject({ messagesIncluded: 0, chunksSent: 0, count: 50 });
    expect(responseData(result).note).toContain("nada foi enviado");
    expect(queue.enqueueGroupHistoryMessage).not.toHaveBeenCalled();
  });
});

describe("group history formatting and chunking", () => {
  it("formats names, number fallbacks, media placeholders, captions, date changes, and oldest first", () => {
    const base = Date.UTC(2025, 0, 1, 9, 0) / 1_000;
    const messages = [
      message({ id: "later", timestamp: base + 60, content: "newer" }),
      message({
        id: "image",
        timestamp: base,
        senderId: MEMBER_JID,
        pushName: "Push name",
        type: "image",
        content: "photo caption",
        caption: "photo caption",
      }),
      message({
        id: "video",
        timestamp: base + 120,
        senderId: "5511000000003@s.whatsapp.net",
        pushName: "Push name",
        type: "video",
        content: "clip caption",
      }),
      message({ id: "audio", timestamp: base + 180, type: "audio", content: "audio caption" }),
      message({
        id: "document",
        timestamp: base + 240,
        type: "document",
        fileName: "arquivo.pdf",
        content: "document caption",
      }),
      message({ id: "sticker", timestamp: base + 300, type: "sticker" }),
      message({ id: "location", timestamp: base + 360, type: "location", content: "place" }),
      message({ id: "contact", timestamp: base + 420, type: "contact" }),
      message({ id: "poll", timestamp: base + 480, type: "poll", content: "question" }),
      message({
        id: "next-day",
        timestamp: Date.UTC(2025, 0, 2, 0, 1) / 1_000,
        content: "next day",
      }),
      message({
        id: "number-fallback",
        timestamp: base + 540,
        senderId: "5511000000002@s.whatsapp.net",
        content: "unknown sender",
      }),
    ];
    const digest = formatGroupHistoryDigest({
      groupJid: GROUP_JID,
      groupName: "Equipe local",
      messages,
      contacts: [
        {
          jid: MEMBER_JID,
          name: "Contact name",
          notifyName: "Notify name",
          phone: "5511000000001",
          profilePicUrl: null,
          isBusiness: false,
          isBlocked: false,
        },
      ],
      timeZone: "UTC",
    });

    expect(digest).toContain('Histórico recente de "Equipe local" — 11 mensagens');
    expect(digest.indexOf("[imagem] photo caption")).toBeLessThan(digest.indexOf("newer"));
    expect(digest).toContain("2025-01-01 09:00 Contact name: [imagem] photo caption");
    expect(digest).toContain("Push name");
    expect(digest).toContain("[vídeo] clip caption");
    expect(digest).toContain("[áudio] audio caption");
    expect(digest).toContain("[documento: arquivo.pdf] document caption");
    expect(digest).toContain("[figurinha]");
    expect(digest).toContain("[localização] place");
    expect(digest).toContain("[contato]");
    expect(digest).toContain("[enquete] question");
    expect(digest).toContain("2025-01-02 00:01");
    expect(digest).toContain("5511000000002: unknown sender");
  });

  it("prefers line boundaries and hard-splits long lines without splitting surrogate pairs", () => {
    const lines = ["a".repeat(20), "b".repeat(20)];
    const lineChunks = chunkGroupHistoryDigest(lines.join("\n"), 20);
    expect(lineChunks).toEqual(lines);

    const longChunks = chunkGroupHistoryDigest("c".repeat(47), 20);
    expect(longChunks.map((chunk) => chunk.length)).toEqual([20, 20, 7]);

    const emojiChunks = chunkGroupHistoryDigest("😀😀😀", 3);
    expect(emojiChunks).toEqual(["😀", "😀", "😀"]);
    expect(emojiChunks.every((chunk) => chunk.length <= 3)).toBe(true);
  });
});

describe("automatic group history on direct adds", () => {
  it("stays off by default and requires the group write gate", async () => {
    vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN", undefined);
    const disabledByDefault = autoJoinFixture();
    publishOwnDirectParticipantAdds(INSTANCE_ID, [directAddStub()], {
      phone: OWN_PN,
      lid: OWN_LID,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disabledByDefault.queue.enqueueGroupHistoryMessage).not.toHaveBeenCalled();

    vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN", "true");
    vi.stubEnv("WA_GROUP_WRITES_ENABLED", "false");
    const disabledByGate = autoJoinFixture();
    publishOwnDirectParticipantAdds(INSTANCE_ID, [directAddStub("stub-gate")], {
      phone: OWN_PN,
      lid: OWN_LID,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disabledByGate.queue.enqueueGroupHistoryMessage).not.toHaveBeenCalled();
  });

  it("sends a phone-number DM for our own direct add and uses the configured count", async () => {
    vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN", "true");
    vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN_COUNT", "42");
    const fixture = autoJoinFixture();
    const otherAuthor = directAddStub("other-author");
    otherAuthor.key.participant = "5511000000009@s.whatsapp.net";
    otherAuthor.key.participantAlt = "5511000000009@s.whatsapp.net";
    publishOwnDirectParticipantAdds(INSTANCE_ID, [otherAuthor], { phone: OWN_PN, lid: OWN_LID });
    publishOwnDirectParticipantAdds(
      INSTANCE_ID,
      [directAddStub("self-target") as WAMessage].map((stub) => {
        stub.messageStubParameters = [JSON.stringify({ id: OWN_LID, phoneNumber: OWN_PN })];
        return stub;
      }),
      { phone: OWN_PN, lid: OWN_LID },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.queue.enqueueGroupHistoryMessage).not.toHaveBeenCalled();

    publishOwnDirectParticipantAdds(INSTANCE_ID, [directAddStub()], {
      phone: OWN_PN,
      lid: OWN_LID,
    });
    await vi.waitFor(() => expect(fixture.queue.enqueueGroupHistoryMessage).toHaveBeenCalledOnce());
    expect(fixture.adapter.getMessages).toHaveBeenCalledWith(GROUP_JID, 42);
    expect(fixture.queue.enqueueGroupHistoryMessage).toHaveBeenCalledWith(
      INSTANCE_ID,
      MEMBER_JID,
      expect.any(String),
      "baileys",
    );
    expect(isOwnGroupHistoryParticipant(OWN_PN, { phone: OWN_PN, lid: OWN_LID })).toBe(true);
  });

  it("does not send a redelivered stub again after the id was recorded", async () => {
    vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN", "true");
    const store = sqliteClaim();
    const first = autoJoinFixture(store.claim);
    publishOwnDirectParticipantAdds(INSTANCE_ID, [directAddStub("reconnect-stub")], {
      phone: OWN_PN,
      lid: OWN_LID,
    });
    await vi.waitFor(() => expect(first.queue.enqueueGroupHistoryMessage).toHaveBeenCalledOnce());

    const restarted = autoJoinFixture(store.claim);
    publishOwnDirectParticipantAdds(INSTANCE_ID, [directAddStub("reconnect-stub")], {
      phone: OWN_PN,
      lid: OWN_LID,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(restarted.queue.enqueueGroupHistoryMessage).not.toHaveBeenCalled();
    expect(first.queue.enqueueGroupHistoryMessage).toHaveBeenCalledOnce();
    store.sqlite.close();
  });

  it("rejects invalid on-join settings instead of turning them off or using 50", () => {
    expect(isGroupHistoryOnJoinEnabled(undefined)).toBe(false);
    expect(isGroupHistoryOnJoinEnabled("true")).toBe(true);
    expect(isGroupHistoryOnJoinEnabled("FALSE")).toBe(false);
    expect(() => isGroupHistoryOnJoinEnabled("yes")).toThrow(/WA_GROUP_HISTORY_ON_JOIN/);
    expect(() => isGroupHistoryOnJoinEnabled("1")).toThrow(/WA_GROUP_HISTORY_ON_JOIN/);
    expect(getGroupHistoryOnJoinCount("42")).toBe(42);
    expect(getGroupHistoryOnJoinCount("10")).toBe(25);
    expect(getGroupHistoryOnJoinCount("150")).toBe(100);
    expect(getGroupHistoryOnJoinCount(undefined)).toBe(50);
    expect(() => getGroupHistoryOnJoinCount("not-a-count")).toThrow(
      /WA_GROUP_HISTORY_ON_JOIN_COUNT/,
    );
    expect(() => getGroupHistoryOnJoinCount("1.5")).toThrow(/WA_GROUP_HISTORY_ON_JOIN_COUNT/);

    vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN", "yes");
    expect(() =>
      registerGroupHistoryOnJoin({} as InstanceManager, createQueue(), memoryClaim()),
    ).toThrow(/WA_GROUP_HISTORY_ON_JOIN/);
  });
});
