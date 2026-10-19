import { createHmac, randomUUID } from "node:crypto";
import { DisconnectReason, type WASocket } from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import type { ContactStore } from "../src/services/contact-store.js";
import {
  createEventWebhookHeaders,
  eventWebhookFailureLogData,
  registerEventWebhookHandler,
  type EventWebhookJob,
} from "../src/services/event-webhook.js";
import { loadEventWebhookConfig } from "../src/services/event-webhook-config.js";
import { InstanceManager } from "../src/services/instance-manager.js";
import { sqlite } from "../src/db/client.js";
import { registerInstanceTools } from "../src/tools/instance.tools.js";
import type { ChannelEventPayload, InstanceAuthMethod } from "../src/types/channel.types.js";
import type { MessageQueue } from "../src/services/message-queue.js";

vi.mock("../src/channels/baileys/baileys.auth.js", () => ({
  clearAuthState: vi.fn(),
  useSqliteAuthState: vi.fn(),
}));

type FakeConnectionListener = (payload: unknown) => void;

interface SocketFixture {
  socket: WASocket;
  update: (payload: unknown) => void;
}

function socketFixture(): SocketFixture {
  const listeners = new Map<string, FakeConnectionListener[]>();
  const ev = {
    on: (event: string, handler: FakeConnectionListener) => {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    },
    process: () => undefined,
  };
  const socket = {
    user: {
      id: "5511999999999@s.whatsapp.net",
      lid: "9000000000001@lid",
      name: "Lifecycle fixture",
    },
    ev,
    end: vi.fn(),
    requestPairingCode: vi.fn(async () => "fixture-pairing-code"),
    signalRepository: { lidMapping: { getPNForLID: vi.fn(async () => null) } },
  } as unknown as WASocket;
  return {
    socket,
    update: (payload) => listeners.get("connection.update")?.[0]?.(payload),
  };
}

function adapterFixture() {
  const adapter = new BaileysAdapter(`lifecycle-${randomUUID()}`, {} as ContactStore);
  activeAdapters.add(adapter);
  const internals = adapter as unknown as Record<string, unknown>;
  internals.presenceMode = "always";
  internals.getAppendNotifyWatermark = () => null;
  internals.resetHealthWatchdog = () => undefined;
  internals.clearHealthWatchdog = () => undefined;
  internals.clearEventBufferStallWatchdog = () => undefined;
  internals.resetActivityPresence = () => undefined;
  const scheduleReconnect = vi.fn(() => 1_000);
  internals.scheduleReconnect = scheduleReconnect;
  return { adapter, internals, scheduleReconnect };
}

function bindFixture(adapter: BaileysAdapter, socket: WASocket): void {
  const internals = adapter as unknown as { bindEvents: (sock: WASocket) => void };
  internals.bindEvents(socket);
  (adapter as unknown as { sock: WASocket }).sock = socket;
}

function invokePrivate<T>(adapter: BaileysAdapter, name: string, ...args: unknown[]): T {
  const method = (adapter as unknown as Record<string, (...values: unknown[]) => T>)[name];
  return method.apply(adapter, args);
}

const activeAdapters = new Set<BaileysAdapter>();
const activeInstanceIds = new Set<string>();

