import { createHash, randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthAttemptLimiter, clientAddress } from "../src/server/auth-limiter.js";
import {
  BASIC_AUTH_SCRYPT_QUEUE_MAX,
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
import { createHttpRequestHandler, normalizeClientIp } from "../src/server/http-listener.js";
import { authorizeMcpHttpRequest } from "../src/server/mcp-auth.js";
import { parseTrustProxy } from "../src/server/ip-address.js";
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
    const results = Array.from(
      { length: 300 },
      () => limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs,
    );
    expect(results.filter((wait) => wait === 0)).toHaveLength(9);
    expect(results.slice(9).every((wait) => wait > 0)).toBe(true);
    expect(results[299]).toBe(results[9]);
    now += results[9] ?? 0;
    const after = limiter.beginAttempt("203.0.113.5", "alice");
    expect(after.retryAfterMs).toBe(0);
    expect(limiter.retryAfterMs("203.0.113.5", "alice")).toBe(2000);
  });

  it("doubles the lock on each later cycle until the maximum, then forgets an idle bucket", () => {
    let now = 0;
    const base = 1000;
    const max = 8_000;
    const limiter = new AuthAttemptLimiter({
      freeFailures: 1,
      baseDelayMs: base,
      maxDelayMs: max,
      now: () => now,
    });
    expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(0);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(0);
      const wait = limiter.retryAfterMs("203.0.113.5", "alice");
      expect(wait).toBe(Math.min(base * 2 ** cycle, max));
      expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(wait);
      now += wait;
    }
    expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(0);
    expect(limiter.retryAfterMs("203.0.113.5", "alice")).toBe(max);
    const held = limiter.retryAfterMs("203.0.113.5", "alice");
    expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(held);
    now += held + max;
    expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(0);
  });

  it("keeps the backoff at the ceiling after a 15 minute lock", () => {
    let now = 0;
    const max = 15 * 60 * 1000;
    const limiter = new AuthAttemptLimiter({
      freeFailures: 1,
      baseDelayMs: 1000,
      maxDelayMs: max,
      now: () => now,
    });
    expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(0);
    let wait = 0;
    for (let cycle = 0; cycle < 12; cycle += 1) {
      expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(0);
      wait = limiter.retryAfterMs("203.0.113.5", "alice");
      expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(wait);
      now += wait;
    }
    expect(wait).toBe(max);
    expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(0);
    expect(limiter.retryAfterMs("203.0.113.5", "alice")).toBe(max);
  });

  it("refuses the correct password once the in-flight budget is exhausted", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checks = 0;
    const limiter = new AuthAttemptLimiter({ freeFailures: 0, baseDelayMs: 60_000 });
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
    const limiter = new AuthAttemptLimiter({ freeFailures: 0, baseDelayMs: 60_000 });
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

  it("accepts 50 correct Basic logins from the same address", async () => {
    const limiter = new AuthAttemptLimiter();
    const users = parseBasicAuthUsers(`alice:${PASSWORD},bob:${PASSWORD}-bob`);
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
    const basic = (username: string, password: string) =>
      fetch(`${harness.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        },
      });
    const statuses: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      statuses.push((await basic("alice", PASSWORD)).status);
    }
    expect(statuses).toEqual(Array.from({ length: 50 }, () => 200));
  });

  it("does not rate limit another user on that address", async () => {
    const limiter = new AuthAttemptLimiter();
    const users = parseBasicAuthUsers(`alice:${PASSWORD},bob:${PASSWORD}-bob`);
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
    const basic = (username: string, password: string) =>
      fetch(`${harness.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        },
      });
    for (let index = 0; index < 50; index += 1) {
      expect((await basic("alice", PASSWORD)).status).toBe(200);
    }
    expect((await basic("bob", `${PASSWORD}-bob`)).status).toBe(200);
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
    expect(clientAddress(request("127.0.0.1", "203.0.113.4:5555"), trust)).toBe("203.0.113.4");
    expect(clientAddress(request("127.0.0.1", "[2001:db8::5]:443"), trust)).toBe(
      normalizeClientIp("2001:db8::5"),
    );
    expect(clientAddress(request("10.1.1.1", "not-an-ip, 10.2.2.2"), trust)).toBe("10.2.2.2");
    expect(clientAddress(request("10.1.1.1", "203.0.113.9, not-an-ip"), trust)).toBe("10.1.1.1");
  });

  it("groups IPv6 by /64 and folds IPv4-mapped addresses", () => {
    expect(normalizeClientIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeClientIp("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(normalizeClientIp("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeClientIp("2001:db8:1:2::1")).toBe(normalizeClientIp("2001:db8:1:2::abcd"));
    expect(normalizeClientIp("2001:db8:1:2::1")).not.toBe(normalizeClientIp("2001:db8:1:3::1"));

    const limiter = new AuthAttemptLimiter({ freeFailures: 1, baseDelayMs: 1000, now: () => 50 });
    expect(limiter.beginAttempt("2001:db8:1:2::1", "alice").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("2001:db8:1:2::2", "bob").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("2001:db8:1:2::3", "frank").retryAfterMs).toBe(1000);
    expect(limiter.beginAttempt("2001:db8:9:9::1", "carol").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("::ffff:127.0.0.1", "dave").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("127.0.0.1", "erin").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("127.0.0.1", "gary").retryAfterMs).toBe(1000);
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
  it("does not let an attacker on another address lock the legitimate user", () => {
    const limiter = new AuthAttemptLimiter({ freeFailures: 1, baseDelayMs: 60_000, now: () => 10 });
    expect(limiter.beginAttempt("198.51.100.1", "alice").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("198.51.100.1", "alice").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("198.51.100.1", "alice").retryAfterMs).toBe(60_000);
    expect(limiter.beginAttempt("203.0.113.8", "alice").retryAfterMs).toBe(0);
    expect(limiter.retryAfterMs("203.0.113.8", "alice")).toBe(0);
  });

  it("locks a username globally only after failures from many addresses", () => {
    const limiter = new AuthAttemptLimiter({
      freeFailures: 1,
      globalFreeFailures: 2,
      baseDelayMs: 1000,
      now: () => 10,
    });
    expect(limiter.beginAttempt("198.51.100.1", "alice").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("198.51.100.2", "alice").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("203.0.113.3", "alice").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("203.0.113.4", "alice").retryAfterMs).toBe(1000);
  });

  it("gives a recent address a few tries, then drops the exemption on a failure", () => {
    let now = 10_000;
    const limiter = new AuthAttemptLimiter({
      freeFailures: 1,
      baseDelayMs: 60_000,
      recentSuccessMs: 60_000,
      exemptFailures: 3,
      now: () => now,
    });
    limiter.recordSuccess("203.0.113.8", "alice");
    expect(limiter.beginAttempt("203.0.113.8", "mallory").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("203.0.113.8", "mallory").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("203.0.113.8", "mallory").retryAfterMs).toBe(60_000);
    expect(limiter.beginAttempt("203.0.113.8", "alice").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("203.0.113.8", "alice").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("203.0.113.8", "alice").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("203.0.113.8", "alice").retryAfterMs).toBe(60_000);
    limiter.recordSuccess("203.0.113.8", "alice");
    expect(limiter.beginAttempt("203.0.113.8", "alice").retryAfterMs).toBe(0);
    limiter.recordFailure("203.0.113.8", "alice");
    expect(limiter.beginAttempt("203.0.113.8", "alice").retryAfterMs).toBe(60_000);
    expect(limiter.beginAttempt("203.0.113.8", "bob").retryAfterMs).toBe(60_000);
    now += 60_000;
    expect(limiter.retryAfterMs("198.51.100.1", "carol")).toBe(0);
  });
});

describe("scrypt concurrency cap", () => {
  it("keeps a slot for a recent sign-in while four attackers occupy the rest", async () => {
    setBasicAuthScryptLimit(4);
    clearBasicAuthSuccessCache();
    const users = parseBasicAuthUsers(scryptUser("alice", PASSWORD));
    const before = basicAuthScryptOperations();
    const attackers = Array.from({ length: 3 }, () =>
      verifyBasicCredentials(users, "alice", `${PASSWORD}-no`, { priority: false }),
    );
    expect(basicAuthScryptOperations()).toBe(before + 3);
    const queued = verifyBasicCredentials(users, "alice", `${PASSWORD}-queued`, {
      priority: false,
    });
    expect(basicAuthScryptOperations()).toBe(before + 3);
    const legitimate = verifyBasicCredentials(users, "alice", PASSWORD, { priority: true });
    expect(basicAuthScryptOperations()).toBe(before + 4);
    expect(await legitimate).toBe(true);
    expect(await queued).toBe(false);
    expect((await Promise.all(attackers)).every((accepted) => accepted === false)).toBe(true);
  });

  it("rejects scrypt work that does not fit in the queue", async () => {
    setBasicAuthScryptLimit(1);
    clearBasicAuthSuccessCache();
    const users = parseBasicAuthUsers(scryptUser("queued", PASSWORD));
    const started = [
      verifyBasicCredentials(users, "queued", PASSWORD),
      ...Array.from({ length: BASIC_AUTH_SCRYPT_QUEUE_MAX }, () =>
        verifyBasicCredentials(users, "queued", PASSWORD),
      ),
    ];
    const overflow = verifyBasicCredentials(users, "queued", PASSWORD).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(await overflow).toBeInstanceOf(ScryptBusyError);
    await Promise.all(started);
  });

  it("counts a busy scrypt attempt instead of erasing the reservation", async () => {
    setBasicAuthScryptLimit(0);
    clearBasicAuthSuccessCache();
    const users = parseBasicAuthUsers(scryptUser("alice", PASSWORD));
    const limiter = new AuthAttemptLimiter({ freeFailures: 1, baseDelayMs: 1000, now: () => 20 });
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
    limiter.recordSuccess("203.0.113.8", "alice");
    expect(limiter.beginAttempt("203.0.113.8", "alice").retryAfterMs).toBe(0);
    expect(limiter.retryAfterMs("203.0.113.8", "bob")).toBe(1000);
  });

  it("slides the successful scrypt cache forward on a hit", async () => {
    clearBasicAuthSuccessCache();
    const users = parseBasicAuthUsers(scryptUser("slide", PASSWORD));
    const before = basicAuthScryptOperations();
    const start = 1_700_000_000_000;
    expect(await verifyBasicCredentials(users, "slide", PASSWORD, { now: start })).toBe(true);
    expect(await verifyBasicCredentials(users, "slide", PASSWORD, { now: start + 20_000 })).toBe(
      true,
    );
    expect(await verifyBasicCredentials(users, "slide", PASSWORD, { now: start + 40_000 })).toBe(
      true,
    );
    expect(basicAuthScryptOperations()).toBe(before + 1);
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

  it("creates the key with an exclusive write and reads it back when the file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "wamcp-mac-"));
    try {
      const file = join(root, "oauth.db");
      writeFileSync(file, "");
      const first = loadCredentialMacKey(file);
      const second = loadCredentialMacKey(file);
      expect(second.equals(first)).toBe(true);
      expect(statSync(credentialMacKeyPath(file)).mode & 0o777).toBe(0o600);
      expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
      const existing = randomBytes(32);
      const occupied = join(root, "occupied.db");
      writeFileSync(occupied, "");
      writeFileSync(credentialMacKeyPath(occupied), existing, { mode: 0o600 });
      expect(loadCredentialMacKey(occupied).equals(existing)).toBe(true);
      expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sign-in after the lock window", () => {
  it("accepts the correct password after eight failures and the lock window", async () => {
    let now = 9_000_000;
    const limiter = new AuthAttemptLimiter({
      freeFailures: 8,
      baseDelayMs: 1000,
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
    for (let index = 0; index < 8; index += 1) {
      expect((await basic(`${PASSWORD}-wrong`)).status).toBe(401);
    }
    expect((await basic(`${PASSWORD}-wrong`)).status).toBe(401);
    const locked = await basic(PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("1");
    now += 1000;
    expect((await basic(PASSWORD)).status).toBe(200);
  });

  it("accepts the correct password after the global lock window", async () => {
    let now = 4_000_000;
    const limiter = new AuthAttemptLimiter({
      globalFreeFailures: 128,
      baseDelayMs: 60_000,
      now: () => now,
    });
    for (let index = 0; index < 128; index += 1) {
      const ip = `198.51.0.${index + 1}`;
      const attempt = limiter.beginAttempt(ip, "alice");
      expect(attempt.retryAfterMs).toBe(0);
      limiter.recordFailure(ip, "alice", attempt.token);
    }
    const arming = limiter.beginAttempt("203.0.113.50", "alice");
    expect(arming.retryAfterMs).toBe(0);
    limiter.recordFailure("203.0.113.50", "alice", arming.token);
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
    expect((await basic(PASSWORD)).status).toBe(429);
    now += 60_000;
    expect((await basic(PASSWORD)).status).toBe(200);
  });
});

describe("full limiter maps and unsettled attempts", () => {
  it("lets a real user through after 1250 networks fill the maps", () => {
    const limiter = new AuthAttemptLimiter({ now: () => 1_000 });
    let count = 0;
    for (let net = 0; net < 1250; net += 1) {
      const ip = `2001:db8:${net.toString(16)}::1`;
      for (let name = 0; name < 8; name += 1) {
        expect(limiter.beginAttempt(ip, `user-${count}`).retryAfterMs).toBe(0);
        count += 1;
      }
    }
    expect(count).toBe(10_000);
    expect(limiter.beginAttempt("2001:db8:ffff::1", "alice").retryAfterMs).toBe(0);
  });

  it("does not let a leaked attempt undo a later failure", () => {
    const limiter = new AuthAttemptLimiter({ freeFailures: 1, baseDelayMs: 1000, now: () => 50 });
    const leaked = limiter.beginAttempt("203.0.113.5", "alice");
    expect(leaked.retryAfterMs).toBe(0);
    const failure = limiter.beginAttempt("203.0.113.5", "alice");
    expect(failure.retryAfterMs).toBe(0);
    limiter.recordFailure("203.0.113.5", "alice", failure.token);
    expect(limiter.retryAfterMs("203.0.113.5", "alice")).toBe(1000);
    limiter.recordSuccess("203.0.113.5", "alice", leaked.token);
    expect(limiter.retryAfterMs("203.0.113.5", "bob")).toBe(1000);
    expect(limiter.retryAfterMs("203.0.113.5", "alice")).toBe(0);
  });

  it("drops the oldest unsettled attempt once pending is full", () => {
    let now = 1_000;
    const limiter = new AuthAttemptLimiter({
      freeFailures: 10_000,
      globalFreeFailures: 10_000,
      baseDelayMs: 1000,
      now: () => now,
    });
    const first = limiter.beginAttempt("203.0.113.5", "alice");
    expect(first.retryAfterMs).toBe(0);
    for (let index = 1; index < 10_000; index += 1) {
      expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(0);
    }
    expect(limiter.beginAttempt("203.0.113.5", "alice").retryAfterMs).toBe(0);
    expect(limiter.retryAfterMs("203.0.113.5", "alice")).toBe(1000);
    limiter.recordSuccess("203.0.113.5", "alice", first.token);
    expect(limiter.retryAfterMs("203.0.113.5", "alice")).toBe(0);
    expect(limiter.retryAfterMs("203.0.113.5", "bob")).toBe(1000);
    now += 1000;
    expect(limiter.beginAttempt("203.0.113.5", "bob").retryAfterMs).toBe(0);
    expect(limiter.retryAfterMs("203.0.113.5", "bob")).toBe(2000);
  });

  it("keeps a username above the free-attempt count through a flood of other names", () => {
    const limiter = new AuthAttemptLimiter({ baseDelayMs: 60_000, now: () => 10_000 });
    const ipFor = (index: number) => `198.51.${Math.floor(index / 250)}.${(index % 250) + 1}`;
    for (let index = 0; index < 120; index += 1) {
      expect(limiter.beginAttempt(ipFor(index), "vic").retryAfterMs).toBe(0);
    }
    for (let index = 0; index < 10_000; index += 1) {
      limiter.beginAttempt(ipFor(1_000 + index), `junk-${index}`);
    }
    let locked = false;
    for (let index = 0; index < 40; index += 1) {
      if (limiter.beginAttempt(ipFor(20_000 + index), "vic").retryAfterMs > 0) locked = true;
    }
    expect(locked).toBe(true);
    expect(limiter.retryAfterMs(ipFor(21_000), "vic")).toBeGreaterThan(0);
  });

  it("counts a new address in one overflow bucket when every address is locked", () => {
    const limiter = new AuthAttemptLimiter({
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      now: () => 20_000,
    });
    let blocked = 0;
    for (let net = 0; net < 10_000; net += 1) {
      const ip = `2001:db8:${net.toString(16)}::1`;
      const user = `a${net}`;
      for (let attempt = 0; attempt < 9; attempt += 1) {
        if (limiter.beginAttempt(ip, user).retryAfterMs !== 0) blocked += 1;
      }
    }
    expect(blocked).toBe(0);
    const fresh = (index: number) => `2001:db8:ffff:${index.toString(16)}::1`;
    const undone = limiter.beginAttempt(fresh(1), "undo-me");
    expect(undone.retryAfterMs).toBe(0);
    limiter.recordSuccess(fresh(1), "undo-me", undone.token);
    const first = limiter.beginAttempt(fresh(2), "new-2");
    expect(first.retryAfterMs).toBe(0);
    limiter.recordFailure(fresh(2), "new-2", first.token);
    expect(limiter.beginAttempt(fresh(1), "undo-me").retryAfterMs).toBe(0);
    for (let index = 3; index <= 9; index += 1) {
      expect(limiter.beginAttempt(fresh(index), `new-${index}`).retryAfterMs).toBe(0);
    }
    expect(limiter.beginAttempt(fresh(10), "new-10").retryAfterMs).toBe(0);
    const locked = limiter.beginAttempt(fresh(11), "new-11");
    expect(locked.retryAfterMs).toBeGreaterThan(0);
    const wait = limiter.retryAfterMs(fresh(12), "new-12");
    expect(wait).toBe(locked.retryAfterMs);
    limiter.recordSuccess(fresh(13), "legit");
    expect(limiter.beginAttempt(fresh(13), "legit").retryAfterMs).toBe(0);
    expect(limiter.retryAfterMs(fresh(12), "new-12")).toBe(wait);
  });
});

describe("unknown usernames and bucket eviction", () => {
  it("does not answer differently when the username does not exist", async () => {
    const limiter = new AuthAttemptLimiter({ freeFailures: 1, baseDelayMs: 60_000 });
    const users = parseBasicAuthUsers(`alice:${PASSWORD}`);
    const call = (username: string, password: string, ip: string) => {
      const response = mockResponse();
      return authorizeMcpHttpRequest(
        {
          socket: { remoteAddress: ip },
          headers: {
            authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          },
        } as unknown as IncomingMessage,
        response,
        { basicUsers: users, limiter },
        null,
      ).then(() => response.statusCode);
    };
    expect(await call("alice", `${PASSWORD}-wrong`, "203.0.113.40")).toBe(401);
    expect(await call("alice", `${PASSWORD}-wrong`, "203.0.113.40")).toBe(401);
    expect(await call("alice", `${PASSWORD}-wrong`, "203.0.113.40")).toBe(429);
    expect(await call("stranger-a", "x", "198.51.100.1")).toBe(401);
    expect(await call("stranger-b", "x", "198.51.100.2")).toBe(401);
    expect(await call("ghost", "x", "198.51.100.3")).toBe(401);
    expect(await call("ghost", "x", "198.51.100.3")).toBe(401);
    expect(await call("ghost", "x", "198.51.100.3")).toBe(429);
    expect(await call("phantom", "x", "198.51.100.4")).toBe(401);
    expect(await call("alice", `${PASSWORD}-wrong`, "198.51.100.5")).toBe(401);
    for (let index = 0; index < 10_001; index += 1) {
      limiter.beginAttempt(`198.51.100.${index % 200}`, `stranger-${index}`);
    }
    expect(await call("alice", PASSWORD, "203.0.113.40")).toBe(429);
  });

  it("locks a username after 10k networks saturate the address maps", () => {
    let now = 0;
    const limiter = new AuthAttemptLimiter({ baseDelayMs: 1000, now: () => now });
    let blocked = 0;
    for (let net = 0; net < 10_000; net += 1) {
      const ip = `2001:db8:${net.toString(16)}::1`;
      for (let attempt = 0; attempt < 9; attempt += 1) {
        if (limiter.beginAttempt(ip, `a${net}`).retryAfterMs !== 0) blocked += 1;
      }
    }
    expect(blocked).toBe(0);
    now = 5_000;
    const ipFor = (index: number) => `198.51.${Math.floor(index / 250)}.${(index % 250) + 1}`;
    let lockedAt = -1;
    for (let index = 0; index < 400; index += 1) {
      now += 1_000;
      if (limiter.beginAttempt(ipFor(index), "admin").retryAfterMs > 0) {
        lockedAt = index;
        break;
      }
    }
    expect(lockedAt).toBeGreaterThanOrEqual(0);
    expect(lockedAt).toBeLessThan(400);
    expect(limiter.retryAfterMs(ipFor(500), "admin")).toBeGreaterThan(0);
    const others = ["carol", "dave", "erin", "frank"];
    const open = others.filter(
      (name, index) => limiter.beginAttempt(ipFor(501 + index), name).retryAfterMs === 0,
    );
    expect(open.length).toBeGreaterThan(0);
  });

  it("does not leave a stranger at 429 for hours after address locks expire", () => {
    let now = 0;
    const limiter = new AuthAttemptLimiter({ baseDelayMs: 1000, now: () => now });
    let blocked = 0;
    for (let net = 0; net < 10_000; net += 1) {
      const ip = `2001:db8:${net.toString(16)}::1`;
      for (let attempt = 0; attempt < 9; attempt += 1) {
        if (limiter.beginAttempt(ip, `a${net}`).retryAfterMs !== 0) blocked += 1;
      }
    }
    expect(blocked).toBe(0);
    let deniedWhileLocked = 0;
    for (let index = 0; index < 36; index += 1) {
      const ip = `2001:db8:eee0:${index.toString(16)}::1`;
      if (limiter.beginAttempt(ip, `hold-${index}`).retryAfterMs > 0) deniedWhileLocked += 1;
    }
    expect(deniedWhileLocked).toBeGreaterThan(0);
    now += 6 * 60 * 60 * 1000;
    let allowed = 0;
    for (let index = 0; index < 36; index += 1) {
      const ip = `2001:db8:eeef:${index.toString(16)}::1`;
      if (limiter.beginAttempt(ip, `person-${index}`).retryAfterMs === 0) allowed += 1;
    }
    expect(allowed).toBe(36);
  });

  it("forgets a username bucket after a quiet period", () => {
    let now = 0;
    const limiter = new AuthAttemptLimiter({
      globalFreeFailures: 1,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      now: () => now,
    });
    expect(limiter.beginAttempt("203.0.113.1", "admin").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("203.0.113.2", "admin").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt("203.0.113.3", "admin").retryAfterMs).toBe(1000);
    now += 61_000;
    expect(limiter.beginAttempt("203.0.113.4", "admin").retryAfterMs).toBe(0);
  });

  it("does not evict a locked bucket to store another username", () => {
    let now = 5_000;
    const limiter = new AuthAttemptLimiter({
      freeFailures: 0,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      now: () => now,
    });
    const address = (index: number) => `10.1.${Math.floor(index / 256)}.${index % 256}`;
    for (let index = 0; index < 10_000; index += 1) {
      expect(limiter.beginAttempt(address(index), `user-${index}`).retryAfterMs).toBe(0);
    }
    expect(limiter.retryAfterMs(address(0), "user-0")).toBe(1000);
    expect(limiter.beginAttempt("203.0.113.80", "overflow").retryAfterMs).toBe(0);
    expect(limiter.retryAfterMs(address(0), "user-0")).toBe(1000);
    expect(limiter.beginAttempt("203.0.113.81", "overflow-2").retryAfterMs).toBe(1000);
    expect(limiter.retryAfterMs(address(0), "user-0")).toBe(1000);
    now += 61_000;
    expect(limiter.beginAttempt("203.0.113.80", "overflow").retryAfterMs).toBe(0);
    expect(limiter.beginAttempt(address(0), "user-0").retryAfterMs).toBe(0);
    expect(limiter.retryAfterMs(address(0), "user-0")).toBe(1000);
  });
});

describe("optional HTTP fallback", () => {
  it("runs before the 404 and can leave the request unhandled", async () => {
    const handler = createHttpRequestHandler({
      routes: { health: "/health", mcp: "/mcp", webhook: "/cloud-webhook" },
      oauth: null,
      authorize: () => true,
      health: (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      mcp: async (_req, res) => {
        res.writeHead(204);
        res.end();
      },
      webhook: async (_req, res) => {
        res.writeHead(204);
        res.end();
      },
      fallback: (_req, res, url) => {
        if (url.pathname !== "/dashboard") return false;
        res.writeHead(204);
        res.end();
        return true;
      },
    });
    const harness = await listen(handler);
    expect((await fetch(`${harness.baseUrl}/dashboard`)).status).toBe(204);
    expect((await fetch(`${harness.baseUrl}/missing`)).status).toBe(404);
    expect(normalizeClientIp("127.0.0.1")).toBe("127.0.0.1");
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
