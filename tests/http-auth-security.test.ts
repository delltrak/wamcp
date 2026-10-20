import { createHash, randomBytes, scryptSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageQueue } from "../src/services/message-queue.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import { BASIC_AUTH_SCRYPT, verifyBasicCredentials } from "../src/server/basic-auth.js";
import { loadHttpTransportConfig, type HttpTransportConfig } from "../src/server/http-config.js";
import { createHttpRequestHandler } from "../src/server/http-listener.js";
import { McpHttpSessionManager } from "../src/server/http-session.js";
import { authorizeMcpHttpRequest } from "../src/server/mcp-auth.js";
import { McpOAuthServer, type OAuthLogger } from "../src/server/oauth/server.js";
import { openOAuthStore, type OAuthStore } from "../src/server/oauth/store.js";

const ISSUER = "https://example.com";
const RESOURCE = "https://example.com/mcp";
const REDIRECT = "https://client.example/callback";
const PASSWORD = "pw-do-not-leak-918273";

interface LogEntry {
  level: "info" | "warn";
  bindings: Record<string, unknown>;
  message: string;
}

interface Harness {
  baseUrl: string;
  oauth: McpOAuthServer | null;
  logs: LogEntry[];
  errors: unknown[];
  close: () => Promise<void>;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function pkce(verifier = randomBytes(32).toString("base64url")): {
  verifier: string;
  challenge: string;
} {
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function collectingLogger(logs: LogEntry[]): OAuthLogger {
  return {
    info(bindings, message) {
      logs.push({ level: "info", bindings, message });
    },
    warn(bindings, message) {
      logs.push({ level: "warn", bindings, message });
    },
  };
}

function oauthServer(options: {
  issuerUrl?: string;
  resourceUrl?: string;
  users?: string;
  now?: () => Date;
  store?: OAuthStore;
  logs?: LogEntry[];
}): McpOAuthServer {
  const users = options.users ?? `alice:${PASSWORD},bob:other-secret`;
  const parsed = loadHttpTransportConfig({ WA_BASIC_AUTH: users }).basicUsers;
  const store = options.store ?? openOAuthStore(":memory:");
  return new McpOAuthServer({
    issuerUrl: options.issuerUrl ?? ISSUER,
    resourceUrl: options.resourceUrl ?? RESOURCE,
    store,
    validateCredential: (username, password) => verifyBasicCredentials(parsed, username, password),
    ...(options.now ? { now: options.now } : {}),
    log: collectingLogger(options.logs ?? []),
  });
}

async function startHarness(options: {
  config?: HttpTransportConfig;
  oauth?: McpOAuthServer | null;
  mcp?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}): Promise<Harness> {
  const logs: LogEntry[] = [];
  const errors: unknown[] = [];
  const config = options.config ?? loadHttpTransportConfig({});
  const oauth = options.oauth === undefined ? null : options.oauth;
  const mcp =
    options.mcp ??
    (async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  const handler = createHttpRequestHandler({
    routes: config.routes,
    oauth,
    authorize: (req, res) =>
      authorizeMcpHttpRequest(
        req,
        res,
        { ...(config.apiKey ? { apiKey: config.apiKey } : {}), basicUsers: config.basicUsers },
        oauth,
      ),
    health: (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    },
    mcp,
    webhook: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ webhook: true }));
    },
  });
  const httpServer: Server = createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      errors.push(error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${port}`,
    oauth,
    logs,
    errors,
    close: async () => {
      oauth?.close();
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  };
  closers.push(harness.close);
  return harness;
}

async function register(
  harness: Harness,
  body: Record<string, unknown>,
  path = "/oauth/register",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json };
}

async function authorizeCode(
  harness: Harness,
  clientId: string,
  options: {
    redirectUri?: string;
    resource?: string;
    username?: string;
    password?: string;
    scope?: string;
    state?: string;
    authorizePath?: string;
    challenge?: string;
  } = {},
): Promise<{ status: number; location: string; body: string }> {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: options.redirectUri ?? REDIRECT,
    code_challenge: options.challenge ?? challenge,
    code_challenge_method: "S256",
    resource: options.resource ?? RESOURCE,
    scope: options.scope ?? "mcp",
    ...(options.state ? { state: options.state } : {}),
  });
  const path = options.authorizePath ?? "/oauth/authorize";
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...Object.fromEntries(params),
      username: options.username ?? "alice",
      password: options.password ?? PASSWORD,
    }),
  });
  return {
    status: response.status,
    location: response.headers.get("location") ?? "",
    body: await response.text(),
    ...(verifier ? {} : {}),
  };
}

function codeFromLocation(location: string): string {
  return new URL(location).searchParams.get("code") ?? "";
}

async function exchange(
  harness: Harness,
  body: Record<string, string>,
  path = "/oauth/token",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json };
}

describe("HTTP transport configuration", () => {
  it("keeps the historical routes and open auth when nothing is configured", () => {
    const config = loadHttpTransportConfig({});
    expect(config.basePath).toBe("");
    expect(config.routes).toEqual({ health: "/health", mcp: "/mcp", webhook: "/cloud-webhook" });
    expect(config.basicUsers).toEqual([]);
    expect(config.apiKey).toBeUndefined();
    expect(config.oauth.enabled).toBe(false);
  });

  it("normalizes a base path and rejects traversal", () => {
    expect(loadHttpTransportConfig({ WA_BASE_PATH: "/wamcp/" }).basePath).toBe("/wamcp");
    expect(() => loadHttpTransportConfig({ WA_BASE_PATH: "wamcp" })).toThrow(/WA_BASE_PATH/);
    expect(() => loadHttpTransportConfig({ WA_BASE_PATH: "/../etc" })).toThrow(/WA_BASE_PATH/);
  });

  it("rejects invalid auth settings without echoing secrets", () => {
    const secret = "super-secret-password";
    expect(() => loadHttpTransportConfig({ WA_BASIC_AUTH: secret })).toThrow(/user:password/);
    try {
      loadHttpTransportConfig({ WA_BASIC_AUTH: secret });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
    }
    expect(() =>
      loadHttpTransportConfig({
        WA_BASIC_AUTH: `alice:${secret},alice:other`,
      }),
    ).toThrow(/unique/);
    expect(() => loadHttpTransportConfig({ WA_MCP_OAUTH_ENABLED: "yes" })).toThrow(/true or false/);
    expect(() =>
      loadHttpTransportConfig({
        WA_MCP_OAUTH_ENABLED: "true",
        WA_BASIC_AUTH: `alice:${secret}`,
        WA_MCP_OAUTH_ISSUER_URL: `https://user:${secret}@example.com`,
      }),
    ).toThrow(/HTTPS URL/);
    try {
      loadHttpTransportConfig({
        WA_MCP_OAUTH_ENABLED: "true",
        WA_BASIC_AUTH: `alice:${secret}`,
        WA_MCP_OAUTH_ISSUER_URL: `https://user:${secret}@example.com`,
      });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("requires matching issuer and resource URLs when OAuth is enabled", () => {
    const enabled = loadHttpTransportConfig({
      WA_BASIC_AUTH: "alice:secret",
      WA_BASE_PATH: "/wamcp",
      WA_MCP_OAUTH_ENABLED: "true",
      WA_MCP_OAUTH_ISSUER_URL: "https://example.com/wamcp",
    });
    expect(enabled.oauth).toMatchObject({
      enabled: true,
      issuerUrl: "https://example.com/wamcp",
      resourceUrl: "https://example.com/wamcp/mcp",
    });
    expect(() =>
      loadHttpTransportConfig({
        WA_BASIC_AUTH: "alice:secret",
        WA_MCP_OAUTH_ENABLED: "true",
      }),
    ).toThrow(/WA_MCP_OAUTH_ISSUER_URL/);
    expect(() =>
      loadHttpTransportConfig({
        WA_MCP_OAUTH_ENABLED: "true",
        WA_MCP_OAUTH_ISSUER_URL: "https://example.com",
      }),
    ).toThrow(/WA_BASIC_AUTH/);
    expect(() =>
      loadHttpTransportConfig({
        WA_BASIC_AUTH: "alice:secret",
        WA_BASE_PATH: "/wamcp",
        WA_MCP_OAUTH_ENABLED: "true",
        WA_MCP_OAUTH_ISSUER_URL: "https://example.com",
      }),
    ).toThrow(/match WA_BASE_PATH/);
    expect(() =>
      loadHttpTransportConfig({
        WA_BASIC_AUTH: "alice:secret",
        WA_MCP_OAUTH_ENABLED: "true",
        WA_MCP_OAUTH_ISSUER_URL: "https://example.com",
        WA_MCP_OAUTH_DB_PATH: "data/whatsapp.db",
      }),
    ).toThrow(/separate from WA_DATABASE_PATH/);
  });
});

