import { eventWebhookHealth, type EventWebhookStatus } from "../services/event-webhook-config.js";
import { PROXY_URL_ENV, redactProxyCredentials } from "../utils/proxy-redact.js";

export interface HealthInstanceCounts {
  total: number;
  connected: number;
  disconnected: number;
}

export interface HealthBody {
  status: "ok";
  uptime: number;
  instances: HealthInstanceCounts;
  version: string;
  webhook: ReturnType<typeof eventWebhookHealth>;
}

function redactHealthValue<T>(value: T, proxyUrl: string | undefined): T {
  if (typeof value === "string") return redactProxyCredentials(value, proxyUrl) as T;
  if (Array.isArray(value)) return value.map((item) => redactHealthValue(item, proxyUrl)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = redactHealthValue(child, proxyUrl);
    }
    return output as T;
  }
  return value;
}

/** JSON body for GET /health. Webhook fields and any proxy userinfo are redacted. */
export function buildHealthBody(input: {
  uptimeSeconds: number;
  instances: HealthInstanceCounts;
  version: string;
  webhook: EventWebhookStatus;
}): HealthBody {
  return redactHealthValue(
    {
      status: "ok",
      uptime: input.uptimeSeconds,
      instances: input.instances,
      version: input.version,
      webhook: eventWebhookHealth(input.webhook),
    },
    process.env[PROXY_URL_ENV],
  );
}

/** Serialized GET /health body. Proxy credentials are removed again at the boundary. */
export function renderHealthBody(body: HealthBody, proxyUrl = process.env[PROXY_URL_ENV]): string {
  return redactProxyCredentials(JSON.stringify(body), proxyUrl);
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
