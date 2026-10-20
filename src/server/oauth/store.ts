import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { verifyPkceS256 } from "./pkce.js";

const CODE_TTL_SECONDS = 5 * 60;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  application_type TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_created_at ON oauth_clients(created_at);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires_at ON oauth_authorization_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client_id ON oauth_authorization_codes(client_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires_at ON oauth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client_id ON oauth_tokens(client_id);
`;

export type OAuthApplicationType = "web" | "native";

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  applicationType: OAuthApplicationType;
  tokenEndpointAuthMethod: "none";
  createdAt: number;
}

export interface AuthorizationGrant {
  clientId: string;
  subject: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
}

export interface CodeExchange {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
}

export interface RefreshExchange {
  clientId: string;
  refreshToken: string;
  resource: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export interface OAuthPrincipal {
  subject: string;
  clientId: string;
  scope: string;
}

export class OAuthFlowError extends Error {
  constructor(
    readonly oauthCode: "invalid_grant" | "invalid_target" | "refresh_reuse" | "registration_limit",
  ) {
    super(oauthCode);
    this.name = "OAuthFlowError";
  }
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris_json: string;
  application_type: string;
  token_endpoint_auth_method: string;
  created_at: number;
}

interface CodeRow {
  client_id: string;
  subject: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  expires_at: number;
  used_at: number | null;
}

interface RefreshRow {
  family_id: string;
  client_id: string;
  subject: string;
  resource: string;
  scope: string;
  expires_at: number;
  revoked_at: number | null;
}

interface AccessRow {
  subject: string;
  client_id: string;
  scope: string;
  resource: string;
  expires_at: number;
  revoked_at: number | null;
}

interface CountRow {
  n: number;
}

function unixSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

function randomSecret(prefix: string, byteLength: number): string {
  return prefix + randomBytes(byteLength).toString("base64url");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function asApplicationType(value: string): OAuthApplicationType {
  if (value === "web" || value === "native") return value;
  throw new Error("Stored OAuth client is invalid");
}

export class OAuthStore {
  maxClients = 1000;
  maxRegistrationsPerWindow = 40;
  registrationWindowMs = 60 * 60 * 1000;
  unusedClientTtlMs = 24 * 60 * 60 * 1000;

  constructor(private readonly db: Database.Database) {}

  close(): void {
    this.db.close();
  }

  clientCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get() as CountRow).n;
  }

  authorizationCodeCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM oauth_authorization_codes").get() as CountRow
    ).n;
  }

  /** Hashes and public client fields only. Raw codes, verifiers, and tokens are never stored. */
  inspectionSnapshot(): string {
    const clients = this.db
      .prepare(
        "SELECT client_id, client_name, redirect_uris_json, application_type, token_endpoint_auth_method, created_at FROM oauth_clients",
      )
      .all();
    const codes = this.db
      .prepare(
        "SELECT code_hash, client_id, subject, redirect_uri, code_challenge, resource, scope, expires_at, used_at, created_at FROM oauth_authorization_codes",
      )
      .all();
    const tokens = this.db
      .prepare(
        "SELECT token_hash, token_type, family_id, client_id, subject, resource, scope, expires_at, revoked_at, created_at FROM oauth_tokens",
      )
      .all();
    return JSON.stringify({ clients, codes, tokens });
  }

  registerClient(client: OAuthClient): void {
    const insert = this.db.prepare(`
      INSERT INTO oauth_clients (
        client_id, client_name, redirect_uris_json, application_type,
        token_endpoint_auth_method, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const register = this.db.transaction(() => {
      this.deleteExpired(client.createdAt);
      this.deleteUnusedClients(client.createdAt - Math.floor(this.unusedClientTtlMs / 1000));
      const total = this.db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get() as CountRow;
      if (total.n >= this.maxClients) throw new OAuthFlowError("registration_limit");
      const windowStart = client.createdAt - Math.floor(this.registrationWindowMs / 1000);
      const recent = this.db
        .prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE created_at > ?")
        .get(windowStart) as CountRow;
      if (recent.n >= this.maxRegistrationsPerWindow)
        throw new OAuthFlowError("registration_limit");
      insert.run(
        client.id,
        client.name,
        JSON.stringify(client.redirectUris),
        client.applicationType,
        client.tokenEndpointAuthMethod,
        client.createdAt,
      );
    });
    register.immediate();
  }

  getClient(clientId: string): OAuthClient | undefined {
    const row = this.db
      .prepare(
        `SELECT client_id, client_name, redirect_uris_json, application_type,
                token_endpoint_auth_method, created_at
         FROM oauth_clients WHERE client_id = ?`,
      )
      .get(clientId) as ClientRow | undefined;
    if (!row || row.token_endpoint_auth_method !== "none") return undefined;
    const parsed: unknown = JSON.parse(row.redirect_uris_json);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string"))
      return undefined;
    return {
      id: row.client_id,
      name: row.client_name,
      redirectUris: parsed,
      applicationType: asApplicationType(row.application_type),
      tokenEndpointAuthMethod: "none",
      createdAt: row.created_at,
    };
  }

  issueAuthorizationCode(grant: AuthorizationGrant, now: Date): string {
    const code = randomSecret("wamcp_code_", 32);
    const issuedAt = unixSeconds(now);
    const insert = this.db.prepare(`
      INSERT INTO oauth_authorization_codes (
        code_hash, client_id, subject, redirect_uri, code_challenge,
        resource, scope, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const issue = this.db.transaction(() => {
      this.deleteExpired(issuedAt);
      insert.run(
        hashSecret(code),
        grant.clientId,
        grant.subject,
        grant.redirectUri,
        grant.codeChallenge,
        grant.resource,
        grant.scope,
        issuedAt + CODE_TTL_SECONDS,
        issuedAt,
      );
    });
    issue.immediate();
    return code;
  }

  exchangeAuthorizationCode(request: CodeExchange, now: Date): TokenPair {
    const nowSec = unixSeconds(now);
    const exchange = this.db.transaction((): TokenPair => {
      this.deleteExpired(nowSec);
      const row = this.db
        .prepare(
          `SELECT client_id, subject, redirect_uri, code_challenge, resource, scope, expires_at, used_at
           FROM oauth_authorization_codes WHERE code_hash = ?`,
        )
        .get(hashSecret(request.code)) as CodeRow | undefined;
      if (!row) throw new OAuthFlowError("invalid_grant");
      if (
        row.used_at !== null ||
        nowSec >= row.expires_at ||
        row.client_id !== request.clientId ||
        row.redirect_uri !== request.redirectUri
      ) {
        throw new OAuthFlowError("invalid_grant");
      }
      if (row.resource !== request.resource) throw new OAuthFlowError("invalid_target");
      if (!verifyPkceS256(request.codeVerifier, row.code_challenge))
        throw new OAuthFlowError("invalid_grant");

      const marked = this.db
        .prepare(
          "UPDATE oauth_authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
        )
        .run(nowSec, hashSecret(request.code));
      if (marked.changes !== 1) throw new OAuthFlowError("invalid_grant");
      return this.insertTokenPair(
        randomSecret("wamcp_family_", 18),
        row.client_id,
        row.subject,
        row.resource,
        row.scope,
        nowSec,
      );
    });
    return exchange.immediate();
  }

  rotateRefreshToken(request: RefreshExchange, now: Date): TokenPair {
    const nowSec = unixSeconds(now);
    const rotate = this.db.transaction((): { reuse: true } | { reuse: false; pair: TokenPair } => {
      this.deleteExpired(nowSec);
      const row = this.db
        .prepare(
          `SELECT family_id, client_id, subject, resource, scope, expires_at, revoked_at
           FROM oauth_tokens WHERE token_hash = ? AND token_type = 'refresh'`,
        )
        .get(hashSecret(request.refreshToken)) as RefreshRow | undefined;
      if (!row) throw new OAuthFlowError("invalid_grant");
      if (row.revoked_at !== null) {
        this.db
          .prepare(
            "UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
          )
          .run(nowSec, row.family_id);
        return { reuse: true };
      }
      if (nowSec >= row.expires_at || row.client_id !== request.clientId) {
        throw new OAuthFlowError("invalid_grant");
      }
      if (row.resource !== request.resource) throw new OAuthFlowError("invalid_target");

      const revoked = this.db
        .prepare(
          `UPDATE oauth_tokens SET revoked_at = ?
           WHERE token_hash = ? AND token_type = 'refresh' AND revoked_at IS NULL`,
        )
        .run(nowSec, hashSecret(request.refreshToken));
      if (revoked.changes !== 1) throw new OAuthFlowError("invalid_grant");
      return {
        reuse: false,
        pair: this.insertTokenPair(
          row.family_id,
          row.client_id,
          row.subject,
          row.resource,
          row.scope,
          nowSec,
        ),
      };
    });
    const result = rotate.immediate();
    if (result.reuse) throw new OAuthFlowError("refresh_reuse");
    return result.pair;
  }

  validateAccessToken(token: string, resource: string, now: Date): OAuthPrincipal | undefined {
    const row = this.db
      .prepare(
        `SELECT subject, client_id, scope, resource, expires_at, revoked_at
         FROM oauth_tokens WHERE token_hash = ? AND token_type = 'access'`,
      )
      .get(hashSecret(token)) as AccessRow | undefined;
    if (
      !row ||
      row.revoked_at !== null ||
      unixSeconds(now) >= row.expires_at ||
      row.resource !== resource
    ) {
      return undefined;
    }
    return { subject: row.subject, clientId: row.client_id, scope: row.scope };
  }

  private insertTokenPair(
    familyId: string,
    clientId: string,
    subject: string,
    resource: string,
    scope: string,
    nowSec: number,
  ): TokenPair {
    const accessToken = randomSecret("wamcp_at_", 32);
    const refreshToken = randomSecret("wamcp_rt_", 32);
    const insert = this.db.prepare(`
      INSERT INTO oauth_tokens (
        token_hash, token_type, family_id, client_id, subject, resource, scope, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      hashSecret(accessToken),
      "access",
      familyId,
      clientId,
      subject,
      resource,
      scope,
      nowSec + ACCESS_TTL_SECONDS,
      nowSec,
    );
    insert.run(
      hashSecret(refreshToken),
      "refresh",
      familyId,
      clientId,
      subject,
      resource,
      scope,
      nowSec + REFRESH_TTL_SECONDS,
      nowSec,
    );
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, scope };
  }

  private deleteExpired(nowSec: number): void {
    this.db.prepare("DELETE FROM oauth_authorization_codes WHERE expires_at <= ?").run(nowSec);
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at <= ?").run(nowSec);
  }

  private deleteUnusedClients(cutoffSec: number): void {
    this.db
      .prepare(
        `DELETE FROM oauth_clients
         WHERE created_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM oauth_authorization_codes
             WHERE oauth_authorization_codes.client_id = oauth_clients.client_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM oauth_tokens
             WHERE oauth_tokens.client_id = oauth_clients.client_id
           )`,
      )
      .run(cutoffSec);
  }
}

export function openOAuthStore(filename: string): OAuthStore {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return new OAuthStore(db);
}

export function newOAuthClientId(): string {
  return randomSecret("wamcp_client_", 24);
}
