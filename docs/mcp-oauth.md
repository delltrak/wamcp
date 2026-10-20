# MCP OAuth

WA MCP can embed an OAuth 2.1 authorization server for its streamable HTTP MCP endpoint. Remote MCP clients that cannot send `WA_MCP_API_KEY` complete an authorization-code flow with PKCE, then call `/mcp` with the issued bearer token.

OAuth is **disabled by default**. Nothing in this document changes a deployment that leaves the new variables unset: `/mcp`, `/health`, and `/cloud-webhook` stay where they are, and `WA_MCP_API_KEY` behaves as before.

When OAuth is enabled, the MCP endpoint accepts any configured method:

- `Authorization: Bearer` with the existing `WA_MCP_API_KEY`
- `X-Api-Key` with that same key
- `Authorization: Basic` for any `WA_BASIC_AUTH` user
- `Authorization: Bearer` with an OAuth access token

Health stays unauthenticated. The Cloud API webhook keeps Meta's signature check and does not accept OAuth tokens. OAuth tokens are not credentials for anything except the MCP endpoint.

## Configuration

```env
WA_BASIC_AUTH=alice:replace-me,bob:replace-me
WA_BASE_PATH=/wamcp
WA_MCP_OAUTH_ENABLED=true
WA_MCP_OAUTH_ISSUER_URL=https://wa.example.com/wamcp
# Optional. Defaults to the issuer origin, the base path, and /mcp.
WA_MCP_OAUTH_RESOURCE_URL=https://wa.example.com/wamcp/mcp
# Optional. Created only when OAuth is enabled. Must not be the WhatsApp database.
WA_MCP_OAUTH_DB_PATH=data/oauth.db
```

`WA_MCP_OAUTH_ISSUER_URL` is required. It must be an absolute public HTTPS URL with no userinfo, query, or fragment, and its path must equal `WA_BASE_PATH` (both empty, or both `/wamcp`). The resource URL must be that origin plus the base path plus `/mcp`. Startup fails when OAuth is enabled without at least one Basic Auth user, because the authorization page signs in with those accounts.

Without a base path:

```env
WA_BASIC_AUTH=alice:replace-me
WA_MCP_OAUTH_ENABLED=true
WA_MCP_OAUTH_ISSUER_URL=https://wa.example.com
```

The MCP resource is `https://wa.example.com/mcp`.

### Basic Auth passwords

`WA_BASIC_AUTH` is a comma-separated list of `username:password` pairs. Usernames are 1–128 characters from `A-Za-z0-9._~@+-`. Passwords are 1–256 characters and may contain colons; the first colon separates the username. Commas separate accounts, so a password that needs a comma must use the scrypt form.

A password that starts with `$scrypt$` is a verifier, not the plaintext:

```text
$scrypt$<base64url salt>$<base64url 32-byte hash>
```

The parameters are scrypt `N=16384`, `r=8`, `p=1`. Generate one with:

```bash
node --input-type=module -e 'import { randomBytes, scryptSync } from "node:crypto"; const salt = randomBytes(16); const hash = scryptSync(process.argv[1], salt, 32, { N: 16384, r: 8, p: 1 }); console.log(`$scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`);' 'replace-me'
```

The server never writes passwords, API keys, authorization codes, or tokens to the log.

## What a client does

1. `POST` the MCP resource without a token and read `WWW-Authenticate`. The `resource_metadata` parameter is the protected-resource metadata URL.
2. Fetch that document. It lists the issuer in `authorization_servers`.
3. Fetch the authorization-server metadata from the path-inserted well-known URL.
4. Register a public client at `registration_endpoint` when the client does not already have a `client_id`.
5. Send the user to `authorization_endpoint` with `response_type=code`, PKCE `S256`, `resource` set to the canonical MCP URL, and `scope=mcp`.
6. The user signs in with a `WA_BASIC_AUTH` account. The callback receives `code`, `state`, and `iss`.
7. Exchange the code at `token_endpoint`. Refresh tokens rotate. Reusing a rotated refresh token revokes that token family.
8. Call the MCP endpoint with `Authorization: Bearer` and the access token.

For a root deployment the discovery URLs are:

```text
https://wa.example.com/.well-known/oauth-protected-resource/mcp
https://wa.example.com/.well-known/oauth-authorization-server
https://wa.example.com/oauth/register
https://wa.example.com/oauth/authorize
https://wa.example.com/oauth/token
```

With `WA_BASE_PATH=/wamcp` and issuer `https://wa.example.com/wamcp`, application routes move under that prefix:

```text
https://wa.example.com/wamcp/mcp
https://wa.example.com/wamcp/health
https://wa.example.com/wamcp/cloud-webhook
https://wa.example.com/wamcp/oauth/register
https://wa.example.com/wamcp/oauth/authorize
https://wa.example.com/wamcp/oauth/token
```

RFC 8414 and RFC 9728 insert the path after the well-known prefix. The reverse proxy must route these root paths to WA MCP as well:

```text
https://wa.example.com/.well-known/oauth-authorization-server/wamcp
https://wa.example.com/.well-known/oauth-protected-resource/wamcp/mcp
```

The `401` challenge includes the protected-resource metadata URL, so a conforming client does not have to guess it.

## Security model

- Public clients only (`token_endpoint_auth_method=none`).
- Authorization code with mandatory PKCE `S256`. Codes are single-use and expire after 5 minutes.
- Access tokens expire after 1 hour. Refresh tokens expire after 30 days and rotate on use.
- Reuse of a rotated refresh token revokes the whole token family, including outstanding access tokens.
- Codes and tokens are random. The database stores SHA-256 hashes, not the raw values.
- The OAuth `resource` value is bound to the canonical MCP URL at authorization, token issuance, refresh, and MCP access.
- Successful and failed authorization redirects include the issuer (`iss`) after the client and redirect URI have been validated.
- Redirect URIs must match the registered value. Native clients may change only the port of an `http://127.0.0.1` or `http://[::1]` callback. `localhost` callbacks require an explicit port and still match exactly, including the port.
- HTTPS redirect URIs are accepted for web and native clients. Plain HTTP is limited to native loopback callbacks.
- The authorization page sets `Cache-Control: no-store`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a restrictive `Content-Security-Policy`.
- Dynamic registration documents are limited to 16 KiB, each redirect URI to 2 KiB, 10 redirect URIs, 40 new clients per hour, and 1,000 stored clients. Clients unused for 24 hours are pruned before a new registration is accepted.
- The OAuth state lives in `WA_MCP_OAUTH_DB_PATH` (default `data/oauth.db`), which is created only when OAuth is enabled. It is not the WhatsApp session database.

Internet-facing deployments should rate-limit failed sign-in attempts at the reverse proxy. The issuer and resource values are the public HTTPS URLs clients use, not the container's internal address.
