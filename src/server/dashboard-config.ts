// ============================================================
// WA MCP — Operations dashboard configuration
// Off by default. Enabling it requires WA_DASHBOARD_USERS.
// ============================================================

export interface DashboardUser {
  username: string;
  password: string;
}

export interface DashboardConfig {
  enabled: boolean;
  users: readonly DashboardUser[];
}

export interface CloudWebhookFlags {
  verifyTokenConfigured: boolean;
  signatureSecretConfigured: boolean;
}

type Environment = Record<string, string | undefined>;

const USERNAME_RE = /^[A-Za-z0-9._@+-]{1,64}$/;
const MAX_USERS = 20;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;

function parseBoolean(env: Environment, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error(`Invalid ${key}; expected true or false`);
}

/** Parse `user:password` entries. Passwords may contain colons and must not contain commas. */
export function parseDashboardUsers(value: string): DashboardUser[] {
  const users: DashboardUser[] = [];
  const seen = new Set<string>();
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf(":");
    if (trimmed === "" || separator <= 0) {
      throw new Error(
        "Invalid WA_DASHBOARD_USERS; expected user:password entries separated by commas",
      );
    }
    const username = trimmed.slice(0, separator).trim();
    const password = trimmed.slice(separator + 1).trim();
    if (!USERNAME_RE.test(username) || password.length > MAX_PASSWORD_LENGTH) {
      throw new Error(
        "Invalid WA_DASHBOARD_USERS; expected user:password entries separated by commas",
      );
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Invalid WA_DASHBOARD_USERS; password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    if (seen.has(username)) {
      throw new Error("Invalid WA_DASHBOARD_USERS; usernames must be unique");
    }
    seen.add(username);
    users.push({ username, password });
  }
  if (users.length > MAX_USERS) {
    throw new Error(`Invalid WA_DASHBOARD_USERS; expected at most ${MAX_USERS} users`);
  }
  return users;
}

export function loadDashboardConfig(env: Environment = process.env): DashboardConfig {
  const enabled = parseBoolean(env, "WA_DASHBOARD_ENABLED", false);
  const raw = env.WA_DASHBOARD_USERS;
  const users = raw !== undefined && raw.trim() !== "" ? parseDashboardUsers(raw) : [];
  if (enabled && users.length === 0) {
    throw new Error("WA_DASHBOARD_USERS is required when WA_DASHBOARD_ENABLED=true");
  }
  return { enabled, users };
}

export function assertDashboardTransport(config: DashboardConfig, transport: string): void {
  if (config.enabled && transport !== "http") {
    throw new Error("WA_DASHBOARD_ENABLED=true requires WA_TRANSPORT=http");
  }
}

/** Presence flags only. Token and secret values are never returned. */
export function cloudWebhookFlags(env: Environment = process.env): CloudWebhookFlags {
  return {
    verifyTokenConfigured: Boolean(env.WA_CLOUD_VERIFY_TOKEN?.trim()),
    signatureSecretConfigured: Boolean(env.WA_CLOUD_WEBHOOK_SECRET?.trim()),
  };
}
