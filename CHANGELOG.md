# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-09-18

Dependency modernization after ~6.5 months of drift. Closes 4 critical and 17 high
advisories; `npm audit` goes from **33 vulnerabilities to 4** (all moderate, all dev-only).

### Security

- **Baileys `7.0.0-rc.9` → `7.0.0-rc14`** — fixes [GHSA-qvv5-jq5g-4cgg] (critical, affects
  `>=7.0.0-rc.1 <7.0.0-rc12`): message-upsert / history-sync spoofing and app-state corruption
  from a maliciously crafted `protocolMessage` payload. rc.9 was vulnerable; rc12 patched it.
- **drizzle-orm `0.39.3` → `0.45.2`** — fixes [GHSA-gpj5-g38j-94v9] (high, CVSS 7.5):
  SQL injection via improperly escaped SQL identifiers.
- Baileys rc14 also moves `libsignal` off a git URL onto the registry package `libsignal@^6`,
  and pulls patched `protobufjs` (critical RCE) and `music-metadata`.
- Refreshed transitive dependencies within their existing semver ranges, clearing advisories in
  `ws`, `sharp`, `hono`, `@hono/node-server`, `express-rate-limit`, `path-to-regexp`, `qs`,
  `body-parser`, `fast-uri` and `ip-address`.
- The Docker runtime image no longer ships devDependencies — a dedicated `deps` stage installs
  with `npm ci --omit=dev`, so `drizzle-kit`/`vitest`/`eslint` and their advisories stay out of
  production.
- `vitest 4.0.18 → 5.0.1` — 4.0.18 sat inside GHSA-5xrq-8626-4rwp (critical, CVSS 9.8,
  `>=4.0.0 <4.1.0`). Dev-only, but it was the fourth critical in the tree.
- CI now gates on `npm audit --omit=dev --audit-level=high` after the test step.

### Breaking

- **Node.js floor raised from 22 to 24** (`engines`, Dockerfile, CI). Node 24 is the Active LTS.
- **Tool arguments are now actually validated as strict.** All 62 schemas were declared
  `.strict()`, but passing `Schema.shape` to the deprecated `server.tool()` discarded that —
  unknown keys were silently stripped and never reported. Tools now reject unknown arguments
  with a validation error, and `additionalProperties: false` is advertised in every tool's
  input schema again.

### Changed

- Migrated all 62 tools from the deprecated `server.tool(name, desc, Schema.shape, handler)` to
  `server.registerTool(name, { description, inputSchema: Schema }, handler)`. Passing the full
  schema instead of its `.shape` is what preserves strictness through the SDK.
- `MaintenanceService` repeatable jobs migrated to BullMQ v6 Job Schedulers
  (`queue.upsertJobScheduler()`); `repeat` was removed from `JobsOptions` in v6.
- Dropped the `as unknown as import("pino").Logger` cast in the Baileys adapter — rc14 accepts a
  structural `ILogger`, so the logger is now type-checked instead of cast past the compiler.
- TypeScript pinned to **6.0.3, not 7.x**: `typescript-eslint@8.70.0` still declares
  `typescript: ">=4.8.4 <6.1.0"`, so TS 7 would break `npm run lint`.
- `better-sqlite3 11 → 13`, `bullmq 5 → 6`, `ioredis 5 → 6`, `zod 3 → 4`, `pino 9 → 10`,
  `dotenv 16 → 18`, `@modelcontextprotocol/sdk 1.27.1 → 1.30.0`, `vitest 4 → 5`,
  `eslint 10.0.2 → 10.10.0`, `@types/node 22 → 24`, plus `drizzle-kit`, `tsx`, `prettier`.
- CI matrix now runs Node 24.x and 26.x (was 22.x only).
- `tsconfig.json` now sets `"types": ["node"]`. Node globals previously resolved only through a
  `/// <reference types="node" />` directive inside `@types/better-sqlite3`.
- zod 4.5 changed `.min()`/`.max()` on strings from counting UTF-16 code units to counting code
  points. This only loosens the limits (20 emoji now pass `.max(25)`, where they were 40 units
  before) and it matches what the field descriptions already promised ("max 25 characters"), so
  the schemas are left as they are — but the underlying WhatsApp limits are not code-point based,
  so an over-long display name or group subject can now be rejected downstream rather than by the
  schema.

### Fixed

- `VERSION` in `src/constants.ts` was hardcoded `"1.0.0"` while `package.json` read `1.1.1`. It
  feeds the MCP server identity and `/health`. Both are now `2.0.0`, and a test asserts they
  match so the drift cannot return.
- `better-sqlite3@11` could not build on Node 24+ (no prebuilt binary, and the source fails
  against modern V8) — `npm ci` simply failed. v13 ships N-API prebuilds including
  `linuxmusl-x64`/`linuxmusl-arm64`, so Alpine needs no build toolchain.
