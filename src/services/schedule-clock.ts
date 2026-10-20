// ============================================================
// WA MCP — Timezone-aware schedule occurrences
// once, daily, weekly, and monthly. Weekday 0 is Sunday.
// ============================================================

import { DEFAULT_SCHEDULER_TIMEZONE, SCHEDULER_MAX_HORIZON_MS } from "../constants.js";

export type Recurrence = "once" | "daily" | "weekly" | "monthly";

export interface ScheduleSpec {
  scheduledAt: number;
  timezone: string;
  recurrence: Recurrence;
  weekdays: number[];
  dayOfMonth: number | null;
  endAt: number | null;
}

export interface ParsedSchedule extends ScheduleSpec {
  occurrenceLimit: number | null;
  /** First slot at or after scheduledAt that satisfies weekdays or dayOfMonth. */
  nextRunAt: number;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const OFFSET_ZONE = /^[+-]\d{2}:?\d{2}$/;

/**
 * Canonical IANA name, or null.
 * `america/bahia` becomes `America/Bahia`.
 * Names Intl resolves to UTC are stored as `UTC`, including `UTC`, `GMT`,
 * `UCT`, `Zulu`, `Etc/UTC`, and `Etc/GMT`.
 * Numeric offsets, abbreviations that resolve to a regional zone (such as EST),
 * and `Etc/*` zones that stay under `Etc/` (such as `Etc/GMT+3`) are rejected.
 */
export function canonicalTimeZone(timeZone: string): string | null {
  const value = timeZone.trim();
  if (value === "" || OFFSET_ZONE.test(value)) return null;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions()
      .timeZone;
    if (!resolved || resolved.startsWith("Etc/")) return null;
    if (!value.includes("/") && resolved !== "UTC") return null;
    return resolved;
  } catch {
    return null;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  return canonicalTimeZone(timeZone) !== null;
}

export function defaultTimeZone(): string {
  return DEFAULT_SCHEDULER_TIMEZONE;
}

export function parseRfc3339(value: string, label: string): number {
  const trimmed = value.trim();
  if (!RFC3339.test(trimmed)) {
    throw new Error(`Invalid ${label}; expected an RFC3339 timestamp`);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label}; expected an RFC3339 timestamp`);
  }
  return parsed;
}

export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const mapped: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") mapped[part.type] = part.value;
  }
  let hour = Number(mapped.hour);
  if (hour === 24) hour = 0;
  const weekday = WEEKDAY_INDEX[mapped.weekday];
  if (weekday === undefined) {
    throw new Error("Invalid timezone; expected an IANA timezone");
  }
  return {
    year: Number(mapped.year),
    month: Number(mapped.month),
    day: Number(mapped.day),
    hour,
    minute: Number(mapped.minute),
    second: Number(mapped.second),
    weekday,
  };
}

/**
 * Convert a civil wall-clock time in an IANA timezone to a UTC epoch.
 * A time that falls in a DST gap is pushed forward to the next existing instant.
 */
export function zonedWallTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetAt = (epochMs: number): number => {
    const parts = zonedParts(epochMs, timeZone);
    return (
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
      epochMs
    );
  };
  let candidate = desired - offsetAt(desired);
  candidate = desired - offsetAt(candidate);
  for (let step = 0; step < 4; step++) {
    const parts = zonedParts(candidate, timeZone);
    const wall = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    if (wall >= desired) return candidate;
    candidate += 60 * 60 * 1000;
  }
  return candidate;
}

/**
 * First slot at or after `scheduledAt`. Weekly and monthly schedules skip
 * `scheduledAt` when that civil day is not one of the requested days.
 * One-shot and daily schedules keep `scheduledAt`.
 */
export function firstOccurrence(spec: ScheduleSpec): number | null {
  if (spec.recurrence === "once" || spec.recurrence === "daily") {
    if (spec.endAt != null && spec.scheduledAt > spec.endAt) return null;
    return spec.scheduledAt;
  }
  if (matchesSlot(spec, spec.scheduledAt)) {
    if (spec.endAt != null && spec.scheduledAt > spec.endAt) return null;
    return spec.scheduledAt;
  }
  return nextOccurrence(spec, spec.scheduledAt);
}

/** Next occurrence strictly after `afterMs`. One-shot schedules have none. */
export function nextOccurrence(spec: ScheduleSpec, afterMs: number): number | null {
  if (spec.recurrence === "once") return null;
  const start = zonedParts(spec.scheduledAt, spec.timezone);
  const origin = zonedParts(afterMs, spec.timezone);
  let candidate: number | null = null;

  if (spec.recurrence === "daily") {
    for (let offset = 0; offset <= 2; offset++) {
      const date = addDays(origin.year, origin.month, origin.day, offset);
      const at = atWall(date, start, spec.timezone);
      if (at > afterMs) {
        candidate = at;
        break;
      }
    }
  } else if (spec.recurrence === "weekly") {
    for (let offset = 0; offset <= 7; offset++) {
      const date = addDays(origin.year, origin.month, origin.day, offset);
      if (!spec.weekdays.includes(weekdayOf(date.year, date.month, date.day))) continue;
      const at = atWall(date, start, spec.timezone);
      if (at > afterMs) {
        candidate = at;
        break;
      }
    }
  } else {
    const dayOfMonth = spec.dayOfMonth ?? start.day;
    for (let offset = 0; offset <= 24; offset++) {
      const month = addMonths(origin.year, origin.month, offset);
      const day = Math.min(dayOfMonth, daysInMonth(month.year, month.month));
      const at = atWall({ ...month, day }, start, spec.timezone);
      if (at > afterMs) {
        candidate = at;
        break;
      }
    }
  }

  if (candidate == null) return null;
  if (spec.endAt != null && candidate > spec.endAt) return null;
  return candidate;
}

export interface ScheduleRequestInput {
  scheduledAt: string;
  timezone?: string;
  recurrence?: Recurrence;
  weekdays?: number[];
  dayOfMonth?: number;
  endAt?: string;
  occurrenceLimit?: number;
}

export function parseScheduleRequest(input: ScheduleRequestInput, now: number): ParsedSchedule {
  const timezone = canonicalTimeZone(input.timezone ?? defaultTimeZone());
  if (!timezone) {
    throw new Error("Invalid timezone; expected an IANA timezone");
  }
  const scheduledAt = parseRfc3339(input.scheduledAt, "scheduledAt");
  if (scheduledAt <= now) {
    throw new Error("Invalid scheduledAt; it must be in the future");
  }
  if (scheduledAt > now + SCHEDULER_MAX_HORIZON_MS) {
    throw new Error("Invalid scheduledAt; it must be at most 1 year in the future");
  }
  const recurrence = input.recurrence ?? "once";
  if (!["once", "daily", "weekly", "monthly"].includes(recurrence)) {
    throw new Error("Invalid recurrence; expected once, daily, weekly, or monthly");
  }

  const weekdays = [...(input.weekdays ?? [])];
  if (recurrence === "weekly") {
    if (weekdays.length === 0) {
      throw new Error("Invalid weekdays; weekly recurrence requires unique values from 0 to 6");
    }
    const seen = new Set<number>();
    for (const day of weekdays) {
      if (!Number.isInteger(day) || day < 0 || day > 6 || seen.has(day)) {
        throw new Error("Invalid weekdays; weekly recurrence requires unique values from 0 to 6");
      }
      seen.add(day);
    }
  } else if (weekdays.length > 0) {
    throw new Error("Invalid weekdays; weekdays require weekly recurrence");
  }

  let dayOfMonth: number | null = null;
  if (recurrence === "monthly") {
    if (
      input.dayOfMonth === undefined ||
      !Number.isInteger(input.dayOfMonth) ||
      input.dayOfMonth < 1 ||
      input.dayOfMonth > 31
    ) {
      throw new Error("Invalid dayOfMonth; monthly recurrence requires a day from 1 to 31");
    }
    dayOfMonth = input.dayOfMonth;
  } else if (input.dayOfMonth !== undefined) {
    throw new Error("Invalid dayOfMonth; dayOfMonth requires monthly recurrence");
  }

  let endAt: number | null = null;
  if (input.endAt !== undefined && input.endAt.trim() !== "") {
    endAt = parseRfc3339(input.endAt, "endAt");
    if (endAt <= scheduledAt) {
      throw new Error("Invalid endAt; it must be after scheduledAt");
    }
  }

  let occurrenceLimit: number | null = null;
  if (input.occurrenceLimit !== undefined) {
    if (!Number.isInteger(input.occurrenceLimit) || input.occurrenceLimit < 1) {
      throw new Error("Invalid occurrenceLimit; expected a positive integer");
    }
    if (recurrence === "once" && input.occurrenceLimit > 1) {
      throw new Error("Invalid occurrenceLimit; one-time sends accept 1 or omit the limit");
    }
    occurrenceLimit = input.occurrenceLimit;
  }

  const weekdaysSorted = weekdays.sort((left, right) => left - right);
  const draft: ScheduleSpec = {
    scheduledAt,
    timezone,
    recurrence,
    weekdays: weekdaysSorted,
    dayOfMonth,
    endAt,
  };
  const nextRunAt = firstOccurrence(draft);
  if (nextRunAt == null) {
    throw new Error("Invalid schedule; no occurrence falls before endAt");
  }
  if (nextRunAt > now + SCHEDULER_MAX_HORIZON_MS) {
    throw new Error(
      "Invalid scheduledAt; the first occurrence must be at most 1 year in the future",
    );
  }

  return {
    ...draft,
    occurrenceLimit,
    nextRunAt,
  };
}

function matchesSlot(spec: ScheduleSpec, epochMs: number): boolean {
  const parts = zonedParts(epochMs, spec.timezone);
  if (spec.recurrence === "weekly") return spec.weekdays.includes(parts.weekday);
  const dayOfMonth = spec.dayOfMonth ?? parts.day;
  return parts.day === Math.min(dayOfMonth, daysInMonth(parts.year, parts.month));
}

function atWall(
  date: { year: number; month: number; day: number },
  start: ZonedParts,
  timeZone: string,
): number {
  return zonedWallTimeToEpoch(
    date.year,
    date.month,
    date.day,
    start.hour,
    start.minute,
    start.second,
    timeZone,
  );
}

function addDays(
  year: number,
  month: number,
  day: number,
  offset: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + offset));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function addMonths(year: number, month: number, offset: number): { year: number; month: number } {
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
