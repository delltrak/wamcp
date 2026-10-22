// ============================================================
// WA MCP — Optional Baileys presence pulse
// Marks a connected account available inside a daily window, then unavailable.
// Disabled unless WA_PRESENCE_PULSE_ENABLED=true.
// ============================================================

import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger({ service: "presence-pulse" });

export const PRESENCE_PULSE_MIN_TIMES_PER_DAY = 1;
export const PRESENCE_PULSE_MAX_TIMES_PER_DAY = 12;
export const PRESENCE_PULSE_DEFAULT_TIMES_PER_DAY = 2;
export const PRESENCE_PULSE_MIN_MINUTES = 1;
export const PRESENCE_PULSE_MAX_MINUTES = 15;
export const PRESENCE_PULSE_DEFAULT_MINUTES = 5;
/** Offline time required between the end of one pulse and the start of the next. */
export const PRESENCE_PULSE_MIN_OFFLINE_GAP_MINUTES = 15;
export const PRESENCE_PULSE_DEFAULT_WINDOW = "08:00-22:00";
/** How often the scheduler looks for a due pulse. */
export const PRESENCE_PULSE_CHECK_INTERVAL_MS = 60 * 1000;
/**
 * Slots that start this close to process start are skipped.
 * A restart otherwise replans the day and can fire another pulse immediately.
 */
export const PRESENCE_PULSE_BOOT_SKIP_MS = 3 * 60 * 1000;
const MIN_REMAINING_MS = 1_000;

export interface PresenceWindow {
  startMinutes: number;
  endMinutes: number;
  label: string;
}

export interface PresencePulseConfig {
  enabled: boolean;
  timesPerDay: number;
  minutes: number;
  window: PresenceWindow;
  /** IANA zone for the daily window. Defaults to the process zone, or the server zone. */
  timeZone: string;
  /** always mode with mark-online-on-connect already keeps the account online. */
  skipWhenAlwaysOnline: boolean;
}

interface PresencePulseLog {
  info(obj: Record<string, unknown>, message: string): void;
  warn(obj: Record<string, unknown>, message: string): void;
}

export interface PresencePulseDevice {
  id: string;
  isReady: () => boolean;
  /** Resolves true when the available update was sent. */
  runPulse: (durationMs: number) => Promise<boolean>;
}

export interface PresencePulseSchedulerOptions {
  config: PresencePulseConfig;
  listDevices: () => PresencePulseDevice[];
  checkIntervalMs?: number;
  now?: () => number;
  /** Process start used to skip slots that begin within a few minutes of boot. */
  bootedAt?: number;
  random?: () => number;
  log?: PresencePulseLog;
}

interface DevicePlan {
  dayKey: string;
  starts: number[];
  done: boolean[];
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`Invalid ${key}; expected true or false`);
}

function readBoundedInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid ${key}; expected an integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${key}; expected an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

/** Parse HH:MM-HH:MM. The window is wall-clock time in WA_PRESENCE_PULSE_TZ and must end after it starts. */
export function parsePresencePulseWindow(value: string | undefined): PresenceWindow {
  const raw =
    value === undefined || value.trim() === "" ? PRESENCE_PULSE_DEFAULT_WINDOW : value.trim();
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  const startMinutes = match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
  const endMinutes = match ? Number(match[3]) * 60 + Number(match[4]) : Number.NaN;
  if (!match || endMinutes <= startMinutes) {
    throw new Error(
      "Invalid WA_PRESENCE_PULSE_WINDOW; expected HH:MM-HH:MM from 00:00 to 23:59, ending after it starts",
    );
  }
  return {
    startMinutes,
    endMinutes,
    label: `${match[1]}:${match[2]}-${match[3]}:${match[4]}`,
  };
}

function assertPulseFits(timesPerDay: number, minutes: number, window: PresenceWindow): void {
  const windowMinutes = window.endMinutes - window.startMinutes;
  const spacing = minutes + PRESENCE_PULSE_MIN_OFFLINE_GAP_MINUTES;
  const needed = (timesPerDay - 1) * spacing + minutes;
  if (needed > windowMinutes) {
    throw new Error(
      `Invalid WA_PRESENCE_PULSE_TIMES_PER_DAY; ${timesPerDay} pulses of ${minutes} minutes do not fit in ${window.label} with a ${PRESENCE_PULSE_MIN_OFFLINE_GAP_MINUTES} minute gap`,
    );
  }
}

