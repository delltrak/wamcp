import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue } from "../src/services/message-queue.js";
import * as redisOptions from "../src/services/redis.js";
import type { ChannelAdapter } from "../src/channels/channel.interface.js";
import { Redis } from "ioredis";
import { reserveOtpRequest, consumeOtpEnvelope } from "../src/utils/otp-queue.js";

const available = spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;
// A private disposable socket: never connect these tests to the application's Redis.
describe.skipIf(!available)("OTP atomic Redis reservation and consumption", () => {
  let directory: string, client: Redis, server: ChildProcess;
  let socket: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "wamcp-otp-redis-"));
    socket = join(directory, "redis.sock");
    server = spawn(
      "redis-server",
      ["--port", "0", "--unixsocket", socket, "--save", "", "--appendonly", "no"],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 100; i++) {
      try {
        await access(socket);
        break;
      } catch {
        if (server.exitCode !== null)
          throw Error("Disposable Redis exited before creating its socket");
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    client = new Redis(socket, {
      lazyConnect: true,
      retryStrategy: () => 50,
      maxRetriesPerRequest: 40,
    });
    client.on("error", () => {});
    await client.connect();
    await client.ping();
  }, 10000);
  afterAll(async () => {
    await client?.quit().catch(() => {});
    if (server && !server.killed) server.kill();
    await rm(directory, { recursive: true, force: true });
  });
  const envelope = { iv: "iv", tag: "tag", ciphertext: "ciphertext" };
  async function fixture(id: string) {
    const expiresAt = Date.now() + 60000,
      binding = "digest";
    const job = "test:" + id,
      request = job + ":request";
    await reserveOtpRequest(client, request, binding, expiresAt);
    await client.hset(job, "data", JSON.stringify({ kind: "otp", binding, expiresAt, envelope }));
    return { job, request, binding };
  }
  it("rejects an old lock owner even if it still holds decrypted options", async () => {
    const f = await fixture("stalled");
    await client.set(f.job + ":lock", "old-worker");
    await client.set(f.job + ":lock", "recovered-worker");
    let sends = 0;
    if (await consumeOtpEnvelope(client, f.job, f.request, "recovered-worker", envelope, f.binding))
      sends++;
    if (await consumeOtpEnvelope(client, f.job, f.request, "old-worker", envelope, f.binding))
      sends++;
    expect(sends).toBe(1);
    expect(JSON.parse((await client.hget(f.job, "data"))!).envelope).toBeUndefined();
  });
  it("only the current owner can consume an unspent envelope, and concurrent owners cannot both win", async () => {
    const f = await fixture("ownership");
    await client.set(f.job + ":lock", "current");
    expect(await consumeOtpEnvelope(client, f.job, f.request, "wrong", envelope, f.binding)).toBe(
      false,
    );
    const values = await Promise.all([
      consumeOtpEnvelope(client, f.job, f.request, "current", envelope, f.binding),
      consumeOtpEnvelope(client, f.job, f.request, "current", envelope, f.binding),
    ]);
    expect(values.filter(Boolean)).toHaveLength(1);
  });
  it("keeps the original idempotency reservation after ordinary completed jobs are removed", async () => {
    const f = await fixture("cleanup");
    const ttl = await client.pttl(f.request);
    await client.del(f.job);
    const r = await reserveOtpRequest(client, f.request, f.binding, Date.now() + 300000);
    expect(r.created).toBe(false);
    expect(await client.pttl(f.request)).toBeLessThanOrEqual(ttl);
    expect(await client.pttl(f.request)).toBeGreaterThan(23 * 3600000);
    await expect(
      reserveOtpRequest(client, f.request, "different-digest", Date.now() + 1000),
    ).rejects.toThrow("bound to another payload");
  });
  it("refuses stale or changed envelopes and expired deadlines", async () => {
    const f = await fixture("tampered");
    await client.set(f.job + ":lock", "current");
    expect(
      await consumeOtpEnvelope(
        client,
        f.job,
        f.request,
        "current",
        { ...envelope, ciphertext: "other" },
        f.binding,
      ),
    ).toBe(false);
    const past = Date.now() - 1000;
    await client.set(
      f.request,
      JSON.stringify({ binding: f.binding, expiresAt: past, consumed: false }),
      "PX",
      10000,
    );
    await client.hset(
      f.job,
      "data",
      JSON.stringify({ kind: "otp", binding: f.binding, expiresAt: past, envelope }),
    );
    expect(await consumeOtpEnvelope(client, f.job, f.request, "current", envelope, f.binding)).toBe(
      false,
    );
  });
  it("runs the actual BullMQ worker with its lock token and preserves deduplication after job deletion", async () => {
    const spy = vi
      .spyOn(redisOptions, "getRedisConnectionOptions")
      .mockReturnValue({ path: socket, maxRetriesPerRequest: null } as unknown as ReturnType<
        typeof redisOptions.getRedisConnectionOptions
      >);
    vi.stubEnv("WA_OTP_ENCRYPTION_KEY", "ab".repeat(32));
    const queue = new MessageQueue();
    let sends = 0;
    queue.setAdapterResolver(
      () =>
        ({
          sendOtp: async () => {
            sends++;
            return { messageId: "wamid.fixture", timestamp: Date.now(), status: "sent" };
          },
        }) as unknown as ChannelAdapter,
    );
    try {
      const opts = { templateName: "login_code", languageCode: "pt_BR", otpCode: "A1B2C3" };
      const r = await queue.enqueueOtp(
        "redis-otp-fixture",
        "5500000000001",
        opts,
        "worker-request-123",
      );
      let completed = false;
      for (let i = 0; i < 100; i++) {
        if (
          (await queue.getMessageJobState("redis-otp-fixture", r.jobId, "cloud")).state ===
          "completed"
        ) {
          completed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(completed).toBe(true);
      expect(sends).toBe(1);
      // The same safe result is readable by a fresh service with no adapter resolver/worker.
      const reader = new MessageQueue();
      try {
        const status = await reader.getJobStatus("redis-otp-fixture", r.jobId);
        expect(status).toMatchObject({
          state: "completed",
          kind: "otp",
          message: { messageId: "wamid.fixture", status: "sent" },
        });
        expect(JSON.stringify(status)).not.toContain(opts.otpCode);
      } finally {
        await reader.close();
      }
      const stored = await client.hget("bull:outbound-redis-otp-fixture:" + r.jobId, "data");
      expect(stored).not.toContain(opts.otpCode);
      expect(JSON.parse(stored!).envelope).toBeUndefined();
      await queue.removeScheduledJob("redis-otp-fixture", r.jobId, "cloud");
      await expect(
        queue.enqueueOtp("redis-otp-fixture", "5500000000001", opts, "worker-request-123"),
      ).rejects.toThrow("could not be confirmed");
      expect(sends).toBe(1);
    } finally {
      await queue.close();
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
  }, 10000);
});
