import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Job } from "bullmq";
import { OtpOptionsSchema, SendOtpSchema } from "../src/schemas/otp.schema.js";
import { MessageQueue } from "../src/services/message-queue.js";
import { otpEncryptionKey, openOtp, otpContext, sealOtp } from "../src/utils/otp.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { registerMessagingTools } from "../src/tools/messaging.tools.js";
import type { InstanceManager } from "../src/services/instance-manager.js";

type FakeJob = {
  id: string;
  data: Record<string, unknown>;
  updateData: (data: Record<string, unknown>) => Promise<void>;
};
const fake = vi.hoisted(() => ({
  jobs: new Map<string, FakeJob>(),
  processors: [] as Array<(job: Job) => Promise<unknown>>,
  options: [] as unknown[],
  add: vi.fn(),
}));
vi.mock("bullmq", () => ({
  Queue: class {
    async add(name: string, data: Record<string, unknown>, options: { jobId: string }) {
      fake.add(name, data, options);
      if (!fake.jobs.has(options.jobId)) {
        const job: FakeJob = {
          id: options.jobId,
          data,
          updateData: async (next) => {
            job.data = next;
          },
        };
        fake.jobs.set(options.jobId, job);
      }
      return fake.jobs.get(options.jobId);
    }
    async getJob(id: string) {
      return fake.jobs.get(id);
    }
    async close() {}
  },
  Worker: class {
    constructor(_name: string, process: (job: Job) => Promise<unknown>, options: unknown) {
      fake.processors.push(process);
      fake.options.push(options);
    }
    on() {
      return this;
    }
    async close() {}
  },
  UnrecoverableError: class extends Error {},
}));
const options = { templateName: "login_code", languageCode: "pt_BR", otpCode: "Q9W8E7R6" };
const recipient = "5500000000001";
beforeEach(() => {
  vi.stubEnv("WA_OTP_ENCRYPTION_KEY", "ab".repeat(32));
  fake.jobs.clear();
  fake.processors.length = 0;
  fake.options.length = 0;
  fake.add.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native OTP input and cryptography", () => {
  it("rejects groups, LIDs, arbitrary template components, invalid codes, deadlines and request IDs", () => {
    const input = { ...options, instanceId: "instance", to: recipient, requestId: "request-123" };
    expect(SendOtpSchema.parse(input).deliveryTtlSeconds).toBe(120);
    for (const to of [
      "120000000000@g.us",
      "5500000000001@lid",
      "status@broadcast",
      "5500000000001@newsletter",
      "abc",
      "+00000000000",
    ])
      expect(SendOtpSchema.safeParse({ ...input, to }).success).toBe(false);
    for (const otpCode of ["123", "x".repeat(16), "1234\n5678", "<secret>", "12 34"])
      expect(SendOtpSchema.safeParse({ ...input, otpCode }).success).toBe(false);
    expect(SendOtpSchema.safeParse({ ...input, components: [] }).success).toBe(false);
    expect(SendOtpSchema.safeParse({ ...input, deliveryTtlSeconds: 601 }).success).toBe(false);
    expect(SendOtpSchema.safeParse({ ...input, templateName: "Bad template" }).success).toBe(false);
    expect(OtpOptionsSchema.safeParse({ ...options, languageCode: "../../secret" }).success).toBe(
      false,
    );
  });
  it("encrypts the complete payload and authenticates its instance, recipient and expiry", () => {
    const key = otpEncryptionKey(),
      context = otpContext("instance", recipient, 12345);
    const sealed = sealOtp(options, context, key);
    expect(JSON.stringify(sealed)).not.toContain(options.otpCode);
    expect(openOtp(sealed, context, key)).toEqual(options);
    expect(() => openOtp(sealed, otpContext("other", recipient, 12345), key)).toThrow(
      "could not be authenticated",
    );
    expect(() => openOtp(sealed, context, randomBytes(32))).toThrow("could not be authenticated");
    expect(() =>
      openOtp({ ...sealed, tag: Buffer.alloc(16).toString("base64") }, context, key),
    ).toThrow("could not be authenticated");
    vi.stubEnv("WA_OTP_ENCRYPTION_KEY", "invalid");
    expect(() => otpEncryptionKey()).toThrow("64 hex");
  });
});

