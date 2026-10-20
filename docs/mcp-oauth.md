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
# The database file is mode 0600. A new parent directory is mode 0700.
# An existing directory, including data/, is left unchanged.
WA_MCP_OAUTH_DB_PATH=data/oauth.db
# Optional. open (default) or disabled.
WA_MCP_OAUTH_DCR=open
# Optional. Comma-separated hostnames or native scheme names. Unset allows every valid redirect.
WA_MCP_OAUTH_REDIRECT_HOST_ALLOWLIST=client.example,com.example.app
```

`WA_TRUST_PROXY` is optional and empty by default. It is a comma-separated CIDR list. `X-Forwarded-For` is used only when the socket peer belongs to that list. Leave it unset when WA MCP is reached directly.

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

The parameters are scrypt `N=16384`, `r=8`, `p=1`. The server derives that key asynchronously and keeps a successful verification for 30 seconds. Generate a verifier with:

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
7. Exchange the code at `token_endpoint`. Access tokens expire after 15 minutes. Refresh tokens rotate and revoke the previous access token. Reusing a rotated refresh token, or reusing the authorization code, revokes that token family.
8. Call the MCP endpoint with `Authorization: Bearer` and the access token. `POST /oauth/revoke` with `token` and `client_id` revokes that token's family. The same endpoint with `username`, plus that user's Basic credentials or `WA_MCP_API_KEY`, revokes every token for the user.

For a root deployment the discovery URLs are:

```text
https://wa.example.com/.well-known/oauth-protected-resource/mcp
https://wa.example.com/.well-known/oauth-authorization-server
https://wa.example.com/oauth/register
https://wa.example.com/oauth/authorize
https://wa.example.com/oauth/token
https://wa.example.com/oauth/revoke
```

With `WA_BASE_PATH=/wamcp` and issuer `https://wa.example.com/wamcp`, application routes move under that prefix:

