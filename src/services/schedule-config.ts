// ============================================================
// WA MCP — Scheduled send environment gate
// ============================================================

export type MissedPolicy = "skip" | "send";

export interface SchedulerConfig {
  enabled: boolean;
  missedPolicy: MissedPolicy;
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