describe("native OTP queue", () => {
  it("deduplicates a request without extending its deadline or persisting the plaintext code", async () => {
    const queue = new MessageQueue();
    const a = await queue.enqueueOtp("instance", "+" + recipient, options, "request-123");
    const b = await queue.enqueueOtp("instance", recipient, options, "request-123");
    expect(b).toEqual(a);
    expect(fake.add).toHaveBeenCalledTimes(1);
    expect(fake.add.mock.calls[0][2]).toMatchObject({
      attempts: 1,
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 86400 },
    });
    expect(JSON.stringify([...fake.jobs.values()].map((j) => j.data))).not.toContain(
      options.otpCode,
    );
    expect(JSON.stringify(a)).not.toContain(options.otpCode);
    await expect(
      queue.enqueueOtp("instance", recipient, { ...options, otpCode: "ABCD1234" }, "request-123"),
    ).rejects.toThrow("bound to another payload");
    await queue.close();
  });
  it("consumes the persisted envelope before sending, preventing a stalled worker from sending twice", async () => {
    const queue = new MessageQueue();
    const result = await queue.enqueueOtp("instance", recipient, options, "request-123");
    const job = fake.jobs.get(result.jobId)!;
    const sendOtp = vi.fn(async () => {
      expect(job.data.envelope).toBeUndefined();
      return { messageId: "wamid.fixture", status: "sent", timestamp: 1 };
    });
    queue.setAdapterResolver(
      () => ({ sendOtp }) as unknown as ReturnType<InstanceManager["getAdapter"]>,
    );
    expect(await fake.processors[0](job as unknown as Job)).toMatchObject({
      messageId: "wamid.fixture",
    });
    expect(sendOtp).toHaveBeenCalledWith(recipient, options);
    await expect(fake.processors[0](job as unknown as Job)).rejects.toThrow(
      "Do not automatically resend",
    );
    expect(sendOtp).toHaveBeenCalledTimes(1);
    await queue.close();
  });
  it("never calls the provider after the queue deadline or an encryption key change", async () => {
    vi.useFakeTimers();
    const queue = new MessageQueue();
    const result = await queue.enqueueOtp("instance", recipient, options, "request-123", 10);
    const sendOtp = vi.fn();
    queue.setAdapterResolver(
      () => ({ sendOtp }) as unknown as ReturnType<InstanceManager["getAdapter"]>,
    );
    vi.advanceTimersByTime(10000);
    await expect(fake.processors[0](fake.jobs.get(result.jobId) as unknown as Job)).rejects.toThrow(
      "not confirmed",
    );
    expect(sendOtp).not.toHaveBeenCalled();
    const next = await queue.enqueueOtp("instance", recipient, options, "request-456", 120);
    vi.stubEnv("WA_OTP_ENCRYPTION_KEY", "cd".repeat(32));
    await expect(fake.processors[0](fake.jobs.get(next.jobId) as unknown as Job)).rejects.toThrow(
      "not confirmed",
    );
    expect(sendOtp).not.toHaveBeenCalled();
    await queue.close();
  });
  it("does not leak provider failures and never resends after an ambiguous outcome", async () => {
    const queue = new MessageQueue();
    const r = await queue.enqueueOtp("instance", recipient, options, "request-123");
    const sendOtp = vi.fn(async () => {
      throw Error("provider echoed " + options.otpCode);
    });
    queue.setAdapterResolver(
      () => ({ sendOtp }) as unknown as ReturnType<InstanceManager["getAdapter"]>,
    );
    const job = fake.jobs.get(r.jobId)!;
    try {
      await fake.processors[0](job as unknown as Job);
      expect.fail("must fail");
    } catch (e) {
      expect(String(e)).not.toContain(options.otpCode);
    }
    await expect(fake.processors[0](job as unknown as Job)).rejects.toThrow("not confirmed");
    expect(sendOtp).toHaveBeenCalledTimes(1);
    expect(job.data.envelope).toBeUndefined();
    await queue.close();
  });
  it("refuses to send if the durable consumption fence cannot be saved", async () => {
    const queue = new MessageQueue();
    const r = await queue.enqueueOtp("instance", recipient, options, "request-123");
    const sendOtp = vi.fn();
    queue.setAdapterResolver(
      () => ({ sendOtp }) as unknown as ReturnType<InstanceManager["getAdapter"]>,
    );
    const job = fake.jobs.get(r.jobId)!;
    job.updateData = async () => {
      throw Error("Redis failed");
    };
    await expect(fake.processors[0](job as unknown as Job)).rejects.toThrow("not confirmed");
    expect(sendOtp).not.toHaveBeenCalled();
    await queue.close();
  });
});

