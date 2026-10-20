// ============================================================
// WA MCP — Optional outbound proxy for the Baileys connection
// WebSocket uses `agent`. rc14 applies `fetchAgent` to Node media
// uploads. Media downloads ignore `fetchAgent` and honor the
// dispatcher passed to downloadMediaMessage.
// ============================================================

import type { Agent as HttpsAgent } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { ProxyAgent, type Dispatcher } from "undici";
import { PROXY_URL_ENV, redactError, redactProxyUrl } from "../../utils/proxy-redact.js";

export { PROXY_URL_ENV };

const ALLOWED_SCHEMES = new Set(["socks5", "socks5h", "http", "https"]);

const PROXY_URL_RE =
  /^(socks5h?|https?):\/\/(?:([^/?#@:\s]*)(?::([^/?#@\s]*))?@)?(\[[^\]]+\]|[^/?#@:]+)(?::(\d+))?(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i;

export interface BaileysProxyAgents {
  readonly url: string;
  readonly redactedUrl: string;
  readonly agent: HttpsAgent;
  readonly fetchAgent: HttpsAgent;
  readonly dispatcher: Dispatcher;
}

function invalidProxy(reason: string): Error {
  return new Error(`Invalid ${PROXY_URL_ENV}; ${reason}`);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function decodeUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidProxy("credentials are not valid percent-encoding");
  }
}

/**
 * Parse the opt-in proxy URL. Empty or unset means a direct connection.
 * The returned string keeps credentials exactly as configured.
 */
export function parseBaileysProxyUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed !== raw) throw invalidProxy("URL must not contain surrounding whitespace");
  if (raw.includes("\\") || hasControlCharacter(raw)) {
    throw invalidProxy("URL must not contain control characters or backslashes");
  }

  const match = PROXY_URL_RE.exec(raw);
  if (!match) throw invalidProxy("expected an absolute socks5, socks5h, http, or https URL");

  const schemeRaw = match[1];
  const user = match[2];
  const pass = match[3];
  const host = match[4];
  const portText = match[5];
  const path = match[6];
  const query = match[7];
  const fragment = match[8];
  if (!schemeRaw || !host) {
    throw invalidProxy("expected an absolute socks5, socks5h, http, or https URL");
  }
  if (!portText) throw invalidProxy("an explicit port is required");
  const scheme = schemeRaw.toLowerCase();

  if (!ALLOWED_SCHEMES.has(scheme)) {
    throw invalidProxy("scheme must be socks5, socks5h, http, or https");
  }
  if (query) throw invalidProxy("query string is not allowed");
  if (fragment) throw invalidProxy("fragment is not allowed");
  if (path && path !== "/") throw invalidProxy("path is not allowed");
  if (pass !== undefined && user === "") {
    throw invalidProxy("username is required when a password is set");
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalidProxy("port must be an integer from 1 to 65535");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidProxy("expected an absolute socks5, socks5h, http, or https URL");
  }
  if (parsed.protocol !== `${scheme}:`)
    throw invalidProxy("scheme must be socks5, socks5h, http, or https");
  if (parsed.host.toLowerCase() !== `${host}:${portText}`.toLowerCase()) {
    throw invalidProxy("hostname or port is invalid");
  }
  if (Number(parsed.port) !== port) throw invalidProxy("port must be an integer from 1 to 65535");

  const expectedUser = user ?? "";
  const expectedPass = pass ?? "";
  const decodedUser = decodeUserInfo(expectedUser);
  const decodedPass = decodeUserInfo(expectedPass);
  const parsedUser = decodeUserInfo(parsed.username);
  const parsedPass = decodeUserInfo(parsed.password);
  if (parsedUser !== decodedUser) throw invalidProxy("username is invalid");
  if (parsedPass !== decodedPass) throw invalidProxy("password is invalid");

  const userinfo = user === undefined ? "" : pass === undefined ? `${user}@` : `${user}:${pass}@`;
  return `${scheme}://${userinfo}${parsed.host}`;
}

/** undici 7.30 accepts socks5, not socks5h. Its SOCKS5 client still sends the hostname. */
export function proxyDispatcherUrl(proxyUrl: string): string {
  return proxyUrl.startsWith("socks5h:") ? `socks5:${proxyUrl.slice("socks5h:".length)}` : proxyUrl;
}

export function createBaileysProxyAgents(proxyUrl: string): BaileysProxyAgents {
  const parsed = new URL(proxyUrl);
  const socks = parsed.protocol === "socks5:" || parsed.protocol === "socks5h:";
  const agent = socks ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
  const fetchAgent = socks ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
  try {
    // undici decodes HTTP proxy userinfo, but forwards SOCKS5 opts.username/password raw.
    const dispatcher = new ProxyAgent({
      uri: proxyDispatcherUrl(proxyUrl),
      username: decodeURIComponent(parsed.username) || undefined,
      password: decodeURIComponent(parsed.password) || undefined,
    } as ConstructorParameters<typeof ProxyAgent>[0]);
    return {
      url: proxyUrl,
      redactedUrl: redactProxyUrl(proxyUrl),
      agent: agent as HttpsAgent,
      fetchAgent: fetchAgent as HttpsAgent,
      dispatcher,
    };
  } catch (error) {
    agent.destroy();
    fetchAgent.destroy();
    throw redactError(error, proxyUrl);
  }
}

/** How long to wait for a graceful dispatcher close before aborting in-flight requests. */
export const PROXY_DISPATCHER_CLOSE_TIMEOUT_MS = 1_000;

async function closeDispatcher(dispatcher: Dispatcher): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = dispatcher.close().then(
    () => true,
    () => false,
  );
  try {
    const finished = await Promise.race([
      closed,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), PROXY_DISPATCHER_CLOSE_TIMEOUT_MS);
      }),
    ]);
    if (!finished) await dispatcher.destroy();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closeBaileysProxyAgents(
  agents: BaileysProxyAgents | undefined,
): Promise<void> {
  if (!agents) return;
  try {
    agents.agent.destroy();
    agents.fetchAgent.destroy();
  } finally {
    await closeDispatcher(agents.dispatcher);
  }
}

export function mediaDownloadOptions(
  timeoutMs: number | undefined,
  dispatcher: Dispatcher | undefined,
): { options?: RequestInit } {
  if (timeoutMs === undefined && !dispatcher) return {};
  const options: RequestInit & { dispatcher?: Dispatcher } = {};
  if (timeoutMs !== undefined) options.signal = AbortSignal.timeout(timeoutMs);
  if (dispatcher) options.dispatcher = dispatcher;
  return { options };
}
