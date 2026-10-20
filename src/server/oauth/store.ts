import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { normalizeClientIp } from "../ip-address.js";
import { logger } from "../../utils/logger.js";
import { loadCredentialMacKey } from "./credential-key.js";
import { verifyPkceS256 } from "./pkce.js";

const CODE_TTL_SECONDS = 5 * 60;
const ACCESS_TTL_SECONDS = 15 * 60;
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
  family_id TEXT,
  credential_version TEXT NOT NULL DEFAULT '',
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
  credential_version TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires_at ON oauth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client_id ON oauth_tokens(client_id);

CREATE TABLE IF NOT EXISTS oauth_registration_attempts (
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_registration_attempts_ip
  ON oauth_registration_attempts(ip, created_at);
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
  credentialVersion?: string;
}

/** Returns the current credential version, or undefined when the subject no longer exists. */
export type CredentialVersionResolver = (subject: string) => string | undefined;

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
  family_id: string | null;
  credential_version: string;
}

interface RefreshRow {
  family_id: string;
  client_id: string;
  subject: string;
  resource: string;
  scope: string;
  expires_at: number;
  revoked_at: number | null;
  credential_version: string;
}

interface AccessRow {
  family_id: string;
  subject: string;
  client_id: string;
  scope: string;
  resource: string;
  expires_at: number;
  revoked_at: number | null;
  credential_version: string;
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
  credentialVersion: CredentialVersionResolver | undefined;
  readonly macKey: Buffer;

  constructor(
    private readonly db: Database.Database,
    macKey: Buffer,
    private readonly filePath?: string,
  ) {
    this.macKey = macKey;
  }

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

