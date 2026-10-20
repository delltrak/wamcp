import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../utils/logger.js";
import { AuthAttemptLimiter, clientAddress, type TrustedProxy } from "./auth-limiter.js";
import { ScryptBusyError, verifyBasicCredentials, type BasicAuthUser } from "./basic-auth.js";
import type { McpOAuthServer } from "./oauth/server.js";

export interface McpHttpAuth {
  apiKey?: string;
  basicUsers: readonly BasicAuthUser[];
  limiter?: AuthAttemptLimiter;
  trustProxy?: TrustedProxy;
}

function verifyApiKey(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

function splitAuthorization(
  header: string | undefined,
): { scheme: string; credentials: string } | undefined {
  if (!header) return undefined;
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { scheme: parts[0].toLowerCase(), credentials: parts[1] };
}

function decodeBasic(credentials: string): { username: string; password: string } | undefined {
  if (credentials.length > 4096) return undefined;
  const decoded = Buffer.from(credentials, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) return undefined;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (!username || username.length > 128 || password.length > 256) return undefined;
  return { username, password };
}

function writeUnauthorized(res: ServerResponse, challenges: string[]): void {
  if (challenges.length === 0) {
    res.writeHead(401, { "Content-Type": "application/json" });
  } else {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "WWW-Authenticate": challenges.length === 1 ? challenges[0]! : challenges,
    });
  }
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function writeTooMany(res: ServerResponse, waitMs: number, challenges: string[]): void {
  const headers: Record<string, string | string[]> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Retry-After": String(Math.max(1, Math.ceil(waitMs / 1000))),
  };
  if (challenges.length === 1) headers["WWW-Authenticate"] = challenges[0]!;
  else if (challenges.length > 1) headers["WWW-Authenticate"] = challenges;
  res.writeHead(429, headers);
  res.end(JSON.stringify({ error: "too_many_requests" }));
}

/**
 * Authenticate one MCP HTTP request.
 * With no API key, Basic users, or OAuth server, the historical open behavior is preserved.
 * A configured API key still matches `Authorization: Bearer` or `x-api-key`.
 */
export async function authorizeMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: McpHttpAuth,
  oauth: McpOAuthServer | null,
): Promise<boolean> {
  if (!auth.apiKey && auth.basicUsers.length === 0 && !oauth) return true;

  const challenges = oauth
    ? [
        `Bearer realm="wa-mcp", resource_metadata="${oauth.protectedResourceMetadataUrl()}", scope="mcp"`,
        ...(auth.basicUsers.length > 0 ? ['Basic realm="wa-mcp"'] : []),
      ]
    : auth.basicUsers.length > 0
      ? ['Basic realm="wa-mcp"']
      : [];
  const authorization = splitAuthorization(
    typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
  );
  const apiKeyHeader = req.headers["x-api-key"];

  if (authorization?.scheme === "bearer") {
    if (
      authorization.credentials.length <= 4096 &&
      auth.apiKey &&
      verifyApiKey(authorization.credentials, auth.apiKey)
    ) {
      return true;
    }
    if (oauth?.authenticateAccessToken(authorization.credentials)) return true;
    logger.warn("Unauthorized MCP request");
    writeUnauthorized(
      res,
      oauth ? [`${challenges[0]}, error="invalid_token"`, ...challenges.slice(1)] : challenges,
    );
    return false;
  }

  if (authorization?.scheme === "basic" && auth.basicUsers.length > 0) {
    const decoded = decodeBasic(authorization.credentials);
    const ip = clientAddress(req, auth.trustProxy);
    const username = decoded?.username ?? "\0invalid";
    const reserved = auth.limiter?.beginAttempt(ip, username) ?? 0;
    if (reserved > 0) {
      logger.warn("MCP Basic authentication is rate limited");
      writeTooMany(res, reserved, challenges);
      return false;
    }
    try {
      const accepted = decoded
        ? await verifyBasicCredentials(auth.basicUsers, decoded.username, decoded.password)
        : false;
      if (accepted && decoded) {
        auth.limiter?.recordSuccess(ip, decoded.username);
        return true;
      }
    } catch (error) {
      if (error instanceof ScryptBusyError) {
        auth.limiter?.cancelAttempt(ip, username);
        logger.warn("MCP Basic authentication is rate limited");
        writeTooMany(res, 1000, challenges);
        return false;
      }
      throw error;
    }
    logger.warn("Unauthorized MCP request");
    writeUnauthorized(res, challenges);
    return false;
  }

  if (typeof apiKeyHeader === "string" && auth.apiKey && verifyApiKey(apiKeyHeader, auth.apiKey))
    return true;

  logger.warn("Unauthorized MCP request");
  writeUnauthorized(res, challenges);
  return false;
}
