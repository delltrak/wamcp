import { createHash, randomBytes, scryptSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { AuthAttemptLimiter, clientAddress } from "../src/server/auth-limiter.js";
import {
  basicAuthScryptOperations,
  clearBasicAuthSuccessCache,
  credentialFingerprint,
  findBasicUser,
  parseBasicAuthUsers,
  verifyBasicCredentials,
} from "../src/server/basic-auth.js";
import {
  loadHttpTransportConfig,
  loadHttpTransportConfigForTransport,
} from "../src/server/http-config.js";
import { createHttpRequestHandler } from "../src/server/http-listener.js";
import { authorizeMcpHttpRequest } from "../src/server/mcp-auth.js";
import { redirectHostAllowed, validRedirectUri } from "../src/server/oauth/redirect.js";
import { McpOAuthServer } from "../src/server/oauth/server.js";
import {
  migrateOAuthSchema,
  newOAuthClientId,
  OAuthFlowError,
  openOAuthStore,
  type OAuthClient,
} from "../src/server/oauth/store.js";

const ISSUER = "https://example.com";
const RESOURCE = "https://example.com/mcp";
const REDIRECT = "https://client.example/callback";
const PASSWORD = "pw-do-not-leak-918273";

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

function scryptUser(username: string, password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${username}:$scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const httpServer: Server = createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : "error");
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
  const close = async () => {
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
  closers.push(close);
  return { baseUrl: `http://127.0.0.1:${port}`, close };
}

function clientRecord(redirectUris: string[], applicationType: "web" | "native"): OAuthClient {
  return {
    id: newOAuthClientId(),
    name: "MCP client",
    redirectUris,
    applicationType,
    tokenEndpointAuthMethod: "none",
    createdAt: Math.floor(Date.now() / 1000),
  };
}

describe("async Basic Auth verification", () => {
  it("does not block the event loop and caches a successful scrypt verification", async () => {
    const password = "scrypt-cache-password";
    const users = parseBasicAuthUsers(scryptUser("scryptuser", password));
    clearBasicAuthSuccessCache();
    const before = basicAuthScryptOperations();
    const started = performance.now();
    const pending = verifyBasicCredentials(users, "scryptuser", password);
    const elapsed = performance.now() - started;
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(elapsed).toBeLessThan(50);
    expect(settled).toBe(false);
    expect(await pending).toBe(true);
    expect(basicAuthScryptOperations()).toBe(before + 1);

    expect(await verifyBasicCredentials(users, "scryptuser", password)).toBe(true);
    expect(basicAuthScryptOperations()).toBe(before + 1);

    const later = Date.now() + 60_000;
    expect(await verifyBasicCredentials(users, "scryptuser", password, { now: later })).toBe(true);
    expect(basicAuthScryptOperations()).toBe(before + 2);
    expect(await verifyBasicCredentials(users, "scryptuser", `${password}-no`)).toBe(false);
    expect(await verifyBasicCredentials(users, "scryptuser", `${password}-no`)).toBe(false);
    expect(basicAuthScryptOperations()).toBe(before + 4);

    const rotated = parseBasicAuthUsers(scryptUser("scryptuser", `${password}-rotated`));
    expect(credentialFingerprint(rotated[0]!)).not.toBe(credentialFingerprint(users[0]!));
    expect(await verifyBasicCredentials(rotated, "scryptuser", password)).toBe(false);
  });
});

describe("sign-in backoff", () => {
  it("backs off per address and per user, and a success clears only the user", () => {
    let now = 1_000_000;
    const limiter = new AuthAttemptLimiter({
      freeFailures: 1,
      baseDelayMs: 1000,
      now: () => now,
    });
    expect(limiter.recordFailure("203.0.113.5", "alice")).toBe(0);
    expect(limiter.recordFailure("203.0.113.5", "alice")).toBe(1000);
    expect(limiter.retryAfterMs("203.0.113.9", "alice")).toBe(1000);
    expect(limiter.retryAfterMs("203.0.113.5", "bob")).toBe(1000);
    now += 1000;
    limiter.recordSuccess("alice");
    expect(limiter.retryAfterMs("198.51.100.4", "alice")).toBe(0);
    expect(limiter.recordFailure("203.0.113.5", "bob")).toBe(2000);
    expect(limiter.retryAfterMs("198.51.100.8", "bob")).toBe(0);
    const forwarded = {
      socket: { remoteAddress: "203.0.113.10" },
      headers: { "x-forwarded-for": "198.51.100.20" },
    } as unknown as IncomingMessage;
    expect(clientAddress(forwarded)).toBe("203.0.113.10");
  });

  it("rate limits Basic authentication on /mcp", async () => {
    let now = 5_000_000;
    const limiter = new AuthAttemptLimiter({
      freeFailures: 1,
      baseDelayMs: 2000,
      now: () => now,
    });
    const users = parseBasicAuthUsers(`alice:${PASSWORD}`);
    const handler = createHttpRequestHandler({
      routes: { health: "/health", mcp: "/mcp", webhook: "/cloud-webhook" },
      oauth: null,
      authorize: (req, res) =>
        authorizeMcpHttpRequest(req, res, { basicUsers: users, limiter }, null),
      health: (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      mcp: async (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      webhook: async (_req, res) => {
        res.writeHead(200);
        res.end();
      },
    });
    const harness = await listen(handler);
    const basic = (password: string, forwardedFor?: string) =>
      fetch(`${harness.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`alice:${password}`).toString("base64")}`,
          ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
        },
      });
    expect((await basic(`${PASSWORD}-wrong`)).status).toBe(401);
    const limited = await basic(`${PASSWORD}-wrong`, "198.51.100.50");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("2");
    expect(await limited.text()).not.toContain(PASSWORD);
    expect((await basic(PASSWORD, "198.51.100.51")).status).toBe(429);
    now += 2000;
    expect((await basic(PASSWORD)).status).toBe(200);
  });

  it("rate limits the authorization password", async () => {
    let now = 8_000_000;
    const limiter = new AuthAttemptLimiter({
      freeFailures: 1,
      baseDelayMs: 2000,
      now: () => now,
    });
    const users = parseBasicAuthUsers(`alice:${PASSWORD}`);
    const store = openOAuthStore(":memory:");
    const oauth = new McpOAuthServer({
      issuerUrl: ISSUER,
      resourceUrl: RESOURCE,
      store,
      limiter,
      validateCredential: (username, password) => verifyBasicCredentials(users, username, password),
      log: { info() {}, warn() {} },
    });
    const handler = createHttpRequestHandler({
      routes: { health: "/health", mcp: "/mcp", webhook: "/cloud-webhook" },
      oauth,
      authorize: (req, res) => authorizeMcpHttpRequest(req, res, { basicUsers: users }, oauth),
      health: (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      mcp: async (_req, res) => {
        res.writeHead(204);
        res.end();
      },
      webhook: async (_req, res) => {
        res.writeHead(200);
        res.end();
      },
    });
    const harness = await listen(handler);
    closers.push(async () => oauth.close());

    const registered = await fetch(`${harness.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Remote",
        redirect_uris: [REDIRECT],
        application_type: "web",
      }),
    });
    const clientId = String(((await registered.json()) as { client_id: string }).client_id);
    const { challenge } = pkce();
    const authorize = (password: string) =>
      fetch(`${harness.baseUrl}/oauth/authorize`, {
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
          username: "alice",
          password,
        }),
      });
    expect((await authorize(`${PASSWORD}-wrong`)).status).toBe(401);
    const locked = await authorize(`${PASSWORD}-wrong`);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("2");
    const body = await locked.json();
    expect(body).toMatchObject({ error: "temporarily_unavailable" });
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
    expect((await authorize(PASSWORD)).status).toBe(429);
    now += 2000;
    expect((await authorize(PASSWORD)).status).toBe(302);
  });
});

describe("OAuth credential binding and revocation", () => {
  it("invalidates tokens when the Basic user is removed or rotated, and accepts revoke", async () => {
    let users = parseBasicAuthUsers(`alice:${PASSWORD},bob:other-secret`);
    const versionOf = (username: string) => {
      const user = findBasicUser(users, username);
      return user ? credentialFingerprint(user) : undefined;
    };
    const store = openOAuthStore(":memory:");
    const oauth = new McpOAuthServer({
      issuerUrl: ISSUER,
      resourceUrl: RESOURCE,
      store,
      apiKey: "test-api-key",
      validateCredential: (username, password) => verifyBasicCredentials(users, username, password),
      resolveCredentialVersion: versionOf,
      log: { info() {}, warn() {} },
    });
    const handler = createHttpRequestHandler({
      routes: { health: "/health", mcp: "/mcp", webhook: "/cloud-webhook" },
      oauth,
      authorize: (req, res) => authorizeMcpHttpRequest(req, res, { basicUsers: users }, oauth),
      health: (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      mcp: async (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      webhook: async (_req, res) => {
        res.writeHead(200);
        res.end();
      },
    });
    const harness = await listen(handler);
    closers.push(async () => oauth.close());

    const registered = await fetch(`${harness.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], application_type: "web" }),
    });
    const clientId = String(((await registered.json()) as { client_id: string }).client_id);
    const issue = async () => {
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
          username: "alice",
          password: PASSWORD,
        }),
      });
      const code = new URL(granted.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const token = await fetch(`${harness.baseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: RESOURCE,
        }),
      });
      const json = (await token.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      return { code, verifier, ...json, status: token.status };
    };

    const first = await issue();
    expect(first.status).toBe(200);
    expect(first.expires_in).toBe(3600);
    expect(oauth.authenticateAccessToken(first.access_token)).toBe(true);
    const replay = await fetch(`${harness.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: first.code,
        redirect_uri: REDIRECT,
        code_verifier: first.verifier,
        resource: RESOURCE,
      }),
    });
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
    expect(oauth.authenticateAccessToken(first.access_token)).toBe(false);
    const replayRefresh = await fetch(`${harness.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: first.refresh_token,
        resource: RESOURCE,
      }),
    });
    expect(replayRefresh.status).toBe(400);

    const second = await issue();
    const refreshed = await fetch(`${harness.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: second.refresh_token,
        resource: RESOURCE,
      }),
    });
    const refreshedJson = (await refreshed.json()) as { expires_in: number; refresh_token: string };
    expect(refreshed.status).toBe(200);
    expect(refreshedJson.expires_in).toBe(900);

    const live = await issue();
    users = parseBasicAuthUsers(`alice:${PASSWORD}-rotated,bob:other-secret`);
    expect(oauth.authenticateAccessToken(live.access_token)).toBe(false);
    const rotatedRefresh = await fetch(`${harness.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: live.refresh_token,
        resource: RESOURCE,
      }),
    });
    expect(rotatedRefresh.status).toBe(400);
    const rotatedFamilyRefresh = await fetch(`${harness.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshedJson.refresh_token,
        resource: RESOURCE,
      }),
    });
    expect(rotatedFamilyRefresh.status).toBe(400);

    users = parseBasicAuthUsers(`alice:${PASSWORD},bob:other-secret`);
    const third = await issue();
    users = parseBasicAuthUsers("bob:other-secret");
    expect(oauth.authenticateAccessToken(third.access_token)).toBe(false);

    users = parseBasicAuthUsers(`alice:${PASSWORD},bob:other-secret`);
    const fourth = await issue();
    const wrongClient = await fetch(`${harness.baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: fourth.access_token, client_id: "someone-else" }),
    });
    expect(wrongClient.status).toBe(200);
    expect(oauth.authenticateAccessToken(fourth.access_token)).toBe(true);
    const revoked = await fetch(`${harness.baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: fourth.access_token, client_id: clientId }),
    });
    expect(revoked.status).toBe(200);
    expect(oauth.authenticateAccessToken(fourth.access_token)).toBe(false);
    const again = await fetch(`${harness.baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "missing-token", client_id: clientId }),
    });
    expect(again.status).toBe(200);

    const fifth = await issue();
    const denied = await fetch(`${harness.baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from("bob:other-secret").toString("base64")}`,
      },
      body: new URLSearchParams({ username: "alice" }),
    });
    expect(denied.status).toBe(401);
    expect(oauth.authenticateAccessToken(fifth.access_token)).toBe(true);
    const byUser = await fetch(`${harness.baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`alice:${PASSWORD}`).toString("base64")}`,
      },
      body: new URLSearchParams({ username: "alice" }),
    });
    expect(byUser.status).toBe(200);
    expect(oauth.authenticateAccessToken(fifth.access_token)).toBe(false);

    const sixth = await issue();
    const byKey = await fetch(`${harness.baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Bearer test-api-key",
      },
      body: new URLSearchParams({ username: "alice" }),
    });
    expect(byKey.status).toBe(200);
    expect(oauth.authenticateAccessToken(sixth.access_token)).toBe(false);
  });
});

