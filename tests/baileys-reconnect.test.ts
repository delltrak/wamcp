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
import { getWaVersion } from "../src/channels/baileys/baileys.version.js";
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
  emit: (update: Record<string, unknown>) => Promise<void>;
}

const sockets: FakeSocket[] = [];
const adapters: BaileysAdapter[] = [];
const instanceIds: string[] = [];

function createFakeSocket(): FakeSocket {
  const listeners = new Map<string, Array<(payload: unknown) => void | Promise<void>>>();
  const socket = {
    user: {
      id: "5511999999999@s.whatsapp.net",
      lid: "9000000000001@lid",
      name: "Reconnect fixture",
    },
    ev: {
      on: (event: string, handler: (payload: unknown) => void | Promise<void>) => {
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
    emit: async (update) => {
      for (const handler of listeners.get("connection.update") ?? []) await handler(update);
    },
  };
}

function reconnectDelay(attempt: number): number {
  if (attempt >= RECONNECT_MAX_ATTEMPTS) return RECONNECT_MAX_DELAY_MS;
  return Math.min(RECONNECT_INITIAL_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
}

function connectionAttempt(adapter: BaileysAdapter): Promise<void> | null {
  return (adapter as unknown as { connectInFlight: Promise<void> | null }).connectInFlight;
}

async function advanceTimersAndConnections(milliseconds: number): Promise<void> {
  // Stop at each possible reconnect boundary so PostgreSQL I/O can finish before
  // advancing through its query timeout. A single large jump can time out a new
  // connection before the real event loop has had a chance to answer its queries.
  for (let remaining = milliseconds; remaining > 0;) {
    const step = Math.min(remaining, RECONNECT_INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(step);
    // Await only attempts started by timers; never trigger connect() from the fixture.
    await Promise.all(adapters.map(connectionAttempt));
    remaining -= step;
  }
}

async function closeSocket(index: number, statusCode: number): Promise<void> {
  const fake = sockets[index];
  if (!fake) throw new Error(`Missing socket ${index}`);
  await fake.emit({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode } } },
  });
}

async function openSocket(index: number): Promise<void> {
  const fake = sockets[index];
  if (!fake) throw new Error(`Missing socket ${index}`);
  await fake.emit({ connection: "open" });
}

async function instanceStatus(id: string): Promise<string> {
  return (await instanceLifecycle(id)).status;
}

async function instanceLifecycle(id: string): Promise<{
  status: string;
  lastConnected: number | null;
  lastDisconnected: number | null;
}> {
  const row = (await sqlite
    .prepare(
      `SELECT status,
              last_connected AS "lastConnected",
              last_disconnected AS "lastDisconnected"
       FROM instances WHERE id = ?`,
    )
    .get(id)) as
    { status: string; lastConnected: number | null; lastDisconnected: number | null } | undefined;
  if (!row) throw new Error(`Missing instance ${id}`);
  return row;
}

async function authKeyCount(id: string): Promise<number> {
  const row = (await sqlite
    .prepare("SELECT COUNT(*) AS count FROM auth_keys WHERE instance_id = ?")
    .get(id)) as { count: number };
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
  const adapter = (await manager.ensureAdapter(instance.id)) as BaileysAdapter;
  adapters.push(adapter);
  await openSocket(sockets.length - 1);
  return { manager, id: instance.id, adapter };
}

async function runHealthCheck(manager: InstanceManager): Promise<void> {
  const service = new MaintenanceService(manager);
  await (service as unknown as { runHealthCheck: () => Promise<void> }).runHealthCheck();
}

describe("Baileys reconnect after unavailable service", () => {
  beforeEach(() => {
    mocks.warnings.length = 0;
    sockets.length = 0;
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "false");
    vi.stubEnv("WA_BAILEYS_HEALTH_WATCHDOG_MS", "86400000");
    vi.stubEnv("WA_AUTO_RECONNECT", "true");
    vi.mocked(getWaVersion)
      .mockReset()
      .mockResolvedValue({ version: [2, 3000, 0], isLatest: true });
    mocks.makeWASocket.mockReset().mockImplementation(() => {
      const fake = createFakeSocket();
      sockets.push(fake);
      return fake.socket;
    });
  });

  afterEach(async () => {
    for (const adapter of adapters) await adapter.disconnect();
    adapters.length = 0;
    for (const id of instanceIds)
      await sqlite.prepare("DELETE FROM instances WHERE id = ?").run(id);
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
    await closeSocket(0, DisconnectReason.unavailableService);
    expect(await instanceStatus(id)).toBe("disconnected");
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
      await advanceTimersAndConnections(reconnectDelay(attempt));
      expect(mocks.makeWASocket.mock.calls.length).toBe(before + 1);
      expect(await instanceStatus(id)).toBe("connecting");
      await closeSocket(sockets.length - 1, DisconnectReason.unavailableService);
      expect(await instanceStatus(id)).toBe("disconnected");
    }

    expect(mocks.makeWASocket.mock.calls.length).toBeGreaterThan(RECONNECT_MAX_ATTEMPTS + 1);
    const exhausted = disconnected.filter(
      (event) => event.reconnectInMs === RECONNECT_MAX_DELAY_MS,
    );
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

  it("persists an overlapping open and close in socket event order", async () => {
    const manager = new InstanceManager();
    const instance = await manager.createInstance("overlapping lifecycle");
    instanceIds.push(instance.id);
    await markPaired(instance.id);
    await manager.connectInstance(instance.id);
    const adapter = (await manager.ensureAdapter(instance.id)) as BaileysAdapter;
    adapters.push(adapter);
    await Promise.all([
      openSocket(sockets.length - 1),
      closeSocket(sockets.length - 1, DisconnectReason.timedOut),
    ]);
    expect(adapter.getStatus()).toBe("disconnected");
    expect(manager.hasLiveSocket(instance.id)).toBe(false);
    const stored = await instanceLifecycle(instance.id);
    expect(stored.status).toBe("disconnected");
    expect(stored.lastConnected).not.toBeNull();
    expect(stored.lastDisconnected).toBeGreaterThanOrEqual(stored.lastConnected!);
  });

  it("creates a new socket when connect() runs after a 503", async () => {
    vi.useFakeTimers();
    const { manager, id } = await createConnectedInstance();
    await closeSocket(0, DisconnectReason.unavailableService);
    expect(await instanceStatus(id)).toBe("disconnected");
    expect(manager.hasLiveSocket(id)).toBe(false);

    const before = mocks.makeWASocket.mock.calls.length;
    mocks.warnings.length = 0;
    await manager.connectInstance(id);

    expect(mocks.makeWASocket.mock.calls.length).toBe(before + 1);
    expect(mocks.warnings).not.toContain("Already connected or connecting");
    expect(manager.hasLiveSocket(id)).toBe(true);
    expect(await instanceStatus(id)).toBe("connecting");

    await advanceTimersAndConnections(RECONNECT_MAX_DELAY_MS);
    expect(mocks.makeWASocket.mock.calls.length).toBe(before + 1);
  });

  it("does not schedule another reconnect for a close from an old socket", async () => {
    vi.useFakeTimers();
    await createConnectedInstance();
    await closeSocket(0, DisconnectReason.unavailableService);
    await closeSocket(0, DisconnectReason.unavailableService);

    await advanceTimersAndConnections(reconnectDelay(0));
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(2);

    const previous = sockets[0];
    if (!previous) throw new Error("Missing the replaced socket");
    await previous.emit({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.unavailableService } } },
    });
    await advanceTimersAndConnections(RECONNECT_MAX_DELAY_MS);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(2);
  });

  it("stops reconnecting after logout", async () => {
    vi.useFakeTimers();
    const { id } = await createConnectedInstance();
    expect(await authKeyCount(id)).toBeGreaterThan(0);

    await closeSocket(0, DisconnectReason.loggedOut);
    expect(await authKeyCount(id)).toBe(0);
    await advanceTimersAndConnections(RECONNECT_MAX_DELAY_MS * 2);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);
    expect(await instanceStatus(id)).toBe("disconnected");

    const { id: retryId } = await createConnectedInstance();
    const socketsBeforeRetry = mocks.makeWASocket.mock.calls.length;
    await closeSocket(sockets.length - 1, DisconnectReason.unavailableService);
    await closeSocket(sockets.length - 1, DisconnectReason.loggedOut);
    expect(await authKeyCount(retryId)).toBe(0);
    await advanceTimersAndConnections(RECONNECT_MAX_DELAY_MS * 2);
    expect(mocks.makeWASocket.mock.calls.length).toBe(socketsBeforeRetry);
  });

  it.each([false, true])(
    "stops an in-flight reconnect after late logout (version lookup fails: %s)",
    async (lookupFails) => {
      vi.useFakeTimers();
      const { manager, id, adapter } = await createConnectedInstance();
      const disconnected: ChannelEventPayload["instance.disconnected"][] = [];
      adapter.on("instance.disconnected", (payload) => disconnected.push(payload));
      const versionLookup = Promise.withResolvers<Awaited<ReturnType<typeof getWaVersion>>>();
      const versionStarted = Promise.withResolvers<void>();
      vi.mocked(getWaVersion).mockImplementationOnce(() => {
        versionStarted.resolve();
        return versionLookup.promise;
      });

      await closeSocket(0, DisconnectReason.unavailableService);
      await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_DELAY_MS);
      await versionStarted.promise;
      // The timer has fired and loaded credentials, but no replacement socket exists yet.
      expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);
      expect(adapter.getStatus()).toBe("connecting");
      await closeSocket(0, DisconnectReason.loggedOut);
      expect(await authKeyCount(id)).toBe(0);

      const inFlight = connectionAttempt(adapter);
      expect(inFlight).not.toBeNull();
      const settled = lookupFails
        ? expect(inFlight).rejects.toThrow("Version lookup failed")
        : expect(inFlight).resolves.toBeUndefined();
      if (lookupFails) versionLookup.reject(new Error("Version lookup failed"));
      else versionLookup.resolve({ version: [2, 3000, 0], isLatest: true });
      await settled;
      await advanceTimersAndConnections(RECONNECT_MAX_DELAY_MS * 2);

      expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);
      expect(manager.hasLiveSocket(id)).toBe(false);
      expect(adapter.getStatus()).toBe("disconnected");
      expect(await instanceStatus(id)).toBe("disconnected");
      expect(await authKeyCount(id)).toBe(0);
      expect(disconnected.at(-1)).toMatchObject({ loggedOut: true, willReconnect: false });
    },
  );

  it("recovers a stuck connecting status when no socket is live", async () => {
    const manager = new InstanceManager();
    const recent = await manager.createInstance("recent connecting");
    const stuck = await manager.createInstance("stuck connecting");
    const live = await manager.createInstance("live connecting");
    const unpaired = await manager.createInstance("abandoned pairing");
    instanceIds.push(recent.id, stuck.id, live.id, unpaired.id);
    adapters.push(
      (await manager.ensureAdapter(recent.id)) as BaileysAdapter,
      (await manager.ensureAdapter(stuck.id)) as BaileysAdapter,
      (await manager.ensureAdapter(unpaired.id)) as BaileysAdapter,
    );
    await manager.connectInstance(live.id);
    adapters.push((await manager.ensureAdapter(live.id)) as BaileysAdapter);

    const now = Date.now();
    await sqlite
      .prepare("UPDATE instances SET status = 'connecting', updated_at = ? WHERE id = ?")
      .run(now, recent.id);
    await sqlite
      .prepare(
        "UPDATE instances SET status = 'connecting', updated_at = ?, last_connected = ? WHERE id = ?",
      )
      .run(now - CONNECTING_STUCK_AFTER_MS - 1_000, now - 600_000, stuck.id);
    await sqlite
      .prepare(
        "UPDATE instances SET status = 'connecting', updated_at = ?, last_connected = NULL WHERE id = ?",
      )
      .run(now - CONNECTING_STUCK_AFTER_MS - 1_000, unpaired.id);
    await sqlite
      .prepare("UPDATE instances SET status = 'connecting', updated_at = ? WHERE id = ?")
      .run(now - CONNECTING_STUCK_AFTER_MS - 1_000, live.id);

    const watched = new Set([recent.id, stuck.id, live.id, unpaired.id]);
    const listInstances = manager.getAllInstances.bind(manager);
    vi.spyOn(manager, "getAllInstances").mockImplementation(async () =>
      (await listInstances()).filter((instance) => watched.has(instance.id)),
    );

    const callsBeforeHealthCheck = mocks.makeWASocket.mock.calls.length;
    await runHealthCheck(manager);

    expect(mocks.makeWASocket.mock.calls.length).toBe(callsBeforeHealthCheck + 1);
    expect(manager.hasLiveSocket(stuck.id)).toBe(true);
    expect(manager.hasLiveSocket(recent.id)).toBe(false);
    expect(manager.hasLiveSocket(live.id)).toBe(true);
    expect(await instanceStatus(stuck.id)).toBe("connecting");
    expect(await instanceStatus(recent.id)).toBe("connecting");
    expect(manager.hasLiveSocket(unpaired.id)).toBe(false);
  });

  it("persists timestamps when a 408 close reconnects and opens again", async () => {
    vi.useFakeTimers();
    const { manager, id, adapter } = await createConnectedInstance();
    const connected: ChannelEventPayload["instance.connected"][] = [];
    const disconnected: ChannelEventPayload["instance.disconnected"][] = [];
    adapter.on("instance.connected", (payload) => connected.push(payload));
    adapter.on("instance.disconnected", (payload) => disconnected.push(payload));

    const initial = await instanceLifecycle(id);
    expect(initial.status).toBe("connected");
    expect(initial.lastConnected).not.toBeNull();

    await advanceTimersAndConnections(60_000);
    await closeSocket(0, DisconnectReason.timedOut);
    const dropped = await instanceLifecycle(id);
    expect(dropped.status).toBe("disconnected");
    expect(dropped.lastDisconnected).toBeGreaterThan(initial.lastConnected ?? 0);
    expect(disconnected).toHaveLength(1);
    expect(connected).toHaveLength(0);

    const staleBeforeReconnect = await instanceLifecycle(id);
    await closeSocket(0, DisconnectReason.timedOut);
    expect(await instanceLifecycle(id)).toEqual(staleBeforeReconnect);
    expect(disconnected).toHaveLength(1);

    await advanceTimersAndConnections(RECONNECT_INITIAL_DELAY_MS);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(2);
    await advanceTimersAndConnections(60_000);
    await openSocket(sockets.length - 1);
    const restored = await instanceLifecycle(id);
    expect(restored.status).toBe("connected");
    expect(restored.lastDisconnected).toBe(dropped.lastDisconnected);
    expect(restored.lastConnected).toBeGreaterThan(dropped.lastDisconnected ?? 0);
    expect(connected).toHaveLength(1);
    expect((await manager.getInstanceLifecycleStatuses(id))[0]).toMatchObject({
      state: "connected",
      lastConnectedAt: restored.lastConnected,
      lastDisconnectedAt: restored.lastDisconnected,
    });
  });

  it("keeps advancing persisted timestamps across repeated automatic reconnects", async () => {
    vi.useFakeTimers();
    const { id } = await createConnectedInstance();
    let previousConnected = (await instanceLifecycle(id)).lastConnected ?? 0;

    for (let cycle = 0; cycle < 3; cycle++) {
      await advanceTimersAndConnections(60_000);
      await closeSocket(sockets.length - 1, DisconnectReason.timedOut);
      const dropped = await instanceLifecycle(id);
      expect(dropped.status).toBe("disconnected");
      expect(dropped.lastDisconnected).toBeGreaterThan(previousConnected);

      await advanceTimersAndConnections(RECONNECT_INITIAL_DELAY_MS + 60_000);
      await openSocket(sockets.length - 1);
      const restored = await instanceLifecycle(id);
      expect(restored.status).toBe("connected");
      expect(restored.lastDisconnected).toBe(dropped.lastDisconnected);
      expect(restored.lastConnected).toBeGreaterThan(dropped.lastDisconnected ?? 0);
      previousConnected = restored.lastConnected ?? 0;
    }
  });

  it("keeps the outage start and append watermark across closes that never open", async () => {
    vi.useFakeTimers();
    const { id, adapter } = await createConnectedInstance();
    const disconnected: ChannelEventPayload["instance.disconnected"][] = [];
    adapter.on("instance.disconnected", (payload) => disconnected.push(payload));
    const initial = await instanceLifecycle(id);

    await advanceTimersAndConnections(60_000);
    await closeSocket(0, DisconnectReason.connectionClosed);
    const outageStart = (await instanceLifecycle(id)).lastDisconnected;
    expect(outageStart).toBeGreaterThan(initial.lastConnected ?? 0);

    for (let attempt = 0; attempt < 3; attempt++) {
      await advanceTimersAndConnections(reconnectDelay(attempt) + 5_000);
      await closeSocket(sockets.length - 1, DisconnectReason.connectionClosed);
      expect(await instanceLifecycle(id)).toEqual({
        status: "disconnected",
        lastConnected: initial.lastConnected,
        lastDisconnected: outageStart,
      });
    }
    expect(disconnected).toHaveLength(1);

    await advanceTimersAndConnections(reconnectDelay(3));
    await openSocket(sockets.length - 1);
    expect((await instanceLifecycle(id)).lastDisconnected).toBe(outageStart);
    // The append watermark is the outage start minus the 5-minute clock-skew allowance.
    expect(
      (adapter as unknown as { appendNotifyWatermarkMs: number | null }).appendNotifyWatermarkMs,
    ).toBe((outageStart ?? 0) - 5 * 60_000);
  });

  it("does not move persisted timestamps when a replaced socket closes", async () => {
    vi.useFakeTimers();
    const { manager, id } = await createConnectedInstance();
    await advanceTimersAndConnections(60_000);
    await closeSocket(0, DisconnectReason.timedOut);
    await advanceTimersAndConnections(RECONNECT_INITIAL_DELAY_MS + 60_000);
    await openSocket(sockets.length - 1);

    const current = await instanceLifecycle(id);
    expect(current.status).toBe("connected");
    const replaced = sockets[0];
    if (!replaced) throw new Error("Missing the replaced socket");
    await replaced.emit({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.timedOut } } },
    });

    expect(await instanceLifecycle(id)).toEqual(current);
    expect((await manager.getInstanceLifecycleStatuses(id))[0]).toMatchObject({
      state: "connected",
      lastConnectedAt: current.lastConnected,
      lastDisconnectedAt: current.lastDisconnected,
    });
    await advanceTimersAndConnections(RECONNECT_MAX_DELAY_MS);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(2);
    expect(await instanceLifecycle(id)).toEqual(current);
  });

  it("opens one socket when connect() runs concurrently", async () => {
    vi.useFakeTimers();
    const { adapter } = await createConnectedInstance();
    await closeSocket(0, DisconnectReason.unavailableService);

    const before = mocks.makeWASocket.mock.calls.length;
    await Promise.all([adapter.connect(), adapter.connect(), vi.advanceTimersByTimeAsync(0)]);
    expect(mocks.makeWASocket.mock.calls.length).toBe(before + 1);

    await advanceTimersAndConnections(RECONNECT_MAX_DELAY_MS);
    expect(mocks.makeWASocket.mock.calls.length).toBe(before + 1);
  });

  it("keeps the bounded retry for a session that never paired", async () => {
    vi.useFakeTimers();
    await createConnectedInstance(false);
    await closeSocket(0, DisconnectReason.timedOut);

    for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
      await advanceTimersAndConnections(reconnectDelay(attempt));
      await closeSocket(sockets.length - 1, DisconnectReason.timedOut);
    }
    const afterBackoff = mocks.makeWASocket.mock.calls.length;
    expect(afterBackoff).toBe(RECONNECT_MAX_ATTEMPTS + 1);

    await advanceTimersAndConnections(RECONNECT_MAX_DELAY_MS * 3);
    expect(mocks.makeWASocket.mock.calls.length).toBe(afterBackoff);
  });
});