describe("MCP HTTP authentication", () => {
  it("leaves /mcp open when no credential is configured", async () => {
    const harness = await startHarness({});
    const health = await fetch(`${harness.baseUrl}/health`);
    const mcp = await fetch(`${harness.baseUrl}/mcp`, { method: "POST" });
    const metadata = await fetch(`${harness.baseUrl}/.well-known/oauth-protected-resource`);
    expect(health.status).toBe(200);
    expect(mcp.status).toBe(200);
    expect(metadata.status).toBe(404);
    expect(harness.errors).toEqual([]);
  });

  it("keeps API key bearer and x-api-key behavior without a new challenge", async () => {
    const config = loadHttpTransportConfig({ WA_MCP_API_KEY: "test-api-key" });
    const harness = await startHarness({ config });
    const missing = await fetch(`${harness.baseUrl}/mcp`, { method: "POST" });
    const wrong = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-key" },
    });
    const bearer = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer test-api-key" },
    });
    const header = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { "X-Api-Key": "test-api-key" },
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBeNull();
    expect(await missing.json()).toEqual({ error: "Unauthorized" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toBeNull();
    expect(bearer.status).toBe(200);
    expect(header.status).toBe(200);
  });

  it("accepts every configured basic user and a scrypt verifier", async () => {
    const salt = randomBytes(16);
    const hash = scryptSync("bob-password", salt, BASIC_AUTH_SCRYPT.keylen, {
      N: BASIC_AUTH_SCRYPT.N,
      r: BASIC_AUTH_SCRYPT.r,
      p: BASIC_AUTH_SCRYPT.p,
    });
    const encoded = `$scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
    const config = loadHttpTransportConfig({
      WA_BASIC_AUTH: `alice:${PASSWORD},bob:${encoded}`,
      WA_MCP_API_KEY: "test-api-key",
    });
    const harness = await startHarness({ config });
    const alice = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`alice:${PASSWORD}`).toString("base64")}` },
    });
    const bob = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from("bob:bob-password").toString("base64")}` },
    });
    const wrong = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from("bob:nope").toString("base64")}` },
    });
    const apiKey = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer test-api-key" },
    });
    expect(alice.status).toBe(200);
    expect(bob.status).toBe(200);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain('Basic realm="wa-mcp"');
    expect(apiKey.status).toBe(200);
    expect(await wrong.text()).not.toContain(PASSWORD);
  });

  it("serves health, MCP, and the Cloud webhook under the base path", async () => {
    const config = loadHttpTransportConfig({
      WA_BASE_PATH: "/wamcp",
      WA_BASIC_AUTH: `alice:${PASSWORD}`,
    });
    const harness = await startHarness({ config });
    expect((await fetch(`${harness.baseUrl}/health`)).status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/mcp`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/wamcp/health`)).status).toBe(200);
    expect((await fetch(`${harness.baseUrl}/wamcp/cloud-webhook`, { method: "POST" })).status).toBe(
      200,
    );
    const mcp = await fetch(`${harness.baseUrl}/wamcp/mcp`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`alice:${PASSWORD}`).toString("base64")}` },
    });
    expect(mcp.status).toBe(200);
    expect((await fetch(`${harness.baseUrl}/wamcp/mcp`, { method: "POST" })).status).toBe(401);
  });
});

describe("OAuth 2.1 authorization server", () => {
  const webClient = {
    client_name: "Remote MCP",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };

  it("publishes metadata and challenges unauthenticated MCP calls", async () => {
    const logs: LogEntry[] = [];
    const oauth = oauthServer({ logs });
    const config = loadHttpTransportConfig({
      WA_BASIC_AUTH: `alice:${PASSWORD},bob:other-secret`,
      WA_MCP_API_KEY: "test-api-key",
    });
    const harness = await startHarness({ config, oauth });
    const resource = await fetch(`${harness.baseUrl}/.well-known/oauth-protected-resource/mcp`);
    const server = await fetch(`${harness.baseUrl}/.well-known/oauth-authorization-server`);
    const unauthorized = await fetch(`${harness.baseUrl}/mcp`, { method: "POST" });
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
    expect(await server.json()).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      authorization_response_iss_parameter_supported: true,
    });
    const challenge = unauthorized.headers.get("www-authenticate") ?? "";
    expect(unauthorized.status).toBe(401);
    expect(challenge).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challenge).toContain('Basic realm="wa-mcp"');
    expect(challenge).not.toContain("invalid_token");
  });

  it("completes authorization code, PKCE, refresh rotation, and lists tools", async () => {
    const logs: LogEntry[] = [];
    const oauth = oauthServer({ logs });
    const subscribers = new Set<unknown>();
    const sessionManager = new McpHttpSessionManager(
      {
        onAnyEvent(handler: unknown) {
          subscribers.add(handler);
          return () => subscribers.delete(handler);
        },
      } as unknown as InstanceManager,
      {} as MessageQueue,
    );
    closers.push(async () => {
      await sessionManager.closeAll();
    });
    const config = loadHttpTransportConfig({
      WA_BASIC_AUTH: `alice:${PASSWORD},bob:other-secret`,
      WA_MCP_API_KEY: "test-api-key",
    });
    const harness = await startHarness({
      config,
      oauth,
      mcp: (req, res) => sessionManager.handleRequest(req, res),
    });

    const registered = await register(harness, webClient);
    expect(registered.status).toBe(201);
    const clientId = String(registered.json.client_id);
    const { verifier, challenge } = pkce();
    const page = await fetch(
      `${harness.baseUrl}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        scope: "mcp",
        state: '"><script>',
      })}`,
    );
    const pageHtml = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://client.example;",
    );
    expect(pageHtml).toContain("&quot;&gt;&lt;script&gt;");
    expect(pageHtml).not.toContain('"><script>');

    const granted = await fetch(`${harness.baseUrl}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        scope: "mcp",
        state: "state-123",
        username: "alice",
        password: PASSWORD,
      }),
    });
    expect(granted.status).toBe(302);
    const location = new URL(granted.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("iss")).toBe(ISSUER);
    expect(location.searchParams.get("state")).toBe("state-123");
    const code = location.searchParams.get("code") ?? "";
    expect(code).toMatch(/^wamcp_code_/);

    const wrongVerifier = randomBytes(32).toString("base64url");
    const wrong = await exchange(harness, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: wrongVerifier,
      resource: RESOURCE,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe("invalid_grant");

    const token = await exchange(harness, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(token.status).toBe(200);
    expect(token.json.token_type).toBe("Bearer");
    expect(token.json.expires_in).toBe(3600);
    expect(token.json.scope).toBe("mcp");
    const accessToken = String(token.json.access_token);
    const refreshToken = String(token.json.refresh_token);
    const snapshot = oauth.store.inspectionSnapshot();
    expect(snapshot).not.toContain(code);
    expect(snapshot).not.toContain(verifier);
    expect(snapshot).not.toContain(accessToken);
    expect(snapshot).not.toContain(refreshToken);
    expect(snapshot).not.toContain(PASSWORD);
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
    expect(JSON.stringify(logs)).not.toContain(accessToken);
    expect(JSON.stringify(logs)).not.toContain(code);

    const reused = await exchange(harness, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(reused.json.error).toBe("invalid_grant");

    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "MCP-Protocol-Version": "2025-03-26",
    };
    const initialize = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "remote-client", version: "1.0.0" },
        },
      }),
    });
    expect(initialize.status).toBe(200);
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initialize.text();
    const initialized = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId ?? "" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initialized.status).toBe(202);
    const tools = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId ?? "" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(tools.status).toBe(200);
    const toolsBody = await tools.text();
    expect(toolsBody).toContain("wa_create_instance");

    const apiKey = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...headers, Authorization: "Bearer test-api-key" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} }),
    });
    expect(apiKey.status).not.toBe(401);

    const rotated = await exchange(harness, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      resource: RESOURCE,
    });
    expect(rotated.status).toBe(200);
    const rotatedAccess = String(rotated.json.access_token);
    const rotatedRefresh = String(rotated.json.refresh_token);
    const reuse = await exchange(harness, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      resource: RESOURCE,
    });
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toBe("invalid_grant");
    const revoked = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rotatedAccess}` },
    });
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const revokedRefresh = await exchange(harness, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: rotatedRefresh,
      resource: RESOURCE,
    });
    expect(revokedRefresh.json.error).toBe("invalid_grant");
    expect(harness.errors).toEqual([]);
  });

  it("rejects redirect prefix matches and does not issue a code", async () => {
    const oauth = oauthServer({});
    const harness = await startHarness({ oauth });
    const registered = await register(harness, webClient);
    const clientId = String(registered.json.client_id);
    const denied = await authorizeCode(harness, clientId, {
      redirectUri: "https://client.example.evil/callback",
    });
    expect(denied.status).toBe(400);
    expect(denied.body).toContain("invalid_request");
    expect(oauth.store.authorizationCodeCount()).toBe(0);
  });

  it("returns safe authorization errors to the registered client", async () => {
    const oauth = oauthServer({});
    const harness = await startHarness({ oauth });
    const registered = await register(harness, webClient);
    const denied = await authorizeCode(harness, String(registered.json.client_id), {
      scope: "admin",
      state: "state-123",
    });
    expect(denied.status).toBe(302);
    const location = new URL(denied.location);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("iss")).toBe(ISSUER);
    expect(location.searchParams.get("code")).toBeNull();
    expect(oauth.store.authorizationCodeCount()).toBe(0);
  });

  it("does not render or log a rejected password", async () => {
    const logs: LogEntry[] = [];
    const oauth = oauthServer({ logs });
    const harness = await startHarness({ oauth });
    const registered = await register(harness, {
      ...webClient,
      client_name: "<script>alert(1)</script>",
    });
    const { challenge } = pkce();
    const response = await fetch(`${harness.baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: String(registered.json.client_id),
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        scope: "mcp",
        username: "alice",
        password: `${PASSWORD}-wrong`,
      }),
    });
    expect(response.status).toBe(401);
    const html = await response.text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`${PASSWORD}-wrong`);
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
    expect(oauth.store.authorizationCodeCount()).toBe(0);
  });

  it("rejects a mismatched resource without consuming the code", async () => {
    const oauth = oauthServer({});
    const harness = await startHarness({ oauth });
    const registered = await register(harness, webClient);
    const clientId = String(registered.json.client_id);
    const { verifier, challenge } = pkce();
    const granted = await fetch(`${harness.baseUrl}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        scope: "mcp",
        username: "bob",
        password: "other-secret",
      }),
    });
    const code = codeFromLocation(granted.headers.get("location") ?? "");
    const mismatched = await exchange(harness, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: "https://example.com/elsewhere",
    });
    expect(mismatched.json.error).toBe("invalid_target");
    const recovered = await exchange(harness, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(recovered.status).toBe(200);
  });

  it("expires authorization codes", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const oauth = oauthServer({ now: () => now });
    const harness = await startHarness({ oauth });
    const registered = await register(harness, webClient);
    const { verifier, challenge } = pkce();
    const granted = await fetch(`${harness.baseUrl}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: String(registered.json.client_id),
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        username: "alice",
        password: PASSWORD,
      }),
    });
    const code = codeFromLocation(granted.headers.get("location") ?? "");
    now = new Date(now.getTime() + 6 * 60 * 1000);
    const expired = await exchange(harness, {
      grant_type: "authorization_code",
      client_id: String(registered.json.client_id),
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(expired.json.error).toBe("invalid_grant");
  });

  it("limits dynamic registration and native redirect URIs", async () => {
    const oauth = oauthServer({});
    oauth.store.maxClients = 1;
    const harness = await startHarness({ oauth });
    const native = (redirectUri: string, applicationType = "native") =>
      register(harness, {
        client_name: "Local",
        redirect_uris: [redirectUri],
        application_type: applicationType,
        token_endpoint_auth_method: "none",
      });
    expect((await native("http://127.0.0.1:49152/callback")).status).toBe(201);
    expect((await native("http://[::1]:49152/callback")).status).toBe(429);
    oauth.store.maxClients = 10;
    expect((await native("http://localhost:49152/callback")).status).toBe(201);
    expect((await native("http://example.com/callback")).status).toBe(400);
    expect((await native("http://localhost/callback")).status).toBe(400);
    expect((await native("http://localhost:49152/callback", "web")).status).toBe(400);
    expect((await native("https://client.example/callback", "web")).status).toBe(201);

    const oversized = await fetch(`${harness.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Large",
        redirect_uris: [REDIRECT],
        padding: "x".repeat(16 * 1024),
      }),
    });
    expect(oversized.status).toBe(413);
    const longRedirect = `https://client.example/${"x".repeat(2048)}`;
    const longResponse = await register(harness, {
      client_name: "Long",
      redirect_uris: [longRedirect],
      application_type: "web",
    });
    expect(longResponse.status).toBe(400);
    expect(longResponse.json.error).toBe("invalid_redirect_uri");
  });

  it("allows only the port to change for native loopback callbacks", async () => {
    const oauth = oauthServer({});
    const harness = await startHarness({ oauth });
    const registeredRedirect = "http://127.0.0.1:49152/callback";
    const requestedRedirect = "http://127.0.0.1:53100/callback";
    const registered = await register(harness, {
      client_name: "Local",
      redirect_uris: [registeredRedirect],
      application_type: "native",
      token_endpoint_auth_method: "none",
    });
    const clientId = String(registered.json.client_id);
    const { verifier, challenge } = pkce();
    const wrongPath = await authorizeCode(harness, clientId, {
      redirectUri: "http://127.0.0.1:53100/other",
      challenge,
    });
    expect(wrongPath.status).toBe(400);
    const granted = await fetch(`${harness.baseUrl}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: requestedRedirect,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        scope: "mcp",
        username: "alice",
        password: PASSWORD,
      }),
    });
    expect(granted.status).toBe(302);
    const code = codeFromLocation(granted.headers.get("location") ?? "");
    const wrongRedirect = await exchange(harness, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: registeredRedirect,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(wrongRedirect.json.error).toBe("invalid_grant");
    const exchanged = await exchange(harness, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: requestedRedirect,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(exchanged.status).toBe(200);

    const localhost = await register(harness, {
      client_name: "Named",
      redirect_uris: ["http://localhost:60390/callback"],
      application_type: "native",
    });
    const beforePortSwap = oauth.store.authorizationCodeCount();
    const portSwap = await authorizeCode(harness, String(localhost.json.client_id), {
      redirectUri: "http://localhost:60391/callback",
    });
    expect(portSwap.status).toBe(400);
    expect(oauth.store.authorizationCodeCount()).toBe(beforePortSwap);
  });

  it("places OAuth routes under the base path and well-known URLs at the RFC paths", async () => {
    const issuer = "https://example.com/wamcp";
    const resource = "https://example.com/wamcp/mcp";
    const oauth = oauthServer({ issuerUrl: issuer, resourceUrl: resource });
    const config = loadHttpTransportConfig({
      WA_BASE_PATH: "/wamcp",
      WA_BASIC_AUTH: `alice:${PASSWORD}`,
      WA_MCP_OAUTH_ENABLED: "true",
      WA_MCP_OAUTH_ISSUER_URL: issuer,
      WA_MCP_OAUTH_DB_PATH: ":memory:",
    });
    const harness = await startHarness({ config, oauth });
    expect(
      (await fetch(`${harness.baseUrl}/.well-known/oauth-authorization-server/wamcp`)).status,
    ).toBe(200);
    expect(
      (await fetch(`${harness.baseUrl}/.well-known/oauth-protected-resource/wamcp/mcp`)).status,
    ).toBe(200);
    expect(
      (await fetch(`${harness.baseUrl}/wamcp/.well-known/oauth-authorization-server`)).status,
    ).toBe(404);
    const registered = await register(harness, webClient, "/wamcp/oauth/register");
    expect(registered.status).toBe(201);
    const metadata = (await (
      await fetch(`${harness.baseUrl}/.well-known/oauth-authorization-server/wamcp`)
    ).json()) as { authorization_endpoint: string };
    expect(metadata.authorization_endpoint).toBe(`${issuer}/oauth/authorize`);
    const denied = await fetch(`${harness.baseUrl}/wamcp/mcp`, { method: "POST" });
    expect(denied.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://example.com/.well-known/oauth-protected-resource/wamcp/mcp"',
    );
  });
});