  registerClient(client: OAuthClient, ip: string): void {
    const clientIp = normalizeRegistrationIp(ip);
    const insert = this.db.prepare(`
      INSERT INTO oauth_clients (
        client_id, client_name, redirect_uris_json, application_type,
        token_endpoint_auth_method, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertAttempt = this.db.prepare(
      "INSERT INTO oauth_registration_attempts (ip, created_at) VALUES (?, ?)",
    );
    const register = this.db.transaction(() => {
      this.deleteExpired(client.createdAt);
      this.deleteUnusedClients(client.createdAt - Math.floor(this.unusedClientTtlMs / 1000));
      const total = this.db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get() as CountRow;
      if (total.n >= this.maxClients) throw new OAuthFlowError("registration_limit");
      const windowStart = client.createdAt - Math.floor(this.registrationWindowMs / 1000);
      this.db
        .prepare("DELETE FROM oauth_registration_attempts WHERE created_at <= ?")
        .run(windowStart);
      const recent = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM oauth_registration_attempts WHERE ip = ? AND created_at > ?",
        )
        .get(clientIp, windowStart) as CountRow;
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
      insertAttempt.run(clientIp, client.createdAt);
    });
    register.immediate();
    this.tightenPermissions();
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
    const version = grant.credentialVersion ?? this.currentCredentialVersion(grant.subject);
    const insert = this.db.prepare(`
      INSERT INTO oauth_authorization_codes (
        code_hash, client_id, subject, redirect_uri, code_challenge,
        resource, scope, expires_at, created_at, credential_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        version,
      );
    });
    issue.immediate();
    this.tightenPermissions();
    return code;
  }

  exchangeAuthorizationCode(request: CodeExchange, now: Date): TokenPair {
    const nowSec = unixSeconds(now);
    const codeHash = hashSecret(request.code);
    const exchange = this.db.transaction(
      (): { kind: "issued"; pair: TokenPair } | { kind: "rejected" } => {
        this.deleteExpired(nowSec);
        const row = this.db
          .prepare(
            `SELECT client_id, subject, redirect_uri, code_challenge, resource, scope,
                  expires_at, used_at, family_id, credential_version
           FROM oauth_authorization_codes WHERE code_hash = ?`,
          )
          .get(codeHash) as CodeRow | undefined;
        if (!row) throw new OAuthFlowError("invalid_grant");
        if (row.used_at !== null) {
          if (row.family_id) this.revokeFamily(row.family_id, nowSec);
          return { kind: "rejected" };
        }
        if (
          nowSec >= row.expires_at ||
          row.client_id !== request.clientId ||
          row.redirect_uri !== request.redirectUri
        ) {
          throw new OAuthFlowError("invalid_grant");
        }
        if (row.resource !== request.resource) throw new OAuthFlowError("invalid_target");
        if (!verifyPkceS256(request.codeVerifier, row.code_challenge))
          throw new OAuthFlowError("invalid_grant");
        if (!this.subjectCredentialCurrent(row.subject, row.credential_version)) {
          this.db
            .prepare(
              "UPDATE oauth_authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
            )
            .run(nowSec, codeHash);
          return { kind: "rejected" };
        }

        const familyId = randomSecret("wamcp_family_", 18);
        const marked = this.db
          .prepare(
            `UPDATE oauth_authorization_codes
           SET used_at = ?, family_id = ?
           WHERE code_hash = ? AND used_at IS NULL`,
          )
          .run(nowSec, familyId, codeHash);
        if (marked.changes !== 1) {
          const current = this.db
            .prepare("SELECT family_id FROM oauth_authorization_codes WHERE code_hash = ?")
            .get(codeHash) as { family_id: string | null } | undefined;
          if (current?.family_id) this.revokeFamily(current.family_id, nowSec);
          return { kind: "rejected" };
        }
        return {
          kind: "issued",
          pair: this.insertTokenPair(
            familyId,
            row.client_id,
            row.subject,
            row.resource,
            row.scope,
            row.credential_version,
            nowSec,
            ACCESS_TTL_SECONDS,
          ),
        };
      },
    );
    const result = exchange.immediate();
    this.tightenPermissions();
    if (result.kind === "rejected") throw new OAuthFlowError("invalid_grant");
    return result.pair;
  }

  rotateRefreshToken(request: RefreshExchange, now: Date): TokenPair {
    const nowSec = unixSeconds(now);
    const rotate = this.db.transaction(
      (): { kind: "reuse" } | { kind: "rejected" } | { kind: "issued"; pair: TokenPair } => {
        this.deleteExpired(nowSec);
        const row = this.db
          .prepare(
            `SELECT family_id, client_id, subject, resource, scope, expires_at, revoked_at,
                    credential_version
             FROM oauth_tokens WHERE token_hash = ? AND token_type = 'refresh'`,
          )
          .get(hashSecret(request.refreshToken)) as RefreshRow | undefined;
        if (!row) throw new OAuthFlowError("invalid_grant");
        if (row.revoked_at !== null) {
          this.revokeFamily(row.family_id, nowSec);
          return { kind: "reuse" };
        }
        if (nowSec >= row.expires_at || row.client_id !== request.clientId) {
          throw new OAuthFlowError("invalid_grant");
        }
        if (row.resource !== request.resource) throw new OAuthFlowError("invalid_target");
        if (!this.subjectCredentialCurrent(row.subject, row.credential_version)) {
          this.revokeFamily(row.family_id, nowSec);
          return { kind: "rejected" };
        }

        const revoked = this.db
          .prepare(
            `UPDATE oauth_tokens SET revoked_at = ?
             WHERE token_hash = ? AND token_type = 'refresh' AND revoked_at IS NULL`,
          )
          .run(nowSec, hashSecret(request.refreshToken));
        if (revoked.changes !== 1) throw new OAuthFlowError("invalid_grant");
        this.db
          .prepare(
            `UPDATE oauth_tokens SET revoked_at = ?
             WHERE family_id = ? AND token_type = 'access' AND revoked_at IS NULL`,
          )
          .run(nowSec, row.family_id);
        return {
          kind: "issued",
          pair: this.insertTokenPair(
            row.family_id,
            row.client_id,
            row.subject,
            row.resource,
            row.scope,
            row.credential_version,
            nowSec,
            ACCESS_TTL_SECONDS,
          ),
        };
      },
    );
    const result = rotate.immediate();
    this.tightenPermissions();
    if (result.kind === "reuse") throw new OAuthFlowError("refresh_reuse");
    if (result.kind === "rejected") throw new OAuthFlowError("invalid_grant");
    return result.pair;
  }

  validateAccessToken(token: string, resource: string, now: Date): OAuthPrincipal | undefined {
    const row = this.db
      .prepare(
        `SELECT family_id, subject, client_id, scope, resource, expires_at, revoked_at,
                credential_version
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
    if (!this.subjectCredentialCurrent(row.subject, row.credential_version)) {
      const nowSec = unixSeconds(now);
      const revoke = this.db.transaction(() => {
        this.revokeFamily(row.family_id, nowSec);
      });
      revoke.immediate();
      this.tightenPermissions();
      return undefined;
    }
    return { subject: row.subject, clientId: row.client_id, scope: row.scope };
  }

  /** RFC 7009. Unknown tokens and client mismatches are ignored. */
  revokePresentedToken(token: string, clientId: string, now: Date): void {
    if (token.length < 1 || token.length > 4096) return;
    const nowSec = unixSeconds(now);
    const revoke = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT family_id, client_id FROM oauth_tokens WHERE token_hash = ?")
        .get(hashSecret(token)) as { family_id: string; client_id: string } | undefined;
      if (!row || (clientId !== "" && row.client_id !== clientId)) return;
      this.revokeFamily(row.family_id, nowSec);
    });
    revoke.immediate();
    this.tightenPermissions();
  }

  revokeSubject(subject: string, now: Date): void {
    if (subject.length < 1 || subject.length > 128) return;
    const nowSec = unixSeconds(now);
    const revoke = this.db.transaction(() => {
      this.db
        .prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE subject = ? AND revoked_at IS NULL")
        .run(nowSec, subject);
      this.db
        .prepare(
          `UPDATE oauth_authorization_codes SET used_at = ?
           WHERE subject = ? AND used_at IS NULL`,
        )
        .run(nowSec, subject);
    });
    revoke.immediate();
    this.tightenPermissions();
  }

  private currentCredentialVersion(subject: string): string {
    if (!this.credentialVersion) return "";
    return this.credentialVersion(subject) ?? "";
  }

  private subjectCredentialCurrent(subject: string, version: string): boolean {
    if (!this.credentialVersion) return true;
    const current = this.credentialVersion(subject);
    return current !== undefined && version !== "" && current === version;
  }

  private revokeFamily(familyId: string, nowSec: number): void {
    this.db
      .prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
      .run(nowSec, familyId);
  }

  private insertTokenPair(
    familyId: string,
    clientId: string,
    subject: string,
    resource: string,
    scope: string,
    credentialVersion: string,
    nowSec: number,
    accessTtlSeconds: number,
  ): TokenPair {
    const accessToken = randomSecret("wamcp_at_", 32);
    const refreshToken = randomSecret("wamcp_rt_", 32);
    const insert = this.db.prepare(`
      INSERT INTO oauth_tokens (
        token_hash, token_type, family_id, client_id, subject, resource, scope,
        expires_at, created_at, credential_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      hashSecret(accessToken),
      "access",
      familyId,
      clientId,
      subject,
      resource,
      scope,
      nowSec + accessTtlSeconds,
      nowSec,
      credentialVersion,
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
      credentialVersion,
    );
    return { accessToken, refreshToken, expiresIn: accessTtlSeconds, scope };
  }

  private deleteExpired(nowSec: number): void {
    this.db
      .prepare(
        `DELETE FROM oauth_authorization_codes
         WHERE (used_at IS NULL AND expires_at <= ?)
            OR (used_at IS NOT NULL AND created_at <= ?)`,
      )
      .run(nowSec, nowSec - REFRESH_TTL_SECONDS);
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

  private tightenPermissions(): void {
    if (!this.filePath) return;
    tightenOAuthFile(this.filePath);
  }
}

function normalizeRegistrationIp(ip: string): string {
  return normalizeClientIp(ip);
}

export function migrateOAuthSchema(db: Database.Database): void {
  ensureColumn(db, "oauth_authorization_codes", "family_id", "family_id TEXT");
  ensureColumn(
    db,
    "oauth_authorization_codes",
    "credential_version",
    "credential_version TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(
    db,
    "oauth_tokens",
    "credential_version",
    "credential_version TEXT NOT NULL DEFAULT ''",
  );
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function tightenOAuthFile(filePath: string): void {
  chmodSync(filePath, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    const sibling = `${filePath}${suffix}`;
    if (existsSync(sibling)) chmodSync(sibling, 0o600);
  }
}

function prepareOAuthDirectory(directory: string): void {
  if (existsSync(directory)) {
    const mode = statSync(directory).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      logger.warn(
        { mode: mode.toString(8) },
        "OAuth database directory allows access by other users; its permissions were left unchanged",
      );
    }
    return;
  }
  const created: string[] = [];
  let current = directory;
  while (!existsSync(current)) {
    created.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(directory, { recursive: true });
  for (const path of created) chmodSync(path, 0o700);
}

export function openOAuthStore(filename: string): OAuthStore {
  const memory = filename === ":memory:";
  if (!memory) prepareOAuthDirectory(dirname(filename));
  const macKey = loadCredentialMacKey(filename);
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrateOAuthSchema(db);
  const store = new OAuthStore(db, macKey, memory ? undefined : filename);
  if (!memory) tightenOAuthFile(filename);
  return store;
}

export function newOAuthClientId(): string {
  return randomSecret("wamcp_client_", 24);
}
