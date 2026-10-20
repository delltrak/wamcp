// ============================================================
// WA MCP — Optional Baileys presence pulse
// Briefly marks a connected account available, then unavailable.
// Disabled unless WA_PRESENCE_PULSE_ENABLED=true.
// ============================================================

import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger({ service: "presence-pulse" });

/** 15 minutes. Shorter pulses would keep the account online too often. */
export const PRESENCE_PULSE_MIN_INTERVAL_MS = 15 * 60 * 1000;
/** 7 days. */
export const PRESENCE_PULSE_MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** 24 hours. */
export const PRESENCE_PULSE_DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 5 seconds. */
export const PRESENCE_PULSE_MIN_DURATION_MS = 5 * 1000;
/** 15 minutes. */
export const PRESENCE_PULSE_MAX_DURATION_MS = 15 * 60 * 1000;
/** 5 minutes. */
export const PRESENCE_PULSE_DEFAULT_DURATION_MS = 5 * 60 * 1000;
/** How often the scheduler looks for a due pulse. */
export const PRESENCE_PULSE_CHECK_INTERVAL_MS = 60 * 1000;

export interface PresencePulseConfig {
  enabled: boolean;
  intervalMs: number;
  durationMs: number;
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

/** Read presence-pulse settings. Invalid values throw; unset values keep the defaults. */
export function loadPresencePulseConfig(env: NodeJS.ProcessEnv = process.env): PresencePulseConfig {
  const enabled = readBoolean(env, "WA_PRESENCE_PULSE_ENABLED", false);
  const intervalMs = readBoundedInteger(
    env,
    "WA_PRESENCE_PULSE_INTERVAL_MS",
    PRESENCE_PULSE_DEFAULT_INTERVAL_MS,
    PRESENCE_PULSE_MIN_INTERVAL_MS,
    PRESENCE_PULSE_MAX_INTERVAL_MS,
  );
  const durationMs = readBoundedInteger(
    env,
    "WA_PRESENCE_PULSE_DURATION_MS",
    PRESENCE_PULSE_DEFAULT_DURATION_MS,
    PRESENCE_PULSE_MIN_DURATION_MS,
    PRESENCE_PULSE_MAX_DURATION_MS,
  );
  if (durationMs >= intervalMs) {
    throw new Error(
      "Invalid WA_PRESENCE_PULSE_DURATION_MS; duration must be less than WA_PRESENCE_PULSE_INTERVAL_MS",
    );
  }
  return { enabled, intervalMs, durationMs };
}

export class PresencePulseScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly lastPulseAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly config: PresencePulseConfig;
  private readonly listDevices: () => PresencePulseDevice[];
  private readonly checkIntervalMs: number;
  private readonly now: () => number;

  constructor(options: PresencePulseSchedulerOptions) {
    this.config = options.config;
    this.listDevices = options.listDevices;
    this.checkIntervalMs = options.checkIntervalMs ?? PRESENCE_PULSE_CHECK_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.stopped = false;
    this.runDue();
    this.timer = setInterval(() => this.runDue(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Start a pulse for every ready device whose interval has elapsed. */
  runDue(now = this.now()): void {
    if (!this.config.enabled || this.stopped) return;
    for (const device of this.listDevices()) {
      this.startIfDue(device, now);
    }
  }

  private startIfDue(device: PresencePulseDevice, now: number): void {
    if (!device.id || !device.isReady() || this.inFlight.has(device.id)) return;
    const lastPulseAt = this.lastPulseAt.get(device.id);
    if (lastPulseAt !== undefined && now - lastPulseAt < this.config.intervalMs) return;

    this.inFlight.add(device.id);
    void device
      .runPulse(this.config.durationMs)
      .then((pulsed) => {
        if (pulsed) this.lastPulseAt.set(device.id, this.now());
      })
      .catch((error: unknown) => {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), instanceId: device.id },
          "Presence pulse failed",
        );
      })
      .finally(() => {
        this.inFlight.delete(device.id);
      });
  }
}
