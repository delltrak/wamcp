import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { getChannelCapabilities } from "../src/services/channel-capabilities.js";
import { registerInstanceTools } from "../src/tools/instance.tools.js";
import { registerMessagingTools } from "../src/tools/messaging.tools.js";
import {
  GetChannelCapabilitiesSchema,
  GetJobStatusSchema,
  ListAuthenticationTemplatesSchema,
} from "../src/schemas/discovery.schema.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const template = (overrides: Record<string, unknown> = {}) => ({
  id: "123",
  name: "login_code",
  language: "pt_BR",
  category: "AUTHENTICATION",
  status: "APPROVED",
  components: [
    { type: "BODY", text: "EXAMPLE_SECRET_CODE" },
    { type: "FOOTER", code_expiration_minutes: 5 },
    {
      type: "BUTTONS",
      buttons: [
        { type: "OTP", otp_type: "COPY_CODE", text: "Copy", example: ["EXAMPLE_SECRET_CODE"] },
      ],
    },
  ],
  ...overrides,
});

describe("authentication template discovery", () => {
  async function cloud(businessId: string | undefined = "123456") {
    const adapter = new CloudApiAdapter("templates-fixture");
    await adapter.setCredentials({
      accessToken: "fixture-token",
      phoneNumberId: "456",
      businessId,
    });
    return adapter;
  }
  it("returns only safe authentication metadata and follows opaque cursors on the fixed Graph host", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          template(),
          template({ id: "2", category: "MARKETING" }),
          template({ id: "3", status: "PENDING" }),
        ],
        paging: {
          next: "https://untrusted.invalid/?access_token=fixture-token",
          cursors: { after: "cursor+/=" },
        },
      }),
    }));
    vi.stubGlobal("fetch", fetch);
    const adapter = await cloud();
    const page = await adapter.listAuthenticationTemplates({
      limit: 25,
      approvedOnly: true,
      after: "input+/=",
    });
    expect(page).toEqual({
      templates: [
        {
          id: "123",
          name: "login_code",
          languageCode: "pt_BR",
          status: "APPROVED",
          otpButtonType: "COPY_CODE",
          compatibleWithSendOtp: true,
          codeExpirationMinutes: 5,
        },
      ],
      nextCursor: "cursor+/=",
      hasMore: true,
    });
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://graph.facebook.com");
    expect(parsed.pathname).toBe("/v21.0/123456/message_templates");
    expect(parsed.searchParams.get("after")).toBe("input+/=");
    expect(options.redirect).toBe("error");
    expect(options.headers).toBeInstanceOf(Headers);
    expect(JSON.stringify(page)).not.toMatch(/fixture-token|EXAMPLE_SECRET_CODE|untrusted/);
    expect(adapter.getStatus()).toBe("disconnected");
  });
  it("keeps filtered-empty pages traversable, and marks pending/autofill/unknown shapes incompatible", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [template({ category: "UTILITY" })],
          paging: { next: "ignored", cursors: { after: "more" } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            template({ status: "PENDING" }),
            template({ components: [] }),
            template({
              components: [{ type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "ONE_TAP" }] }],
            }),
          ],
        }),
      });
    vi.stubGlobal("fetch", fetch);
    const adapter = await cloud();
    expect(await adapter.listAuthenticationTemplates({ limit: 1, approvedOnly: true })).toEqual({
      templates: [],
      nextCursor: "more",
      hasMore: true,
    });
    const page = await adapter.listAuthenticationTemplates({
      limit: 25,
      approvedOnly: false,
      after: "more",
    });
    expect(page.templates).toHaveLength(3);
    expect(page.templates.every((t) => !t.compatibleWithSendOtp)).toBe(true);
    expect(page.hasMore).toBe(false);
  });
  it("rejects unsupported channels/missing WABA and sanitizes provider and parse failures", async () => {
    await expect(new BaileysAdapter("fixture").listAuthenticationTemplates()).rejects.toThrow(
      "not supported",
    );
    const fetch = vi.fn().mockRejectedValue(new Error("fixture-token secret-url"));
    vi.stubGlobal("fetch", fetch);
    const invalid = await cloud("not-an-id");
    await expect(
      invalid.listAuthenticationTemplates({ limit: 25, approvedOnly: true }),
    ).rejects.toThrow("WABA");
    expect(fetch).not.toHaveBeenCalled();
    const adapter = await cloud();
    await expect(
      adapter.listAuthenticationTemplates({ limit: 25, approvedOnly: true }),
    ).rejects.toThrow("whatsapp_business_management");
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ secret: "EXAMPLE_SECRET_CODE" }] }),
    });
    await expect(
      adapter.listAuthenticationTemplates({ limit: 25, approvedOnly: true }),
    ).rejects.not.toThrow("EXAMPLE_SECRET_CODE");
  });
});

