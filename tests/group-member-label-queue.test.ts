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

describe("group member label queue", () => {
  it("uses the instance outbound queue and rate limiter for label changes", async () => {
    vi.stubEnv("WA_BAILEYS_RATE_LIMIT", "7");
    const updateGroupMemberLabel = vi.fn(async () => {});
    const adapter = {
      assertGroupMemberLabelWritesEnabled: vi.fn(),
      updateGroupMemberLabel,
    } as unknown as ChannelAdapter;
    const messageQueue = new MessageQueue();
    messageQueue.setAdapterResolver(() => adapter);

    await expect(
      messageQueue.enqueueGroupMemberLabel(
        "inst_group_label_fixture",
        "120363000000000000@g.us",
        "Group coordinator",
      ),
    ).resolves.toEqual({ status: "queued", jobId: "label-job-1" });
    await expect(
      messageQueue.enqueueGroupMemberLabel(
        "inst_group_label_fixture",
        "120363000000000000@g.us",
        null,
      ),
    ).resolves.toEqual({ status: "queued", jobId: "label-job-2" });

    expect(mockQueueState.queues).toHaveLength(1);
    expect(mockQueueState.queues[0]?.name).toBe("outbound-inst_group_label_fixture");
    expect(mockQueueState.workers).toHaveLength(1);
    expect(mockQueueState.workers[0]?.name).toBe("outbound-inst_group_label_fixture");
    expect(
      (mockQueueState.workers[0]?.options as { limiter: { max: number; duration: number } })
        .limiter,
    ).toEqual({ max: 7, duration: 60_000 });
    expect(mockQueueState.jobs.map((job) => job.data)).toEqual([
      {
        kind: "group-member-label",
        instanceId: "inst_group_label_fixture",
        groupId: "120363000000000000@g.us",
        memberLabel: "Group coordinator",
      },
      {
        kind: "group-member-label",
        instanceId: "inst_group_label_fixture",
        groupId: "120363000000000000@g.us",
        memberLabel: null,
      },
    ]);

    for (const job of mockQueueState.jobs) {
      await mockQueueState.workers[0]?.process({ data: job.data });
    }
    expect(updateGroupMemberLabel).toHaveBeenNthCalledWith(
      1,
      "120363000000000000@g.us",
      "Group coordinator",
    );
    expect(updateGroupMemberLabel).toHaveBeenNthCalledWith(2, "120363000000000000@g.us", null);
  });
});
