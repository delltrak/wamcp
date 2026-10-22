import { isIP } from "node:net";
import type { OAuthClient } from "./store.js";

function isLoopbackAddress(hostname: string): boolean {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const version = isIP(bare);
  if (version === 4) return bare.startsWith("127.");
  if (version !== 6) return false;
  const lower = bare.toLowerCase();
  if (lower === "::1") return true;
  if (!lower.startsWith("::ffff:")) return false;
  const mapped = lower.slice("::ffff:".length);
  return isIP(mapped) === 4 && mapped.startsWith("127.");
}

export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const BLOCKED_NATIVE_SCHEMES = [
  "javascript",
  "x-javascript",
  "data",
  "file",
  "blob",
  "about",
  "chrome",
  "chrome-extension",
  "filesystem",
  "vbscript",
  "ws",
  "wss",
  "ftp",
  "mailto",
  "intent",
  "view-source",
  "jar",
  "http+unix",
  "ssh",
  "tel",
  "sms",
  "smsto",
  "market",
  "content",
];

function schemeName(url: URL): string {
  return url.protocol.slice(0, -1).toLowerCase();
}

function blockedNativeScheme(scheme: string): boolean {
  return BLOCKED_NATIVE_SCHEMES.some(
    (blocked) =>
      scheme === blocked || scheme.startsWith(`${blocked}.`) || scheme.startsWith(`${blocked}+`),
  );
}

/**
 * Private-use native schemes must be reverse-DNS names (RFC 8252), such as
 * `com.example.app:/cb`. Loopback HTTP is separate.
 */
function validNativeScheme(url: URL): boolean {
  const scheme = schemeName(url);
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || !scheme.includes(".") || blockedNativeScheme(scheme)) {
    return false;
  }
  if (url.hostname) return true;
  return url.pathname.length > 1;
}

export function validRedirectUri(raw: string, applicationType: "web" | "native"): boolean {
  if (raw.length > 2048 || raw.includes("\\") || raw.includes(" ") || hasControlCharacter(raw))
    return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return Boolean(url.hostname);
  if (url.protocol === "http:") {
    if (applicationType !== "native" || !url.hostname || url.port === "") return false;
    if (url.hostname.toLowerCase() === "localhost") return true;
    return isLoopbackAddress(url.hostname);
  }
  return applicationType === "native" && validNativeScheme(url);
}

/**
 * Empty allowlist permits every otherwise-valid redirect.
 * HTTP(S) entries match the hostname (or hostname:port). Other entries match a native scheme.
 */
export function redirectHostAllowed(uri: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  const allowed = new Set(allowlist.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const scheme = schemeName(url);
  if (scheme === "http" || scheme === "https") {
    const host = url.hostname.toLowerCase();
    const hostPort = url.port ? `${host}:${url.port}` : host;
    return allowed.has(host) || allowed.has(hostPort);
  }
  return allowed.has(scheme);
}

export function redirectUriMatches(client: OAuthClient, requested: string): boolean {
  for (const registered of client.redirectUris) {
    if (registered === requested) return true;
    if (client.applicationType === "native" && loopbackRedirectMatches(registered, requested))
      return true;
  }
  return false;
}

function loopbackRedirectMatches(registered: string, requested: string): boolean {
  let registeredUrl: URL;
  let requestedUrl: URL;
  try {
    registeredUrl = new URL(registered);
    requestedUrl = new URL(requested);
  } catch {
    return false;
  }
  if (
    registeredUrl.protocol !== "http:" ||
    requestedUrl.protocol !== "http:" ||
    registeredUrl.username ||
    requestedUrl.username ||
    registeredUrl.password ||
    requestedUrl.password ||
    registeredUrl.hash ||
    requestedUrl.hash ||
    registeredUrl.hostname !== requestedUrl.hostname ||
    !isLoopbackAddress(registeredUrl.hostname)
  ) {
    return false;
  }
  return (
    registeredUrl.pathname === requestedUrl.pathname && registeredUrl.search === requestedUrl.search
  );
}

export function redirectOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (!/^https?:\/\/(?:[A-Za-z0-9._~-]+|\[[0-9A-Fa-f:]+\])(?::\d+)?$/.test(url.origin))
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function redirectDisplay(raw: string): { target: string; local: boolean } {
  try {
    const url = new URL(raw);
    if (!url.host) return { target: "the registered client", local: false };
    const local = url.hostname.toLowerCase() === "localhost" || isLoopbackAddress(url.hostname);
    return { target: url.host, local };
  } catch {
    return { target: "the registered client", local: false };
  }
}