describe("channel feature discovery and MCP registration", () => {
  it("matches adapter restrictions and references only tools that actually exist", () => {
    const names = new Set(
      readdirSync("src/tools").flatMap((f) =>
        [...readFileSync(`src/tools/${f}`, "utf8").matchAll(/"(wa_[a-z_]+)"/g)].map((m) => m[1]),
      ),
    );
    for (const channel of ["baileys", "cloud"] as const) {
      const features = getChannelCapabilities(channel);
      expect(features.authenticationOtp.supported).toBe(channel === "cloud");
      expect(features.presence.supported).toBe(channel === "baileys");
      expect(features.participantReceipts.supported).toBe(channel === "baileys");
      expect(features.nativeInteractiveMessages.supported).toBe(channel === "cloud");
      expect(features.jobStatus.supported).toBe(true);
      expect(features.authenticationOtp.requirements.join(" ")).not.toContain("fixture-token");
      for (const feature of Object.values(features))
        for (const name of feature.tools) expect(names.has(name), name).toBe(true);
    }
  });
  it("registers strict schemas and uses read-only paths even while disconnected", async () => {
    const tools = new Map<
      string,
      { inputSchema: z.ZodType; handler: (p: unknown) => Promise<unknown> }
    >();
    const server = {
      registerTool: (
        name: string,
        config: { inputSchema: z.ZodType },
        handler: (p: unknown) => Promise<unknown>,
      ) => tools.set(name, { ...config, handler }),
    } as unknown as McpServer;
    const manager = {
      getInstanceLifecycleStatuses: vi.fn(async () => [
        { channel: "cloud", state: "disconnected", cloudAccessToken: "must-not-leak" },
      ]),
      getInstanceChannel: vi.fn(async () => "cloud"),
      ensureAdapter: vi.fn(async () => ({
        listAuthenticationTemplates: vi.fn(async () => ({
          templates: [],
          hasMore: false,
          nextCursor: null,
        })),
      })),
    };
    const queue = { getJobStatus: vi.fn(async () => ({ state: "missing" })) };
    registerInstanceTools(
      server,
      manager as unknown as InstanceManager,
      queue as unknown as MessageQueue,
    );
    registerMessagingTools(
      server,
      manager as unknown as InstanceManager,
      queue as unknown as MessageQueue,
    );
    const inputs = [
      ["wa_get_channel_capabilities", { instanceId: "fixture" }],
      [
        "wa_list_authentication_templates",
        { instanceId: "fixture", limit: 25, approvedOnly: true },
      ],
      ["wa_get_job_status", { instanceId: "fixture", jobId: "otp-123" }],
    ] as const;
    for (const [name, params] of inputs) {
      const tool = tools.get(name)!;
      expect(tool.inputSchema.safeParse({ ...params, extra: true }).success).toBe(false);
      expect(JSON.stringify(await tool.handler(params))).not.toContain("must-not-leak");
    }
    expect(manager.getInstanceLifecycleStatuses).toHaveBeenCalledWith("fixture");
    expect(queue.getJobStatus).toHaveBeenCalledWith("fixture", "otp-123");
    manager.getInstanceChannel.mockResolvedValueOnce("baileys");
    manager.ensureAdapter.mockClear();
    expect(
      JSON.stringify(await tools.get("wa_list_authentication_templates")!.handler(inputs[1][1])),
    ).toContain("not supported");
    expect(manager.ensureAdapter).not.toHaveBeenCalled();
  });
  it("rejects malformed job keys and unbounded page sizes", () => {
    expect(
      ListAuthenticationTemplatesSchema.safeParse({
        instanceId: "fixture",
        after: "https://provider.invalid/?access_token=secret",
      }).success,
    ).toBe(false);
    for (const jobId of ["../1", "1:lock", "", "a".repeat(257)])
      expect(GetJobStatusSchema.safeParse({ instanceId: "fixture", jobId }).success).toBe(false);
    for (const limit of [0, 101, 1.1])
      expect(
        ListAuthenticationTemplatesSchema.safeParse({ instanceId: "fixture", limit }).success,
      ).toBe(false);
    expect(GetChannelCapabilitiesSchema.safeParse({ instanceId: "" }).success).toBe(false);
  });
});
