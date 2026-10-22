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
  zonedWallTimeMs,
  type PresencePulseConfig,
  type PresencePulseDevice,
} from "../src/services/presence-pulse.js";

const CHAT_JID = "5511999999999@s.whatsapp.net";
const PULSE_ENV_KEYS = [
  "WA_PRESENCE_PULSE_ENABLED",
  "WA_PRESENCE_PULSE_TIMES_PER_DAY",
  "WA_PRESENCE_PULSE_MINUTES",
  "WA_PRESENCE_PULSE_WINDOW",
  "WA_PRESENCE_PULSE_TZ",
  "WA_PRESENCE_MODE",
  "WA_MARK_ONLINE_ON_CONNECT",
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
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      skipWhenAlwaysOnline: false,
    });
  });

  it("accepts explicit bounds and rejects values outside them", () => {
    process.env.WA_PRESENCE_PULSE_ENABLED = "true";
    process.env.WA_PRESENCE_PULSE_TIMES_PER_DAY = "1";
    process.env.WA_PRESENCE_PULSE_MINUTES = String(PRESENCE_PULSE_MAX_MINUTES);
    process.env.WA_PRESENCE_PULSE_WINDOW = "09:30-18:00";

    process.env.WA_PRESENCE_PULSE_TZ = "America/Bahia";
    expect(loadPresencePulseConfig()).toEqual({
      enabled: true,
      timesPerDay: 1,
      minutes: PRESENCE_PULSE_MAX_MINUTES,
      window: { startMinutes: 9 * 60 + 30, endMinutes: 18 * 60, label: "09:30-18:00" },
      timeZone: "America/Bahia",
      skipWhenAlwaysOnline: false,
    });

    process.env.WA_PRESENCE_MODE = "always";
    process.env.WA_MARK_ONLINE_ON_CONNECT = "true";
    expect(loadPresencePulseConfig().skipWhenAlwaysOnline).toBe(true);
    process.env.WA_PRESENCE_MODE = "on_activity";
    expect(loadPresencePulseConfig().skipWhenAlwaysOnline).toBe(false);
    delete process.env.WA_PRESENCE_MODE;
    delete process.env.WA_MARK_ONLINE_ON_CONNECT;

    process.env.WA_PRESENCE_PULSE_TZ = "Not/AZone";
    expect(() => loadPresencePulseConfig()).toThrow(
      "Invalid WA_PRESENCE_PULSE_TZ; expected an IANA time zone name",
    );
    delete process.env.WA_PRESENCE_PULSE_TZ;

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
  const now = Date.UTC(2026, 9, 20, 12);
  const window = parsePresencePulseWindow("08:00-22:00");

  it("spreads pulses with jitter and keeps a minimum offline gap", () => {
    const early = planPresencePulseStarts({
      now,
      timeZone: "UTC",
      window,
      timesPerDay: 2,
      minutes: 5,
      random: () => 0,
    });
    const late = planPresencePulseStarts({
      now,
      timeZone: "UTC",
      window,
      timesPerDay: 2,
      minutes: 5,
      random: () => 0.999999999999,
    });

    expect(early[0]).toBe(Date.UTC(2026, 9, 20, 8));
    expect(early[1]! - early[0]!).toBe((5 + PRESENCE_PULSE_MIN_OFFLINE_GAP_MINUTES) * 60_000);
    expect(late[0]).toBeGreaterThan(early[0]!);
    expect(late[1]! + 5 * 60_000).toBeLessThanOrEqual(Date.UTC(2026, 9, 20, 22));
    expect(late[1]! - late[0]!).toBeGreaterThanOrEqual(
      (5 + PRESENCE_PULSE_MIN_OFFLINE_GAP_MINUTES) * 60_000,
    );
  });

  it("keeps America/New_York wall-clock hours across the 2026 DST changes", () => {
    const springNow = Date.parse("2026-03-08T15:00:00Z");
    const fallNow = Date.parse("2026-11-01T15:00:00Z");
    const zone = "America/New_York";

    expect(zonedWallTimeMs(2026, 3, 8, 8 * 60, zone)).toBe(Date.parse("2026-03-08T12:00:00Z"));
    expect(zonedWallTimeMs(2026, 3, 8, 22 * 60, zone)).toBe(Date.parse("2026-03-09T02:00:00Z"));
    expect(zonedWallTimeMs(2026, 11, 1, 8 * 60, zone)).toBe(Date.parse("2026-11-01T13:00:00Z"));
    expect(zonedWallTimeMs(2026, 11, 1, 22 * 60, zone)).toBe(Date.parse("2026-11-02T03:00:00Z"));

    const spring = planPresencePulseStarts({
      now: springNow,
      timeZone: zone,
      window,
      timesPerDay: 1,
      minutes: 5,
      random: () => 0,
    });
    const fall = planPresencePulseStarts({
      now: fallNow,
      timeZone: zone,
      window,
      timesPerDay: 1,
      minutes: 5,
      random: () => 0,
    });

    expect(spring[0]).toBe(Date.parse("2026-03-08T12:00:00Z"));
    expect(fall[0]).toBe(Date.parse("2026-11-01T13:00:00Z"));
    expect(spring[0]).not.toBe(Date.parse("2026-03-08T05:00:00Z") + 8 * 60 * 60 * 1000);
    expect(fall[0]).not.toBe(Date.parse("2026-11-01T04:00:00Z") + 8 * 60 * 60 * 1000);
  });
});

