import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
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
  dashboardClientKey,
  dashboardOriginAllowed,
  pruneLoginBuckets,
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
  mountPath?: string;
  maxLoginFailures?: number;
  loginWindowMs?: number;
  loginProbeIntervalMs?: number;
  maxComparisonsPerMinute?: number;
  clientAddress?: (req: IncomingMessage) => string;
  users?: DashboardConfig["users"];
  matchCredentials?: (
    users: DashboardConfig["users"],
    username: string,
    password: string,
  ) => boolean;
  now?: () => number;
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
    users: input.users ?? users,
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
      ...(input.mountPath ? { mountPath: input.mountPath } : {}),
      ...(input.maxLoginFailures ? { maxLoginFailures: input.maxLoginFailures } : {}),
      ...(input.loginWindowMs ? { loginWindowMs: input.loginWindowMs } : {}),
      ...(input.loginProbeIntervalMs ? { loginProbeIntervalMs: input.loginProbeIntervalMs } : {}),
      ...(input.maxComparisonsPerMinute
        ? { maxComparisonsPerMinute: input.maxComparisonsPerMinute }
        : {}),
      ...(input.clientAddress ? { clientAddress: input.clientAddress } : {}),
      ...(input.matchCredentials ? { matchCredentials: input.matchCredentials } : {}),
      now: input.now ?? (() => 6_000),
    }),
  };
}

async function dashboardStatus(
  handle: DashboardHandler,
  headers: Record<string, string>,
): Promise<number> {
  let status = 0;
  const req = {
    method: "GET",
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
    },
    end() {
      return this;
    },
  };
  await handle(req, res as unknown as ServerResponse, new URL("http://127.0.0.1/dashboard/"));
  return status;
}

