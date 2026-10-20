import { resolve } from "node:path";
import { HEALTH_ENDPOINT, MCP_ENDPOINT } from "../constants.js";
import { parseBasicAuthUsers, type BasicAuthUser } from "./basic-auth.js";
import { defaultOAuthResourceUrl, parsePublicHttpsUrl } from "./oauth/urls.js";

const WEBHOOK_ENDPOINT = "/cloud-webhook";

export interface HttpRoutes {
  health: string;
  mcp: string;
  webhook: string;
}

export interface DisabledOAuthConfig {
  enabled: false;
}

export interface EnabledOAuthConfig {
  enabled: true;
  issuerUrl: string;
  resourceUrl: string;
  dbPath: string;
  dynamicRegistration: "open" | "disabled";
  redirectHostAllowlist: string[];
}

export interface HttpTransportConfig {
  basePath: string;
  routes: HttpRoutes;
  apiKey?: string;
  basicUsers: BasicAuthUser[];
  oauth: DisabledOAuthConfig | EnabledOAuthConfig;
}

export function parseBasePath(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "/") return "";
  const value = raw.trim().replace(/\/+$/, "");
  if (!value.startsWith("/") || value.includes("//") || value.length > 128) {
    throw new Error("Invalid WA_BASE_PATH; expected an absolute path such as /wamcp");
  }
  for (const segment of value.slice(1).split("/")) {
    if (segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/.test(segment)) {
      throw new Error("Invalid WA_BASE_PATH; expected an absolute path such as /wamcp");
    }
  }
  return value;
}

export function httpRoutesForBasePath(basePath: string): HttpRoutes {
  return {
    health: `${basePath}${HEALTH_ENDPOINT}`,
    mcp: `${basePath}${MCP_ENDPOINT}`,
    webhook: `${basePath}${WEBHOOK_ENDPOINT}`,
  };
}

function parseEnabledFlag(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Invalid WA_MCP_OAUTH_ENABLED; expected true or false");
}

function loadOAuthConfig(
  env: NodeJS.ProcessEnv,
  basePath: string,
  basicUsers: readonly BasicAuthUser[],
): DisabledOAuthConfig | EnabledOAuthConfig {
  if (!parseEnabledFlag(env.WA_MCP_OAUTH_ENABLED)) return { enabled: false };
  if (basicUsers.length === 0) {
    throw new Error("WA_MCP_OAUTH_ENABLED requires WA_BASIC_AUTH with at least one user");
  }

  const issuerRaw = env.WA_MCP_OAUTH_ISSUER_URL;
  if (!issuerRaw?.trim()) {
    throw new Error("WA_MCP_OAUTH_ENABLED requires WA_MCP_OAUTH_ISSUER_URL");
  }
  const issuer = parsePublicHttpsUrl(issuerRaw, "WA_MCP_OAUTH_ISSUER_URL");
  if (issuer.path !== basePath) {
    throw new Error("Invalid WA_MCP_OAUTH_ISSUER_URL; its path must match WA_BASE_PATH");
  }

  const expectedResource = defaultOAuthResourceUrl(issuer, basePath);
  const resource = env.WA_MCP_OAUTH_RESOURCE_URL?.trim()
    ? parsePublicHttpsUrl(env.WA_MCP_OAUTH_RESOURCE_URL, "WA_MCP_OAUTH_RESOURCE_URL")
    : parsePublicHttpsUrl(expectedResource, "WA_MCP_OAUTH_RESOURCE_URL");
  if (resource.origin !== issuer.origin || resource.href !== expectedResource) {
    throw new Error(
      "Invalid WA_MCP_OAUTH_RESOURCE_URL; expected the public MCP endpoint on the issuer origin",
    );
  }

  const configuredDb = env.WA_MCP_OAUTH_DB_PATH?.trim() || "data/oauth.db";
  const dbPath = configuredDb === ":memory:" ? configuredDb : resolve(configuredDb);
  const mainDb = resolve(env.WA_DATABASE_PATH?.trim() || "data/whatsapp.db");
  if (dbPath !== ":memory:" && dbPath === mainDb) {
    throw new Error("Invalid WA_MCP_OAUTH_DB_PATH; use a file separate from WA_DATABASE_PATH");
  }

  return {
    enabled: true,
    issuerUrl: issuer.href,
    resourceUrl: resource.href,
    dbPath,
    dynamicRegistration: parseDynamicRegistration(env.WA_MCP_OAUTH_DCR),
    redirectHostAllowlist: parseRedirectHostAllowlist(env.WA_MCP_OAUTH_REDIRECT_HOST_ALLOWLIST),
  };
}

function parseDynamicRegistration(raw: string | undefined): "open" | "disabled" {
  if (raw === undefined || raw.trim() === "" || raw.trim().toLowerCase() === "open") return "open";
  if (raw.trim().toLowerCase() === "disabled") return "disabled";
  throw new Error("Invalid WA_MCP_OAUTH_DCR; expected open or disabled");
}

function parseRedirectHostAllowlist(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of entries) {
    if (entry.length > 253 || !/^[a-z0-9._~:-]+$/.test(entry)) {
      throw new Error(
        "Invalid WA_MCP_OAUTH_REDIRECT_HOST_ALLOWLIST; expected comma-separated hosts or native schemes",
      );
    }
  }
  return entries;
}

/**
 * stdio does not serve HTTP auth. Invalid HTTP auth settings must not prevent that mode from starting.
 */
export function loadHttpTransportConfigForTransport(
  transport: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HttpTransportConfig | undefined {
  if ((transport ?? "http") === "stdio") return undefined;
  return loadHttpTransportConfig(env);
}

export function loadHttpTransportConfig(env: NodeJS.ProcessEnv = process.env): HttpTransportConfig {
  const basePath = parseBasePath(env.WA_BASE_PATH);
  const basicUsers = parseBasicAuthUsers(env.WA_BASIC_AUTH);
  const apiKey = env.WA_MCP_API_KEY;
  return {
    basePath,
    routes: httpRoutesForBasePath(basePath),
    ...(apiKey ? { apiKey } : {}),
    basicUsers,
    oauth: loadOAuthConfig(env, basePath, basicUsers),
  };
}
