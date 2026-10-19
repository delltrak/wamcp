import { DisconnectReason, type WASocket } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlite } from "../src/db/client.js";
import {
  CONNECTING_STUCK_AFTER_MS,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
} from "../src/constants.js";
import type { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { useSqliteAuthState } from "../src/channels/baileys/baileys.auth.js";
import { InstanceManager } from "../src/services/instance-manager.js";
import { MaintenanceService } from "../src/services/maintenance.js";
import type { ChannelEventPayload } from "../src/types/channel.types.js";

const mocks = vi.hoisted(() => {
  const warnings: string[] = [];
  const logger = {
    level: "silent",
    info: () => undefined,
    warn: (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg === "string") warnings.push(arg);
      }
    },
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    isLevelEnabled: () => false,
    child: () => logger,
  };
  return {
    warnings,
    logger,
    makeWASocket: vi.fn(),
  };
});

vi.mock("../src/utils/logger.js", () => ({
  createChildLogger: () => mocks.logger,
  createRequestLogger: () => mocks.logger,
  logger: mocks.logger,
}));

vi.mock("@whiskeysockets/baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@whiskeysockets/baileys")>();
  return {
    ...actual,
    default: mocks.makeWASocket,
  };
});

vi.mock("../src/channels/baileys/baileys.version.js", () => ({
  getWaVersion: vi.fn(async () => ({ version: [2, 3000, 0] as [number, number, number] })),
  refreshWaVersion: vi.fn(),
}));

interface FakeSocket {
  socket: WASocket;
  emit: (update: Record<string, unknown>) => void;
}

const sockets: FakeSocket[] = [];
const adapters: BaileysAdapter[] = [];
const instanceIds: string[] = [];

function createFakeSocket(): FakeSocket {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const socket = {
    user: {
      id: "5511999999999@s.whatsapp.net",
      lid: "9000000000001@lid",
      name: "Reconnect fixture",
    },
    ev: {
      on: (event: string, handler: (payload: unknown) => void) => {
        const handlers = listeners.get(event) ?? [];
        handlers.push(handler);
        listeners.set(event, handlers);
      },
      process: () => undefined,
      isBuffering: () => false,
      flush: () => undefined,
    },
    end: vi.fn(),
    sendPresenceUpdate: vi.fn(async () => undefined),
    ws: { readyState: 1 },
  } as unknown as WASocket;
  return {
    socket,
    emit: (update) => {
      for (const handler of listeners.get("connection.update") ?? []) handler(update);
    },
  };
}

function reconnectDelay(attempt: number): number {
  if (attempt >= RECONNECT_MAX_ATTEMPTS) return RECONNECT_MAX_DELAY_MS;
  return Math.min(RECONNECT_INITIAL_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
}

function closeSocket(index: number, statusCode: number): void {
  const fake = sockets[index];
  if (!fake) throw new Error(`Missing socket ${index}`);
  fake.emit({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode } } },
  });
}

function openSocket(index: number): void {
  const fake = sockets[index];
  if (!fake) throw new Error(`Missing socket ${index}`);
  fake.emit({ connection: "open" });
}

function instanceStatus(id: string): string {
  const row = sqlite.prepare("SELECT status FROM instances WHERE id = ?").get(id) as
    | { status: string }
    | undefined;
  if (!row) throw new Error(`Missing instance ${id}`);
  return row.status;
}

function authKeyCount(id: string): number {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS count FROM auth_keys WHERE instance_id = ?")
    .get(id) as { count: number };
  return row.count;
}

async function markPaired(id: string): Promise<void> {
  const { state, saveCreds } = await useSqliteAuthState(id);
  state.creds.me = { id: "5511999999999:1@s.whatsapp.net", lid: "9000000000001:1@lid" };
  await saveCreds();
}

async function createConnectedInstance(paired = true): Promise<{
  manager: InstanceManager;
  id: string;
  adapter: BaileysAdapter;
}> {
  const manager = new InstanceManager();
  const instance = await manager.createInstance("reconnect fixture");
  instanceIds.push(instance.id);
  if (paired) await markPaired(instance.id);
  await manager.connectInstance(instance.id);
  const adapter = manager.ensureAdapter(instance.id) as BaileysAdapter;
  adapters.push(adapter);
  openSocket(sockets.length - 1);
  return { manager, id: instance.id, adapter };
}

