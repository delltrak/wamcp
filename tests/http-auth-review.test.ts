import { createHash, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthAttemptLimiter, clientAddress } from "../src/server/auth-limiter.js";
import {
  ScryptBusyError,
  basicAuthScryptOperations,
  clearBasicAuthSuccessCache,
  credentialFingerprint,
  parseBasicAuthUsers,
  setBasicAuthScryptLimit,
  verifyBasicCredentials,
} from "../src/server/basic-auth.js";
import {
  loadHttpTransportConfig,
  loadHttpTransportConfigForTransport,
} from "../src/server/http-config.js";
import { createHttpRequestHandler } from "../src/server/http-listener.js";
import { authorizeMcpHttpRequest } from "../src/server/mcp-auth.js";
import { normalizeClientIp, parseTrustProxy } from "../src/server/ip-address.js";
import { credentialMacKeyPath, loadCredentialMacKey } from "../src/server/oauth/credential-key.js";
import { redirectUriMatches, validRedirectUri } from "../src/server/oauth/redirect.js";
import { McpOAuthServer } from "../src/server/oauth/server.js";
import {
  OAuthFlowError,
  newOAuthClientId,
  openOAuthStore,
  type OAuthClient,
} from "../src/server/oauth/store.js";

const ISSUER = "https://example.com";
const RESOURCE = "https://example.com/mcp";
const REDIRECT = "https://client.example/callback";
const PASSWORD = "pw-do-not-leak-918273";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  setBasicAuthScryptLimit(2);
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function mockResponse(): ServerResponse & { statusCode: number } {
  const response = {
    statusCode: 0,
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end() {
      return this;
    },
  };
  return response as unknown as ServerResponse & { statusCode: number };
}

describe("concurrent sign-in attempts", () => {
  it("counts a burst before any password check and does not extend an existing lock", () => {
    let now = 1_000;
    const limiter = new AuthAttemptLimiter({
      freeFailures: 8,
      baseDelayMs: 1000,
      now: () => now,
    });
    const results = Array.from({ length: 300 }, () => limiter.beginAttempt("203.0.113.5", "alice"));
    expect(results.filter((wait) => wait === 0)).toHaveLength(8);
    expect(results.slice(8).every((wait) => wait > 0)).toBe(true);
    expect(results[299]).toBe(results[8]);
    now += results[8] ?? 0;
    expect(limiter.beginAttempt("203.0.113.5", "alice")).toBe(0);
  });

  it("refuses the correct password once the in-flight budget is exhausted", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checks = 0;
    const limiter = new AuthAttemptLimiter({ freeFailures: 1, baseDelayMs: 60_000 });
    const store = openOAuthStore(":memory:");
    const oauth = new McpOAuthServer({
      issuerUrl: ISSUER,
      resourceUrl: RESOURCE,
      store,
      limiter,
      validateCredential: async (_username, password) => {
        checks += 1;
        await gate;
        return password === PASSWORD;
      },
      log: { info() {}, warn() {} },
    });
    const harness = await listen((req, res) => oauth.handle(req, res));
    closers.push(async () => oauth.close());
    const registered = await fetch(`${harness.baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], application_type: "web" }),
    });
    const clientId = String(((await registered.json()) as { client_id: string }).client_id);
    const authorize = (password: string) =>
      fetch(`${harness.baseUrl}/oauth/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
          resource: RESOURCE,
          scope: "mcp",
          username: "alice",
          password,
        }),
      });

    const first = authorize(`${PASSWORD}-wrong`);
    await waitFor(() => checks === 1);
    const burst = await Promise.all(
      Array.from({ length: 20 }, (_value, index) =>
        authorize(index === 19 ? PASSWORD : `${PASSWORD}-wrong`),
      ),
    );
    expect(burst.map((response) => response.status)).toEqual(Array.from({ length: 20 }, () => 429));
    expect(checks).toBe(1);
    release();
    expect((await first).status).toBe(401);
  });

  it("does not let a trailing correct Basic password skip the backoff", async () => {
    clearBasicAuthSuccessCache();
    const limiter = new AuthAttemptLimiter({ freeFailures: 1, baseDelayMs: 60_000 });
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
        res.writeHead(200);
        res.end();
      },
      webhook: async (_req, res) => {
        res.writeHead(200);
        res.end();
      },
    });
    const harness = await listen(handler);
    const basic = (password: string) =>
      fetch(`${harness.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`alice:${password}`).toString("base64")}`,
        },
      });
    const before = basicAuthScryptOperations();
    const first = basic(`${PASSWORD}-wrong`);
    await waitFor(() => basicAuthScryptOperations() > before);
    const during = basicAuthScryptOperations();
    const burst = await Promise.all(
      Array.from({ length: 20 }, (_value, index) =>
        basic(index === 19 ? PASSWORD : `${PASSWORD}-also-wrong`),
      ),
    );
    expect(burst.every((response) => response.status === 429)).toBe(true);
    expect(basicAuthScryptOperations()).toBe(during);
    expect((await first).status).toBe(401);
  });
});

