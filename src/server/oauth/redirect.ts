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

export function validRedirectUri(raw: string, applicationType: "web" | "native"): boolean {
  if (raw.length > 2048 || raw.includes("\\") || raw.includes(" ") || hasControlCharacter(raw))
    return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || !url.hostname) return false;
  if (url.protocol === "https:") return true;
  if (applicationType !== "native" || url.protocol !== "http:") return false;
  if (url.hostname.toLowerCase() === "localhost") return url.port !== "";
  return isLoopbackAddress(url.hostname);
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
