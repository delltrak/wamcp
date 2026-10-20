// ============================================================
// WA MCP — Redacted dashboard activity
// Recent channel events for the operations page. Payloads are not copied.
// ============================================================

const MAX_EVENTS = 50;
const SAFE_EVENT = /^[a-z][a-z0-9._-]{0,63}$/i;
const INSTANCE_RE = /^inst_[0-9a-f]{8}$/;
const SAFE_REASON = /^[A-Za-z0-9 .:_-]{1,80}$/;

export interface DashboardActivityEntry {
  at: number;
  instanceId: string;
  event: string;
  detail: string;
}

function detailFor(event: string, payload: unknown): string {
  if (!payload || typeof payload !== "object") return "recorded";
  const record = payload as Record<string, unknown>;
  if (event === "connection.changed") {
    return record.status === "open" || record.status === "close" || record.status === "connecting"
      ? record.status
      : "updated";
  }
  if (event === "instance.disconnected") {
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (SAFE_REASON.test(reason) && !/https?:/i.test(reason)) return reason;
    return "disconnected";
  }
  if (event === "instance.connected") return "connected";
  if (event === "instance.qr_generated" || event === "instance.pairing_code_generated") {
    return "challenge";
  }
  if (event === "instance.qr_expired" || event === "instance.pairing_expired") {
    return "challenge expired";
  }
  return "recorded";
}

export class DashboardEventLog {
  private readonly entries: DashboardActivityEntry[] = [];

  record(event: string, instanceId: string, payload: unknown, at = Date.now()): void {
    this.entries.unshift({
      at,
      instanceId: INSTANCE_RE.test(instanceId) ? instanceId : "instance",
      event: SAFE_EVENT.test(event) ? event : "event",
      detail: detailFor(SAFE_EVENT.test(event) ? event : "event", payload),
    });
    if (this.entries.length > MAX_EVENTS) this.entries.length = MAX_EVENTS;
  }

  list(): DashboardActivityEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}
