import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { MessageQueue } from "../src/services/message-queue.js";
import type { ChannelAdapter } from "../src/channels/channel.interface.js";

const fake = vi.hoisted(() => ({
  getJob: vi.fn(),
  getState: vi.fn(),
  close: vi.fn(async () => {}),
  getDeliverySummary: vi.fn(async () => ({
    counts: { delivered: 0, read: 1, played: 0 },
    latestObservedAt: null,
    scope: "observed_participants_only",
  })),
  processors: [] as Array<(job: Job) => Promise<unknown>>,
  job: {} as Record<string, unknown>,
}));
vi.mock("../src/services/delivery-status.js", () => ({
  getDeliverySummary: fake.getDeliverySummary,
}));
vi.mock("bullmq", () => ({
  Queue: class {
    getJob = fake.getJob;
    close = fake.close;
    async add() {
      return { id: "1" };
    }
  },
  Worker: class {
    constructor(_name: string, processor: (job: Job) => Promise<unknown>) {
      fake.processors.push(processor);
    }
    on() {
      return this;
    }
    async close() {}
  },
  UnrecoverableError: class extends Error {},
}));
beforeEach(() => {
  vi.clearAllMocks();
  fake.processors.length = 0;
  fake.getState.mockResolvedValue("completed");
  fake.job = {
    data: { instanceId: "fixture", to: "5500000000001", content: { text: "SECRET_MESSAGE" } },
    getState: fake.getState,
    attemptsMade: 1,
    processedOn: 123,
    finishedOn: 456,
    returnvalue: {
      messageId: "wamid.fixture",
      timestamp: 456,
      status: "sent",
      otpCode: "SECRET_OTP",
    },
    failedReason: "SECRET_ERROR /private/path",
    stacktrace: ["SECRET_STACK"],
  };
  fake.getJob.mockImplementation(async () => fake.job);
});
afterEach(() => vi.restoreAllMocks());
describe("safe, read-only outbound job status", () => {
  it("reads a retained result after restart without starting a worker or exposing data/errors", async () => {
    const queue = new MessageQueue();
    const result = await queue.getJobStatus("fixture", "1");
    expect(result).toMatchObject({
      state: "completed",
      message: { messageId: "wamid.fixture", timestamp: 456, status: "sent" },
      receipts: { counts: { read: 1 }, scope: "observed_participants_only" },
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private\/path/);
    expect(fake.getDeliverySummary).toHaveBeenCalledWith(
      "fixture",
      "5500000000001@s.whatsapp.net",
      "wamid.fixture",
    );
    expect(fake.processors).toHaveLength(0);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it.each(["waiting", "active", "delayed", "prioritized", "waiting-children", "failed"])(
    "reports %s without stale success or raw failure diagnostics",
    async (state) => {
      const queue = new MessageQueue();
      fake.getState.mockResolvedValue(state);
      const result = await queue.getJobStatus("fixture", "1");
      expect(result).toMatchObject({ state, message: null, receipts: null });
      expect(JSON.stringify(result)).not.toMatch(/SECRET|private\/path/);
      expect(fake.getDeliverySummary).not.toHaveBeenCalled();
      expect(fake.processors).toHaveLength(0);
    },
  );
  it("distinguishes missing/cleaned up/cross-instance jobs from Redis errors, and always closes readers", async () => {
    const queue = new MessageQueue();
    fake.getJob.mockResolvedValueOnce(undefined);
    expect(await queue.getJobStatus("fixture", "1")).toEqual({
      instanceId: "fixture",
      jobId: "1",
      state: "missing",
    });
    fake.job.data = { instanceId: "other" };
    expect(await queue.getJobStatus("fixture", "1")).toMatchObject({ state: "missing" });
    fake.job.data = { instanceId: "fixture" };
    fake.getState.mockResolvedValueOnce("unknown");
    expect(await queue.getJobStatus("fixture", "1")).toMatchObject({ state: "missing" });
    fake.getJob.mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(queue.getJobStatus("fixture", "1")).rejects.toThrow("Redis unavailable");
    expect(fake.close).toHaveBeenCalledTimes(4);
  });
  it("handles older/non-message jobs and retains only safe results from all sending worker paths", async () => {
    const queue = new MessageQueue();
    fake.job.returnvalue = null;
    expect(await queue.getJobStatus("fixture", "1")).toMatchObject({
      state: "completed",
      message: null,
    });
    const send = vi.fn(async () => ({
      messageId: "fixture",
      timestamp: 10,
      status: "sent",
      otpCode: "SECRET_OTP",
    }));
    queue.setAdapterResolver(
      () =>
        ({
          sendMessage: send,
          sendMediaAlbum: send,
          resolveCommunityAnnouncementGroup: async () => "group@g.us",
          updateGroupMemberLabel: async () => {},
        }) as unknown as ChannelAdapter,
    );
    await queue.enqueueMessage("fixture", "5500000000001", { type: "text", text: "secret" });
    const processor = fake.processors[0];
    for (const data of [
      { instanceId: "fixture", to: "5500000000001", content: { type: "text", text: "SECRET" } },
      { kind: "album", instanceId: "fixture", to: "group@g.us", images: [] },
      {
        kind: "community-announcement",
        instanceId: "fixture",
        communityId: "community@g.us",
        to: "group@g.us",
        content: { type: "text", text: "SECRET" },
      },
    ])
      expect(await processor({ data } as Job)).toEqual({
        messageId: "fixture",
        timestamp: 10,
        status: "sent",
      });
    expect(
      await processor({
        data: {
          kind: "group-member-label",
          instanceId: "fixture",
          groupId: "group@g.us",
          memberLabel: "SECRET",
        },
      } as Job),
    ).toBeNull();
    // Inspection may reuse an owned Queue, but must not close the live send queue.
    fake.close.mockClear();
    await queue.getJobStatus("fixture", "1");
    expect(fake.close).not.toHaveBeenCalled();
    await queue.close();
  });
});
