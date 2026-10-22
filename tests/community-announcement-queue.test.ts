import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../src/channels/channel.interface.js";
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

describe("community announcement queue", () => {
  const COMMUNITY = "120363000000000000@g.us";
  const AVISOS = "120363000000000001@g.us";
  function fixture() {
    const resolve = vi.fn(async () => AVISOS);
    const send = vi.fn(async () => ({}));
    const validate = vi.fn();
    const adapter = {
      resolveCommunityAnnouncementGroup: resolve,
      sendMessage: send,
      validateQuotedMessage: validate,
    } as unknown as ChannelAdapter;
    const queue = new MessageQueue();
    queue.setAdapterResolver(() => adapter);
    return { queue, resolve, send, validate };
  }
  it("uses the existing outbound limiter, validates replies and prevents automatic duplicate broadcasts", async () => {
    vi.stubEnv("WA_BAILEYS_RATE_LIMIT", "7");
    const { queue, resolve, send, validate } = fixture();
    const content = { type: "text" as const, text: "Notice", quotedMessageId: "original" };
    expect(await queue.enqueueCommunityAnnouncement("fixture", COMMUNITY, content)).toMatchObject({
      status: "queued",
      to: AVISOS,
    });
    expect(mockQueueState.queues[0]?.name).toBe("outbound-fixture");
    expect(mockQueueState.workers[0]?.options).toMatchObject({
      limiter: { max: 7, duration: 60000 },
    });
    expect(mockQueueState.jobs[0]?.options).toEqual({ attempts: 1 });
    await mockQueueState.workers[0]!.process({ data: mockQueueState.jobs[0]!.data });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith(COMMUNITY, true);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(AVISOS, content);
  });
  it("awaits async quoted-message validation before enqueue and before delivery", async () => {
    const { queue, send, validate } = fixture();
    const content = { type: "text" as const, text: "Notice", quotedMessageId: "original" };
    validate.mockRejectedValueOnce(new Error("missing quote"));
    await expect(queue.enqueueCommunityAnnouncement("fixture", COMMUNITY, content)).rejects.toThrow("missing quote");
    expect(mockQueueState.jobs).toHaveLength(0);
    await queue.enqueueCommunityAnnouncement("fixture", COMMUNITY, content);
    validate.mockRejectedValueOnce(new Error("expired quote"));
    await expect(mockQueueState.workers[0]!.process({ data: mockQueueState.jobs[0]!.data })).rejects.toThrow("expired quote");
    expect(send).not.toHaveBeenCalled();
    await queue.close();
  });
  it("does not enqueue when destination/permissions cannot be verified", async () => {
    const { queue, resolve } = fixture();
    resolve.mockRejectedValue(new Error("Only an Avisos group admin can send"));
    await expect(
      queue.enqueueCommunityAnnouncement("fixture", COMMUNITY, { type: "text", text: "Notice" }),
    ).rejects.toThrow("admin");
    expect(mockQueueState.jobs).toHaveLength(0);
  });
  it("does not silently retarget a queued announcement after a hierarchy change", async () => {
    const { queue, resolve, send } = fixture();
    await queue.enqueueCommunityAnnouncement("fixture", COMMUNITY, {
      type: "text",
      text: "Notice",
    });
    resolve.mockResolvedValue("120363000000000002@g.us");
    await expect(
      mockQueueState.workers[0]!.process({ data: mockQueueState.jobs[0]!.data }),
    ).rejects.toThrow("destination changed");
    expect(send).not.toHaveBeenCalled();
  });
  it("does not send if permissions were revoked after enqueueing", async () => {
    const { queue, resolve, send } = fixture();
    await queue.enqueueCommunityAnnouncement("fixture", COMMUNITY, {
      type: "text",
      text: "Notice",
    });
    resolve.mockRejectedValue(new Error("writes are disabled"));
    await expect(
      mockQueueState.workers[0]!.process({ data: mockQueueState.jobs[0]!.data }),
    ).rejects.toThrow("writes are disabled");
    expect(send).not.toHaveBeenCalled();
  });
});