async function listen(
  handle: DashboardHandler,
): Promise<{ base: string; close: () => Promise<void> }> {
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
      loadDashboardConfig({ WA_DASHBOARD_USERS: "ops:correct-horse,ops:another-secret" }),
    ).toThrow(/usernames must be unique/);
    expect(() => loadDashboardConfig({ WA_DASHBOARD_USERS: "ops:short-pass" })).toThrow(
      /password must be at least 12 characters/,
    );
  });

  it("parses one or more user:password entries", () => {
    const config = loadDashboardConfig({
      WA_DASHBOARD_ENABLED: "true",
      WA_DASHBOARD_USERS: "ops:correct-horse,night:pass:word-ok",
    });
    expect(config.enabled).toBe(true);
    expect(config.users).toEqual([
      { username: "ops", password: "correct-horse" },
      { username: "night", password: "pass:word-ok" },
    ]);
    expect(assertDashboardTransport(config, "http")).toBeUndefined();
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
    expect(baileysCredsArePaired(undefined)).toBe(false);
    expect(baileysCredsArePaired("")).toBe(true);
    expect(baileysCredsArePaired("   ")).toBe(true);
    expect(baileysCredsArePaired('{"registered":false}')).toBe(false);
    expect(baileysCredsArePaired('{"registered":true,"me":{"id":"15551212@s.whatsapp.net"}}')).toBe(
      true,
    );
    expect(baileysCredsArePaired("{}")).toBe(true);
    expect(baileysCredsArePaired('{"registered":"false"}')).toBe(true);
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
      data: {
        destinationId: "owner-routine",
        payload: { event: "instance.connected", text: SECRET_TOKEN },
      },
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
      instances: Array<{
        instanceId: string;
        paired: boolean;
        qrImage: string | null;
        phone: string | null;
      }>;
      webhook: {
        droppedEvents: string[];
        authConfigured: boolean;
        deliveries: unknown[];
        cloud: unknown;
      };
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

  it.each(["", "   ", "{}", '{"registered":null}', '{"registered":"false"}'])(
    "refuses pairing and QR access for malformed stored credentials: %j",
    async (storedCreds) => {
      const { handle, calls } = handlerFor({
        rows: [snapshot({ state: "qr_pending" })],
        isPaired: () => baileysCredsArePaired(storedCreds),
      });
      const base = await serve(handle);
      const headers = {
        Authorization: basic("ops", "correct-horse"),
        "Content-Type": "application/json",
      };
      const overview = await fetch(`${base}/dashboard/api/overview`, { headers });
      expect(overview.status).toBe(200);
      expect(await overview.json()).toMatchObject({
        instances: [{ pairingAvailable: false, qrImage: null }],
      });
      const response = await fetch(`${base}/dashboard/api/instances/inst_aabbccdd/pairing`, {
        method: "POST",
        headers,
        body: JSON.stringify({ phone: "15551234567" }),
      });
      expect(response.status).toBe(409);
      expect(calls).toEqual([]);
    },
  );

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

  it("starts pairing only for an existing unpaired instance", async () => {
    const { handle, calls } = handlerFor({});
    const base = await serve(handle);
    const created = await fetch(`${base}/dashboard/api/pairing`, {
      method: "POST",
      headers: {
        Authorization: basic("ops", "correct-horse"),
        "Content-Type": "application/json",
        Origin: new URL(base).origin,
      },
      body: JSON.stringify({ name: "Front desk", phone: "+1 (555) 123-4567" }),
    });
    expect(created.status).toBe(404);
    expect(calls).toEqual([]);

    const existing = await fetch(`${base}/dashboard/api/instances/inst_aabbccdd/pairing`, {
      method: "POST",
      headers: {
        Authorization: basic("ops", "correct-horse"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phone: "+1 (555) 123-4567" }),
    });
    expect(existing.status).toBe(200);
    const body = (await existing.json()) as { instanceId: string; pairingCode: string };
    expect(body.instanceId).toBe("inst_aabbccdd");
    expect(body.pairingCode).toBe("ABCD-1234");
    expect(calls).toContain("connect:inst_aabbccdd");
    expect(calls).toContain("code:inst_aabbccdd:15551234567");
  });

  it("rejects a cross-site or non-JSON pairing request before connecting", async () => {
    const { handle, calls } = handlerFor({});
    const base = await serve(handle);
    const headers = { Authorization: basic("ops", "correct-horse") };
    const url = `${base}/dashboard/api/instances/inst_aabbccdd/pairing`;
    const crossSite = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain", "Sec-Fetch-Site": "cross-site" },
      body: "",
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "Cross-site request rejected" });

    const foreignOrigin = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-site",
        Origin: "https://evil.example",
      },
      body: "{}",
    });
    expect(foreignOrigin.status).toBe(403);

    const plain = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain", "Sec-Fetch-Site": "same-origin" },
      body: "",
    });
    expect(plain.status).toBe(415);
    expect(calls).toEqual([]);

    const emptyJson = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Origin: new URL(base).origin,
        "Sec-Fetch-Site": "same-origin",
      },
      body: "",
    });
    expect(emptyJson.status).toBe(200);
    expect(calls).toContain("connect:inst_aabbccdd");
  });

  it("checks a limited address at most once per minute", async () => {
    let clock = 1_000_000;
    let comparisons = 0;
    const { handle } = handlerFor({
      maxLoginFailures: 8,
      loginProbeIntervalMs: 60_000,
      now: () => clock,
      matchCredentials(list, username, password) {
        comparisons += 1;
        return dashboardCredentialsMatch(list, username, password);
      },
    });
    const base = await serve(handle);
    const missing = await fetch(`${base}/dashboard/`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Basic");
    expect(comparisons).toBe(0);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const wrong = await fetch(`${base}/dashboard/`, {
        headers: { Authorization: basic("ops", "wrong-horse") },
      });
      expect(wrong.status).toBe(401);
    }
    expect(comparisons).toBe(8);
    const probe = await fetch(`${base}/dashboard/`, {
      headers: { Authorization: basic("ops", "wrong-horse") },
    });
    expect(probe.status).toBe(429);
    expect(probe.headers.get("www-authenticate")).toBeNull();
    expect(comparisons).toBe(9);
    const blocked = await fetch(`${base}/dashboard/`, {
      headers: { Authorization: basic("ops", "correct-horse") },
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "Too many login attempts" });
    expect(comparisons).toBe(9);
    const stillMissing = await fetch(`${base}/dashboard/`);
    expect(stillMissing.status).toBe(401);
    expect(comparisons).toBe(9);
    clock += 60_000;
    const accepted = await fetch(`${base}/dashboard/`, {
      headers: { Authorization: basic("ops", "correct-horse") },
    });
    expect(accepted.status).toBe(200);
    expect(comparisons).toBe(10);
    const otherUser = await fetch(`${base}/dashboard/`, {
      headers: { Authorization: basic("night", "wrong-horse") },
    });
    expect(otherUser.status).toBe(429);
    expect(comparisons).toBe(10);
    const afterSuccess = await fetch(`${base}/dashboard/`, {
      headers: { Authorization: basic("ops", "wrong-horse") },
    });
    expect(afterSuccess.status).toBe(429);
    expect(comparisons).toBe(10);
  });

  it("keeps the address limited when a correct login is not itself limited", async () => {
    const { handle } = handlerFor({ maxLoginFailures: 8 });
    const base = await serve(handle);
    const wrong = { Authorization: basic("ops", "wrong-horse") };
    for (let attempt = 0; attempt < 7; attempt += 1) {
      expect((await fetch(`${base}/dashboard/`, { headers: wrong })).status).toBe(401);
    }
    const success = await fetch(`${base}/dashboard/`, {
      headers: { Authorization: basic("ops", "correct-horse") },
    });
    expect(success.status).toBe(200);
    expect((await fetch(`${base}/dashboard/`, { headers: wrong })).status).toBe(401);
    expect((await fetch(`${base}/dashboard/`, { headers: wrong })).status).toBe(429);
  });

  it("does not let a polled login free guesses from the same address", async () => {
    let clock = 1_000_000;
    let comparisons = 0;
    const { handle } = handlerFor({
      maxLoginFailures: 8,
      loginProbeIntervalMs: 60_000,
      now: () => clock,
      users: [
        { username: "ops", password: "correct-horse" },
        { username: "night", password: "night-password" },
      ],
      matchCredentials(list, username, password) {
        comparisons += 1;
        return dashboardCredentialsMatch(list, username, password);
      },
    });
    const base = await serve(handle);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(
        (
          await fetch(`${base}/dashboard/`, {
            headers: { Authorization: basic("night", "wrong-horse") },
          })
        ).status,
      ).toBe(401);
    }
    expect(comparisons).toBe(8);
    const poll = await fetch(`${base}/dashboard/`, {
      headers: { Authorization: basic("ops", "correct-horse") },
    });
    expect(poll.status).toBe(200);
    expect(comparisons).toBe(9);
    clock += 3_000;
    const polledAgain = await fetch(`${base}/dashboard/`, {
      headers: { Authorization: basic("ops", "correct-horse") },
    });
    expect(polledAgain.status).toBe(200);
    expect(comparisons).toBe(10);
    const attacker = await fetch(`${base}/dashboard/`, {
      headers: { Authorization: basic("night", "wrong-horse") },
    });
    expect(attacker.status).toBe(429);
    expect(comparisons).toBe(10);
  });

  it("limits password comparisons across addresses", async () => {
    let comparisons = 0;
    const { handle } = handlerFor({
      maxLoginFailures: 8,
      maxComparisonsPerMinute: 2,
      matchCredentials(list, username, password) {
        comparisons += 1;
        return dashboardCredentialsMatch(list, username, password);
      },
    });
    const base = await serve(handle);
    const wrong = { Authorization: basic("ops", "wrong-horse") };
    expect((await fetch(`${base}/dashboard/`, { headers: wrong })).status).toBe(401);
    expect((await fetch(`${base}/dashboard/`, { headers: wrong })).status).toBe(401);
    const blocked = await fetch(`${base}/dashboard/`, { headers: wrong });
    expect(blocked.status).toBe(429);
    expect(comparisons).toBe(2);
  });

  it("serves four polling tabs without spending the global failure cap", async () => {
    let clock = 1_000_000;
    const { handle } = handlerFor({
      maxComparisonsPerMinute: 60,
      now: () => clock,
    });
    const base = await serve(handle);
    const auth = { Authorization: basic("ops", "correct-horse") };
    for (let tick = 0; tick < 20; tick += 1) {
      for (let tab = 0; tab < 4; tab += 1) {
        expect((await fetch(`${base}/dashboard/`, { headers: auth })).status).toBe(200);
      }
      clock += 3_000;
    }
    const outsider = await fetch(`${base}/dashboard/`, {
      headers: { Authorization: basic("night", "wrong-horse") },
    });
    expect(outsider.status).toBe(401);
  });

  it("keeps a recent success available while other addresses fill the global cap", async () => {
    let clock = 1_000_000;
    let comparisons = 0;
    const { handle } = handlerFor({
      maxComparisonsPerMinute: 60,
      now: () => clock,
      clientAddress(req) {
        const raw = req.headers["x-client-address"];
        return typeof raw === "string" && raw.length > 0 ? raw : "203.0.113.10";
      },
      matchCredentials(list, username, password) {
        comparisons += 1;
        return dashboardCredentialsMatch(list, username, password);
      },
    });
    const base = await serve(handle);
    const operator = {
      Authorization: basic("ops", "correct-horse"),
      "x-client-address": "203.0.113.10",
    };
    expect((await fetch(`${base}/dashboard/`, { headers: operator })).status).toBe(200);
    for (let index = 1; index <= 60; index += 1) {
      const attack = await fetch(`${base}/dashboard/`, {
        headers: {
          Authorization: basic("ops", "wrong-horse"),
          "x-client-address": `198.51.100.${index}`,
        },
      });
      expect(attack.status).toBe(401);
    }
    expect(comparisons).toBe(61);
    const blocked = await fetch(`${base}/dashboard/`, {
      headers: {
        Authorization: basic("ops", "wrong-horse"),
        "x-client-address": "198.51.100.61",
      },
    });
    expect(blocked.status).toBe(429);
    expect(comparisons).toBe(61);
    const polled = await fetch(`${base}/dashboard/`, { headers: operator });
    expect(polled.status).toBe(200);
    expect(comparisons).toBe(62);
    const freshLogin = await fetch(`${base}/dashboard/`, {
      headers: {
        Authorization: basic("ops", "correct-horse"),
        "x-client-address": "198.51.100.80",
      },
    });
    expect(freshLogin.status).toBe(429);
    expect(comparisons).toBe(62);
  });

  it("lets a recent success pass the address total but not its own pair limit", async () => {
    let clock = 1_000_000;
    let comparisons = 0;
    const { handle } = handlerFor({
      maxLoginFailures: 8,
      loginProbeIntervalMs: 60_000,
      now: () => clock,
      users: [
        { username: "ops", password: "correct-horse" },
        { username: "night", password: "night-password" },
      ],
      matchCredentials(list, username, password) {
        comparisons += 1;
        return dashboardCredentialsMatch(list, username, password);
      },
    });
    const base = await serve(handle);
    const operator = { Authorization: basic("ops", "correct-horse") };
    const attacker = { Authorization: basic("night", "wrong-horse") };
    expect((await fetch(`${base}/dashboard/`, { headers: operator })).status).toBe(200);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await fetch(`${base}/dashboard/`, { headers: attacker })).status).toBe(401);
    }
    expect((await fetch(`${base}/dashboard/`, { headers: attacker })).status).toBe(429);
    expect(comparisons).toBe(10);
    expect((await fetch(`${base}/dashboard/`, { headers: operator })).status).toBe(200);
    expect(comparisons).toBe(11);
    expect((await fetch(`${base}/dashboard/`, { headers: attacker })).status).toBe(429);
    expect(comparisons).toBe(11);
    const ownFailure = { Authorization: basic("ops", "wrong-horse") };
    expect((await fetch(`${base}/dashboard/`, { headers: ownFailure })).status).toBe(401);
    expect(comparisons).toBe(12);
    const dropped = await fetch(`${base}/dashboard/`, { headers: operator });
    expect(dropped.status).toBe(429);
    expect(comparisons).toBe(12);
  });

  it("keeps the global failure window independent of the probe interval", async () => {
    let clock = 1_000_000;
    const { handle } = handlerFor({
      maxComparisonsPerMinute: 1,
      loginProbeIntervalMs: 1_000,
      now: () => clock,
      clientAddress(req) {
        const raw = req.headers["x-client-address"];
        return typeof raw === "string" && raw.length > 0 ? raw : "203.0.113.10";
      },
    });
    const base = await serve(handle);
    const wrong = (address: string) =>
      fetch(`${base}/dashboard/`, {
        headers: {
          Authorization: basic("ops", "wrong-horse"),
          "x-client-address": address,
        },
      });
    expect((await wrong("198.51.100.1")).status).toBe(401);
    clock += 1_000;
    expect((await wrong("198.51.100.2")).status).toBe(429);
    clock += 60_000;
    expect((await wrong("198.51.100.3")).status).toBe(401);
  });

  it("does not let a successful poll refresh guesses for that username", async () => {
    let clock = 1_000_000;
    let comparisons = 0;
    const { handle } = handlerFor({
      maxLoginFailures: 8,
      loginProbeIntervalMs: 60_000,
      now: () => clock,
      matchCredentials(list, username, password) {
        comparisons += 1;
        return dashboardCredentialsMatch(list, username, password);
      },
    });
    const base = await serve(handle);
    const wrong = { Authorization: basic("ops", "wrong-horse") };
    const right = { Authorization: basic("ops", "correct-horse") };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await fetch(`${base}/dashboard/`, { headers: wrong })).status).toBe(401);
    }
    expect(comparisons).toBe(8);
    for (let minute = 0; minute < 12; minute += 1) {
      if (minute > 0) clock += 60_000;
      expect((await fetch(`${base}/dashboard/`, { headers: right })).status).toBe(200);
      for (let guess = 0; guess < 8; guess += 1) {
        expect((await fetch(`${base}/dashboard/`, { headers: wrong })).status).toBe(429);
      }
    }
    expect(comparisons).toBe(8 + 12);
  });

  it("still limits a new address and an exempt pair after the bucket map is full", async () => {
    const { handle } = handlerFor({
      maxLoginFailures: 8,
      clientAddress(req) {
        const raw = req.headers["x-client-address"];
        return dashboardClientKey(typeof raw === "string" ? raw : "127.0.0.1");
      },
    });
    const malformed = { authorization: "Basic !!!!", "x-client-address": "" };
    for (let index = 0; index < 1100; index += 1) {
      const address = `2001:db8:${(index >>> 8).toString(16)}:${(index & 0xff).toString(16)}::1`;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const status = await dashboardStatus(handle, {
          ...malformed,
          "x-client-address": address,
        });
        if (status !== 401) {
          throw new Error(`filled prefix ${index} attempt ${attempt} returned ${status}`);
        }
      }
    }
    const fresh = "2001:db8:ffff:eeee::1";
    const wrong = basic("ops", "wrong-horse");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(
        await dashboardStatus(handle, {
          authorization: wrong,
          "x-client-address": fresh,
        }),
      ).toBe(401);
    }
    expect(await dashboardStatus(handle, { authorization: wrong, "x-client-address": fresh })).toBe(
      429,
    );
    const exempt = "2001:db8:ffff:eeed::1";
    expect(
      await dashboardStatus(handle, {
        authorization: basic("ops", "correct-horse"),
        "x-client-address": exempt,
      }),
    ).toBe(200);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(
        await dashboardStatus(handle, { authorization: wrong, "x-client-address": exempt }),
      ).toBe(401);
    }
    expect(
      await dashboardStatus(handle, { authorization: wrong, "x-client-address": exempt }),
    ).toBe(429);
  });

  it("uses relative API URLs under its mount path", async () => {
    const { handle, calls } = handlerFor({ mountPath: "/wamcp/dashboard" });
    const base = await serve(handle);
    const absent = await fetch(`${base}/dashboard`, {
      headers: { Authorization: basic("ops", "correct-horse") },
    });
    expect(absent.status).toBe(404);
    const redirect = await fetch(`${base}/wamcp/dashboard`, {
      headers: { Authorization: basic("ops", "correct-horse") },
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/wamcp/dashboard/");
    const page = await fetch(`${base}/wamcp/dashboard/`, {
      headers: { Authorization: basic("ops", "correct-horse") },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    const csp = page.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).toContain('const overviewUrl = "api/overview"');
    expect(html).toContain('"api/instances/"');
    expect(html).not.toContain("/dashboard/api/");
    expect(html).not.toContain("/api/pairing");
    const overview = await fetch(`${base}/wamcp/dashboard/api/overview`, {
      headers: { Authorization: basic("ops", "correct-horse") },
    });
    expect(overview.status).toBe(200);
    expect(calls).toEqual([]);
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

  it("accepts pairing when Host includes the default port and ignores X-Forwarded-Proto", async () => {
    const { handle, calls } = handlerFor({});
    const base = await serve(handle);
    const target = new URL(base);
    const send = (headers: Record<string, string>) =>
      new Promise<{ status: number }>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: target.hostname,
            port: target.port,
            path: "/dashboard/api/instances/inst_aabbccdd/pairing",
            method: "POST",
            headers: {
              ...headers,
              "Content-Length": Buffer.byteLength("{}"),
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
    const auth = {
      Authorization: basic("ops", "correct-horse"),
      "Content-Type": "application/json",
    };
    const explicitDefault = await send({
      ...auth,
      Host: "dashboard.example:80",
      Origin: "http://dashboard.example",
    });
    expect(explicitDefault.status).toBe(200);
    const nonDefault = await send({
      ...auth,
      Host: "dashboard.example:8080",
      Origin: "http://dashboard.example",
    });
    expect(nonDefault.status).toBe(403);
    const forwarded = await fetch(`${base}/dashboard/api/instances/inst_aabbccdd/pairing`, {
      method: "POST",
      headers: {
        ...auth,
        Origin: new URL(base).origin,
        "X-Forwarded-Proto": "https",
      },
      body: "{}",
    });
    expect(forwarded.status).toBe(200);
    expect(calls.filter((call) => call.startsWith("connect:"))).toEqual(["connect:inst_aabbccdd"]);
  });
});

describe("dashboard login buckets", () => {
  it("keeps limited buckets when the map is over the cap", () => {
    const entries = new Map<string, number[]>();
    for (let index = 0; index < 1025; index += 1) entries.set(`open-${index}`, [1]);
    entries.set("limited", [1, 1, 1, 1, 1, 1, 1, 1]);
    pruneLoginBuckets(entries, 1024, (_key, samples) => samples.length >= 8);
    expect(entries.has("limited")).toBe(true);
    expect(entries.has("open-0")).toBe(false);
    expect(entries.size).toBe(1024);

    const locked = new Map<string, number[]>();
    for (let index = 0; index < 1025; index += 1) {
      locked.set(`locked-${index}`, [1, 1, 1, 1, 1, 1, 1, 1]);
    }
    pruneLoginBuckets(locked, 1024, (_key, samples) => samples.length >= 8);
    expect(locked.size).toBe(1025);

    const crowded = new Map<string, number[]>(locked);
    crowded.set("fresh", [1]);
    pruneLoginBuckets(crowded, 1024, (_key, samples) => samples.length >= 8, {
      pinned: "fresh",
      hardCap: 10_000,
    });
    expect(crowded.has("fresh")).toBe(true);
    expect(crowded.get("fresh")).toEqual([1]);

    const huge = new Map<string, number[]>();
    for (let index = 0; index < 10_000; index += 1) {
      huge.set(`locked-${index}`, [1, 1, 1, 1, 1, 1, 1, 1]);
    }
    huge.set("fresh", [1]);
    pruneLoginBuckets(huge, 1024, (_key, samples) => samples.length >= 8, {
      pinned: "fresh",
      hardCap: 10_000,
    });
    expect(huge.has("fresh")).toBe(true);
    expect(huge.has("locked-0")).toBe(false);
    expect(huge.size).toBe(10_000);
  });
});

describe("dashboard client key", () => {
  it("groups IPv6 addresses by the /64 prefix", () => {
    expect(dashboardClientKey("2001:db8:1:2::1")).toBe(dashboardClientKey("2001:db8:1:2:ffff::9"));
    expect(dashboardClientKey("2001:DB8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(dashboardClientKey("2001:db8:1:3::1")).not.toBe(dashboardClientKey("2001:db8:1:2::1"));
    expect(dashboardClientKey("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(dashboardClientKey("10.0.0.8")).toBe("10.0.0.8");
  });
});

describe("dashboard origin check", () => {
  it("treats default ports as the same host and compares scheme only when known", () => {
    expect(dashboardOriginAllowed("http://x", "x:80", null)).toBe(true);
    expect(dashboardOriginAllowed("https://x", "x:443", null)).toBe(true);
    expect(dashboardOriginAllowed("http://x:80", "x", null)).toBe(true);
    expect(dashboardOriginAllowed("https://x", "X", null)).toBe(true);
    expect(dashboardOriginAllowed("http://x", "x:8080", null)).toBe(false);
    expect(dashboardOriginAllowed("https://x", "x:80", null)).toBe(false);
    expect(dashboardOriginAllowed("http://[::1]", "[::1]:80", null)).toBe(true);
    expect(dashboardOriginAllowed("http://x", "x", "https")).toBe(false);
    expect(dashboardOriginAllowed("https://x", "x:443", "https")).toBe(true);
    expect(dashboardOriginAllowed("http://evil.example", "x", null)).toBe(false);
    expect(dashboardOriginAllowed("null", "x", null)).toBe(false);
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
    expect(dashboardPage("noncevalue12345678")).not.toContain("/api/send");
    expect(dashboardPage("noncevalue12345678")).not.toContain("/dashboard/api/");
  });
});