describe("trusted proxies and address buckets", () => {
  it("uses X-Forwarded-For only when the socket peer is trusted", () => {
    const trust = parseTrustProxy("127.0.0.1/32,10.0.0.0/8");
    const request = (peer: string, forwarded: string) =>
      ({
        socket: { remoteAddress: peer },
        headers: { "x-forwarded-for": forwarded },
      }) as unknown as IncomingMessage;
    expect(clientAddress(request("127.0.0.1", "203.0.113.9"), trust)).toBe("203.0.113.9");
    expect(clientAddress(request("198.51.100.1", "203.0.113.9"), trust)).toBe("198.51.100.1");
    expect(clientAddress(request("10.1.1.1", "1.2.3.4, 10.1.1.1"), trust)).toBe("1.2.3.4");
    expect(clientAddress(request("127.0.0.1", "203.0.113.9"))).toBe("127.0.0.1");
    expect(clientAddress(request("::ffff:127.0.0.1", "203.0.113.9"), trust)).toBe("203.0.113.9");
  });

  it("groups IPv6 by /64 and folds IPv4-mapped addresses", () => {
    expect(normalizeClientIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeClientIp("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(normalizeClientIp("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeClientIp("2001:db8:1:2::1")).toBe(normalizeClientIp("2001:db8:1:2::abcd"));
    expect(normalizeClientIp("2001:db8:1:2::1")).not.toBe(normalizeClientIp("2001:db8:1:3::1"));

    const limiter = new AuthAttemptLimiter({ freeFailures: 1, baseDelayMs: 1000, now: () => 50 });
    expect(limiter.beginAttempt("2001:db8:1:2::1", "alice")).toBe(0);
    expect(limiter.beginAttempt("2001:db8:1:2::2", "bob")).toBe(1000);
    expect(limiter.beginAttempt("2001:db8:9:9::1", "carol")).toBe(0);
    expect(limiter.beginAttempt("::ffff:127.0.0.1", "dave")).toBe(0);
    expect(limiter.beginAttempt("127.0.0.1", "erin")).toBe(1000);
  });

  it("parses WA_TRUST_PROXY and ignores it on stdio", () => {
    expect(loadHttpTransportConfig({}).trustProxy).toBeUndefined();
    expect(() => loadHttpTransportConfig({ WA_TRUST_PROXY: "not-a-cidr" })).toThrow(
      /WA_TRUST_PROXY/,
    );
    const config = loadHttpTransportConfig({ WA_TRUST_PROXY: "127.0.0.1/32,10.0.0.0/8" });
    expect(config.trustProxy?.matches("10.2.3.4")).toBe(true);
    expect(config.trustProxy?.matches("::ffff:10.2.3.4")).toBe(true);
    expect(config.trustProxy?.matches("203.0.113.1")).toBe(false);
    expect(
      loadHttpTransportConfigForTransport("stdio", {
        WA_TRUST_PROXY: "not-a-cidr",
        WA_BASIC_AUTH: "not-a-pair",
      }),
    ).toBeUndefined();
  });

  it("shares one registration bucket inside an IPv6 /64", () => {
    const store = openOAuthStore(":memory:");
    store.maxRegistrationsPerWindow = 1;
    store.registerClient(clientRecord([REDIRECT], "web"), "2001:db8:1:2::1");
    expect(() =>
      store.registerClient(clientRecord([REDIRECT], "web"), "2001:db8:1:2::abcd"),
    ).toThrow(OAuthFlowError);
    store.registerClient(clientRecord([REDIRECT], "web"), "2001:db8:9:9::1");
    store.close();
  });
});

describe("per-user lock exemption", () => {
  it("does not apply a user lock to an address with a recent success", () => {
    let now = 10_000;
    const limiter = new AuthAttemptLimiter({
      freeFailures: 1,
      baseDelayMs: 60_000,
      recentSuccessMs: 1_000,
      now: () => now,
    });
    limiter.recordSuccess("203.0.113.8", "alice");
    expect(limiter.beginAttempt("198.51.100.1", "alice")).toBe(0);
    expect(limiter.beginAttempt("198.51.100.1", "alice")).toBe(60_000);
    expect(limiter.retryAfterMs("203.0.113.8", "alice")).toBe(0);
    expect(limiter.beginAttempt("203.0.113.8", "alice")).toBe(0);
    expect(limiter.retryAfterMs("203.0.113.9", "alice")).toBeGreaterThan(0);
    expect(limiter.beginAttempt("198.51.100.1", "bob")).toBe(60_000);
    now += 1_000;
    expect(limiter.retryAfterMs("203.0.113.8", "alice")).toBeGreaterThan(0);
  });
});

describe("scrypt concurrency cap", () => {
  it("rejects extra scrypt work immediately and cancels the auth reservation", async () => {
    setBasicAuthScryptLimit(1);
    clearBasicAuthSuccessCache();
    const users = parseBasicAuthUsers(scryptUser("alice", PASSWORD));
    const before = basicAuthScryptOperations();
    const pending = verifyBasicCredentials(users, "alice", PASSWORD);
    const settled = await Promise.allSettled(
      Array.from({ length: 9 }, () => verifyBasicCredentials(users, "alice", PASSWORD)),
    );
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
    for (const result of settled) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ScryptBusyError);
    }
    expect(basicAuthScryptOperations()).toBe(before + 1);
    expect(await pending).toBe(true);

    clearBasicAuthSuccessCache();
    setBasicAuthScryptLimit(0);
    const limiter = new AuthAttemptLimiter({ freeFailures: 1, now: () => 20 });
    const response = mockResponse();
    const allowed = await authorizeMcpHttpRequest(
      {
        socket: { remoteAddress: "203.0.113.8" },
        headers: {
          authorization: `Basic ${Buffer.from(`alice:${PASSWORD}`).toString("base64")}`,
        },
      } as unknown as IncomingMessage,
      response,
      { basicUsers: users, limiter },
      null,
    );
    expect(allowed).toBe(false);
    expect(response.statusCode).toBe(429);
    expect(limiter.beginAttempt("203.0.113.8", "alice")).toBe(0);
  });
});

