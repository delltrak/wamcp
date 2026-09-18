# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

WA MCP — an MCP server (TypeScript, ESM, Node >= 24) that exposes WhatsApp as MCP tools, resources, and notifications. Two interchangeable backends: **Baileys** (WhatsApp Web protocol) and **Meta Cloud API**.

## Commands

```bash
npm run dev            # tsx src/index.ts (transport comes from WA_TRANSPORT in .env, not hardcoded)
npm run build          # tsc -> dist/
npm start              # node dist/index.js

npm test               # vitest run
npm run test:watch
npx vitest run tests/media.test.ts          # single file
npx vitest run -t "validateMediaUrl"        # single test by name

npm run lint           # eslint src/
npm run lint:fix
npm run format         # prettier --write src/
npm run format:check
npx tsc --noEmit       # type-check only

npm run db:generate    # drizzle-kit generate (writes to drizzle/)
npm run db:migrate

docker compose up      # wa-mcp + redis
```

**CI (`.github/workflows/ci.yml`) runs all five in order: `lint` → `format:check` → `tsc --noEmit` → `test` → `build`, on Node 24.x and 26.x.** Run `npm run format` before committing — formatting-only CI failures have happened before (commit `7fa86fa`).

Runtime requires **Redis** (BullMQ) even in dev. SQLite lives at `data/whatsapp.db` (gitignored, created on first import of `src/db/client.ts`).

## Architecture

Four layers, strictly one-directional:

```
index.ts            transport: HTTP (Streamable HTTP + SSE) or stdio; /health; /cloud-webhook
  ↓
server/mcp.ts       McpServer + register{Domain}Tools / Resources / EventNotifications
  ↓
services/           InstanceManager (orchestrator) · MessageQueue (BullMQ) · MaintenanceService
  ↓
channels/           ChannelAdapter interface → BaileysAdapter | CloudApiAdapter
```

`tools/` and `resources/` must never import from `channels/` — they reach adapters only through `instanceManager.getAdapter(id)`. That rule currently holds; keep it.

### InstanceManager is the hub

`src/services/instance-manager.ts` owns an in-memory `Map<instanceId, {adapter, channel}>` and mirrors lifecycle state into the SQLite `instances` table. Two wiring details that are easy to miss:

- `setMessageQueue(mq)` is bidirectional — it also calls `mq.setAdapterResolver(...)` so queue workers can resolve adapters. Without this, every queued send throws "Adapter resolver not set".
- `bindAdapterEvents()` subscribes to all 12 channel events, writes `status`/`lastConnected`/`lastDisconnected` on `connection.changed`, then fans out to handlers registered via `onAnyEvent()`. `notifications/events.ts` is the only consumer today.

On startup, `init()` reconnects every instance whose DB status is `connected` or `connecting`.

### Sends are queued; everything else is direct

Outbound messages go through `MessageQueue.enqueueMessage()` and the tool returns **`{ status: "queued", jobId }` — not a message ID**. One BullMQ `Queue` + `Worker` pair is created lazily per instance, named `outbound-<instanceId>`; the worker calls `adapter.sendMessage()`. Rate limiting is per-worker (`WA_BAILEYS_RATE_LIMIT` 20/min, `WA_CLOUD_RATE_LIMIT` 80/min).

Queue names must use hyphens — BullMQ rejects colons (fixed in 1.1.0).

Everything that is not a "send a message" call (edit, delete, react, presence, groups, profile, contacts, status) bypasses the queue and calls the adapter directly, so those are not rate-limited.

### Notifications

`notifications/events.ts` maps each `ChannelEvent` to a custom MCP method `whatsapp/<event>` and pushes it via both `server.server.notification()` and `sendLoggingMessage()`. **`createMcpServer()` must keep declaring `capabilities: { logging: {} }`** — dropping it makes notification delivery fail silently (that was the 1.1.1 fix). Reserved `notifications/message` is deliberately not used.

### Channel adapters

`src/channels/channel.interface.ts` is the contract. Any new capability must be added there and implemented in both adapters — Cloud API implements what Meta supports and otherwise throws `"... is not supported on Cloud API"` (groups, presence, chat modifications, block/unblock, status, calls, message delete/pin). `utils/tool-handler.ts` pattern-matches on that wording to produce an actionable agent-facing error, so keep the phrasing.

**Baileys specifics** (`baileys.adapter.ts`, ~1250 lines):
- `sock.ev.process()` handles the buffered event batch; `connection.update` and `creds.update` are bound with `ev.on` because they are not buffered.
- Auth state is SQLite-backed (`baileys.auth.ts`, `auth_keys` table) — a drop-in replacement for `useMultiFileAuthState`. Logout (`DisconnectReason.loggedOut`) clears it.
- LID (v7): contacts can arrive as `<id>@lid`. `resolvePn()` maps LID→phone via `sock.signalRepository.lidMapping`; `normalizeLidInMessage()` swaps `remoteJid`/`remoteJidAlt` when LID is primary. The contact cache is keyed by phone JID whenever one is known.
- Contacts accumulate in an **in-memory** `contactCache` (from `contacts.upsert`, `chats.upsert`, `messaging-history.set`, and incoming `pushName`) and are only flushed to SQLite inside `getContacts()`. So `wa_search_contact` is what materializes them — a fresh instance returns nothing until that runs.
- `getMessages()` reads the local `messages` table, not WhatsApp. Persistence happens in the `messages.upsert` branch of `bindEvents`.
- Reconnect is exponential backoff (1s → 30s, 10 attempts) inside the adapter; `MaintenanceService` independently retries `disconnected` instances every 5 min if they have a `lastConnected`.