describe("native OTP adapters and MCP tool", () => {
  it("uses the approved template body and OTP button without persisting a message or echoing the code", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.fixture" }] }),
    }));
    vi.stubGlobal("fetch", fetch);
    const adapter = new CloudApiAdapter("otp-cloud");
    await adapter.setCredentials({ accessToken: "fixture-token", phoneNumberId: "fixture-phone" });
    const result = await adapter.sendOtp(recipient, options);
    expect(result.messageId).toBe("wamid.fixture");
    const payload = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string);
    expect(payload).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "template",
      template: {
        name: "login_code",
        language: { code: "pt_BR" },
        components: [
          { type: "body", parameters: [{ type: "text", text: options.otpCode }] },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: options.otpCode }],
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(options.otpCode);
  });
  it("rejects unsupported channels and hides provider text that contains secrets", async () => {
    await expect(new BaileysAdapter("otp-baileys").sendOtp(recipient, options)).rejects.toThrow(
      "not supported on Baileys",
    );
    const adapter = new CloudApiAdapter("otp-cloud");
    await adapter.setCredentials({ accessToken: "fixture-token", phoneNumberId: "fixture-phone" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "invalid " + options.otpCode, code: 100 } }),
      })),
    );
    try {
      await adapter.sendOtp(recipient, options);
      expect.fail("must fail");
    } catch (e) {
      expect(String(e)).toContain("delivery may be uncertain");
      expect(String(e)).not.toContain(options.otpCode);
    }
  });
  it("registers a strict native tool and refuses Baileys before queue access", async () => {
    const tools = new Map<
      string,
      { inputSchema: typeof SendOtpSchema; handler: (p: unknown) => Promise<unknown> }
    >();
    const server = {
      registerTool: (
        name: string,
        config: { inputSchema: typeof SendOtpSchema },
        handler: (p: unknown) => Promise<unknown>,
      ) => tools.set(name, { ...config, handler }),
    } as unknown as McpServer;
    const manager = {
      getInstanceChannel: vi.fn(async () => "baileys"),
    } as unknown as InstanceManager;
    const enqueueOtp = vi.fn();
    registerMessagingTools(server, manager, { enqueueOtp } as unknown as MessageQueue);
    const tool = tools.get("wa_send_otp")!;
    expect(
      tool.inputSchema.safeParse({
        ...options,
        instanceId: "instance",
        to: recipient,
        requestId: "request-123",
        extra: "no",
      }).success,
    ).toBe(false);
    const result = await tool.handler({
      ...options,
      instanceId: "instance",
      to: recipient,
      requestId: "request-123",
      deliveryTtlSeconds: 120,
    });
    expect(JSON.stringify(result)).toContain("not supported");
    expect(enqueueOtp).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(options.otpCode);
  });
});
