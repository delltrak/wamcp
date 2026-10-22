import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../src/channels/channel.interface.js";
import { groupHistoryMessageFingerprint } from "../src/services/group-history.js";
import type { Message } from "../src/types/channel.types.js";
import { MessageQueue } from "../src/services/message-queue.js";

const mockQueueState = vi.hoisted(() => ({
  queues: [] as Array<{ name: string; options: unknown }>,
  workers: [] as Array<{
    name: string;
    options: unknown;
    process: (job: { data: unknown }) => Promise<void>;
  }>,
  jobs: [] as Array<{ name: string; data: unknown; options?: unknown }>,
}));

vi.mock("bullmq", () => {
  class FakeQueue {
    constructor(name: string, options: unknown) {
      mockQueueState.queues.push({ name, options });
    }

    async add(name: string, data: unknown, options?: unknown) {
      mockQueueState.jobs.push({ name, data, options });
      return { id: `label-job-${mockQueueState.jobs.length}` };
    }

    async getWaitingCount() {
      return 0;
    }

    async getActiveCount() {
      return 0;
    }

    async getCompletedCount() {
      return 0;
    }

    async getFailedCount() {
      return 0;
    }

    async obliterate() {}
    async close() {}
  }

  class FakeWorker {
    constructor(
      name: string,
      process: (job: { data: unknown }) => Promise<void>,
      options: unknown,
    ) {
      mockQueueState.workers.push({ name, process, options });
    }

    on() {
      return this;
    }

    async close() {}
  }

  class FakeUnrecoverableError extends Error {}

  return {
    Queue: FakeQueue,
    Worker: FakeWorker,
    UnrecoverableError: FakeUnrecoverableError,
  };
});

beforeEach(() => {
  mockQueueState.queues.length = 0;
  mockQueueState.workers.length = 0;
  mockQueueState.jobs.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("group history queue privacy", () => {
  const groupJid = "123456789@g.us";
  const destination = "111@s.whatsapp.net";
  function fixture() {
    vi.stubEnv("WA_GROUP_WRITES_ENABLED", "true");
    const source: Message = {
      id: "source",
      chatId: groupJid,
      senderId: destination,
      type: "text",
      content: "secret",
      mediaUrl: null,
      quotedMessageId: null,
      isFromMe: false,
      isForwarded: false,
      status: "received",
      timestamp: 1000,
    };
    const metadata = { participants: [{ jid: "222@lid", phone: "111" }], ephemeralDuration: 0 };
    const getMessages = vi.fn(async () => [source]);
    const send = vi.fn();
    const adapter = {
      getGroupMetadata: vi.fn(async () => metadata),
      getMessages,
      sendMessage: send,
    } as unknown as ChannelAdapter;
    const queue = new MessageQueue();
    queue.setAdapterResolver(() => adapter);
    const context = {
      groupJid,
      sources: [{ id: source.id, fingerprint: groupHistoryMessageFingerprint(source) }],
    };
    const enqueue = () =>
      queue.enqueueGroupHistoryMessage("fixture", destination, "secret", "baileys", context);
    const process = () =>
      mockQueueState.workers[0]!.process({ data: mockQueueState.jobs[0]!.data });
    return { queue, source, metadata, send, getMessages, enqueue, process };
  }
  it("rechecks PN/LID membership and source before sending with one attempt", async () => {
    const f = fixture();
    await f.enqueue();
    expect(mockQueueState.jobs[0]?.options).toEqual({ attempts: 1 });
    f.source.status = "read";
    await f.process();
    expect(f.send).toHaveBeenCalledWith(destination, { type: "text", text: "secret" });
  });
  it("rejects membership removed during a queue delay", async () => {
    const f = fixture();
    await f.enqueue();
    f.metadata.participants = [];
    await expect(f.process()).rejects.toThrow("not a current member");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects a group timer enabled during a queue delay", async () => {
    const f = fixture();
    await f.enqueue();
    f.metadata.ephemeralDuration = 86400;
    await expect(f.process()).rejects.toThrow("disappearing");
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([
    ["revoked", { status: "revoked" }],
    ["view once", { viewOnce: true }],
    ["ephemeral", { ephemeral: true }],
    ["unverifiable", { historySharingBlocked: true }],
    ["edited", { content: "replacement" }],
  ] as Array<[string, Partial<Message>]>)(
    "rejects %s source after enqueue",
    async (_name, change) => {
      const f = fixture();
      await f.enqueue();
      Object.assign(f.source, change);
      await expect(f.process()).rejects.toThrow("no longer shareable");
      expect(f.send).not.toHaveBeenCalled();
    },
  );
  it("rejects sources removed from local storage or the scan window", async () => {
    const f = fixture();
    await f.enqueue();
    f.getMessages.mockResolvedValue([]);
    await expect(f.process()).rejects.toThrow("no longer shareable");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects old persisted jobs without validation context", async () => {
    const f = fixture();
    await f.queue.enqueueGroupHistoryMessage("fixture", destination, "secret");
    await expect(f.process()).rejects.toThrow("no source validation context");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("honors the write gate when a queued job is executed", async () => {
    const f = fixture();
    await f.enqueue();
    vi.stubEnv("WA_GROUP_WRITES_ENABLED", "false");
    await expect(f.process()).rejects.toThrow("disabled");
    expect(f.send).not.toHaveBeenCalled();
  });
});