describe("access token rotation and user revocation", () => {
  it("uses a 15 minute access token and revokes the previous one on refresh", () => {
    const store = openOAuthStore(":memory:");
    const client = clientRecord([REDIRECT], "web");
    store.registerClient(client, "203.0.113.7");
    const { verifier, challenge } = pkce();
    const now = new Date("2026-10-20T00:00:00Z");
    const code = store.issueAuthorizationCode(
      {
        clientId: client.id,
        subject: "alice",
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        resource: RESOURCE,
        scope: "mcp",
      },
      now,
    );
    const issued = store.exchangeAuthorizationCode(
      {
        clientId: client.id,
        code,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
        resource: RESOURCE,
      },
      now,
    );
    expect(issued.expiresIn).toBe(900);
    expect(store.validateAccessToken(issued.accessToken, RESOURCE, now)?.subject).toBe("alice");
    const rotated = store.rotateRefreshToken(
      { clientId: client.id, refreshToken: issued.refreshToken, resource: RESOURCE },
      now,
    );
    expect(rotated.expiresIn).toBe(900);
    expect(store.validateAccessToken(issued.accessToken, RESOURCE, now)).toBeUndefined();
    expect(store.validateAccessToken(rotated.accessToken, RESOURCE, now)?.subject).toBe("alice");
    store.close();
  });

  it("invalidates unused authorization codes when the user is revoked", () => {
    const store = openOAuthStore(":memory:");
    const client = clientRecord([REDIRECT], "web");
    store.registerClient(client, "203.0.113.7");
    const { verifier, challenge } = pkce();
    const now = new Date("2026-10-20T00:00:00Z");
    const code = store.issueAuthorizationCode(
      {
        clientId: client.id,
        subject: "alice",
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        resource: RESOURCE,
        scope: "mcp",
      },
      now,
    );
    store.revokeSubject("alice", now);
    expect(() =>
      store.exchangeAuthorizationCode(
        {
          clientId: client.id,
          code,
          redirectUri: REDIRECT,
          codeVerifier: verifier,
          resource: RESOURCE,
        },
        now,
      ),
    ).toThrow(OAuthFlowError);
    store.close();
  });

  it("rejects a token whose credential version is empty", () => {
    const store = openOAuthStore(":memory:");
    store.credentialVersion = () => "current-version";
    const client = clientRecord([REDIRECT], "web");
    store.registerClient(client, "203.0.113.7");
    const { verifier, challenge } = pkce();
    const now = new Date("2026-10-20T00:00:00Z");
    const code = store.issueAuthorizationCode(
      {
        clientId: client.id,
        subject: "alice",
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        resource: RESOURCE,
        scope: "mcp",
        credentialVersion: "",
      },
      now,
    );
    expect(() =>
      store.exchangeAuthorizationCode(
        {
          clientId: client.id,
          code,
          redirectUri: REDIRECT,
          codeVerifier: verifier,
          resource: RESOURCE,
        },
        now,
      ),
    ).toThrow(OAuthFlowError);
    store.close();
  });
});

