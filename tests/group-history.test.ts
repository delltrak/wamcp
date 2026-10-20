import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { ChannelAdapter } from "../src/channels/channel.interface.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import {
  chunkGroupHistoryDigest,
  formatGroupHistoryDigest,
  getGroupHistoryOnJoinCount,
  isGroupHistoryOnJoinEnabled,
  isOwnGroupHistoryJoin,
  isOwnGroupHistoryParticipant,
  registerGroupHistoryOnJoin,
  type GroupHistorySendResult,
} from "../src/services/group-history.js";
import {
  assertGroupHistoryWritesEnabled,
  GroupHistoryWritesDisabledError,
} from "../src/utils/group-history-error.js";
import { registerGroupTools } from "../src/tools/group.tools.js";
import type { Message, NormalizedGroupParticipantsEvent } from "../src/types/channel.types.js";

const INSTANCE_ID = "history-fixture";
const GROUP_JID = "120363000000000001@g.us";
const OWN_PN = "5511000000000@s.whatsapp.net";
const OWN_LID = "1000000000@lid";
const MEMBER_JID = "5511000000001@s.whatsapp.net";

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (params: unknown) => Promise<unknown>;
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ text?: string }>;
};

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

function autoJoinFixture() {
  let listener: ((event: string, instanceId: string, payload: unknown) => void) | undefined;
  const adapter = createAdapter();
  const queue = createQueue();
  const instanceManager = {
    onAnyEvent: vi.fn((handler: unknown) => {
      listener = handler as (event: string, instanceId: string, payload: unknown) => void;
      return vi.fn();
    }),
    getAdapter: vi.fn(() => adapter),
    getInstanceChannel: vi.fn(() => "baileys"),
  } as unknown as InstanceManager;
  registerGroupHistoryOnJoin(instanceManager, queue);

  return {
    adapter,
    queue,
    emit(payload: Partial<NormalizedGroupParticipantsEvent>) {
      listener?.("group.participants_changed", INSTANCE_ID, {
        instanceId: INSTANCE_ID,
        groupId: GROUP_JID,
        action: "add",
        participants: [MEMBER_JID],
        ...payload,
      });
    },
  };
}

beforeEach(() => {
  vi.stubEnv("WA_GROUP_WRITES_ENABLED", "true");
  vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN", "false");
  vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN_COUNT", "50");
});

afterEach(() => {
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

  it("queues all chunks under the conservative limit and normalizes a bare phone number", async () => {
    const longMessage = message({
      id: "large",
      timestamp: 1_735_689_600,
      content: "x".repeat(4_100),
    });
    const adapter = createAdapter({ getMessages: vi.fn(async () => [longMessage]) });
    const queue = createQueue();
    const result = await invoke(registerTool(adapter, queue), {
      instanceId: INSTANCE_ID,
      groupJid: GROUP_JID,
      participant: "5511000000001",
    });

    const chunks = queue.enqueueGroupHistoryMessage.mock.calls.map((call) => call[2] as string);
    expect(responseData(result)).toMatchObject({ messagesIncluded: 1, chunksSent: 3 });
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(chunks[0]).toMatch(/^Histórico recente/);
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
  const directAdd: Partial<NormalizedGroupParticipantsEvent> = {
    action: "add",
    directAdd: true,
    author: OWN_PN,
    authorPn: OWN_LID,
    participants: [OWN_PN, MEMBER_JID],
  };

  it("stays off by default and requires the group write gate", async () => {
    vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN", undefined);
    const disabledByDefault = autoJoinFixture();
    disabledByDefault.emit(directAdd);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disabledByDefault.queue.enqueueGroupHistoryMessage).not.toHaveBeenCalled();

    vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN", "true");
    vi.stubEnv("WA_GROUP_WRITES_ENABLED", "false");
    const disabledByGate = autoJoinFixture();
    disabledByGate.emit(directAdd);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disabledByGate.queue.enqueueGroupHistoryMessage).not.toHaveBeenCalled();
  });

  it("sends only self-authored direct adds, skips self, and uses the configured count", async () => {
    vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN", "true");
    vi.stubEnv("WA_GROUP_HISTORY_ON_JOIN_COUNT", "42");
    const fixture = autoJoinFixture();

    fixture.emit({ ...directAdd, directAdd: false });
    fixture.emit({ ...directAdd, author: "5511000000009@s.whatsapp.net", authorPn: undefined });
    fixture.emit({ ...directAdd, author: undefined, authorPn: undefined });
    fixture.emit({
      ...directAdd,
      participants: ["other-member@lid"],
      participantAliases: [[OWN_PN, "other-member@lid"]],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.queue.enqueueGroupHistoryMessage).not.toHaveBeenCalled();

    fixture.emit(directAdd);
    await vi.waitFor(() => expect(fixture.queue.enqueueGroupHistoryMessage).toHaveBeenCalledOnce());
    expect(fixture.adapter.getMessages).toHaveBeenCalledWith(GROUP_JID, 42);
    expect(fixture.queue.enqueueGroupHistoryMessage).toHaveBeenCalledWith(
      INSTANCE_ID,
      MEMBER_JID,
      expect.any(String),
      "baileys",
    );
    expect(
      isOwnGroupHistoryJoin(
        { ...directAdd, participants: [MEMBER_JID] },
        { phone: OWN_PN, lid: OWN_LID },
      ),
    ).toBe(true);
    expect(isOwnGroupHistoryParticipant(OWN_PN, { phone: OWN_PN, lid: OWN_LID })).toBe(true);
  });

  it("accepts a configured author PN or LID and clamps the join count", () => {
    expect(
      isOwnGroupHistoryJoin(
        { action: "add", directAdd: true, author: "other@lid", authorPn: OWN_PN, participants: [] },
        { phone: OWN_PN, lid: OWN_LID },
      ),
    ).toBe(true);
    expect(isGroupHistoryOnJoinEnabled(undefined)).toBe(false);
    expect(isGroupHistoryOnJoinEnabled("true")).toBe(true);
    expect(getGroupHistoryOnJoinCount("42")).toBe(42);
    expect(getGroupHistoryOnJoinCount("10")).toBe(25);
    expect(getGroupHistoryOnJoinCount("150")).toBe(100);
    expect(getGroupHistoryOnJoinCount("not-a-count")).toBe(50);
  });
});
