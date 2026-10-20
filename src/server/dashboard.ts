// ============================================================
// WA MCP — Operations dashboard
// Served by the existing HTTP server. Disabled unless
// WA_DASHBOARD_ENABLED=true and WA_DASHBOARD_USERS is set.
// Read-only except starting pairing for an unpaired Baileys instance.
// ============================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import { pairingRefusal } from "../channels/baileys/pairing-state.js";
import type { InstanceLifecycleStatusSnapshot } from "../services/instance-manager.js";
import { createChildLogger } from "../utils/logger.js";
import { DashboardEventLog } from "./dashboard-activity.js";
import { dashboardCredentialsMatch, parseBasicAuthorization } from "./dashboard-auth.js";
import type { CloudWebhookFlags, DashboardConfig } from "./dashboard-config.js";
import { dashboardPage } from "./dashboard-page.js";

const logger = createChildLogger({ service: "dashboard" });

const JSON_LIMIT = 4096;
const INSTANCE_ID_RE = /^inst_[0-9a-f]{8}$/;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
const SAFE_EVENT = /^[a-z][a-z0-9._-]{0,63}$/i;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,80}$/;
const SAFE_WARNING = /^[a-z0-9_]{1,64}$/;

class DashboardHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "DashboardHttpError";
    this.statusCode = statusCode;
  }
}

export interface DashboardAdapter {
  getStatus(): string;
  getQrCode(): Promise<string | null>;
  getPairingCode(phone: string): Promise<string | null>;
}

export interface DashboardInstances {
  getInstanceLifecycleStatuses(id?: string): InstanceLifecycleStatusSnapshot[];
  createInstance(name: string, channel?: "baileys" | "cloud"): Promise<{ id: string }>;
  connectInstance(id: string): Promise<void>;
  getAdapter(id: string): DashboardAdapter;
}

export interface DashboardDelivery {
  at: number;
  destinationId: string;
  event: string;
  outcome: "delivered" | "failed";
  attempt: number | null;
  httpStatus: number | null;
  errorCode: string | null;
}

export interface DashboardWebhookStatus {
  configured: boolean;
  destinationCount: number;
  eventCount: number;
  authConfigured: boolean;
  warnings: readonly string[];
  droppedEvents: readonly string[];
}

export interface DashboardHandlerOptions {
  config: DashboardConfig;
  startedAt: number;
  instances: DashboardInstances;
  isPaired: (instanceId: string) => boolean;
  webhookStatus: () => DashboardWebhookStatus;
  deliveries: () => readonly DashboardDelivery[];
  events: DashboardEventLog;
  cloudWebhook: () => CloudWebhookFlags;
  renderQr: (text: string) => Promise<string | null>;
  version: string;
  now?: () => number;
}

export type DashboardHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<boolean>;

function iso(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function publicLabel(value: string | null | undefined, max = 160): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max || /[\r\n]/.test(trimmed)) return null;
  if (/https?:\/\//i.test(trimmed) || /(?:bearer|basic)\s+\S+/i.test(trimmed)) return null;
  return trimmed;
}

function publicPhone(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{5,20}(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(value)) return value;
  if (/^\d{8,15}$/.test(value)) return value;
  return null;
}

function isDashboardPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...extraHeaders,
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(html);
}

function unauthorized(res: ServerResponse): void {
  sendJson(
    res,
    401,
    { error: "Unauthorized" },
    {
      "WWW-Authenticate": 'Basic realm="wa-mcp-dashboard", charset="UTF-8"',
    },
  );
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > JSON_LIMIT) throw new DashboardHttpError(413, "Payload too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (body.length === 0) return {};
  const contentType = req.headers["content-type"];
  const mediaType = typeof contentType === "string" ? contentType.split(";")[0]?.trim() : "";
  if (mediaType.toLowerCase() !== "application/json") {
    throw new DashboardHttpError(415, "Content-Type must be application/json");
  }
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DashboardHttpError(400, "Expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof DashboardHttpError) throw err;
    throw new DashboardHttpError(400, "Invalid JSON");
  }
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || !NAME_RE.test(value.trim())) {
    throw new DashboardHttpError(400, "Instance name must be 1 to 64 characters");
  }
  return value.trim();
}

function normalizeOptionalPhone(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new DashboardHttpError(400, "Phone number must be 8 to 15 digits");
  }
  const digits = value.trim().replace(/[+\s().-]/g, "");
  if (!/^\d{8,15}$/.test(digits)) {
    throw new DashboardHttpError(400, "Phone number must be 8 to 15 digits");
  }
  return digits;
}

