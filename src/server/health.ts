import { eventWebhookHealth, type EventWebhookStatus } from "../services/event-webhook-config.js";

export interface HealthInstanceCounts {
  total: number;
  connected: number;
  disconnected: number;
}

/** JSON body for GET /health. Webhook fields are the redacted status summary. */
export function buildHealthBody(input: {
  uptimeSeconds: number;
  instances: HealthInstanceCounts;
  version: string;
  webhook: EventWebhookStatus;
}): {
  status: "ok";
  uptime: number;
  instances: HealthInstanceCounts;
  version: string;
  webhook: ReturnType<typeof eventWebhookHealth>;
} {
  return {
    status: "ok",
    uptime: input.uptimeSeconds,
    instances: input.instances,
    version: input.version,
    webhook: eventWebhookHealth(input.webhook),
  };
}

/** True when a failure comes from SQLite, Postgres, or the connection to either. */
export function isDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("cause" in error && isDatabaseError(error.cause)) return true;
  const code = "code" in error && error.code != null ? String(error.code) : "";
  if (/^SQLITE_/.test(code) || /^[0-9A-Z]{5}$/.test(code)) return true;
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE"
  ) {
    return true;
  }
  const name = "name" in error ? String(error.name) : "";
  if (name === "SqliteError" || name === "DatabaseError") return true;
  const message = error instanceof Error ? error.message : "";
  return /timeout expired|query read timeout|timeout exceeded when trying to connect|connection terminated|server closed the connection|database system is/i.test(
    message,
  );
}