- README corrected from "63 tools" to **62**, the number actually registered.
- Documented `WA_CLOUD_VERIFY_TOKEN` in `.env.example` and the README (required for Meta's
  webhook GET handshake, previously undocumented).
- Removed `WA_CLOUD_WEBHOOK_PORT` and the exposed port 3001: nothing reads them, the Cloud API
  webhook is served by the main MCP server at `POST /cloud-webhook`.
- **stdio transport could be killed by a large media payload.** MCP SDK 1.30.0 introduced a 10 MB
  default read-buffer ceiling on `StdioServerTransport` (absent in 1.27.1); exceeding it makes the
  transport call `close()`, dropping the whole session instead of failing one request. Media inputs
  are allowed up to 100 MB, and base64 inflates by 4/3, so any document over ~7.5 MB would have
  killed the session under `WA_TRANSPORT=stdio`. The transport is now constructed with an explicit
  `maxBufferSize` derived from `MAX_BASE64_MEDIA_BYTES`.
- `MAX_BASE64_MEDIA_BYTES` in `constants.ts` was exported but never imported — `validation.ts` kept
  its own duplicate literal. It is now the single source of truth for both the base64 ceiling and
  the stdio read buffer.
- Declared `@vitest/coverage-v8`, which `vitest.config.ts` has always referenced but was never in
  `devDependencies`.

### Added

- `.github/dependabot.yml` — weekly npm updates (minor/patch grouped, majors separate), monthly
  GitHub Actions and Docker updates. The absence of this is what let the tree drift.

[GHSA-qvv5-jq5g-4cgg]: https://github.com/advisories/GHSA-qvv5-jq5g-4cgg
[GHSA-gpj5-g38j-94v9]: https://github.com/advisories/GHSA-gpj5-g38j-94v9

## [1.1.1] - 2026-03-02

### Fixed

- Declare `logging` capability on McpServer so `sendLoggingMessage()` and SSE notifications work correctly
- Use custom `whatsapp/*` method names for event notifications instead of the reserved `notifications/message` logging method, which requires the logging capability and was causing silent failures

## [1.1.0] - 2026-02-28

### Added

- Upgrade Baileys from v6 to v7 with full LID (Local Identifier) support
- LID-to-phone-number resolution via Signal repository mapping
- `wa_search_contact` tool with multi-word fuzzy matching across name, notify name, phone, and LID
- `wa_get_messages` tool to retrieve persisted chat messages from the database
- Message persistence: all messages (sent and received) are saved to SQLite automatically
- `lid` column on contacts table with inline migration for existing databases
- Contacts cached from history sync, chat metadata (`chats.upsert`), and incoming message `pushName`
- Structured logging for MCP notification delivery (success/failure tracking)
- Drizzle migration files for schema changes

### Changed

- `markOnlineOnConnect` set to `false` — instance stays offline until explicit interaction
- `syncFullHistory` enabled for better contact and chat sync on reconnection
- Pairing code flow improved with proper queueing, timeout, and caching
- Phonebook names prioritized over WhatsApp profile names in contact cache

### Fixed

- BullMQ queue names now use hyphens instead of colons (colons not allowed)
- LID normalization in incoming messages (swap `remoteJid`/`remoteJidAlt` when LID is primary)
- Group participants update type mismatch in Baileys v7 (`GroupParticipant[]` → `string[]`)
- Redis port mapped to host for external connections
- MCP notifications gracefully handle missing client sessions

## [1.0.0] - 2026-02-28

### Added

- Multi-channel WhatsApp architecture with Baileys and Cloud API adapters
- MCP server exposing WhatsApp as discoverable tools, resources, and notifications
- Instance management tools (create, list, connect, disconnect, delete)
- Messaging tools (send text, image, video, audio, document, sticker, location, contact, poll)
- Chat tools (list chats, read messages, mark as read, archive, pin, delete, mute)
- Group tools (create, list, manage participants, settings, invite links)
- Contact tools (list contacts, check WhatsApp registration, block/unblock)
- Profile tools (get/set display name, status, profile picture)
- Status/Stories tools (post text and media statuses)
- Call tools (reject incoming calls)
- Newsletter/Channel tools (list, create, manage newsletters)
- Resource endpoints for instances, contacts, chats, groups, messages, profile, privacy, blocklist
- Real-time notification system for incoming messages, status updates, calls, and presence events
- SQLite persistence with Drizzle ORM for contacts, chats, groups, and messages
- BullMQ message queue integration with Redis for reliable message delivery
- Message deduplication service
- Media download and handling service
- Zod-based schema validation for all tool inputs