/** Read presence-pulse settings. Invalid values throw; unset values keep the defaults. */
export function loadPresencePulseConfig(env: NodeJS.ProcessEnv = process.env): PresencePulseConfig {
  const enabled = readBoolean(env, "WA_PRESENCE_PULSE_ENABLED", false);
  const timesPerDay = readBoundedInteger(
    env,
    "WA_PRESENCE_PULSE_TIMES_PER_DAY",
    PRESENCE_PULSE_DEFAULT_TIMES_PER_DAY,
    PRESENCE_PULSE_MIN_TIMES_PER_DAY,
    PRESENCE_PULSE_MAX_TIMES_PER_DAY,
  );
  const minutes = readBoundedInteger(
    env,
    "WA_PRESENCE_PULSE_MINUTES",
    PRESENCE_PULSE_DEFAULT_MINUTES,
    PRESENCE_PULSE_MIN_MINUTES,
    PRESENCE_PULSE_MAX_MINUTES,
  );
  const window = parsePresencePulseWindow(env.WA_PRESENCE_PULSE_WINDOW);
  assertPulseFits(timesPerDay, minutes, window);
  const timeZone = resolvePresencePulseTimeZone(env.WA_PRESENCE_PULSE_TZ);
  const skipWhenAlwaysOnline =
    env.WA_PRESENCE_MODE?.trim().toLowerCase() === "always" &&
    env.WA_MARK_ONLINE_ON_CONNECT?.trim().toLowerCase() === "true";
  return { enabled, timesPerDay, minutes, window, timeZone, skipWhenAlwaysOnline };
}

/** IANA zone for the pulse window. Blank uses the process TZ, which follows the server when unset. */
export function resolvePresencePulseTimeZone(value: string | undefined): string {
  const trimmed = value?.trim();
  const timeZone = trimmed || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new Error("Invalid WA_PRESENCE_PULSE_TZ; expected an IANA time zone name");
  }
  return timeZone;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Partial<ZonedParts> = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type === "year" || part.type === "month" || part.type === "day") {
      parts[part.type] = Number(part.value);
    } else if (part.type === "hour" || part.type === "minute" || part.type === "second") {
      parts[part.type] = Number(part.value);
    }
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** Intl can report midnight as hour 24 on the previous calendar day. */
function zonedCalendarDate(parts: ZonedParts): { year: number; month: number; day: number } {
  if (parts.hour !== 24) return { year: parts.year, month: parts.month, day: parts.day };
  const rolled = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return {
    year: rolled.getUTCFullYear(),
    month: rolled.getUTCMonth() + 1,
    day: rolled.getUTCDate(),
  };
}

function zonedOffsetMs(instant: number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - instant;
}

/** UTC instant of a wall-clock minute on a calendar day in an IANA zone. */
export function zonedWallTimeMs(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string,
): number {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstOffset = zonedOffsetMs(utcGuess, timeZone);
  const first = utcGuess - firstOffset;
  const secondOffset = zonedOffsetMs(first, timeZone);
  const second = utcGuess - secondOffset;
  if (zonedOffsetMs(second, timeZone) === secondOffset) return second;
  return first;
}

export function zonedDayKey(instant: number, timeZone: string): string {
  const date = zonedCalendarDate(zonedParts(instant, timeZone));
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

/**
 * Place each pulse at random inside the window while keeping pulses from overlapping.
 * Starts stay at least the duration plus the offline gap apart, and each pulse ends by the window end.
 */
export function planPresencePulseStarts(input: {
  now: number;
  timeZone: string;
  window: PresenceWindow;
  timesPerDay: number;
  minutes: number;
  random?: () => number;
}): number[] {
  const random = input.random ?? Math.random;
  const durationMs = input.minutes * 60_000;
  const spacingMs = (input.minutes + PRESENCE_PULSE_MIN_OFFLINE_GAP_MINUTES) * 60_000;
  const date = zonedCalendarDate(zonedParts(input.now, input.timeZone));
  const earliest = zonedWallTimeMs(
    date.year,
    date.month,
    date.day,
    input.window.startMinutes,
    input.timeZone,
  );
  const windowEnd = zonedWallTimeMs(
    date.year,
    date.month,
    date.day,
    input.window.endMinutes,
    input.timeZone,
  );
  const latestStart = windowEnd - durationMs;
  const slack = latestStart - earliest - (input.timesPerDay - 1) * spacingMs;
  if (slack < 0) {
    throw new Error(
      `Invalid WA_PRESENCE_PULSE_TIMES_PER_DAY; ${input.timesPerDay} pulses of ${input.minutes} minutes do not fit in ${input.window.label} with a ${PRESENCE_PULSE_MIN_OFFLINE_GAP_MINUTES} minute gap`,
    );
  }

  const cuts = Array.from({ length: input.timesPerDay }, () => {
    const sample = random();
    const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.999999999999) : 0;
    return unit * slack;
  }).sort((left, right) => left - right);

  return cuts.map((cut, index) => Math.floor(earliest + cut + index * spacingMs));
}