describe("OAuth database directory permissions", () => {
  it("does not change the mode of an existing directory", () => {
    const root = mkdtempSync(join(tmpdir(), "wamcp-oauth-"));
    const rootMode = statSync(root).mode & 0o777;
    const parentMode = statSync(tmpdir()).mode & 0o777;
    const loose = join(tmpdir(), `wamcp-oauth-loose-${randomBytes(4).toString("hex")}.db`);
    try {
      const directory = join(root, "data");
      mkdirSync(directory, { mode: 0o755 });
      chmodSync(directory, 0o755);
      const file = join(directory, "oauth.db");
      const store = openOAuthStore(file);
      expect(statSync(directory).mode & 0o777).toBe(0o755);
      expect(statSync(root).mode & 0o777).toBe(rootMode);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const macPath = credentialMacKeyPath(file);
      expect(statSync(macPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(macPath).equals(store.macKey)).toBe(true);
      expect(loadCredentialMacKey(file).equals(store.macKey)).toBe(true);
      store.close();

      const looseStore = openOAuthStore(loose);
      expect(statSync(tmpdir()).mode & 0o777).toBe(parentMode);
      expect(statSync(loose).mode & 0o777).toBe(0o600);
      expect(statSync(credentialMacKeyPath(loose)).mode & 0o777).toBe(0o600);
      looseStore.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(loose, { force: true });
      rmSync(`${loose}-wal`, { force: true });
      rmSync(`${loose}-shm`, { force: true });
      rmSync(credentialMacKeyPath(loose), { force: true });
    }
  });
});

describe("credential version HMAC", () => {
  it("does not store an unsalted password hash", () => {
    const user = parseBasicAuthUsers("alice:secret")[0];
    if (!user) throw new Error("expected a user");
    const macKey = randomBytes(32);
    const fingerprint = credentialFingerprint(user, macKey);
    const unsalted = createHash("sha256").update("alice\0plain\0secret").digest("hex");
    expect(fingerprint).not.toBe(unsalted);
    expect(credentialFingerprint(user, randomBytes(32))).not.toBe(fingerprint);
    expect(credentialFingerprint(user, macKey)).toBe(fingerprint);
  });
});

describe("redirect URI rules", () => {
  it("rejects non-reverse-DNS and handler schemes, and requires a loopback port", () => {
    const rejected = [
      "ftp://files.example/cb",
      "mailto:user@example.com",
      "intent://scan",
      "view-source:https://example.com",
      "jar:http://example.com/app.jar!/cb",
      "http+unix://var/run/app.sock/cb",
      "x-javascript:alert(1)",
      "app:/cb",
      "http://127.0.0.1/cb",
      "http://localhost/cb",
      "http://[::1]/cb",
    ];
    for (const uri of rejected) expect(validRedirectUri(uri, "native")).toBe(false);
    expect(validRedirectUri("com.example.app:/cb", "native")).toBe(true);
    expect(validRedirectUri("com.example.app:/cb", "web")).toBe(false);
    expect(validRedirectUri("http://127.0.0.1:8080/cb", "native")).toBe(true);
    expect(validRedirectUri("http://localhost:8080/cb", "native")).toBe(true);
    expect(validRedirectUri("http://[::1]:8080/cb", "native")).toBe(true);

    const loopback = clientRecord(["http://127.0.0.1:1234/cb"], "native");
    expect(redirectUriMatches(loopback, "http://127.0.0.1:5678/cb")).toBe(true);
    const localhost = clientRecord(["http://localhost:1234/cb"], "native");
    expect(redirectUriMatches(localhost, "http://localhost:5678/cb")).toBe(false);
  });
});

describe("revocation CORS", () => {
  it("sends the same CORS headers as the token endpoint", async () => {
    const store = openOAuthStore(":memory:");
    const oauth = new McpOAuthServer({
      issuerUrl: ISSUER,
      resourceUrl: RESOURCE,
      store,
      validateCredential: async () => false,
      log: { info() {}, warn() {} },
    });
    const harness = await listen((req, res) => oauth.handle(req, res));
    closers.push(async () => oauth.close());
    const revoke = await fetch(`${harness.baseUrl}/oauth/revoke`, { method: "OPTIONS" });
    const token = await fetch(`${harness.baseUrl}/oauth/token`, { method: "OPTIONS" });
    expect(revoke.status).toBe(204);
    expect(revoke.headers.get("access-control-allow-origin")).toBe("*");
    expect(revoke.headers.get("access-control-allow-methods")).toBe(
      token.headers.get("access-control-allow-methods"),
    );
    expect(revoke.headers.get("access-control-allow-headers")).toBe(
      token.headers.get("access-control-allow-headers"),
    );
    const authorize = await fetch(`${harness.baseUrl}/oauth/authorize?response_type=code`);
    expect(authorize.headers.get("access-control-allow-origin")).toBeNull();
  });
});