export function createDashboardHandler(options: DashboardHandlerOptions): DashboardHandler {
  const locks = new Set<string>();
  const now = (): number => options.now?.() ?? Date.now();

  function readSnapshot(instanceId: string): InstanceLifecycleStatusSnapshot {
    try {
      const row = options.instances.getInstanceLifecycleStatuses(instanceId)[0];
      if (!row) throw new DashboardHttpError(404, "Instance not found");
      return row;
    } catch (err) {
      if (err instanceof DashboardHttpError) throw err;
      if (err instanceof Error && /not found/i.test(err.message)) {
        throw new DashboardHttpError(404, "Instance not found");
      }
      throw err;
    }
  }

  async function safeQr(value: string): Promise<string | null> {
    try {
      const image = await options.renderQr(value);
      if (typeof image !== "string" || !image.startsWith("data:image/svg+xml")) return null;
      return image;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.name : "Error" }, "Dashboard QR render failed");
      return null;
    }
  }

  async function qrForUnpaired(row: InstanceLifecycleStatusSnapshot): Promise<string | null> {
    const storedPaired = options.isPaired(row.instanceId);
    const allowed =
      pairingRefusal({ channel: row.channel, state: row.state, paired: storedPaired }) === null;
    if (!allowed || (row.state !== "qr_pending" && row.state !== "connecting")) return null;
    try {
      const adapter = options.instances.getAdapter(row.instanceId);
      if (adapter.getStatus() === "connected" || options.isPaired(row.instanceId)) return null;
      const qr = await adapter.getQrCode();
      return qr ? await safeQr(qr) : null;
    } catch (err) {
      logger.warn(
        { instanceId: row.instanceId, err: err instanceof Error ? err.name : "Error" },
        "Dashboard QR unavailable",
      );
      return null;
    }
  }

  async function overview(): Promise<Record<string, unknown>> {
    const rows = options.instances.getInstanceLifecycleStatuses();
    const instances = [];
    for (const row of rows) {
      const storedPaired = options.isPaired(row.instanceId);
      const paired = storedPaired || row.state === "connected";
      const pending = row.pendingChallenge;
      instances.push({
        instanceId: row.instanceId,
        name: row.name,
        channel: row.channel,
        state: row.state,
        paired,
        phone: paired ? publicPhone(row.phone) : null,
        lastConnected: iso(row.lastConnectedAt),
        lastDisconnected: iso(row.lastDisconnectedAt),
        disconnectReason: publicLabel(row.disconnectReason),
        disconnectStatusCode:
          typeof row.disconnectStatusCode === "number" && Number.isFinite(row.disconnectStatusCode)
            ? row.disconnectStatusCode
            : null,
        pendingPairing: {
          status:
            pending?.method === "qr" || pending?.method === "pairing_code"
              ? pending.method
              : "none",
          generatedAt: iso(pending?.generatedAt),
          expiresAt: iso(pending?.expiresAt),
        },
        pairingAvailable:
          pairingRefusal({
            channel: row.channel,
            state: row.state,
            paired: storedPaired,
          }) === null,
        qrImage: await qrForUnpaired(row),
      });
    }
    const webhook = options.webhookStatus();
    const cloud = options.cloudWebhook();
    return {
      version: options.version,
      uptimeSeconds: Math.max(0, Math.floor((now() - options.startedAt) / 1000)),
      health: {
        total: rows.length,
        connected: rows.filter((row) => row.state === "connected").length,
        disconnected: rows.filter((row) => row.state === "disconnected").length,
        connecting: rows.filter((row) => row.state === "connecting").length,
        qrPending: rows.filter((row) => row.state === "qr_pending").length,
      },
      instances,
      webhook: {
        configured: webhook.configured,
        destinationCount: webhook.destinationCount,
        eventCount: webhook.eventCount,
        authConfigured: webhook.authConfigured,
        warnings: webhook.warnings.filter((warning) => SAFE_WARNING.test(warning)),
        droppedEvents: webhook.droppedEvents.filter((event) => SAFE_EVENT.test(event)),
        cloud: {
          verifyTokenConfigured: cloud.verifyTokenConfigured,
          signatureSecretConfigured: cloud.signatureSecretConfigured,
        },
        deliveries: options
          .deliveries()
          .slice(0, 30)
          .flatMap((delivery) => {
            if (delivery.outcome !== "delivered" && delivery.outcome !== "failed") return [];
            return [
              {
                at: iso(delivery.at),
                destinationId: SAFE_ID.test(delivery.destinationId)
                  ? delivery.destinationId
                  : "destination",
                event: SAFE_EVENT.test(delivery.event) ? delivery.event : "event",
                outcome: delivery.outcome,
                attempt: delivery.attempt,
                httpStatus: delivery.httpStatus,
                errorCode:
                  delivery.errorCode && SAFE_CODE.test(delivery.errorCode)
                    ? delivery.errorCode
                    : null,
              },
            ];
          }),
      },
      events: options.events.list().map((entry) => ({
        at: iso(entry.at),
        instanceId: entry.instanceId,
        event: entry.event,
        detail: entry.detail,
      })),
    };
  }

  async function startPairing(
    instanceId: string,
    phone?: string,
  ): Promise<Record<string, unknown>> {
    if (locks.has(instanceId)) throw new DashboardHttpError(429, "Pairing is already starting");
    locks.add(instanceId);
    try {
      const snapshot = readSnapshot(instanceId);
      const refusal = pairingRefusal({
        channel: snapshot.channel,
        state: snapshot.state,
        paired: options.isPaired(instanceId),
      });
      if (refusal === "channel") {
        throw new DashboardHttpError(400, "Pairing is only available for a new Baileys instance");
      }
      if (refusal === "paired") {
        throw new DashboardHttpError(409, "This instance is already paired");
      }
      if (snapshot.state !== "connecting" && snapshot.state !== "qr_pending") {
        if (
          pairingRefusal({
            channel: snapshot.channel,
            state: snapshot.state,
            paired: options.isPaired(instanceId),
          })
        ) {
          throw new DashboardHttpError(409, "This instance is already paired");
        }
        await options.instances.connectInstance(instanceId);
      }
      const current = readSnapshot(instanceId);
      if (
        pairingRefusal({
          channel: current.channel,
          state: current.state,
          paired: options.isPaired(instanceId),
        }) ||
        options.isPaired(instanceId)
      ) {
        throw new DashboardHttpError(409, "This instance is already paired");
      }
      const adapter = options.instances.getAdapter(instanceId);
      if (adapter.getStatus() === "connected" || options.isPaired(instanceId)) {
        throw new DashboardHttpError(409, "This instance is already paired");
      }
      const pairingCode = phone ? await adapter.getPairingCode(phone) : null;
      if (adapter.getStatus() === "connected" || options.isPaired(instanceId)) {
        throw new DashboardHttpError(409, "This instance is already paired");
      }
      const qr = await adapter.getQrCode();
      logger.info({ instanceId }, "Dashboard pairing started");
      return {
        instanceId,
        state: adapter.getStatus(),
        paired: false,
        qrImage: qr ? await safeQr(qr) : null,
        pairingCode,
      };
    } catch (err) {
      if (err instanceof DashboardHttpError) throw err;
      logger.error({ err, instanceId }, "Dashboard pairing failed");
      throw new DashboardHttpError(500, "Unable to start pairing");
    } finally {
      locks.delete(instanceId);
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if ((path === "/dashboard" || path === "/dashboard/") && req.method === "GET") {
      sendHtml(res, dashboardPage());
      return;
    }
    if (path === "/dashboard/api/overview" && req.method === "GET") {
      sendJson(res, 200, await overview());
      return;
    }
    if (path === "/dashboard/api/pairing" && req.method === "POST") {
      const body = await readJson(req);
      const name = normalizeName(body.name);
      const phone = normalizeOptionalPhone(body.phone);
      let created: { id: string };
      try {
        created = await options.instances.createInstance(name, "baileys");
      } catch (err) {
        if (err instanceof DashboardHttpError) throw err;
        logger.error({ err }, "Dashboard instance creation failed");
        throw new DashboardHttpError(500, "Unable to start pairing");
      }
      sendJson(res, 200, await startPairing(created.id, phone));
      return;
    }
    const pairingMatch = /^\/dashboard\/api\/instances\/([^/]+)\/pairing$/.exec(path);
    if (pairingMatch && req.method === "POST") {
      const instanceId = decodeURIComponent(pairingMatch[1] ?? "");
      if (!INSTANCE_ID_RE.test(instanceId)) {
        throw new DashboardHttpError(400, "Invalid instance id");
      }
      const body = await readJson(req);
      sendJson(res, 200, await startPairing(instanceId, normalizeOptionalPhone(body.phone)));
      return;
    }
    if (
      path === "/dashboard" ||
      path === "/dashboard/" ||
      path === "/dashboard/api/overview" ||
      path === "/dashboard/api/pairing" ||
      pairingMatch
    ) {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  }

  return async (req, res, url) => {
    if (!options.config.enabled || !isDashboardPath(url.pathname)) return false;
    try {
      const header = req.headers.authorization;
      const parsed = typeof header === "string" ? parseBasicAuthorization(header) : null;
      const allowed =
        options.config.users.length > 0 &&
        parsed !== null &&
        dashboardCredentialsMatch(options.config.users, parsed.username, parsed.password);
      if (!allowed) {
        unauthorized(res);
        return true;
      }
      await route(req, res, url);
    } catch (err) {
      const httpError = err instanceof DashboardHttpError ? err : null;
      if (!httpError) logger.error({ err }, "Dashboard request failed");
      if (!res.headersSent) {
        sendJson(res, httpError?.statusCode ?? 500, {
          error: httpError?.message ?? "Dashboard request failed",
        });
      }
    }
    return true;
  };
}