export class PresencePulseScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly plans = new Map<string, DevicePlan>();
  private readonly inFlight = new Set<string>();
  private readonly config: PresencePulseConfig;
  private readonly listDevices: () => PresencePulseDevice[];
  private readonly checkIntervalMs: number;
  private readonly now: () => number;
  private readonly bootedAt: number;
  private readonly random: () => number;
  private readonly log: PresencePulseLog;
  private skipLogged = false;

  constructor(options: PresencePulseSchedulerOptions) {
    this.config = options.config;
    this.listDevices = options.listDevices;
    this.checkIntervalMs = options.checkIntervalMs ?? PRESENCE_PULSE_CHECK_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.bootedAt = options.bootedAt ?? this.now();
    this.random = options.random ?? Math.random;
    this.log = options.log ?? logger;
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    if (this.config.skipWhenAlwaysOnline) {
      this.logSkipOnce();
      return;
    }
    this.stopped = false;
    this.runDue();
    this.timer = setInterval(() => this.runDue(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  private logSkipOnce(): void {
    if (this.skipLogged) return;
    this.skipLogged = true;
    this.log.info(
      {},
      "Presence pulse skipped; WA_PRESENCE_MODE=always and WA_MARK_ONLINE_ON_CONNECT=true already keep the account online",
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Start a pulse for every ready device that has a scheduled slot open. */
  runDue(now = this.now()): void {
    if (!this.config.enabled || this.stopped || this.config.skipWhenAlwaysOnline) return;
    const devices = this.listDevices();
    const live = new Set(devices.map((device) => device.id));
    for (const id of this.plans.keys()) {
      if (!live.has(id)) this.plans.delete(id);
    }
    for (const device of devices) {
      try {
        this.startIfDue(device, now);
      } catch (error) {
        this.log.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            instanceId: device.id,
          },
          "Presence pulse skipped for this day",
        );
      }
    }
  }

  private startIfDue(device: PresencePulseDevice, now: number): void {
    if (!device.id || !device.isReady() || this.inFlight.has(device.id)) return;
    const plan = this.planFor(device.id, now);
    const slot = this.claimSlot(plan, now);
    if (!slot) return;

    const { index, remaining } = slot;
    plan.done[index] = true;
    this.inFlight.add(device.id);
    this.log.info({ instanceId: device.id, minutes: this.config.minutes }, "Presence pulse");
    void device
      .runPulse(remaining)
      .then((pulsed) => {
        if (!pulsed) plan.done[index] = false;
      })
      .catch((error: unknown) => {
        plan.done[index] = false;
        this.log.warn(
          { err: error instanceof Error ? error.message : String(error), instanceId: device.id },
          "Presence pulse failed",
        );
      })
      .finally(() => {
        this.inFlight.delete(device.id);
      });
  }

  private planFor(deviceId: string, now: number): DevicePlan {
    const dayKey = zonedDayKey(now, this.config.timeZone);
    const existing = this.plans.get(deviceId);
    if (existing?.dayKey === dayKey) return existing;
    let starts: number[];
    try {
      starts = planPresencePulseStarts({
        now,
        timeZone: this.config.timeZone,
        window: this.config.window,
        timesPerDay: this.config.timesPerDay,
        minutes: this.config.minutes,
        random: this.random,
      });
    } catch (error) {
      this.log.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          instanceId: deviceId,
          day: dayKey,
        },
        "Presence pulse skipped for this day",
      );
      const skipped = { dayKey, starts: [], done: [] };
      this.plans.set(deviceId, skipped);
      return skipped;
    }
    const plan = { dayKey, starts, done: starts.map(() => false) };
    this.plans.set(deviceId, plan);
    return plan;
  }

  private claimSlot(
    plan: DevicePlan,
    now: number,
  ): { index: number; remaining: number } | undefined {
    const durationMs = this.config.minutes * 60_000;
    for (let index = 0; index < plan.starts.length; index += 1) {
      if (plan.done[index]) continue;
      const start = plan.starts[index] ?? 0;
      const end = start + durationMs;
      if (Math.abs(start - this.bootedAt) <= PRESENCE_PULSE_BOOT_SKIP_MS) {
        plan.done[index] = true;
        continue;
      }
      if (now < start) return undefined;
      if (now >= end || end - now < MIN_REMAINING_MS) {
        plan.done[index] = true;
        continue;
      }
      return { index, remaining: end - now };
    }
    return undefined;
  }
}