describe("dynamic client registration scope", () => {
  it("counts registrations per IP and can disable or allowlist redirects", async () => {
    const store = openOAuthStore(":memory:");
    store.maxRegistrationsPerWindow = 1;
    const first = clientRecord([REDIRECT], "web");
    const second = clientRecord(["https://other.example/cb"], "web");
    const third = clientRecord(["https://third.example/cb"], "web");
    store.registerClient(first, "203.0.113.8");
    store.registerClient(second, "203.0.113.9");
    expect(() => store.registerClient(third, "203.0.113.8")).toThrow(OAuthFlowError);
    store.close();

    const limited = openOAuthStore(":memory:");
    limited.maxClients = 1;
    limited.registerClient(clientRecord([REDIRECT], "web"), "203.0.113.1");
    expect(() =>
      limited.registerClient(clientRecord(["https://other.example/cb"], "web"), "198.51.100.2"),
    ).toThrow(OAuthFlowError);
    limited.close();

    const users = parseBasicAuthUsers(`alice:${PASSWORD}`);
    const oauth = new McpOAuthServer({
      issuerUrl: ISSUER,
      resourceUrl: RESOURCE,
      store: openOAuthStore(":memory:"),
      dynamicRegistration: "disabled",
      redirectHostAllowlist: ["client.example", "app"],
      validateCredential: (username, password) => verifyBasicCredentials(users, username, password),
      log: { info() {}, warn() {} },
    });
    oauth.store.maxRegistrationsPerWindow = 1;
    const handler = createHttpRequestHandler({
      routes: { health: "/health", mcp: "/mcp", webhook: "/cloud-webhook" },
      oauth,
      authorize: (req, res) => authorizeMcpHttpRequest(req, res, { basicUsers: users }, oauth),
      health: (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      mcp: async (_req, res) => {
        res.writeHead(204);
        res.end();
      },
      webhook: async (_req, res) => {
        res.writeHead(200);
        res.end();
      },
    });
    const harness = await listen(handler);
    closers.push(async () => oauth.close());
    const metadata = await fetch(`${harness.baseUrl}/.well-known/oauth-authorization-server`);
    const document = (await metadata.json()) as Record<string, unknown>;
    expect(document.registration_endpoint).toBeUndefined();
    expect(document.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
    expect(metadata.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await fetch(`${harness.baseUrl}/oauth/token`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Content-Type");
    const register = await fetch(`${harness.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    expect(register.status).toBe(403);
    expect(oauth.store.clientCount()).toBe(0);
    const authorize = await fetch(`${harness.baseUrl}/oauth/authorize`, { method: "OPTIONS" });
    expect(authorize.headers.get("access-control-allow-origin")).toBeNull();

    expect(
      loadHttpTransportConfig({
        WA_BASIC_AUTH: "alice:secret",
        WA_MCP_OAUTH_ENABLED: "true",
        WA_MCP_OAUTH_ISSUER_URL: "https://example.com",
        WA_MCP_OAUTH_DCR: "disabled",
        WA_MCP_OAUTH_REDIRECT_HOST_ALLOWLIST: "Client.Example, app",
      }).oauth,
    ).toMatchObject({
      dynamicRegistration: "disabled",
      redirectHostAllowlist: ["client.example", "app"],
    });
    expect(() =>
      loadHttpTransportConfig({
        WA_BASIC_AUTH: "alice:secret",
        WA_MCP_OAUTH_ENABLED: "true",
        WA_MCP_OAUTH_ISSUER_URL: "https://example.com",
        WA_MCP_OAUTH_DCR: "sometimes",
      }),
    ).toThrow(/WA_MCP_OAUTH_DCR/);
    expect(loadHttpTransportConfig({ WA_MCP_OAUTH_DCR: "sometimes" }).oauth.enabled).toBe(false);
  });

  it("accepts native scheme redirects and enforces an allowlist", async () => {
    expect(validRedirectUri("app:/cb", "native")).toBe(true);
    expect(validRedirectUri("app:/cb", "web")).toBe(false);
    expect(validRedirectUri("javascript:alert(1)", "native")).toBe(false);
    expect(validRedirectUri("file:///tmp/cb", "native")).toBe(false);
    expect(validRedirectUri("app:", "native")).toBe(false);
    expect(redirectHostAllowed("app:/cb", ["app"])).toBe(true);
    expect(redirectHostAllowed("other:/cb", ["app"])).toBe(false);
    expect(redirectHostAllowed("https://client.example/callback", ["client.example"])).toBe(true);
    expect(redirectHostAllowed("https://evil.example/callback", ["client.example"])).toBe(false);
    expect(redirectHostAllowed("https://evil.example/callback", [])).toBe(true);

    const users = parseBasicAuthUsers(`alice:${PASSWORD}`);
    const oauth = new McpOAuthServer({
      issuerUrl: ISSUER,
      resourceUrl: RESOURCE,
      store: openOAuthStore(":memory:"),
      redirectHostAllowlist: ["client.example", "app"],
      validateCredential: (username, password) => verifyBasicCredentials(users, username, password),
      log: { info() {}, warn() {} },
    });
    const handler = createHttpRequestHandler({
      routes: { health: "/health", mcp: "/mcp", webhook: "/cloud-webhook" },
      oauth,
      authorize: (req, res) => authorizeMcpHttpRequest(req, res, { basicUsers: users }, oauth),
      health: (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      mcp: async (_req, res) => {
        res.writeHead(204);
        res.end();
      },
      webhook: async (_req, res) => {
        res.writeHead(200);
        res.end();
      },
    });
    const harness = await listen(handler);
    closers.push(async () => oauth.close());
    const native = await fetch(`${harness.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["app:/cb"],
        application_type: "native",
      }),
    });
    expect(native.status).toBe(201);
    const webScheme = await fetch(`${harness.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["app:/cb"],
        application_type: "web",
      }),
    });
    expect(webScheme.status).toBe(400);
    const deniedHost = await fetch(`${harness.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://evil.example/callback"],
        application_type: "web",
      }),
    });
    expect(deniedHost.status).toBe(400);
    const tokenCors = await fetch(`${harness.baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(tokenCors.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("OAuth database permissions and stdio config", () => {
  it("creates the OAuth database as 0600 inside a 0700 directory", () => {
    const root = mkdtempSync(join(tmpdir(), "wamcp-oauth-"));
    try {
      const directory = join(root, "state");
      const file = join(directory, "oauth.db");
      const store = openOAuthStore(file);
      store.registerClient(clientRecord([REDIRECT], "web"), "203.0.113.7");
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      for (const suffix of ["-wal", "-shm"]) {
        try {
          expect(statSync(`${file}${suffix}`).mode & 0o777).toBe(0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds credential columns to an OAuth database created before they existed", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        token_type TEXT NOT NULL,
        family_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        resource TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    migrateOAuthSchema(db);
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (column) => column.name,
      );
    expect(columns("oauth_tokens")).toContain("credential_version");
    expect(columns("oauth_authorization_codes")).toEqual(
      expect.arrayContaining(["family_id", "credential_version"]),
    );
    db.close();
  });

  it("does not parse HTTP auth settings for the stdio transport", () => {
    expect(
      loadHttpTransportConfigForTransport("stdio", { WA_BASIC_AUTH: "not-a-user-password-pair" }),
    ).toBeUndefined();
    expect(() =>
      loadHttpTransportConfigForTransport("http", { WA_BASIC_AUTH: "not-a-user-password-pair" }),
    ).toThrow(/user:password/);
    expect(() =>
      loadHttpTransportConfigForTransport(undefined, { WA_BASIC_AUTH: "not-a-user-password-pair" }),
    ).toThrow(/user:password/);
  });
});