afterEach(() => {
  for (const adapter of activeAdapters) invokePrivate(adapter, "clearAuthChallenges");
  activeAdapters.clear();
  for (const instanceId of activeInstanceIds) {
    sqlite.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
  }
  activeInstanceIds.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("instance lifecycle events", () => {
  it("emits a safe pairing-code event and marks the following open as paired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T12:00:00.000Z"));
    const { adapter, internals } = adapterFixture();
    const fixture = socketFixture();
    const pairingEvents: ChannelEventPayload["instance.pairing_code_generated"][] = [];
    const connectedEvents: ChannelEventPayload["instance.connected"][] = [];
    const expiredEvents = vi.fn();
    const qrExpired = vi.fn();
    adapter.on("instance.pairing_code_generated", (payload) => pairingEvents.push(payload));
    adapter.on("instance.connected", (payload) => connectedEvents.push(payload));
    adapter.on("instance.pairing_expired", expiredEvents);
    adapter.on("instance.qr_expired", qrExpired);
    internals.sock = fixture.socket;
    internals.status = "qr_pending";
    internals.qrCode = "fixture-qr-string";
    bindFixture(adapter, fixture.socket);
    fixture.update({ qr: "fixture-qr-string" });

    const pairingCode = adapter.getPairingCode("5511999999999");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pairingCode).resolves.toBe("fixture-pairing-code");

    expect(pairingEvents).toHaveLength(1);
    expect(pairingEvents[0]).toMatchObject({
      instanceId: expect.any(String),
      method: "pairing_code",
      generatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    expect(JSON.stringify(pairingEvents[0])).not.toContain("fixture-pairing-code");
    expect(JSON.stringify(pairingEvents[0])).not.toContain("fixture-qr-string");

    fixture.update({ connection: "open" });
    expect(connectedEvents).toEqual([
      expect.objectContaining({
        phone: "5511999999999@s.whatsapp.net",
        lid: "9000000000001@lid",
        pushName: "Lifecycle fixture",
        wasPairing: true,
      }),
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(expiredEvents).not.toHaveBeenCalled();
    expect(qrExpired).not.toHaveBeenCalled();
    expect(adapter.getLifecycleStatus().pendingChallenge).toBeNull();
  });

  it("expires pairing and QR challenges without including their contents", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T12:00:00.000Z"));
    const { adapter, internals } = adapterFixture();
    const fixture = socketFixture();
    const qrGenerated = vi.fn();
    const qrExpired = vi.fn();
    const pairingExpired = vi.fn();
    adapter.on("instance.qr_generated", qrGenerated);
    adapter.on("instance.qr_expired", qrExpired);
    adapter.on("instance.pairing_expired", pairingExpired);
    internals.sock = fixture.socket;
    internals.status = "qr_pending";
    internals.qrCode = "fixture-qr-string";
    bindFixture(adapter, fixture.socket);

    fixture.update({ qr: "fixture-qr-string" });
    const pairingCode = adapter.getPairingCode("5511999999999");
    await vi.advanceTimersByTimeAsync(1_000);
    await pairingCode;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(qrGenerated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "qr",
        generatedAt: expect.any(Number),
        expiresAt: expect.any(Number),
      }),
    );
    expect(qrExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "qr",
        generatedAt: expect.any(Number),
        expiredAt: expect.any(Number),
      }),
    );
    expect(pairingExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "pairing_code",
        generatedAt: expect.any(Number),
        expiredAt: expect.any(Number),
      }),
    );
    expect(
      JSON.stringify([qrGenerated.mock.calls, qrExpired.mock.calls, pairingExpired.mock.calls]),
    ).not.toContain("fixture-pairing-code");
    expect(JSON.stringify([qrGenerated.mock.calls, qrExpired.mock.calls])).not.toContain(
      "fixture-qr-string",
    );
    expect(internals.qrCode).toBeNull();
    expect(internals.pairingCodeValue).toBeNull();
  });

  it("emits restartRequired details and coalesces reconnect storm closes", () => {
    const { adapter, scheduleReconnect } = adapterFixture();
    const fixture = socketFixture();
    const disconnected = vi.fn();
    adapter.on("instance.disconnected", disconnected);
    bindFixture(adapter, fixture.socket);

    fixture.update({ connection: "open" });
    fixture.update({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
    });
    fixture.update({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
    });

    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reason: "restartRequired",
        statusCode: DisconnectReason.restartRequired,
        loggedOut: false,
        willReconnect: true,
        reconnectInMs: 1_000,
      }),
    );

    fixture.update({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    });
    fixture.update({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    });
    expect(disconnected).toHaveBeenCalledTimes(2);
    expect(disconnected).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reason: "loggedOut",
        loggedOut: true,
        willReconnect: false,
      }),
    );
    expect(scheduleReconnect).toHaveBeenCalledTimes(2);
  });
});