```text
https://wa.example.com/wamcp/mcp
https://wa.example.com/wamcp/health
https://wa.example.com/wamcp/cloud-webhook
https://wa.example.com/wamcp/oauth/register
https://wa.example.com/wamcp/oauth/authorize
https://wa.example.com/wamcp/oauth/token
https://wa.example.com/wamcp/oauth/revoke
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
- Access tokens expire after 15 minutes, including the token issued with the authorization code. Refresh tokens expire after 30 days. Rotation revokes the refresh token that was presented and every previous access token in that family.
- Reuse of a rotated refresh token, or reuse of an authorization code, revokes the whole token family, including outstanding access tokens.
- Tokens are bound to the Basic Auth account that approved them with an HMAC of the credential and a per-install key stored next to the OAuth database (`oauth.db.mac`, mode 0600). The key is written to a temporary file and linked into place. Back up that key with `oauth.db`. Losing it rejects every stored token and signs every session out. Removing an account, or changing its password, makes refresh and access fail and revokes the family. Revoking a user also invalidates that user's unused authorization codes. Tokens issued before this binding have an empty credential version and are rejected.
- Failed sign-in attempts on the authorization page and failed Basic authentication on `/mcp` are counted before the password check. The strict lock is the client address and the address-plus-username pair. One other address cannot lock the name by itself. The username is also limited across addresses after 128 failures, for example 16 IPv6 /64s or NATs each using the 8 free attempts. The attempt that crosses a limit is still checked. If it fails, the next attempts are locked: sign-in then returns 429 with `Retry-After`. The delay starts at one second and doubles on each later failure, up to 15 minutes, including the global username lock, so the same 429 is what that user sees from every address. A distributed attacker can keep that global lock with about one failure per window. While that continues, sign-in stays 429 except for that username at an address that signed in during the last hour, and only for a few failures. After a quiet window with no further failure, the correct password is accepted. A successful password removes that request's count and the lock that request created. If the attempt token was already dropped, the count stays and the exemption is still recorded. A lock that was already in effect stays until it expires, so other failures on the address remain. The failure count is kept when a lock expires. Quiet time is measured from the later of the last attempt and the end of the lock, so a 15 minute lock stays at that ceiling. A recent success exempts only that username at that address, for a few failures; any wrong password removes the exemption. The address bucket is an IPv6 /64 or everyone behind the same NAT when `WA_TRUST_PROXY` is unset. The presented username is limited whether or not an account exists. Usernames are kept in a fixed table of 65536 buckets, selected by an HMAC of the name with a key created for this process. That table does not evict. Names that share a bucket add their failures together, so a collision only makes the limit stricter. A quiet period halves that bucket's count instead of clearing it, so repeating the free attempts once per window eventually locks the name. Locking every bucket takes on the order of 11 million failures when names are spread across the table. Keeping every bucket locked takes about one failure per bucket per 15 minutes: roughly 70 requests per second with one name for each bucket, or several hundred per second without that map. While that continues, sign-in on the authorization page and Basic authentication on `/mcp` stay 429 except for a username that signed in from that address in the last hour, for a few failures. An access token that was already issued still works. The `Retry-After` of a username lock is the 15 minute ceiling for every bucket, so the number does not show which bucket the name uses. `GET /oauth/authorize` does not consult the username. The address maps, when full, drop the unlocked entry with the fewest failures, and the oldest of those on a tie. A live address lock is not dropped. When every address slot is an active lock, a new address is counted in one shared overflow bucket instead of being refused, which answers 429 for a new address while those locks last. A recent success at that address does not create an address bucket. A full username table does not by itself return 429. `X-Forwarded-For` is ignored unless `WA_TRUST_PROXY` lists the socket peer, and a hop that is not an IP stops the walk. scrypt checks use a short queue and keep one slot for an address that signed in recently; a full queue returns 429 and still counts the attempt.
- Codes and tokens are random. The database stores SHA-256 hashes, not the raw values.
- The OAuth `resource` value is bound to the canonical MCP URL at authorization, token issuance, refresh, and MCP access.
- Successful and failed authorization redirects include the issuer (`iss`) after the client and redirect URI have been validated.
- Redirect URIs must match the registered value. Native clients may change only the port of an `http://127.0.0.1` or `http://[::1]` callback. `localhost` callbacks require an explicit port and still match exactly, including the port.
- HTTPS redirect URIs are accepted for web and native clients. Plain HTTP is limited to native loopback callbacks, and both `127.0.0.1` and `localhost` require an explicit port. Native clients may register a reverse-DNS scheme such as `com.example.app:/cb` (RFC 8252). Schemes without a dot, and network or handler schemes such as `ftp`, `mailto`, `intent`, and `javascript`, are rejected.
- `WA_MCP_OAUTH_REDIRECT_HOST_ALLOWLIST` restricts those redirects to the listed hostnames or scheme names. Leave it unset to allow every redirect that passes the rules above.
- Metadata, dynamic registration, the token endpoint, and the revocation endpoint send `Access-Control-Allow-Origin: *`. The authorization page does not.
- The authorization page sets `Cache-Control: no-store`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a restrictive `Content-Security-Policy`.
- Dynamic registration documents are limited to 16 KiB, each redirect URI to 2 KiB, 10 redirect URIs, 40 new clients per IP per hour, and 1,000 stored clients. Clients unused for 24 hours are pruned before a new registration is accepted. `WA_MCP_OAUTH_DCR=disabled` rejects registration and omits `registration_endpoint` from metadata.
- The OAuth state lives in `WA_MCP_OAUTH_DB_PATH` (default `data/oauth.db`), which is created only when OAuth is enabled. The database file and the credential key (`oauth.db.mac`) are mode 0600. Back up both files together; restoring the database without the key signs every session out. A directory created for that file is mode 0700. An existing directory is not changed. It is not the WhatsApp session database.

The issuer and resource values are the public HTTPS URLs clients use, not the container's internal address. A reverse proxy that terminates TLS should still be the only public entry point; the in-process sign-in limiter uses the address it sees on the socket.
