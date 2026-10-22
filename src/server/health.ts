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
