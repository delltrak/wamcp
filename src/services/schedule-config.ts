// ============================================================
// WA MCP — Scheduled send environment gate
// ============================================================

import { DEFAULT_SCHEDULER_MAX_ACTIVE } from "../constants.js";

export type MissedPolicy = "skip" | "send";

export interface SchedulerConfig {
  enabled: boolean;
  missedPolicy: MissedPolicy;
  /** Active, paused, and running schedules allowed per instance. */
  maxActive: number;
}

const DISABLED_MESSAGE =
  "Scheduled sends are disabled. Set WA_SCHEDULER_ENABLED=true to enable them.";

export function schedulerDisabledMessage(): string {
  return DISABLED_MESSAGE;
}

/** Read the scheduler gate. Unset values keep the safe defaults. Invalid values throw. */
export function readSchedulerConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  return {
    enabled: parseEnabled(env.WA_SCHEDULER_ENABLED),
    missedPolicy: parseMissedPolicy(env.WA_SCHEDULER_MISSED_POLICY),
    maxActive: parseMaxActive(env.WA_SCHEDULER_MAX_ACTIVE),
  };
}

function parseEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("Invalid WA_SCHEDULER_ENABLED; expected true or false");
}

function parseMissedPolicy(value: string | undefined): MissedPolicy {
  if (value === undefined || value.trim() === "") return "skip";
  const normalized = value.trim().toLowerCase();
  if (normalized === "skip" || normalized === "send") return normalized;
  throw new Error("Invalid WA_SCHEDULER_MISSED_POLICY; expected skip or send");
}

function parseMaxActive(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SCHEDULER_MAX_ACTIVE;
  if (!/^[1-9]\d*$/.test(value.trim())) {
    throw new Error("Invalid WA_SCHEDULER_MAX_ACTIVE; expected a positive integer");
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw new Error("Invalid WA_SCHEDULER_MAX_ACTIVE; expected a positive integer");
  }
  return parsed;
}