async function runHealthCheck(manager: InstanceManager): Promise<void> {
  const service = new MaintenanceService(manager);
  await (
    service as unknown as { runHealthCheck: () => Promise<void> }
  ).runHealthCheck();
}

describe("Baileys reconnect after unavailable service", () => {
  beforeEach(() => {
    mocks.warnings.length = 0;
    sockets.length = 0;
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "false");
    vi.stubEnv("WA_BAILEYS_HEALTH_WATCHDOG_MS", "86400000");
    vi.stubEnv("WA_AUTO_RECONNECT", "true");
    mocks.makeWASocket.mockImplementation(() => {
      const fake = createFakeSocket();
      sockets.push(fake);
      return fake.socket;
    });
  });

  afterEach(async () => {
    for (const adapter of adapters) await adapter.disconnect();
    adapters.length = 0;
    for (const id of instanceIds) sqlite.prepare("DELETE FROM instances WHERE id = ?").run(id);
    instanceIds.length = 0;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("keeps opening sockets after repeated 503 closes past the backoff cap", async () => {
    vi.useFakeTimers();
    const { id, adapter } = await createConnectedInstance();
    const disconnected: ChannelEventPayload["instance.disconnected"][] = [];
    adapter.on("instance.disconnected", (payload) => disconnected.push(payload));

    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);
    closeSocket(0, DisconnectReason.unavailableService);
    expect(instanceStatus(id)).toBe("disconnected");
    expect(disconnected).toEqual([
      expect.objectContaining({
        reason: "unavailableService",
        statusCode: DisconnectReason.unavailableService,
        loggedOut: false,
        willReconnect: true,
        reconnectInMs: RECONNECT_INITIAL_DELAY_MS,
      }),
    ]);

    for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS + 2; attempt++) {
      const before = mocks.makeWASocket.mock.calls.length;
      await vi.advanceTimersByTimeAsync(reconnectDelay(attempt));
      expect(mocks.makeWASocket.mock.calls.length).toBe(before + 1);
      expect(instanceStatus(id)).toBe("connecting");
      closeSocket(sockets.length - 1, DisconnectReason.unavailableService);
      expect(instanceStatus(id)).toBe("disconnected");
    }

    expect(mocks.makeWASocket.mock.calls.length).toBeGreaterThan(RECONNECT_MAX_ATTEMPTS + 1);
    const exhausted = disconnected.filter((event) => event.reconnectInMs === RECONNECT_MAX_DELAY_MS);
    expect(exhausted).toEqual([
      expect.objectContaining({
        reason: "unavailableService",
        statusCode: DisconnectReason.unavailableService,
        loggedOut: false,
        willReconnect: true,
        reconnectInMs: RECONNECT_MAX_DELAY_MS,
      }),
    ]);
  });

  it("creates a new socket when connect() runs after a 503", async () => {
    vi.useFakeTimers();
    const { manager, id } = await createConnectedInstance();
    closeSocket(0, DisconnectReason.unavailableService);
    expect(instanceStatus(id)).toBe("disconnected");
    expect(manager.hasLiveSocket(id)).toBe(false);

    const before = mocks.makeWASocket.mock.calls.length;
    mocks.warnings.length = 0;
    await manager.connectInstance(id);

    expect(mocks.makeWASocket.mock.calls.length).toBe(before + 1);
    expect(mocks.warnings).not.toContain("Already connected or connecting");
    expect(manager.hasLiveSocket(id)).toBe(true);
    expect(instanceStatus(id)).toBe("connecting");

    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
    expect(mocks.makeWASocket.mock.calls.length).toBe(before + 1);
  });

  it("does not schedule another reconnect for a close from an old socket", async () => {
    vi.useFakeTimers();
    await createConnectedInstance();
    closeSocket(0, DisconnectReason.unavailableService);
    closeSocket(0, DisconnectReason.unavailableService);

    await vi.advanceTimersByTimeAsync(reconnectDelay(0));
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(2);

    const previous = sockets[0];
    if (!previous) throw new Error("Missing the replaced socket");
    previous.emit({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.unavailableService } } },
    });
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(2);
  });

  it("stops reconnecting after logout", async () => {
    vi.useFakeTimers();
    const { id } = await createConnectedInstance();
    expect(authKeyCount(id)).toBeGreaterThan(0);

    closeSocket(0, DisconnectReason.loggedOut);
    expect(authKeyCount(id)).toBe(0);
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 2);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);
    expect(instanceStatus(id)).toBe("disconnected");

    const { id: retryId } = await createConnectedInstance();
    const socketsBeforeRetry = mocks.makeWASocket.mock.calls.length;
    closeSocket(sockets.length - 1, DisconnectReason.unavailableService);
    closeSocket(sockets.length - 1, DisconnectReason.loggedOut);
    expect(authKeyCount(retryId)).toBe(0);
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 2);
    expect(mocks.makeWASocket.mock.calls.length).toBe(socketsBeforeRetry);
  });

  it("recovers a stuck connecting status when no socket is live", async () => {
    const manager = new InstanceManager();
    const recent = await manager.createInstance("recent connecting");
    const stuck = await manager.createInstance("stuck connecting");
    const live = await manager.createInstance("live connecting");
    const unpaired = await manager.createInstance("abandoned pairing");
    instanceIds.push(recent.id, stuck.id, live.id, unpaired.id);
    adapters.push(
      manager.ensureAdapter(recent.id) as BaileysAdapter,
      manager.ensureAdapter(stuck.id) as BaileysAdapter,
      manager.ensureAdapter(unpaired.id) as BaileysAdapter,
    );
    await manager.connectInstance(live.id);
    adapters.push(manager.ensureAdapter(live.id) as BaileysAdapter);

    const now = Date.now();
    sqlite
      .prepare("UPDATE instances SET status = 'connecting', updated_at = ? WHERE id = ?")
      .run(now, recent.id);
    sqlite
      .prepare(
        "UPDATE instances SET status = 'connecting', updated_at = ?, last_connected = ? WHERE id = ?",
      )
      .run(now - CONNECTING_STUCK_AFTER_MS - 1_000, now - 600_000, stuck.id);
    sqlite
      .prepare(
        "UPDATE instances SET status = 'connecting', updated_at = ?, last_connected = NULL WHERE id = ?",
      )
      .run(now - CONNECTING_STUCK_AFTER_MS - 1_000, unpaired.id);
    sqlite
      .prepare("UPDATE instances SET status = 'connecting', updated_at = ? WHERE id = ?")
      .run(now - CONNECTING_STUCK_AFTER_MS - 1_000, live.id);

    const watched = new Set([recent.id, stuck.id, live.id, unpaired.id]);
    const listInstances = manager.getAllInstances.bind(manager);
    vi.spyOn(manager, "getAllInstances").mockImplementation(() =>
      listInstances().filter((instance) => watched.has(instance.id)),
    );

    const callsBeforeHealthCheck = mocks.makeWASocket.mock.calls.length;
    await runHealthCheck(manager);

    expect(mocks.makeWASocket.mock.calls.length).toBe(callsBeforeHealthCheck + 1);
    expect(manager.hasLiveSocket(stuck.id)).toBe(true);
    expect(manager.hasLiveSocket(recent.id)).toBe(false);
    expect(manager.hasLiveSocket(live.id)).toBe(true);
    expect(instanceStatus(stuck.id)).toBe("connecting");
    expect(instanceStatus(recent.id)).toBe("connecting");
    expect(manager.hasLiveSocket(unpaired.id)).toBe(false);
  });

  it("opens one socket when connect() runs concurrently", async () => {
    vi.useFakeTimers();
    const { adapter } = await createConnectedInstance();
    closeSocket(0, DisconnectReason.unavailableService);

    const before = mocks.makeWASocket.mock.calls.length;
    await Promise.all([adapter.connect(), adapter.connect(), vi.advanceTimersByTimeAsync(0)]);
    expect(mocks.makeWASocket.mock.calls.length).toBe(before + 1);

    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
    expect(mocks.makeWASocket.mock.calls.length).toBe(before + 1);
  });

  it("keeps the bounded retry for a session that never paired", async () => {
    vi.useFakeTimers();
    await createConnectedInstance(false);
    closeSocket(0, DisconnectReason.timedOut);

    for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
      await vi.advanceTimersByTimeAsync(reconnectDelay(attempt));
      closeSocket(sockets.length - 1, DisconnectReason.timedOut);
    }
    const afterBackoff = mocks.makeWASocket.mock.calls.length;
    expect(afterBackoff).toBe(RECONNECT_MAX_ATTEMPTS + 1);

    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 3);
    expect(mocks.makeWASocket.mock.calls.length).toBe(afterBackoff);
  });
});
