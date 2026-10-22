import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../src/services/message-queue.js";

const fake = vi.hoisted(() => ({
  add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({
    id: options?.jobId ?? "ordinary",
  })),
  getJob: vi.fn(),
  getState: vi.fn(),
  remove: vi.fn(async () => {}),
  workers: [] as unknown[],
}));
vi.mock("bullmq", () => ({
  Queue: class {
    add = fake.add;
    getJob = fake.getJob;
    async close() {}
  },
  Worker: class {
    constructor(_name: string, _process: unknown, options: unknown) {
      fake.workers.push(options);
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
  fake.workers.length = 0;
  fake.getJob.mockResolvedValue({
    getState: fake.getState,
    failedReason: "adapter rejected message",
    remove: fake.remove,
  });
});
describe("scheduled outbound queue reconciliation", () => {
  it("retains a caller-identified scheduled result until reconciliation", async () => {
    const queue = new MessageQueue();
    expect(
      await queue.enqueueMessage(
        "instance",
        "5500000000001",
        { type: "text", text: "fixture" },
        "cloud",
        "sched-occurrence",
      ),
    ).toEqual({ status: "queued", jobId: "sched-occurrence" });
    expect(fake.add).toHaveBeenCalledWith("send", expect.any(Object), {
      jobId: "sched-occurrence",
      removeOnComplete: false,
      removeOnFail: false,
    });
    expect(fake.workers[0]).toMatchObject({ limiter: { max: 80, duration: 60000 } });
    await queue.close();
  });
  it.each(["waiting", "active", "delayed", "prioritized", "waiting-children"])(
    "leaves %s pending",
    async (state) => {
      const queue = new MessageQueue();
      fake.getState.mockResolvedValue(state);
      expect(await queue.getMessageJobState("instance", "job", "baileys")).toEqual({
        state: "pending",
      });
      expect(fake.workers).toHaveLength(1);
      expect(fake.add).not.toHaveBeenCalled();
      expect(fake.remove).not.toHaveBeenCalled();
      await queue.close();
    },
  );
  it("exposes terminal success and failure and removes only on explicit acknowledgement", async () => {
    const queue = new MessageQueue();
    fake.getState.mockResolvedValue("completed");
    expect(await queue.getMessageJobState("instance", "job", "baileys")).toEqual({
      state: "completed",
    });
    fake.getState.mockResolvedValue("failed");
    expect(await queue.getMessageJobState("instance", "job", "baileys")).toEqual({
      state: "failed",
      error: "adapter rejected message",
    });
    expect(fake.remove).not.toHaveBeenCalled();
    await queue.removeScheduledJob("instance", "job", "baileys");
    expect(fake.remove).toHaveBeenCalledTimes(1);
    await queue.close();
  });
  it("distinguishes absent jobs from Redis failures", async () => {
    const queue = new MessageQueue();
    fake.getJob.mockResolvedValue(undefined);
    expect(await queue.getMessageJobState("instance", "job", "baileys")).toEqual({
      state: "missing",
    });
    fake.getJob.mockRejectedValue(new Error("Redis unavailable"));
    await expect(queue.getMessageJobState("instance", "job", "baileys")).rejects.toThrow(
      "Redis unavailable",
    );
    expect(fake.add).not.toHaveBeenCalled();
    await queue.close();
  });
});
