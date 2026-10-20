import type { IncomingMessage, ServerResponse } from "node:http";
import { logger as appLogger } from "../../utils/logger.js";
import { validPkceChallenge, validPkceVerifier } from "./pkce.js";
import {
  hasControlCharacter,
  redirectDisplay,
  redirectOrigin,
  redirectUriMatches,
  validRedirectUri,
} from "./redirect.js";
import {
  newOAuthClientId,
  OAuthFlowError,
  openOAuthStore,
  type OAuthClient,
  type OAuthStore,
} from "./store.js";
import { parsePublicHttpsUrl, wellKnownPath } from "./urls.js";

const MAX_OAUTH_BODY_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS_BYTES = 8 * 1024;
const MAX_CLIENT_NAME_BYTES = 200;
const DEFAULT_SCOPE = "mcp";

export interface OAuthLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface McpOAuthServerOptions {
  issuerUrl: string;
  resourceUrl: string;
  store: OAuthStore;
  validateCredential: (username: string, password: string) => boolean;
  now?: () => Date;
  log?: OAuthLogger;
}

interface AuthorizationInput {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  scope: string;
  state: string;
}

const defaultLogger: OAuthLogger = {
  info(bindings, message) {
    appLogger.info(bindings, message);
  },
  warn(bindings, message) {
    appLogger.warn(bindings, message);
  },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function contentTypeIs(req: IncomingMessage, expected: string): boolean {
  const header = req.headers["content-type"];
  if (typeof header !== "string") return false;
  return header.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readLimitedBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | "too_large"> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    req.resume();
    return "too_large";
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > maxBytes) {
      req.resume();
      return "too_large";
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendOAuthError(
  res: ServerResponse,
  status: number,
  error: string,
  description: string,
): void {
  sendJson(res, status, { error, error_description: description });
}

function authorizationPageCsp(redirectUri: string): string {
  const origin = redirectOrigin(redirectUri);
  const formAction = origin ? `'self' ${origin}` : "'self'";
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;
}

export class McpOAuthServer {
  readonly store: OAuthStore;
  private readonly issuerUrl: string;
  private readonly resourceUrl: string;
  private readonly validateCredential: (username: string, password: string) => boolean;
  private readonly now: () => Date;
  private readonly log: OAuthLogger;
  private readonly paths: {
    authorizationServerMetadata: string;
    protectedResourceMetadata: string;
    register: string;
    authorize: string;
    token: string;
  };

  constructor(options: McpOAuthServerOptions) {
    const issuer = parsePublicHttpsUrl(options.issuerUrl, "WA_MCP_OAUTH_ISSUER_URL");
    const resource = parsePublicHttpsUrl(options.resourceUrl, "WA_MCP_OAUTH_RESOURCE_URL");
    this.issuerUrl = issuer.href;
    this.resourceUrl = resource.href;
    this.store = options.store;
    this.validateCredential = options.validateCredential;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? defaultLogger;
    this.paths = {
      authorizationServerMetadata: wellKnownPath("oauth-authorization-server", issuer.path),
      protectedResourceMetadata: wellKnownPath("oauth-protected-resource", resource.path),
      register: `${issuer.path}/oauth/register`,
      authorize: `${issuer.path}/oauth/authorize`,
      token: `${issuer.path}/oauth/token`,
    };
  }

  close(): void {
    this.store.close();
  }

  protectedResourceMetadataUrl(): string {
    const resource = parsePublicHttpsUrl(this.resourceUrl, "WA_MCP_OAUTH_RESOURCE_URL");
    return `${resource.origin}${this.paths.protectedResourceMetadata}`;
  }

  handles(pathname: string): boolean {
    return (
      pathname === this.paths.authorizationServerMetadata ||
      pathname === this.paths.protectedResourceMetadata ||
      pathname === this.paths.register ||
      pathname === this.paths.authorize ||
      pathname === this.paths.token
    );
  }

  authenticateAccessToken(token: string): boolean {
    if (token.length < 1 || token.length > 4096) return false;
    return this.store.validateAccessToken(token, this.resourceUrl, this.now()) !== undefined;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = req.url ?? "/";
    if (requestUrl.length > MAX_OAUTH_BODY_BYTES) {
      sendOAuthError(res, 414, "invalid_request", "request is too large");
      return;
    }
    let url: URL;
    try {
      url = new URL(requestUrl, "http://127.0.0.1");
    } catch {
      sendOAuthError(res, 400, "invalid_request", "invalid request target");
      return;
    }

    if (url.pathname === this.paths.authorizationServerMetadata) {
      this.serveAuthorizationServerMetadata(req, res);
      return;
    }
    if (url.pathname === this.paths.protectedResourceMetadata) {
      this.serveProtectedResourceMetadata(req, res);
      return;
    }
    if (url.pathname === this.paths.register) {
      await this.register(req, res);
      return;
    }
    if (url.pathname === this.paths.authorize) {
      if (req.method === "GET") {
        this.authorizeGet(res, url);
        return;
      }
      if (req.method === "POST") {
        await this.authorizePost(req, res);
        return;
      }
      sendOAuthError(res, 405, "invalid_request", "method not allowed");
      return;
    }
    if (url.pathname === this.paths.token) {
      await this.token(req, res);
      return;
    }
    sendOAuthError(res, 404, "invalid_request", "unknown OAuth endpoint");
  }

  private serveAuthorizationServerMetadata(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      sendOAuthError(res, 405, "invalid_request", "method not allowed");
      return;
    }
    sendJson(res, 200, {
      issuer: this.issuerUrl,
      authorization_endpoint: `${this.issuerUrl}/oauth/authorize`,
      token_endpoint: `${this.issuerUrl}/oauth/token`,
      registration_endpoint: `${this.issuerUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [DEFAULT_SCOPE],
      authorization_response_iss_parameter_supported: true,
    });
  }

  private serveProtectedResourceMetadata(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      sendOAuthError(res, 405, "invalid_request", "method not allowed");
      return;
    }
    sendJson(res, 200, {
      resource: this.resourceUrl,
      authorization_servers: [this.issuerUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: [DEFAULT_SCOPE],
      resource_name: "WA MCP",
    });
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendOAuthError(res, 405, "invalid_request", "method not allowed");
      return;
    }
    const body = await readLimitedBody(req, MAX_OAUTH_BODY_BYTES);
    if (body === "too_large") {
      sendOAuthError(res, 413, "invalid_client_metadata", "registration document is too large");
      return;
    }
    if (!contentTypeIs(req, "application/json")) {
      sendOAuthError(res, 400, "invalid_client_metadata", "invalid registration document");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      sendOAuthError(res, 400, "invalid_client_metadata", "invalid registration document");
      return;
    }
    if (!isRecord(parsed)) {
      sendOAuthError(res, 400, "invalid_client_metadata", "invalid registration document");
      return;
    }

    const redirectUris = parsed.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length < 1 ||
      redirectUris.length > 10 ||
      !redirectUris.every((entry) => typeof entry === "string")
    ) {
      sendOAuthError(
        res,
        400,
        "invalid_redirect_uri",
        "redirect_uris must contain between 1 and 10 entries",
      );
      return;
    }

    const applicationType = parsed.application_type === undefined ? "web" : parsed.application_type;
    if (applicationType !== "web" && applicationType !== "native") {
      sendOAuthError(res, 400, "invalid_client_metadata", "unsupported application_type");
      return;
    }
    const tokenEndpointAuthMethod =
      parsed.token_endpoint_auth_method === undefined ? "none" : parsed.token_endpoint_auth_method;
    if (tokenEndpointAuthMethod !== "none") {
      sendOAuthError(res, 400, "invalid_client_metadata", "only public clients are supported");
      return;
    }
    if (
      !onlySupported(parsed.grant_types, ["authorization_code", "refresh_token"]) ||
      !onlySupported(parsed.response_types, ["code"])
    ) {
      sendOAuthError(
        res,
        400,
        "invalid_client_metadata",
        "unsupported response_type or grant_type",
      );
      return;
    }

    let redirectBytes = 0;
    for (const redirectUri of redirectUris) {
      redirectBytes += Buffer.byteLength(redirectUri);
      if (Buffer.byteLength(redirectUri) > 2048 || redirectBytes > MAX_REDIRECT_URIS_BYTES) {
        sendOAuthError(res, 400, "invalid_redirect_uri", "redirect URI is too long");
        return;
      }
      if (!validRedirectUri(redirectUri, applicationType)) {
        sendOAuthError(
          res,
          400,
          "invalid_redirect_uri",
          "redirect URI must use HTTPS, except native loopback redirects",
        );
        return;
      }
    }

    const name = clientName(parsed.client_name);
    if (name === undefined) {
      sendOAuthError(res, 400, "invalid_client_metadata", "client_name is invalid");
      return;
    }

    const client: OAuthClient = {
      id: newOAuthClientId(),
      name,
      redirectUris: [...redirectUris],
      applicationType,
      tokenEndpointAuthMethod: "none",
      createdAt: Math.floor(this.now().getTime() / 1000),
    };
    try {
      this.store.registerClient(client);
    } catch (error) {
      if (error instanceof OAuthFlowError && error.oauthCode === "registration_limit") {
        this.log.warn(
          { event: "oauth_registration_limited" },
          "OAuth dynamic client registration limit reached",
        );
        sendOAuthError(
          res,
          429,
          "temporarily_unavailable",
          "dynamic client registration limit reached; retry later",
        );
        return;
      }
      this.log.warn({ event: "oauth_client_register_failed" }, "OAuth client registration failed");
      sendOAuthError(res, 500, "server_error", "could not register client");
      return;
    }

    this.log.info({ event: "oauth_client_registered" }, "OAuth client registered");
    sendJson(res, 201, {
      client_id: client.id,
      client_id_issued_at: client.createdAt,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      application_type: client.applicationType,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  private authorizeGet(res: ServerResponse, url: URL): void {
    const input = authorizationInputFrom(url.searchParams);
    const validated = this.validateAuthorization(input);
    if (!validated.ok) {
      this.sendAuthorizationFailure(res, input, validated);
      return;
    }
    this.renderAuthorize(res, 200, input, validated.client, "");
  }

  private async authorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!contentTypeIs(req, "application/x-www-form-urlencoded")) {
      sendOAuthError(res, 400, "invalid_request", "invalid authorization request");
      return;
    }
    const body = await readLimitedBody(req, MAX_OAUTH_BODY_BYTES);
    if (body === "too_large") {
      sendOAuthError(res, 413, "invalid_request", "request is too large");
      return;
    }
    const input = authorizationInputFrom(new URLSearchParams(body.toString("utf8")));
    const validated = this.validateAuthorization(input);
    if (!validated.ok) {
      this.sendAuthorizationFailure(res, input, validated);
      return;
    }

    const form = new URLSearchParams(body.toString("utf8"));
    const username = form.get("username") ?? "";
    const password = form.get("password") ?? "";
    if (
      username.length < 1 ||
      username.length > 128 ||
      password.length < 1 ||
      password.length > 256 ||
      !this.validateCredential(username, password)
    ) {
      this.log.warn(
        { event: "oauth_authorize_rejected" },
        "OAuth authorization credentials were rejected",
      );
      this.renderAuthorize(res, 401, input, validated.client, "Invalid username or password.");
      return;
    }

    let code: string;
    try {
      code = this.store.issueAuthorizationCode(
        {
          clientId: input.clientId,
          subject: username,
          redirectUri: input.redirectUri,
          codeChallenge: input.codeChallenge,
          resource: input.resource,
          scope: input.scope || DEFAULT_SCOPE,
        },
        this.now(),
      );
    } catch {
      this.log.warn(
        { event: "oauth_code_issue_failed" },
        "OAuth authorization code could not be issued",
      );
      sendOAuthError(res, 500, "server_error", "could not issue authorization code");
      return;
    }

    const location = redirectLocation(input.redirectUri, {
      code,
      ...(input.state ? { state: input.state } : {}),
      iss: this.issuerUrl,
    });
    this.log.info({ event: "oauth_authorization_granted" }, "OAuth authorization code issued");
    this.redirect(res, location);
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendOAuthError(res, 405, "invalid_request", "method not allowed");
      return;
    }
    if (!contentTypeIs(req, "application/x-www-form-urlencoded")) {
      sendOAuthError(res, 400, "invalid_request", "invalid token request");
      return;
    }
    const body = await readLimitedBody(req, MAX_OAUTH_BODY_BYTES);
    if (body === "too_large") {
      sendOAuthError(res, 413, "invalid_request", "request is too large");
      return;
    }
    const form = new URLSearchParams(body.toString("utf8"));
    const resource = form.get("resource") ?? "";
    if (resource !== this.resourceUrl) {
      sendOAuthError(res, 400, "invalid_target", "resource does not match this MCP server");
      return;
    }

    const grantType = form.get("grant_type") ?? "";
    const codeVerifier = form.get("code_verifier") ?? "";
    if (grantType === "authorization_code" && !validPkceVerifier(codeVerifier)) {
      sendOAuthError(res, 400, "invalid_grant", "invalid authorization code or PKCE verifier");
      return;
    }
    try {
      const pair =
        grantType === "authorization_code"
          ? this.store.exchangeAuthorizationCode(
              {
                clientId: form.get("client_id") ?? "",
                code: form.get("code") ?? "",
                redirectUri: form.get("redirect_uri") ?? "",
                codeVerifier,
                resource,
              },
              this.now(),
            )
          : grantType === "refresh_token"
            ? this.store.rotateRefreshToken(
                {
                  clientId: form.get("client_id") ?? "",
                  refreshToken: form.get("refresh_token") ?? "",
                  resource,
                },
                this.now(),
              )
            : undefined;
      if (!pair) {
        sendOAuthError(
          res,
          400,
          "unsupported_grant_type",
          "supported grant types are authorization_code and refresh_token",
        );
        return;
      }
      this.log.info({ event: "oauth_token_issued", grantType }, "OAuth token issued");
      sendJson(res, 200, {
        access_token: pair.accessToken,
        token_type: "Bearer",
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
        scope: pair.scope,
      });
    } catch (error) {
      if (error instanceof OAuthFlowError && error.oauthCode === "invalid_target") {
        sendOAuthError(
          res,
          400,
          "invalid_target",
          "resource does not match the authorization grant",
        );
        return;
      }
      if (
        error instanceof OAuthFlowError &&
        (error.oauthCode === "invalid_grant" || error.oauthCode === "refresh_reuse")
      ) {
        this.log.warn(
          { event: "oauth_token_rejected", reason: error.oauthCode },
          "OAuth token request was rejected",
        );
        sendOAuthError(
          res,
          400,
          "invalid_grant",
          "authorization grant is invalid, expired, or already used",
        );
        return;
      }
      this.log.warn({ event: "oauth_token_failed" }, "OAuth token request failed");
      sendOAuthError(res, 500, "server_error", "token request failed");
    }
  }

  private validateAuthorization(
    input: AuthorizationInput,
  ):
    | { ok: true; client: OAuthClient }
    | { ok: false; error: string; description: string; redirect: boolean } {
    if (
      input.clientId.length < 1 ||
      input.clientId.length > 256 ||
      input.redirectUri.length < 1 ||
      input.redirectUri.length > 2048
    ) {
      return {
        ok: false,
        error: "invalid_request",
        description: "unknown client_id",
        redirect: false,
      };
    }
    const client = this.store.getClient(input.clientId);
    if (!client || !redirectUriMatches(client, input.redirectUri)) {
      return {
        ok: false,
        error: "invalid_request",
        description: client
          ? "redirect_uri does not match the registered client"
          : "unknown client_id",
        redirect: false,
      };
    }
    if (input.responseType !== "code") {
      return {
        ok: false,
        error: "unsupported_response_type",
        description: "response_type must be code",
        redirect: true,
      };
    }
    if (
      input.codeChallenge.length > 128 ||
      input.codeChallengeMethod.length > 32 ||
      input.codeChallengeMethod !== "S256" ||
      !validPkceChallenge(input.codeChallenge)
    ) {
      return {
        ok: false,
        error: "invalid_request",
        description: "PKCE S256 is required",
        redirect: true,
      };
    }
    if (input.resource.length > 2048 || input.resource !== this.resourceUrl) {
      return {
        ok: false,
        error: "invalid_target",
        description: "resource does not match this MCP server",
        redirect: true,
      };
    }
    if (input.scope.length > 256 || (input.scope !== "" && input.scope !== DEFAULT_SCOPE)) {
      return {
        ok: false,
        error: "invalid_scope",
        description: "only the mcp scope is supported",
        redirect: true,
      };
    }
    if (input.state.length > 2048) {
      return {
        ok: false,
        error: "invalid_request",
        description: "state is too long",
        redirect: true,
      };
    }
    return { ok: true, client };
  }

  private sendAuthorizationFailure(
    res: ServerResponse,
    input: AuthorizationInput,
    failure: { error: string; description: string; redirect: boolean },
  ): void {
    if (!failure.redirect) {
      sendOAuthError(res, 400, failure.error, failure.description);
      return;
    }
    this.redirect(
      res,
      redirectLocation(input.redirectUri, {
        error: failure.error,
        error_description: failure.description,
        ...(input.state ? { state: input.state } : {}),
        iss: this.issuerUrl,
      }),
    );
  }

  private renderAuthorize(
    res: ServerResponse,
    status: number,
    input: AuthorizationInput,
    client: OAuthClient,
    pageError: string,
  ): void {
    const display = redirectDisplay(input.redirectUri);
    const name = escapeHtml(client.name);
    const target = escapeHtml(display.target);
    const continuation = display.local
      ? `After authorization, you will return to ${name} on this device (${target}).`
      : `After authorization, you will continue to ${target}.`;
    const error = pageError ? `<p class="error">${escapeHtml(pageError)}</p>` : "";
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}
label{display:block;margin-top:1rem}
input{box-sizing:border-box;width:100%;padding:.65rem}
button{margin-top:1.25rem;padding:.7rem 1rem}
.error{color:#a00}
</style>
</head>
<body>
<h1>Authorize ${name}</h1>
<p>Sign in with a configured WA MCP account to allow this MCP client to access WhatsApp.</p>
<p>${continuation}</p>
${error}
<form method="post" action="${escapeHtml(this.paths.authorize)}">
<input type="hidden" name="response_type" value="${escapeHtml(input.responseType)}">
<input type="hidden" name="client_id" value="${escapeHtml(input.clientId)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(input.redirectUri)}">
<input type="hidden" name="code_challenge" value="${escapeHtml(input.codeChallenge)}">
<input type="hidden" name="code_challenge_method" value="${escapeHtml(input.codeChallengeMethod)}">
<input type="hidden" name="resource" value="${escapeHtml(input.resource)}">
<input type="hidden" name="scope" value="${escapeHtml(input.scope || DEFAULT_SCOPE)}">
<input type="hidden" name="state" value="${escapeHtml(input.state)}">
<label>Username <input name="username" autocomplete="username" required></label>
<label>Password <input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">Authorize</button>
</form>
</body>
</html>`;
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Content-Security-Policy": authorizationPageCsp(input.redirectUri),
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(html);
  }

  private redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, {
      Location: location,
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    });
    res.end();
  }
}

function onlySupported(values: unknown, supported: readonly string[]): boolean {
  if (values === undefined) return true;
  if (!Array.isArray(values)) return false;
  return values.every((value) => typeof value === "string" && supported.includes(value));
}

function clientName(value: unknown): string | undefined {
  if (value === undefined) return "MCP client";
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name) return "MCP client";
  if (hasControlCharacter(name) || Buffer.byteLength(name) > MAX_CLIENT_NAME_BYTES)
    return undefined;
  return name;
}

function authorizationInputFrom(params: URLSearchParams): AuthorizationInput {
  return {
    responseType: params.get("response_type") ?? "",
    clientId: params.get("client_id") ?? "",
    redirectUri: params.get("redirect_uri") ?? "",
    codeChallenge: params.get("code_challenge") ?? "",
    codeChallengeMethod: params.get("code_challenge_method") ?? "",
    resource: params.get("resource") ?? "",
    scope: params.get("scope") ?? "",
    state: params.get("state") ?? "",
  };
}

function redirectLocation(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function createMcpOAuthServer(options: {
  issuerUrl: string;
  resourceUrl: string;
  dbPath: string;
  validateCredential: (username: string, password: string) => boolean;
  now?: () => Date;
  log?: OAuthLogger;
}): McpOAuthServer {
  const store = openOAuthStore(options.dbPath);
  try {
    return new McpOAuthServer({ ...options, store });
  } catch (error) {
    store.close();
    throw error;
  }
}