**Cloud API**: webhooks are served by the **main** HTTP server at `POST /cloud-webhook`, verified with `x-hub-signature-256` against `WA_CLOUD_WEBHOOK_SECRET`, answered 200 immediately (Meta's 5s budget) and processed async. Routing to an instance is by `phone_number_id` via `findCloudAdapterByPhoneNumberId()`.

## Adding a tool

1. Zod schema in `src/schemas/<domain>.schema.ts`, `.strict()`, every field `.describe()`d — the descriptions are what the agent sees.
2. Register in `src/tools/<domain>.tools.ts`. The established shape:
   ```ts
   server.registerTool(
     "wa_x",
     { description: "description for the agent", inputSchema: XSchema },
     async (params) => {
       const log = createRequestLogger("wa_x", params.instanceId);
       const start = Date.now();
       try { /* ... */ return toolSuccess(result); }
       catch (err) { return handleToolError("wa_x", err, params.instanceId); }
     },
   );
   ```
   **Pass the whole schema, never `XSchema.shape`.** The SDK returns a schema instance untouched but rebuilds a raw shape with a plain `z.object(...)`, which silently drops `.strict()` — both from the agent-visible `additionalProperties: false` and from runtime validation. That bug shipped for all 62 tools until 2.0.0. `server.tool()` is also deprecated in the SDK.
   Always use `toolSuccess`/`handleToolError` — they sanitize file paths and stack traces out of agent-visible output.
3. Add the method to `channel.interface.ts`, implement in Baileys, implement or throw-with-the-standard-wording in Cloud API.
4. Update `README.md` and `docs/API_REFERENCE.md` tables.

## Adding a resource

Use `server.registerResource`, and for anything with a `{variable}` in the URI pass a real `ResourceTemplate` — never the URI as a plain string. A string is registered as a *literal* static URI, so the resource never appears in `resources/templates/list` and cannot be read with either the placeholder or a substituted value. That bug shipped for 8 of 10 resources until 2.0.0. `src/resources/resource-helpers.ts` has `perInstanceTemplate()` for the common `whatsapp://instances/{id}/...` shape; it also wires the `list` callback that makes concrete per-instance URIs discoverable.

Read variables from the `(uri, variables)` callback argument via `varAsString()`. Do **not** parse them out of `uri.pathname`: in `whatsapp://instances/<id>/...` the segment `instances` is the URI *host*, not part of the path, so index-based path scraping silently yields `""`.

Tests in `tests/resources.test.ts` guard both rules — one fails if any `src/` file reuses the deprecated `server.tool()`/`server.resource()`, the other if a placeholder URI is passed to `registerResource` as a static string.

Domain files are fixed: `instance`, `messaging`, `chat`, `group`, `contact`, `profile`, `status`, `newsletter`, `call`. Registration happens in `server/mcp.ts`.

## Schema changes need three (sometimes four) edits

Migrations are **not** run at startup. `src/db/client.ts` creates tables itself with raw `CREATE TABLE IF NOT EXISTS` SQL. A new table or column therefore needs:

1. `src/db/schema.ts` — Drizzle definition (what queries compile against).
2. `src/db/client.ts` — the matching raw SQL in `initializeDatabase()`.
3. `npm run db:generate` — a `drizzle/` migration file for anyone running `db:migrate`.
4. For a column added to a table that already exists in deployed databases, an inline `try { sqlite.exec("ALTER TABLE ... ADD COLUMN ...") } catch {}` **above** `initializeDatabase()` — see the `contacts.lid` precedent in `client.ts`. It must run before index creation.

All tables are keyed by `(instance_id, ...)` and cascade-delete from `instances`.

## Conventions

- Logging: Pino only, never `console.log`. Use `createChildLogger({ service })` in services/adapters and `createRequestLogger(toolName, instanceId)` in tools. Under stdio transport the logger writes to **stderr** — writing to stdout corrupts the MCP protocol stream. Secrets are redacted via the `redact` list in `utils/logger.ts`; add new secret-bearing field names there.
- Media inputs are `https://` URLs or base64. `utils/validation.ts` enforces HTTPS-only and blocks private/loopback/metadata IPs (SSRF) plus `file://`/`data:`; size caps live in `constants.ts`. Never relax these to accept `http://` or local paths.
- Strict TypeScript, no `any`. Prettier: 100 cols, double quotes, trailing commas.
- Tests (`tests/`) are dependency-free by design: they re-declare in-memory Drizzle schemas rather than importing `src/db/client.ts`, which would create a real file DB. Follow that pattern for new DB-touching tests.
- Conventional Commits.

## Known drift — verify before trusting the docs

- `src/services/dedup.ts` (`DedupService`) is tested but not wired into any runtime path; only `MaintenanceService` touches the `processed_messages` table.
- `drizzle-kit` pulls a deprecated `@esbuild-kit/*` chain carrying 4 moderate advisories. It is a devDependency, is excluded from the Docker runtime image, and only runs for `db:generate`/`db:migrate`. Fixing it requires drizzle-kit to drop `@esbuild-kit` upstream.
- Baileys keeps its own nested `pino@9` (it declares `pino: ^9.6`) while the app is on `pino@10`. Harmless: Baileys accepts a structural `ILogger`, so the app's pino 10 child logger type-checks against it directly. It does mean two pino copies on disk.

Fixed in 2.0.0 — previously listed here: the `VERSION` mismatch (now asserted by a test), the "63 tools" README count (62), the unread `WA_CLOUD_WEBHOOK_PORT`/port 3001, and the undocumented `WA_CLOUD_VERIFY_TOKEN`.