describe("presence pulse scheduler", () => {
  function at(hours: number, minutes = 0, seconds = 0, day = 20): number {
    return Date.UTC(2026, 9, day, hours, minutes, seconds);
  }

  function config(overrides: Partial<PresencePulseConfig> = {}): PresencePulseConfig {
    return {
      enabled: true,
      timesPerDay: 2,
      minutes: 5,
      timeZone: "UTC",
      skipWhenAlwaysOnline: false,
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
      bootedAt: at(7),
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
      bootedAt: at(7),
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
      bootedAt: at(7),
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
      bootedAt: at(7),
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

  it("drops a plan when the instance is no longer listed and replans if it returns", async () => {
    const gone = device({ id: "gone" });
    const stay = device({ id: "stay" });
    let devices = [gone, stay];
    let now = at(8, 1);
    const scheduler = new PresencePulseScheduler({
      config: config({ timesPerDay: 1 }),
      listDevices: () => devices,
      now: () => now,
      bootedAt: at(7),
      random: () => 0,
    });

    scheduler.runDue(now);
    await flush();
    expect(gone.runPulse).toHaveBeenCalledTimes(1);

    devices = [stay];
    now = at(8, 2);
    scheduler.runDue(now);
    await flush();
    expect(gone.runPulse).toHaveBeenCalledTimes(1);

    devices = [gone];
    scheduler.runDue(now);
    await flush();
    expect(gone.runPulse).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("skips slots that start within a few minutes of boot and still runs a later slot", async () => {
    const ready = device();
    let now = at(8, 1);
    const scheduler = new PresencePulseScheduler({
      config: config({ timesPerDay: 2 }),
      listDevices: () => [ready],
      now: () => now,
      random: () => 0,
    });

    scheduler.runDue(now);
    await flush();
    expect(ready.runPulse).not.toHaveBeenCalled();

    now = at(8, 20);
    scheduler.runDue(now);
    await flush();
    expect(ready.runPulse).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("skips a spring-forward day when the real window no longer fits", async () => {
    const runPulse = vi.fn(async () => true);
    const warn = vi.fn();
    let now = Date.parse("2026-03-08T06:30:00Z");
    const scheduler = new PresencePulseScheduler({
      config: config({
        timeZone: "America/New_York",
        timesPerDay: 2,
        minutes: 15,
        window: parsePresencePulseWindow("02:00-03:30"),
      }),
      listDevices: () => [device({ runPulse })],
      now: () => now,
      random: () => 0,
      log: { info: vi.fn(), warn },
      checkIntervalMs: 60 * 60 * 1000,
    });

    expect(() => scheduler.start()).not.toThrow();
    expect(() => scheduler.runDue(now)).not.toThrow();
    await flush();
    expect(runPulse).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain("skipped for this day");

    now = Date.parse("2026-03-09T06:00:00Z");
    expect(() => scheduler.runDue(now)).not.toThrow();
    await flush();
    expect(runPulse).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("skips pulsing and logs once when the account is already online", () => {
    const listDevices = vi.fn(() => [device()]);
    const info = vi.fn();
    const scheduler = new PresencePulseScheduler({
      config: config({ skipWhenAlwaysOnline: true }),
      listDevices,
      log: { info, warn: vi.fn() },
    });

    scheduler.start();
    scheduler.start();
    scheduler.runDue(at(8));

    expect(listDevices).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toContain("WA_MARK_ONLINE_ON_CONNECT=true");
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

  it("unrefs the pulse timer so a long pulse does not hold the process open", async () => {
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "false");
    const sample = setTimeout(() => undefined, 60_000);
    const unref = vi.spyOn(Object.getPrototypeOf(sample), "unref");
    clearTimeout(sample);

    const { adapter } = connectedAdapter("pulse-unref");
    const pulse = adapter.runPresencePulse(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(unref).toHaveBeenCalled();
    await adapter.disconnect();
    await pulse;
    unref.mockRestore();
  });

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
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "false");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-always");
    expect((adapter as unknown as { markOnlineOnConnect: boolean }).markOnlineOnConnect).toBe(
      false,
    );

    const pulse = adapter.runPresencePulse(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pulse).resolves.toBe(true);

    expect(sendPresenceUpdate.mock.calls.map(([status]) => status)).toEqual([
      "available",
      "unavailable",
    ]);
  });

  it("does not pulse when always mode already marks the account online on connect", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "true");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-already-online");

    await expect(adapter.runPresencePulse(5_000)).resolves.toBe(false);
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it("leaves an explicit available presence in place when a pulse ends", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "false");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-explicit");

    await adapter.sendPresence(CHAT_JID, "available");
    sendPresenceUpdate.mockClear();
    const before = adapter.runPresencePulse(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(before).resolves.toBe(true);
    expect(sendPresenceUpdate).not.toHaveBeenCalled();

    await adapter.sendPresence(CHAT_JID, "unavailable");
    sendPresenceUpdate.mockClear();
    const during = adapter.runPresencePulse(5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendPresenceUpdate).toHaveBeenCalledWith("available");
    await adapter.sendPresence(CHAT_JID, "available");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(during).resolves.toBe(true);
    expect(sendPresenceUpdate).not.toHaveBeenCalledWith("unavailable");
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

  it.each(["on_activity", "always"])(
    "retries unavailable cleanup in %s after the pulse slot ends",
    async (mode) => {
      vi.useFakeTimers();
      vi.stubEnv("WA_PRESENCE_MODE", mode);
      vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "false");
      const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-cleanup-retry");
      sendPresenceUpdate
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("transient"));
      let finished = false;
      const pulse = adapter.runPresencePulse(1_000).then((result) => {
        finished = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(finished).toBe(false);
      await expect(adapter.runPresencePulse(1_000)).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pulse).resolves.toBe(true);
      expect(sendPresenceUpdate.mock.calls.map(([status]) => status)).toEqual([
        "available",
        "unavailable",
        "unavailable",
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retries cleanup after activity takes ownership from the pulse", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "10");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-activity-cleanup");
    const pulse = adapter.runPresencePulse(1_000);
    await vi.advanceTimersByTimeAsync(0);
    await adapter.sendPresence(CHAT_JID, "typing");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pulse).resolves.toBe(true);
    sendPresenceUpdate.mockRejectedValueOnce(new Error("transient idle failure"));
    await vi.advanceTimersByTimeAsync(9_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      sendPresenceUpdate.mock.calls.filter(([status]) => status === "unavailable"),
    ).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves a new explicit available in control while cleanup retries", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "false");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-explicit-cleanup");
    sendPresenceUpdate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transient"));
    const pulse = adapter.runPresencePulse(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await adapter.sendPresence(CHAT_JID, "available");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pulse).resolves.toBe(true);
    expect(
      sendPresenceUpdate.mock.calls.filter(([status]) => status === "unavailable"),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not throttle explicit unavailable behind a chat indicator during cleanup", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "false");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-explicit-offline");
    sendPresenceUpdate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transient"));
    const pulse = adapter.runPresencePulse(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await adapter.sendPresence(CHAT_JID, "typing");
    await adapter.sendPresence(CHAT_JID, "unavailable");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pulse).resolves.toBe(true);
    expect(
      sendPresenceUpdate.mock.calls.filter(([status]) => status === "unavailable"),
    ).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains cleanup ownership when an explicit available update fails", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "false");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-explicit-failed");
    sendPresenceUpdate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transient"));
    const pulse = adapter.runPresencePulse(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    sendPresenceUpdate.mockRejectedValueOnce(new Error("explicit failure"));
    await expect(adapter.sendPresence(CHAT_JID, "available")).rejects.toThrow("explicit failure");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pulse).resolves.toBe(true);
    expect(
      sendPresenceUpdate.mock.calls.filter(([status]) => status === "unavailable"),
    ).toHaveLength(2);
  });

  it("cancels cleanup retries when disconnected", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "false");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-cleanup-close");
    sendPresenceUpdate.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("transient"));
    const pulse = adapter.runPresencePulse(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await adapter.disconnect();
    await expect(pulse).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendPresenceUpdate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not arm a pulse timer after disconnect during the available update", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "false");
    const { adapter, sendPresenceUpdate } = connectedAdapter("pulse-pending-close");
    let complete!: () => void;
    sendPresenceUpdate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const pulse = adapter.runPresencePulse(60_000);
    await adapter.disconnect();
    complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    await expect(pulse).resolves.toBe(true);
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
    (await manager.ensureAdapter(baileys.id));
    (await manager.ensureAdapter(cloud.id));

    try {
      expect(manager.listBaileysAdapters().map((entry) => entry.instanceId)).toEqual([baileys.id]);
    } finally {
      await manager.deleteInstance(baileys.id);
      await manager.deleteInstance(cloud.id);
    }
  });
});
