import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { baileysCredsArePaired, pairingRefusal } from "../src/channels/baileys/pairing-state.js";
import { DashboardEventLog } from "../src/server/dashboard-activity.js";
import {
  dashboardCredentialsMatch,
  parseBasicAuthorization,
} from "../src/server/dashboard-auth.js";
import {
  assertDashboardTransport,
  cloudWebhookFlags,
  loadDashboardConfig,
  type DashboardConfig,
} from "../src/server/dashboard-config.js";
import { dashboardPage } from "../src/server/dashboard-page.js";
import { renderQrDataUrl } from "../src/server/dashboard-qr.js";
import {
  createDashboardHandler,
  type DashboardHandler,
  type DashboardInstances,
} from "../src/server/dashboard.js";
import type { EventWebhookDestination } from "../src/services/event-webhook-config.js";
import {
  clearRecentWebhookDeliveries,
  getRecentWebhookDeliveries,
  noteWebhookJobOutcome,
} from "../src/services/event-webhook.js";
import type { InstanceLifecycleStatusSnapshot } from "../src/services/instance-manager.js";

const SECRET_URL = "https://hooks.example.test/super-secret-webhook-url-9f3a";
const SECRET_TOKEN = "fixture-token-9f3a";
const QR_SECRET = "QR-SECRET-MARKER-9f3a";
const PAIR_SECRET = "PAIR-SECRET-MARKER-9f3a";

const users = [{ username: "ops", password: "correct-horse" }];

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function snapshot(
  overrides: Partial<InstanceLifecycleStatusSnapshot> = {},
): InstanceLifecycleStatusSnapshot {
  return {
    instanceId: "inst_aabbccdd",
    name: "desk",
    channel: "baileys",
    state: "disconnected",
    phone: null,
    lid: null,
    pushName: null,
    lastConnectedAt: 1_700_000_000_000,
    lastDisconnectedAt: 1_700_000_100_000,
    disconnectReason: "connection lost",
    disconnectStatusCode: 408,
    pendingChallenge: null,
    presenceMode: "on_activity",
    ...overrides,
  };
}

