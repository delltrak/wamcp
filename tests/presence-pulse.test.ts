import { afterEach, describe, expect, it, vi } from "vitest";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { InstanceManager } from "../src/services/instance-manager.js";
import {
  PRESENCE_PULSE_DEFAULT_DURATION_MS,
  PRESENCE_PULSE_DEFAULT_INTERVAL_MS,
  PRESENCE_PULSE_MAX_DURATION_MS,
  PRESENCE_PULSE_MAX_INTERVAL_MS,
  PRESENCE_PULSE_MIN_DURATION_MS,
  PRESENCE_PULSE_MIN_INTERVAL_MS,
  PresencePulseScheduler,
  loadPresencePulseConfig,
  type PresencePulseDevice,
} from "../src/services/presence-pulse.js";

const CHAT_JID = "5511999999999@s.whatsapp.net";
const PULSE_ENV_KEYS = [
  "WA_PRESENCE_PULSE_ENABLED",
  "WA_PRESENCE_PULSE_INTERVAL_MS",
  "WA_PRESENCE_PULSE_DURATION_MS",
] as const;

function restorePulseEnv(previous: Map<string, string | undefined>): void {
  for (const key of PULSE_ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function capturePulseEnv(): Map<string, string | undefined> {
  return new Map(PULSE_ENV_KEYS.map((key) => [key, process.env[key]]));
}

describe("presence pulse configuration", () => {
  const previous = capturePulseEnv();

  afterEach(() => {
    restorePulseEnv(previous);
  });

  it("stays disabled and uses the daily bounds when unset", () => {
    for (const key of PULSE_ENV_KEYS) delete process.env[key];

    expect(loadPresencePulseConfig()).toEqual({
      enabled: false,
      intervalMs: PRESENCE_PULSE_DEFAULT_INTERVAL_MS,
      durationMs: PRESENCE_PULSE_DEFAULT_DURATION_MS,
    });
    expect(PRESENCE_PULSE_MIN_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(PRESENCE_PULSE_DEFAULT_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect(PRESENCE_PULSE_MAX_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(PRESENCE_PULSE_MIN_DURATION_MS).toBe(5_000);
    expect(PRESENCE_PULSE_DEFAULT_DURATION_MS).toBe(5 * 60 * 1000);
    expect(PRESENCE_PULSE_MAX_DURATION_MS).toBe(15 * 60 * 1000);
  });

  it("accepts explicit bounds and rejects values outside them", () => {
    process.env.WA_PRESENCE_PULSE_ENABLED = "true";
    process.env.WA_PRESENCE_PULSE_INTERVAL_MS = String(PRESENCE_PULSE_MIN_INTERVAL_MS);
    process.env.WA_PRESENCE_PULSE_DURATION_MS = String(PRESENCE_PULSE_MIN_DURATION_MS);

    expect(loadPresencePulseConfig()).toMatchObject({
      enabled: true,
      intervalMs: PRESENCE_PULSE_MIN_INTERVAL_MS,
      durationMs: PRESENCE_PULSE_MIN_DURATION_MS,
    });

    process.env.WA_PRESENCE_PULSE_ENABLED = "yes";
    expect(() => loadPresencePulseConfig()).toThrow(
      "Invalid WA_PRESENCE_PULSE_ENABLED; expected true or false",
    );

    process.env.WA_PRESENCE_PULSE_ENABLED = "false";
    process.env.WA_PRESENCE_PULSE_INTERVAL_MS = "60000";
    expect(() => loadPresencePulseConfig()).toThrow(
      `Invalid WA_PRESENCE_PULSE_INTERVAL_MS; expected an integer from ${PRESENCE_PULSE_MIN_INTERVAL_MS} to ${PRESENCE_PULSE_MAX_INTERVAL_MS}`,
    );

    process.env.WA_PRESENCE_PULSE_INTERVAL_MS = String(PRESENCE_PULSE_MIN_INTERVAL_MS);
    process.env.WA_PRESENCE_PULSE_DURATION_MS = "1000";
    expect(() => loadPresencePulseConfig()).toThrow(
      `Invalid WA_PRESENCE_PULSE_DURATION_MS; expected an integer from ${PRESENCE_PULSE_MIN_DURATION_MS} to ${PRESENCE_PULSE_MAX_DURATION_MS}`,
    );

    process.env.WA_PRESENCE_PULSE_DURATION_MS = String(PRESENCE_PULSE_MIN_INTERVAL_MS);
    expect(() => loadPresencePulseConfig()).toThrow(
      "Invalid WA_PRESENCE_PULSE_DURATION_MS; duration must be less than WA_PRESENCE_PULSE_INTERVAL_MS",
    );
  });

  it("does not start a timer or list devices while disabled", () => {
    const listDevices = vi.fn(() => []);
    const scheduler = new PresencePulseScheduler({
      config: loadPresencePulseConfig({}),
      listDevices,
    });

    scheduler.start();
    scheduler.runDue(0);

    expect(listDevices).not.toHaveBeenCalled();
    scheduler.stop();
  });
});

describe("presence pulse scheduler", () => {
  function device(overrides: Partial<PresencePulseDevice> = {}): PresencePulseDevice {
    return {
      id: "inst_pulse",
      isReady: () => true,
      runPulse: vi.fn(async () => true),
      ...overrides,
    };
  }

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("pulses a ready device, then waits for the interval after that pulse finishes", async () => {
    const ready = device();
    const offline = device({ id: "offline", isReady: () => false });
    let now = 1_000;
    const scheduler = new PresencePulseScheduler({
      config: {
        enabled: true,
        intervalMs: PRESENCE_PULSE_MIN_INTERVAL_MS,
        durationMs: PRESENCE_PULSE_MIN_DURATION_MS,
      },
      listDevices: () => [ready, offline],
      now: () => now,
    });

    scheduler.runDue(now);
    await flush();

    expect(ready.runPulse).toHaveBeenCalledTimes(1);
    expect(ready.runPulse).toHaveBeenCalledWith(PRESENCE_PULSE_MIN_DURATION_MS);
    expect(offline.runPulse).not.toHaveBeenCalled();

    scheduler.runDue(now + PRESENCE_PULSE_MIN_INTERVAL_MS - 1);
    await flush();
    expect(ready.runPulse).toHaveBeenCalledTimes(1);

    now += PRESENCE_PULSE_MIN_INTERVAL_MS;
    scheduler.runDue(now);
    await flush();
    expect(ready.runPulse).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("keeps one pulse in flight until it finishes", async () => {
    let resolvePulse: ((value: boolean) => void) | undefined;
    const runPulse = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePulse = resolve;
        }),
    );
    const scheduler = new PresencePulseScheduler({
      config: {
        enabled: true,
        intervalMs: PRESENCE_PULSE_DEFAULT_INTERVAL_MS,
        durationMs: PRESENCE_PULSE_DEFAULT_DURATION_MS,
      },
      listDevices: () => [device({ runPulse })],
      now: () => 0,
    });

    scheduler.runDue(0);
    scheduler.runDue(0);
    expect(runPulse).toHaveBeenCalledTimes(1);

    resolvePulse?.(true);
    await flush();
    scheduler.runDue(0);
    expect(runPulse).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("retries a device when the pulse fails", async () => {
    const runPulse = vi
      .fn<PresencePulseDevice["runPulse"]>()
      .mockRejectedValueOnce(new Error("socket down"))
      .mockResolvedValueOnce(true);
    const scheduler = new PresencePulseScheduler({
      config: {
        enabled: true,
        intervalMs: PRESENCE_PULSE_DEFAULT_INTERVAL_MS,
        durationMs: PRESENCE_PULSE_MIN_DURATION_MS,
      },
      listDevices: () => [device({ runPulse })],
      now: () => 0,
    });

    scheduler.runDue(0);
    await flush();
    scheduler.runDue(0);
    await flush();

    expect(runPulse).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("does not pulse again after stop", async () => {
    const runPulse = vi.fn(async () => true);
    const scheduler = new PresencePulseScheduler({
      config: {
        enabled: true,
        intervalMs: PRESENCE_PULSE_MIN_INTERVAL_MS,
        durationMs: PRESENCE_PULSE_MIN_DURATION_MS,
      },
      listDevices: () => [device({ runPulse })],
      now: () => 0,
    });

    scheduler.stop();
    scheduler.runDue(0);
    await flush();

    expect(runPulse).not.toHaveBeenCalled();
  });
});

describe("BaileysAdapter presence pulse", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function connectedAdapter(instanceId: string): {
    adapter: BaileysAdapter;
    sendPresenceUpdate: ReturnType<typeof vi.fn>;
  } {
    const adapter = new BaileysAdapter(instanceId);
    const sendPresenceUpdate = vi.fn(async () => undefined);
    Object.assign(adapter, {
      status: "connected",
      sock: { sendPresenceUpdate, end: vi.fn() },
    });
    return { adapter, sendPresenceUpdate };
  }

  it("does not pulse when disconnected and rejects a non-positive duration", async () => {
    const adapter = new BaileysAdapter("pulse-disconnected");
    await expect(adapter.runPresencePulse(PRESENCE_PULSE_MIN_DURATION_MS)).resolves.toBe(false);

    const { adapter: connected, sendPresenceUpdate } = connectedAdapter("pulse-duration");
    await expect(connected.runPresencePulse(0)).rejects.toThrow(
      "Presence pulse duration must be a positive integer number of milliseconds",
    );
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it("stays available for the pulse duration even when the activity idle timeout is shorter", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "1");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-hold");

    const pulse = adapter.runPresencePulse(10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendPresenceUpdate).toHaveBeenCalledWith("available");

    await adapter.sendPresence(CHAT_JID, "typing");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendPresenceUpdate.mock.calls.some(([status]) => status === "unavailable")).toBe(false);

    await vi.advanceTimersByTimeAsync(9_000);
    await expect(pulse).resolves.toBe(true);
    expect(sendPresenceUpdate).toHaveBeenCalledWith("unavailable");
  });

  it("leaves an active idle timer in control when the pulse ends", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "30");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-activity");

    const pulse = adapter.runPresencePulse(5_000);
    await vi.advanceTimersByTimeAsync(0);
    await adapter.sendPresence(CHAT_JID, "recording");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pulse).resolves.toBe(true);
    expect(sendPresenceUpdate.mock.calls.some(([status]) => status === "unavailable")).toBe(false);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(sendPresenceUpdate).toHaveBeenCalledWith("unavailable");
  });

  it("sends global available and unavailable in always mode", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-always");

    const pulse = adapter.runPresencePulse(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pulse).resolves.toBe(true);

    expect(sendPresenceUpdate.mock.calls.map(([status]) => status)).toEqual([
      "available",
      "unavailable",
    ]);
  });

  it("does not send unavailable when the socket closes during the pulse", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-close");

    const pulse = adapter.runPresencePulse(10_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await adapter.disconnect();
    await expect(pulse).resolves.toBe(true);

    expect(sendPresenceUpdate).toHaveBeenCalledWith("available");
    expect(sendPresenceUpdate).not.toHaveBeenCalledWith("unavailable");
  });

  it("retries after the available update fails", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-retry");
    sendPresenceUpdate.mockRejectedValueOnce(new Error("socket down"));

    await expect(adapter.runPresencePulse(5_000)).rejects.toThrow("socket down");
    expect(sendPresenceUpdate).not.toHaveBeenCalledWith("unavailable");

    sendPresenceUpdate.mockResolvedValue(undefined);
    const pulse = adapter.runPresencePulse(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pulse).resolves.toBe(true);
    expect(sendPresenceUpdate).toHaveBeenCalledWith("available");
    expect(sendPresenceUpdate).toHaveBeenCalledWith("unavailable");
  });
});

describe("InstanceManager presence pulse targets", () => {
  it("lists Baileys adapters and skips Cloud API instances", async () => {
    const manager = new InstanceManager();
    const baileys = await manager.createInstance("pulse baileys", "baileys");
    const cloud = await manager.createInstance("pulse cloud", "cloud");
    manager.ensureAdapter(baileys.id);
    manager.ensureAdapter(cloud.id);

    try {
      expect(manager.listBaileysAdapters().map((entry) => entry.instanceId)).toEqual([baileys.id]);
    } finally {
      await manager.deleteInstance(baileys.id);
      await manager.deleteInstance(cloud.id);
    }
  });
});
