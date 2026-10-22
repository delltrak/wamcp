// ============================================================
// WA MCP — Dashboard basic authentication
// ============================================================

import { createHash, timingSafeEqual } from "node:crypto";
import type { DashboardUser } from "./dashboard-config.js";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sameDigest(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

export function parseBasicAuthorization(
  header: string | undefined,
): { username: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const encoded = header.slice("Basic ".length).trim();
  if (encoded.length < 1 || encoded.length > 2048 || !/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    return null;
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** Compares against every configured user so the result does not depend on which entry matched. */
export function dashboardCredentialsMatch(
  users: readonly DashboardUser[],
  username: string,
  password: string,
): boolean {
  let matched = false;
  for (const user of users) {
    const userOk = sameDigest(user.username, username);
    const passwordOk = sameDigest(user.password, password);
    matched = matched || (userOk && passwordOk);
  }
  return matched;
}