function handlerFor(input: {
  enabled?: boolean;
  rows?: InstanceLifecycleStatusSnapshot[];
  isPaired?: (instanceId: string) => boolean;
  calls?: string[];
  onConnect?: (instanceId: string) => void;
  adapter?: {
    getStatus: () => string;
    getQrCode: () => Promise<string | null>;
    getPairingCode: (phone: string) => Promise<string | null>;
  };
  events?: DashboardEventLog;
}): { handle: DashboardHandler; calls: string[] } {
  const calls = input.calls ?? [];
  const rows = input.rows ?? [snapshot()];
  const instances: DashboardInstances = {
    getInstanceLifecycleStatuses(id?: string) {
      if (!id) return rows;
      const row = rows.find((item) => item.instanceId === id);
      if (!row) throw new Error(`Instance ${id} not found`);
      return [row];
    },
    async createInstance(name, channel) {
      calls.push(`create:${name}:${channel ?? "baileys"}`);
      const created = snapshot({
        instanceId: "inst_11223344",
        name,
        channel: channel ?? "baileys",
        state: "disconnected",
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        disconnectReason: null,
        disconnectStatusCode: null,
      });
      rows.push(created);
      return { id: created.instanceId };
    },
    async connectInstance(id) {
      calls.push(`connect:${id}`);
      input.onConnect?.(id);
      const row = rows.find((item) => item.instanceId === id);
      if (row && row.state === "disconnected") row.state = "qr_pending";
    },
    getAdapter(id) {
      calls.push(`adapter:${id}`);
      return (
        input.adapter ?? {
          getStatus: () => rows.find((item) => item.instanceId === id)?.state ?? "disconnected",
          async getQrCode() {
            calls.push(`qr:${id}`);
            return QR_SECRET;
          },
          async getPairingCode(phone: string) {
            calls.push(`code:${id}:${phone}`);
            return "ABCD-1234";
          },
        }
      );
    },
  };
  const config: DashboardConfig = {
    enabled: input.enabled ?? true,
    users,
  };
  return {
    calls,
    handle: createDashboardHandler({
      config,
      startedAt: 1_000,
      instances,
      isPaired: input.isPaired ?? (() => false),
      webhookStatus: () => ({
        configured: true,
        destinationCount: 1,
        eventCount: 2,
        authConfigured: true,
        warnings: ["preset_dropped_events"],
        droppedEvents: ["message.reaction"],
      }),
      deliveries: getRecentWebhookDeliveries,
      events: input.events ?? new DashboardEventLog(),
      cloudWebhook: () =>
        cloudWebhookFlags({
          WA_CLOUD_VERIFY_TOKEN: SECRET_TOKEN,
          WA_CLOUD_WEBHOOK_SECRET: SECRET_URL,
        }),
      renderQr: async (text) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`,
      version: "2.0.0",
      now: () => 6_000,
    }),
  };
}

async function listen(handle: DashboardHandler): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handle(req, res, url).then((handled) => {
      if (handled || res.headersSent) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("dashboard configuration", () => {
  it("stays off by default and does not require users", () => {
    expect(loadDashboardConfig({})).toEqual({ enabled: false, users: [] });
  });

  it("requires users when enabled and rejects invalid values", () => {
    expect(() => loadDashboardConfig({ WA_DASHBOARD_ENABLED: "true" })).toThrow(
      /WA_DASHBOARD_USERS is required/,
    );
    expect(() => loadDashboardConfig({ WA_DASHBOARD_ENABLED: "yes" })).toThrow(
      /Invalid WA_DASHBOARD_ENABLED/,
    );
    expect(() => loadDashboardConfig({ WA_DASHBOARD_USERS: "ops" })).toThrow(
      /Invalid WA_DASHBOARD_USERS/,
    );
    expect(() => loadDashboardConfig({ WA_DASHBOARD_USERS: "ops:" })).toThrow(
      /Invalid WA_DASHBOARD_USERS/,
    );
    expect(() =>
      loadDashboardConfig({ WA_DASHBOARD_USERS: "ops:one,ops:two" }),
    ).toThrow(/usernames must be unique/);
  });

  it("parses one or more user:password entries", () => {
    const config = loadDashboardConfig({
      WA_DASHBOARD_ENABLED: "true",
      WA_DASHBOARD_USERS: "ops:correct-horse,night:pass:word",
    });
    expect(config.enabled).toBe(true);
    expect(config.users).toEqual([
      { username: "ops", password: "correct-horse" },
      { username: "night", password: "pass:word" },
    ]);
    expect(
      assertDashboardTransport(config, "http"),
    ).toBeUndefined();
    expect(() => assertDashboardTransport(config, "stdio")).toThrow(/requires WA_TRANSPORT=http/);
  });

  it("reports cloud webhook configuration without the secret values", () => {
    const flags = cloudWebhookFlags({
      WA_CLOUD_VERIFY_TOKEN: SECRET_TOKEN,
      WA_CLOUD_WEBHOOK_SECRET: SECRET_URL,
    });
    expect(flags).toEqual({ verifyTokenConfigured: true, signatureSecretConfigured: true });
    expect(JSON.stringify(flags)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(flags)).not.toContain(SECRET_URL);
  });
});

describe("dashboard credentials", () => {
  it("accepts only a matching basic user", () => {
    const parsed = parseBasicAuthorization(basic("ops", "correct-horse"));
    expect(parsed).toEqual({ username: "ops", password: "correct-horse" });
    expect(dashboardCredentialsMatch(users, "ops", "correct-horse")).toBe(true);
    expect(dashboardCredentialsMatch(users, "ops", "wrong-horse")).toBe(false);
    expect(dashboardCredentialsMatch(users, "other", "correct-horse")).toBe(false);
    expect(parseBasicAuthorization("Bearer correct-horse")).toBeNull();
  });
});

describe("pairing safety", () => {
  it("treats registered creds as paired and unreadable creds as closed", () => {
    expect(baileysCredsArePaired(null)).toBe(false);
    expect(baileysCredsArePaired('{"registered":false}')).toBe(false);
    expect(baileysCredsArePaired('{"registered":true,"me":{"id":"15551212@s.whatsapp.net"}}')).toBe(
      true,
    );
    expect(baileysCredsArePaired("not-json")).toBe(true);
    expect(baileysCredsArePaired("[]")).toBe(true);
  });

  it("allows pairing only for an unpaired Baileys instance that is not connected", () => {
    expect(pairingRefusal({ channel: "baileys", state: "disconnected", paired: false })).toBeNull();
    expect(pairingRefusal({ channel: "baileys", state: "qr_pending", paired: false })).toBeNull();
    expect(pairingRefusal({ channel: "baileys", state: "disconnected", paired: true })).toBe(
      "paired",
    );
    expect(pairingRefusal({ channel: "baileys", state: "connected", paired: false })).toBe(
      "paired",
    );
    expect(pairingRefusal({ channel: "cloud", state: "disconnected", paired: false })).toBe(
      "channel",
    );
  });
});

describe("dashboard activity", () => {
  it("keeps connection status and drops QR and pairing secrets", () => {
    const log = new DashboardEventLog();
    log.record("connection.changed", "inst_aabbccdd", {
      status: "connecting",
      qrCode: QR_SECRET,
      pairingCode: PAIR_SECRET,
    });
    log.record("message.received", "inst_aabbccdd", {
      text: SECRET_TOKEN,
      mediaUrl: SECRET_URL,
    });
    const serialized = JSON.stringify(log.list());
    expect(serialized).toContain("connecting");
    expect(serialized).toContain("recorded");
    expect(serialized).not.toContain(QR_SECRET);
    expect(serialized).not.toContain(PAIR_SECRET);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(SECRET_URL);
  });
});

describe("webhook delivery activity", () => {
  afterEach(() => {
    clearRecentWebhookDeliveries();
  });

  it("records outcome metadata and omits urls, tokens, and message text", () => {
    const destination: EventWebhookDestination = {
      id: "owner-routine",
      url: SECRET_URL,
      headers: { Authorization: SECRET_TOKEN },
      secret: SECRET_TOKEN,
      events: ["message.received"],
      ignoreFromMe: true,
      debounceMs: 0,
    };
    noteWebhookJobOutcome(
      "failed",
      {
        attemptsMade: 2,
        data: {
          destinationId: "owner-routine",
          payload: { event: "message.received", text: SECRET_TOKEN, mediaUrl: SECRET_URL },
        },
      },
      Object.assign(new Error(`delivery to ${SECRET_URL} failed`), {
        httpStatus: 503,
        errorCode: "ECONNRESET",
      }),
      destination,
    );
    noteWebhookJobOutcome("delivered", {
      attemptsMade: 1,
      data: { destinationId: SECRET_URL, payload: { events: [{ text: SECRET_TOKEN }] } },
    });

    const deliveries = getRecentWebhookDeliveries();
    const serialized = JSON.stringify(deliveries);
    expect(deliveries[0]).toMatchObject({
      destinationId: "destination",
      event: "batch",
      outcome: "delivered",
    });
    expect(deliveries[1]).toMatchObject({
      destinationId: "owner-routine",
      event: "message.received",
      outcome: "failed",
      attempt: 2,
      httpStatus: 503,
      errorCode: "ECONNRESET",
    });
    expect(serialized).not.toContain(SECRET_URL);
    expect(serialized).not.toContain(SECRET_TOKEN);
  });
});

describe("dashboard HTTP", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    clearRecentWebhookDeliveries();
    await close?.();
    close = undefined;
  });

  async function serve(handle: DashboardHandler): Promise<string> {
    const server = await listen(handle);
    close = server.close;
    return server.base;
  }

  it("does not expose the route when disabled", async () => {
    const { handle, calls } = handlerFor({ enabled: false });
    const base = await serve(handle);
    const response = await fetch(`${base}/dashboard`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(response.headers.get("www-authenticate")).toBeNull();
    const overview = await fetch(`${base}/dashboard/api/overview`);
    expect(overview.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("returns 401 without a matching login", async () => {
    const { handle } = handlerFor({});
    const base = await serve(handle);
    const missing = await fetch(`${base}/dashboard/api/overview`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Basic");
    expect(await missing.json()).toEqual({ error: "Unauthorized" });
    const wrong = await fetch(`${base}/dashboard`, {
      headers: { Authorization: basic("ops", "wrong-horse") },
    });
    expect(wrong.status).toBe(401);
    const wrongBody = await wrong.text();
    expect(wrongBody).toBe('{"error":"Unauthorized"}');
    expect(wrongBody).not.toContain("desk");
    expect(wrongBody).not.toContain("wrong-horse");
  });

  it("shows redacted status and an in-progress QR only for an unpaired instance", async () => {
    const events = new DashboardEventLog();
    events.record("connection.changed", "inst_aabbccdd", {
      status: "open",
      qrCode: QR_SECRET,
    });
    const rows = [
      snapshot({ state: "qr_pending" }),
      snapshot({
        instanceId: "inst_ff00ff00",
        name: "already",
        state: "connected",
        phone: "15550001111@s.whatsapp.net",
      }),
    ];
    const { handle, calls } = handlerFor({
      rows,
      events,
      isPaired: (id) => id === "inst_ff00ff00",
    });
    noteWebhookJobOutcome("delivered", {
      attemptsMade: 1,
      data: { destinationId: "owner-routine", payload: { event: "instance.connected", text: SECRET_TOKEN } },
    });
    const base = await serve(handle);
    const page = await fetch(`${base}/dashboard`, {
      headers: { Authorization: basic("ops", "correct-horse") },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Read-only");
    expect(html).not.toContain("/api/send");
    expect(html).not.toContain(SECRET_URL);

    const response = await fetch(`${base}/dashboard/api/overview`, {
      headers: { Authorization: basic("ops", "correct-horse") },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      uptimeSeconds: number;
      health: { connected: number; qrPending: number };
      instances: Array<{ instanceId: string; paired: boolean; qrImage: string | null; phone: string | null }>;
      webhook: { droppedEvents: string[]; authConfigured: boolean; deliveries: unknown[]; cloud: unknown };
      events: unknown[];
    };
    const serialized = JSON.stringify(body);
    expect(body.uptimeSeconds).toBe(5);
    expect(body.health).toMatchObject({ connected: 1, qrPending: 1 });
    expect(body.instances.find((item) => item.instanceId === "inst_aabbccdd")).toMatchObject({
      paired: false,
      qrImage: expect.stringContaining(encodeURIComponent(QR_SECRET)),
    });
    expect(body.instances.find((item) => item.instanceId === "inst_ff00ff00")).toMatchObject({
      paired: true,
      qrImage: null,
      phone: "15550001111@s.whatsapp.net",
    });
    expect(body.webhook.droppedEvents).toEqual(["message.reaction"]);
    expect(body.webhook.authConfigured).toBe(true);
    expect(body.webhook.cloud).toEqual({
      verifyTokenConfigured: true,
      signatureSecretConfigured: true,
    });
    expect(serialized).not.toContain(SECRET_URL);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(PAIR_SECRET);
    expect(JSON.stringify(body.events)).not.toContain(QR_SECRET);
    expect(calls.some((call) => call.includes("inst_ff00ff00"))).toBe(false);
  });

  it("does not connect or read a QR for an already paired instance", async () => {
    const { handle, calls } = handlerFor({ isPaired: () => true });
    const base = await serve(handle);
    const response = await fetch(`${base}/dashboard/api/instances/inst_aabbccdd/pairing`, {
      method: "POST",
      headers: {
        Authorization: basic("ops", "correct-horse"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phone: "+1 (555) 123-4567" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This instance is already paired" });
    expect(calls).toEqual([]);
  });

  it("stops before requesting a code when pairing discovers an existing session", async () => {
    let paired = false;
    const { handle, calls } = handlerFor({
      isPaired: () => paired,
      onConnect: () => {
        paired = true;
      },
    });
    const base = await serve(handle);
    const response = await fetch(`${base}/dashboard/api/instances/inst_aabbccdd/pairing`, {
      method: "POST",
      headers: {
        Authorization: basic("ops", "correct-horse"),
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(409);
    expect(calls).toEqual(["connect:inst_aabbccdd"]);
    expect(calls.some((call) => call.startsWith("code:") || call.startsWith("qr:"))).toBe(false);
  });

  it("starts pairing for a new instance and an unpaired existing instance", async () => {
    const { handle, calls } = handlerFor({});
    const base = await serve(handle);
    const created = await fetch(`${base}/dashboard/api/pairing`, {
      method: "POST",
      headers: {
        Authorization: basic("ops", "correct-horse"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Front desk", phone: "+1 (555) 123-4567" }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { instanceId: string; pairingCode: string };
    expect(createdBody.instanceId).toBe("inst_11223344");
    expect(createdBody.pairingCode).toBe("ABCD-1234");
    expect(calls).toContain("create:Front desk:baileys");
    expect(calls).toContain("connect:inst_11223344");
    expect(calls).toContain("code:inst_11223344:15551234567");
    expect(calls.some((call) => call.includes("inst_aabbccdd") && call.startsWith("connect"))).toBe(
      false,
    );

    const existing = await fetch(`${base}/dashboard/api/instances/inst_aabbccdd/pairing`, {
      method: "POST",
      headers: {
        Authorization: basic("ops", "correct-horse"),
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(existing.status).toBe(200);
    expect(calls).toContain("connect:inst_aabbccdd");
    expect(calls).not.toContain("code:inst_aabbccdd:15551234567");
  });

  it("rejects cloud instances and bad ids without connecting", async () => {
    const { handle, calls } = handlerFor({
      rows: [snapshot({ channel: "cloud", state: "disconnected" })],
    });
    const base = await serve(handle);
    const cloud = await fetch(`${base}/dashboard/api/instances/inst_aabbccdd/pairing`, {
      method: "POST",
      headers: {
        Authorization: basic("ops", "correct-horse"),
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(cloud.status).toBe(400);
    const badId = await fetch(`${base}/dashboard/api/instances/not-an-id/pairing`, {
      method: "POST",
      headers: {
        Authorization: basic("ops", "correct-horse"),
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(badId.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("dashboard QR rendering", () => {
  it("returns an svg data url that does not embed the payload as text", async () => {
    const image = await renderQrDataUrl("pairing-marker-9f3a");
    expect(image?.startsWith("data:image/svg+xml")).toBe(true);
    const svg = decodeURIComponent(image?.split(",", 2)[1] ?? "");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("pairing-marker-9f3a");
    expect(svg).not.toContain("<script");
  });
});

describe("dashboard source boundaries", () => {
  it("does not send messages or relocate stored auth", () => {
    const source = [
      "src/server/dashboard.ts",
      "src/server/dashboard-page.ts",
      "src/server/dashboard-config.ts",
      "src/server/dashboard-auth.ts",
      "src/channels/baileys/pairing-state.ts",
    ]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(source).not.toContain("enqueueMessage");
    expect(source).not.toContain("sendMessage");
    expect(source).not.toContain("clearAuthState");
    expect(source).not.toContain("deleteInstance");
    expect(source).not.toContain("WA_DATABASE_PATH");
    expect(dashboardPage()).not.toContain("/api/send");
  });
});