describe("instance lifecycle webhook and status output", () => {
  it("uses event filtering, safe normalization, HMAC signing, and redacted failure diagnostics", async () => {
    let eventHandler: Parameters<InstanceManager["onAnyEvent"]>[0] | undefined;
    const manager = {
      onAnyEvent: (handler: Parameters<InstanceManager["onAnyEvent"]>[0]) => {
        eventHandler = handler;
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOKS: JSON.stringify([
        {
          id: "lifecycle",
          url: "https://hooks.example.test/receive",
          secret: "fixture-signing-secret",
          events: ["instance.pairing_code_generated"],
        },
      ]),
    });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(manager, config, enqueue);

    eventHandler?.("instance.pairing_code_generated", "inst_lifecycle_test", {
      instanceId: "inst_lifecycle_test",
      method: "pairing_code",
      generatedAt: 1_800_000_000_000,
      expiresAt: 1_800_000_060_000,
      pairingCode: "fixture-pairing-code",
      qr: "fixture-qr-string",
    } as never);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());

    const job = enqueue.mock.calls[0]?.[0];
    expect(job).toBeDefined();
    expect(job?.payload).toEqual({
      event: "instance.pairing_code_generated",
      instanceId: "inst_lifecycle_test",
      method: "pairing_code",
      generatedAt: expect.any(Number),
      expiresAt: expect.any(Number),
    });
    const body = JSON.stringify(job?.payload);
    expect(body).not.toContain("fixture-pairing-code");
    expect(body).not.toContain("fixture-qr-string");
    const destination = config.destinations[0]!;
    const headers = createEventWebhookHeaders(body, destination, "1792412400");
    const signature = createHmac("sha256", "fixture-signing-secret")
      .update(`1792412400.${body}`)
      .digest("hex");
    expect(headers.get("x-wa-event-signature")).toBe(`sha256=${signature}`);

    const failure = eventWebhookFailureLogData(
      1,
      new Error("Bearer fixture-signing-secret https://hooks.example.test/receive?token=hidden"),
      destination,
    );
    expect(String(failure.errorMessage)).not.toContain("fixture-signing-secret");
    expect(String(failure.errorMessage)).not.toContain("hooks.example.test/receive");
    expect(String(failure.errorMessage)).not.toContain("hidden");

    unsubscribe();
    await unsubscribe.flush();
  });

  it("returns lifecycle status without pairing or QR material", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T12:00:00.000Z"));
    const manager = new InstanceManager();
    const instance = await manager.createInstance("Lifecycle status fixture");
    activeInstanceIds.add(instance.id);
    const adapter = manager.ensureAdapter(instance.id) as BaileysAdapter;
    activeAdapters.add(adapter);
    const internals = adapter as unknown as Record<string, unknown>;
    internals.status = "connected";
    internals.sock = {
      user: {
        id: "5511999999999@s.whatsapp.net",
        lid: "9000000000001@lid",
        name: "Lifecycle fixture",
      },
      end: vi.fn(),
    } as unknown as WASocket;
    internals.authMeId = "5511999999999@s.whatsapp.net";
    internals.authMeLid = "9000000000001@lid";
    internals.qrCode = "fixture-qr-string";
    internals.pairingCodeValue = "fixture-pairing-code";
    invokePrivate(adapter, "emitAuthChallengeGenerated", "qr" satisfies InstanceAuthMethod);

    const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
    const server = {
      registerTool: (
        name: string,
        _config: unknown,
        handler: (params: unknown) => Promise<unknown>,
      ) => handlers.set(name, handler),
    } as unknown as McpServer;
    registerInstanceTools(server, manager, {} as MessageQueue);
    const statusTool = handlers.get("wa_get_instance_status");
    expect(statusTool).toBeDefined();

    const one = (await statusTool?.({ instanceId: instance.id })) as {
      content: Array<{ text: string }>;
    };
    const oneResult = JSON.parse(one.content[0]!.text) as {
      instances: Array<Record<string, unknown>>;
    };
    expect(oneResult.instances).toHaveLength(1);
    expect(oneResult.instances[0]).toMatchObject({
      instanceId: instance.id,
      connectionState: "connected",
      phone: "5511999999999@s.whatsapp.net",
      lid: "9000000000001@lid",
      pushName: "Lifecycle fixture",
      pendingPairing: {
        status: "qr",
        generatedAt: "2026-10-19T12:00:00.000Z",
        expiresAt: "2026-10-19T12:01:00.000Z",
      },
      presenceMode: "on_activity",
    });
    const all = (await statusTool?.({})) as { content: Array<{ text: string }> };
    expect(
      (JSON.parse(all.content[0]!.text) as { instances: Array<{ instanceId: string }> }).instances,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ instanceId: instance.id })]));
    const serialized = JSON.stringify(oneResult);
    expect(serialized).not.toContain("fixture-pairing-code");
    expect(serialized).not.toContain("fixture-qr-string");
    expect(serialized).not.toMatch(/pairingCode|qrCode|token|secret|credential|keyData/i);
  });
});
