import { afterEach, describe, expect, it, vi } from "vitest";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { InstanceManager } from "../src/services/instance-manager.js";
import {
  PRESENCE_PULSE_DEFAULT_MINUTES,
  PRESENCE_PULSE_DEFAULT_TIMES_PER_DAY,
  PRESENCE_PULSE_DEFAULT_WINDOW,
  PRESENCE_PULSE_MAX_MINUTES,
  PRESENCE_PULSE_MAX_TIMES_PER_DAY,
  PRESENCE_PULSE_MIN_MINUTES,
  PRESENCE_PULSE_MIN_OFFLINE_GAP_MINUTES,
  PRESENCE_PULSE_MIN_TIMES_PER_DAY,
  PresencePulseScheduler,
  loadPresencePulseConfig,
  planPresencePulseStarts,
  parsePresencePulseWindow,
  type PresencePulseConfig,
  type PresencePulseDevice,
} from "../src/services/presence-pulse.js";

const CHAT_JID = "5511999999999@s.whatsapp.net";
const PULSE_ENV_KEYS = [
  "WA_PRESENCE_PULSE_ENABLED",
  "WA_PRESENCE_PULSE_TIMES_PER_DAY",
  "WA_PRESENCE_PULSE_MINUTES",
  "WA_PRESENCE_PULSE_WINDOW",
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

  it("stays disabled and uses the daily window when unset", () => {
    for (const key of PULSE_ENV_KEYS) delete process.env[key];

    expect(loadPresencePulseConfig()).toEqual({
      enabled: false,
      timesPerDay: PRESENCE_PULSE_DEFAULT_TIMES_PER_DAY,
      minutes: PRESENCE_PULSE_DEFAULT_MINUTES,
      window: {
        startMinutes: 8 * 60,
        endMinutes: 22 * 60,
        label: PRESENCE_PULSE_DEFAULT_WINDOW,
      },
    });
  });

  it("accepts explicit bounds and rejects values outside them", () => {
    process.env.WA_PRESENCE_PULSE_ENABLED = "true";
    process.env.WA_PRESENCE_PULSE_TIMES_PER_DAY = "1";
    process.env.WA_PRESENCE_PULSE_MINUTES = String(PRESENCE_PULSE_MAX_MINUTES);
    process.env.WA_PRESENCE_PULSE_WINDOW = "09:30-18:00";

    expect(loadPresencePulseConfig()).toEqual({
      enabled: true,
      timesPerDay: 1,
      minutes: PRESENCE_PULSE_MAX_MINUTES,
      window: { startMinutes: 9 * 60 + 30, endMinutes: 18 * 60, label: "09:30-18:00" },
    });

    process.env.WA_PRESENCE_PULSE_ENABLED = "yes";
    expect(() => loadPresencePulseConfig()).toThrow(
      "Invalid WA_PRESENCE_PULSE_ENABLED; expected true or false",
    );

    process.env.WA_PRESENCE_PULSE_ENABLED = "false";
    process.env.WA_PRESENCE_PULSE_TIMES_PER_DAY = "0";
    expect(() => loadPresencePulseConfig()).toThrow(
      `Invalid WA_PRESENCE_PULSE_TIMES_PER_DAY; expected an integer from ${PRESENCE_PULSE_MIN_TIMES_PER_DAY} to ${PRESENCE_PULSE_MAX_TIMES_PER_DAY}`,
    );

    process.env.WA_PRESENCE_PULSE_TIMES_PER_DAY = "2";
    process.env.WA_PRESENCE_PULSE_MINUTES = "0";
    expect(() => loadPresencePulseConfig()).toThrow(
      `Invalid WA_PRESENCE_PULSE_MINUTES; expected an integer from ${PRESENCE_PULSE_MIN_MINUTES} to ${PRESENCE_PULSE_MAX_MINUTES}`,
    );

    process.env.WA_PRESENCE_PULSE_MINUTES = "5";
    process.env.WA_PRESENCE_PULSE_WINDOW = "22:00-08:00";
    expect(() => loadPresencePulseConfig()).toThrow(
      "Invalid WA_PRESENCE_PULSE_WINDOW; expected HH:MM-HH:MM from 00:00 to 23:59, ending after it starts",
    );

    process.env.WA_PRESENCE_PULSE_WINDOW = "08:00-08:20";
    process.env.WA_PRESENCE_PULSE_TIMES_PER_DAY = "2";
    process.env.WA_PRESENCE_PULSE_MINUTES = "5";
    expect(() => loadPresencePulseConfig()).toThrow(
      `Invalid WA_PRESENCE_PULSE_TIMES_PER_DAY; 2 pulses of 5 minutes do not fit in 08:00-08:20 with a ${PRESENCE_PULSE_MIN_OFFLINE_GAP_MINUTES} minute gap`,
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

describe("presence pulse schedule", () => {
  const dayStart = new Date(2026, 9, 20).getTime();
  const window = parsePresencePulseWindow("08:00-22:00");

  it("spreads pulses with jitter and keeps a minimum offline gap", () => {
    const early = planPresencePulseStarts({
      dayStartMs: dayStart,
      window,
      timesPerDay: 2,
      minutes: 5,
      random: () => 0,
    });
    const late = planPresencePulseStarts({
      dayStartMs: dayStart,
      window,
      timesPerDay: 2,
      minutes: 5,
      random: () => 0.999999999999,
    });

    expect(early[0]).toBe(dayStart + 8 * 60 * 60 * 1000);
    expect(early[1]! - early[0]!).toBe((5 + PRESENCE_PULSE_MIN_OFFLINE_GAP_MINUTES) * 60_000);
    expect(late[0]).toBeGreaterThan(early[0]!);
    expect(late[1]! + 5 * 60_000).toBeLessThanOrEqual(dayStart + 22 * 60 * 60 * 1000);
    expect(late[1]! - late[0]!).toBeGreaterThanOrEqual(
      (5 + PRESENCE_PULSE_MIN_OFFLINE_GAP_MINUTES) * 60_000,
    );
  });
});

describe("presence pulse scheduler", () => {
  function at(hours: number, minutes = 0, seconds = 0, day = 20): number {
    return new Date(2026, 9, day, hours, minutes, seconds).getTime();
  }

  function config(overrides: Partial<PresencePulseConfig> = {}): PresencePulseConfig {
    return {
      enabled: true,
      timesPerDay: 2,
      minutes: 5,
      window: parsePresencePulseWindow("08:00-22:00"),
      ...overrides,
    };
  }

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

  it("pulses inside the window and skips time outside it", async () => {
    const ready = device();
    const offline = device({ id: "offline", isReady: () => false });
    let now = at(7);
    const scheduler = new PresencePulseScheduler({
      config: config(),
      listDevices: () => [ready, offline],
      now: () => now,
      random: () => 0,
    });

    scheduler.runDue(now);
    await flush();
    expect(ready.runPulse).not.toHaveBeenCalled();

    now = at(8);
    scheduler.runDue(now);
    await flush();
    expect(ready.runPulse).toHaveBeenCalledTimes(1);
    expect(ready.runPulse).toHaveBeenCalledWith(5 * 60_000);
    expect(offline.runPulse).not.toHaveBeenCalled();

    now = at(8, 10);
    scheduler.runDue(now);
    await flush();
    expect(ready.runPulse).toHaveBeenCalledTimes(1);

    now = at(8, 20);
    scheduler.runDue(now);
    await flush();
    expect(ready.runPulse).toHaveBeenCalledTimes(2);
    expect(ready.runPulse).toHaveBeenLastCalledWith(5 * 60_000);

    now = at(12);
    scheduler.runDue(now);
    await flush();
    expect(ready.runPulse).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("shortens a pulse that starts after its scheduled time", async () => {
    const ready = device();
    const scheduler = new PresencePulseScheduler({
      config: config({ timesPerDay: 1 }),
      listDevices: () => [ready],
      now: () => at(8, 0, 30),
      random: () => 0,
    });

    scheduler.runDue(at(8, 0, 30));
    await flush();

    expect(ready.runPulse).toHaveBeenCalledWith(5 * 60_000 - 30_000);
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
    const now = at(8);
    const scheduler = new PresencePulseScheduler({
      config: config(),
      listDevices: () => [device({ runPulse })],
      now: () => now,
      random: () => 0,
    });

    scheduler.runDue(now);
    scheduler.runDue(now);
    expect(runPulse).toHaveBeenCalledTimes(1);

    resolvePulse?.(true);
    await flush();
    scheduler.runDue(now);
    expect(runPulse).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("retries a device when the pulse fails inside the same slot", async () => {
    const runPulse = vi
      .fn<PresencePulseDevice["runPulse"]>()
      .mockRejectedValueOnce(new Error("socket down"))
      .mockResolvedValueOnce(true);
    const now = at(8);
    const scheduler = new PresencePulseScheduler({
      config: config(),
      listDevices: () => [device({ runPulse })],
      now: () => now,
      random: () => 0,
    });

    scheduler.runDue(now);
    await flush();
    scheduler.runDue(now);
    await flush();

    expect(runPulse).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("plans a new day after the previous day's slots are done", async () => {
    const ready = device();
    let now = at(8);
    const scheduler = new PresencePulseScheduler({
      config: config({ timesPerDay: 1 }),
      listDevices: () => [ready],
      now: () => now,
      random: () => 0,
    });

    scheduler.runDue(now);
    await flush();
    now = at(8, 0, 0, 21);
    scheduler.runDue(now);
    await flush();

    expect(ready.runPulse).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("does not pulse again after stop", async () => {
    const runPulse = vi.fn(async () => true);
    const scheduler = new PresencePulseScheduler({
      config: config(),
      listDevices: () => [device({ runPulse })],
      now: () => at(8),
      random: () => 0,
    });

    scheduler.stop();
    scheduler.runDue(at(8));
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
    await expect(adapter.runPresencePulse(60_000)).resolves.toBe(false);

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
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "true");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-hold");
    expect((adapter as unknown as { markOnlineOnConnect: boolean }).markOnlineOnConnect).toBe(
      false,
    );

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
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "true");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-always");
    expect((adapter as unknown as { markOnlineOnConnect: boolean }).markOnlineOnConnect).toBe(true);

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
