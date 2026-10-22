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
