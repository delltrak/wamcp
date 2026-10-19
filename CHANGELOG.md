# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added Baileys instance lifecycle webhooks for connection, disconnect, pairing-code, and QR events,
  plus the read-only `wa_get_instance_status` tool. Pairing and QR challenge data is omitted from
  webhook payloads and status output.
- Added per-chat presence subscriptions, send-time participant mentions and group `@all`, native
  Cloud API buttons/lists with Baileys text fallbacks, custom link-preview metadata and generated
  thumbnails, and status-story viewer lookup from observed read receipts.
- Added local per-participant receipt and reaction history, multi-image albums, and private replies
  to stored group-message authors. These replacements use normal messages or local read storage.
- Added `WA_AUTO_REJECT_CALLS=false` for optional automatic rejection of one-to-one call offers.
  Call offers and subsequent reject, timeout, accept, and terminate events now retain their status
  and call details in MCP notifications and configured outgoing webhooks.

- Added Baileys poll vote decryption and persisted poll results, live location sends, audio view-once
  messages, and multi-contact vCards. Poll results use the stored poll message secret and decrypted
  vote updates, so they remain available after reconnecting.
- Added Baileys group invite metadata lookup, pending join-request listing, group invitation cards,
  and contact/group profile-picture URL lookup. Group invite joining now accepts validated WhatsApp
  invite links.
- Startup warns when no outgoing event webhook destination is configured, when webhook authentication
  is only half set, or when the webhook event set is empty. `GET /health` and `wa_get_instance_status`
  report that redacted state. `WA_REQUIRE_EVENT_WEBHOOK=true` refuses to start when no destination is
  configured or the event set is empty.

### Fixed

- Baileys keeps reconnecting after a non-logout close such as `unavailableService` (503). The
  current socket is cleared, retries continue every 30s after the exponential cap, and only one
  reconnect timer is pending. The stored status stays `disconnected` until a live socket exists, and
  the health check recovers a `connecting` row older than 2 minutes with no live socket. When the
  backoff cap is reached, one additional `instance.disconnected` event is sent with
  `willReconnect: true` and `reconnectInMs: 30000`.
- App-state writes now run through a per-instance queue with configurable spacing and a resync
  preflight that requires a retrievable current key, a positive collection version, a 128-byte hash,
  and no Baileys-reported sync, decode, missing-key, or hash-verification failure. Successful writes
  are resynced once and checked for version advancement; failed patches are not retried.
- Chat unread/archive/delete/clear ranges now use at most three recent stored raw message keys,
  numeric Unix-second timestamps, and the raw key's PN/LID `remoteJid` for the patch index. Star and
  unstar refuse messages without a valid stored raw key.
- Added `WA_GROUP_WRITES_ENABLED=false` for group, community, and Channel server operations that
  use IQ/MEX/message queries. `WA_APP_STATE_WRITES_ENABLED=true` continues to enable those writes
  along with app-state and other gated account/server operations.
- Baileys presence now defaults to appearing online only around outgoing messages and typing or
  recording activity, then returning to unavailable after the configured idle timeout.
- Incoming offline messages delivered through Baileys `append` upserts now emit one `message.received`
  event and webhook, with timestamp filtering, persistent deduplication, and a per-batch cap. Baileys
  also logs every connection close and reconnect attempt. Its health watchdog uses `fetchStatus`
  USync probes instead of counting raw websocket frames; two consecutive failed probes end the
  socket so the existing reconnect flow can recover silent drops. A Baileys event buffer that stalls
  past `WA_BAILEYS_EVENT_BUFFER_STALL_MS` is flushed once, and the socket ends if buffering persists
  at the next check.
- Baileys `on_receive` auto-read now marks only offline append messages that pass emission eligibility
  and deduplication.
- Poll votes on polls sent by this account now decrypt across LID/PN identity variants, including
  wrapped updates. Unresolved votes retry after poll storage and when results are read.
- Event messages sent by this account now retain their binary protobuf message secret in local
  history, allowing encrypted RSVP responses to decrypt after the send and later message upserts.
- Outgoing event webhook delivery failures now log the attempt, HTTP status, safe error details,
  and an endpoint with query strings removed.
- Media albums now store the album parent as `album` and each child under its extracted media type.
- On-demand history sync now decrypts and persists poll votes, retrying votes that arrive before
  their poll.
- View-once audio now uses detected MP3, M4A, or OGG MIME types and only marks verified OGG/Opus
  as PTT.
- Cloud API now returns unsupported-operation errors for edits and view-once messages instead of
  sending ordinary messages or media that appeared to meet those requests. Live locations, poll
  result reads, and Baileys-only group helpers also return explicit Cloud API unsupported errors.
- Group setting updates now apply both announcement and locked modes using their corresponding
  Baileys enum values.
- Channel follow/unfollow and the `defaultDisappearingMode` privacy update are now blocked unless
  `WA_APP_STATE_WRITES_ENABLED=true`; other privacy setting updates remain available with writes
  disabled.
- Test databases and media directories now use temporary per-run paths.

### Changed

- Gate private disappearing-message timers and all Baileys group creation, settings, membership,
  picture, invite, join, and join-request changes behind `WA_APP_STATE_WRITES_ENABLED`.
- Added `WA_MARK_ONLINE_ON_CONNECT` to control whether Baileys marks the linked account online
  when its socket connects. It defaults to `false`, preserving the current behavior.
- Baileys status stories now report the recipient count and warn when the configured audience cap
  truncates a recipient list.
- Baileys status tools now return the status message ID needed to list observed viewers.

### Added

- Added private disappearing-message timers, blocked-contact and About reads, group join approval
  and member-add modes, PTV video notes, community management, Channel management, and Business
  catalog/product/order tools. Quick reply writes and community, Channel, catalog-product, and group
  mode changes are gated by `WA_APP_STATE_WRITES_ENABLED`; list is unavailable because Baileys rc14
  exposes no read method and quick reply sync actions are not stored locally. Read-only calls and
  normal message sends remain available when writes are disabled.
- Added local `wa_search_messages` with case-insensitive substring matching, escaped SQL `LIKE`
  wildcards, date/sender/chat filters, and stable offset pagination.
- Added Baileys WhatsApp Business label tools for listing, creation, edits, soft deletion, and
  chat/message associations. Label edits and associations persist locally; chat listings, message
  reads, MCP notifications, and optional outgoing webhooks include label details.
- Added `wa_list_chats`, `wa_mark_chat_unread`, and `wa_star_message`. Mark-unread uses the stored
  reverse-chronological message range required by Baileys, and starred state is retained locally.
- Added `wa_send_event` and `wa_get_event_responses` with encrypted RSVP decryption, delayed
  retries when an event message arrives, per-status counts, responder phone lookup, and additive
  `event.response` notifications and webhooks.
- Added `wa_fetch_message_history` for Baileys on-demand history sync, anchored at the oldest local
  message, deduplicated through existing message persistence, and bounded by a response timeout.
- Added additive SQLite tables for Business labels, their associations, and event responses, plus a
  `starred` message column. Startup creates new tables and adds the column to existing databases.
- Optional per-chat batching for incoming event webhook messages with a sliding debounce window,
  maximum batch age, message-count cap, transcription-aware ordering, and shutdown flushing.
- Added Baileys group listing and detailed participant roles, plus admin-only group picture updates
  and removal. Picture inputs accept HTTPS URLs or base64 images and are converted to square JPEGs.
- Added `wa_send_sticker`, `wa_send_gif`, and `wa_download_media`. Sticker conversion uses ffmpeg
  when needed, GIFs are normalized to silent H.264 MP4 for Baileys playback, and received media can
  be saved to a dedicated directory or returned as size-limited base64. Received media events now
  include available MIME type, filename, caption, and size metadata.
- Added `WA_MEDIA_DOWNLOAD_DIR`, `WA_MEDIA_DOWNLOAD_MAX_BYTES`, `WA_MEDIA_FFMPEG_PATH`, and
  `WA_MEDIA_FFMPEG_TIMEOUT_MS` settings for media downloads and conversions.
- Added `wa_resync_contacts` to refresh contacts on an existing Baileys session without pairing
  again. It resyncs app-state collections individually, recovers contacts from local chats and
  messages, and keeps recovered contacts in SQLite across restarts.
- Optional `WA_STATUS_MAX_RECIPIENTS` cap for Baileys status audiences; it defaults to 256.
- Added Baileys privacy read/update tools for last seen, online, profile photo, About/profile text
  visibility, read receipts, group adds, calls, and default disappearing duration.
- Optional ElevenLabs text-to-speech voice notes through a provider interface, with voice listing,
  base64 previews, text chunk continuity, retry handling, and OGG/Opus output for Baileys.
- Configurable TTS enablement, provider, voice, model, language, output format, text limit, API host,
  timeout, and ffmpeg executable path.
- Optional `WA_AUTO_READ=false|on_fetch|on_receive` behavior for incoming messages, with receipts
  scheduled in the background so message handling and tool/resource responses continue promptly.
- Optional `participant` input for `wa_mark_read`; Baileys group receipt keys now include the
  participant and stored `fromMe` value while direct chat keys keep their existing shape.
- Optional incoming audio transcription for Baileys and Cloud API messages through an
  OpenAI-compatible transcription endpoint, with a `wa_transcribe_audio` MCP tool and
  asynchronous transcription text on successful audio message notifications.
- Configurable transcription enablement, API URL/model/language, size ceiling, and timeout.

### Fixed

- Baileys event response decryption now tries normalized LID and PN creator/responder candidates,
  retries stored encrypted responses when `wa_get_event_responses` is called, and reports the number
  of attempted JID combinations when decryption still fails.
- Baileys event responses now map numeric, named, Long-like, and encoded WAProto RSVP values to
  `GOING`, `NOT_GOING`, or `MAYBE`; stored encrypted responses with an earlier `UNKNOWN` status are
  re-decoded on read when possible.
- Baileys event responses that fail decryption with every available creator and responder JID
  combination are now reported as unrecoverable; this commonly means the stored event `messageSecret`
  does not match after re-pairing, so the participant must answer again.
- Previously stored Baileys `messages.update` RSVP payloads are now re-decoded on read as well.
  `wa_get_event_responses` explains remaining `UNKNOWN` statuses with a reason and recoverability;
  responses whose payload was never stored cannot be recovered, and the responder can answer again.
- Event RSVP responses now decrypt with the original event's `messageSecret`, including LID/PN
  author resolution; encrypted responses are retained until the event is available, and the last
  response per participant is stored with its timestamp and extra guest count.
- Baileys message forwarding now uses the stored original message content, including outgoing media
  protos and Buffer fields. Messages without available content return an error instead of sending an
  empty forwarded bubble.
- Baileys status deletions now include the original audience (or a validated explicit audience),
  and successful message deletions are marked as revoked in local message history.
- Baileys status stories now pass a normalized, deduplicated recipient list (the account's own JID
  plus stored contacts by default) to `sendMessage`, so status updates are distributed. Status tools
  also accept an explicit individual-recipient list and validate text-story RGB/ARGB colors.
- Baileys business templates, interactive messages, button/list messages, and their selection
  responses now retain readable content, button metadata, and header media details across storage,
  `wa_get_messages`, MCP notifications, and event webhooks. Unknown Baileys content types retain
  their raw type name. Structured message metadata is recovered from the existing `raw_data`
  column, so no database migration is needed.
- Baileys PTT voice notes now include a 64-byte waveform and duration when ffmpeg can decode the
  audio; non-Opus input is converted to OGG/Opus, with sends falling back gracefully on failure.
- Baileys quoted text, image, and video sends now resolve the referenced message from the same
  chat and instance and pass a complete WAMessage to the socket. Missing quotes return a clear
  tool error before enqueueing; quotes removed before delivery fail without BullMQ retries.
- Outgoing event webhooks retry only network errors, timeouts, HTTP 429, and 5xx responses;
  other 4xx responses fail permanently. Retries use capped exponential backoff with jitter and
  honor a capped `Retry-After` minimum when provided.

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
- **Eight of the ten resources were unreachable.** They were registered by passing a plain string
  containing `{id}` to the deprecated `server.resource()`, which the SDK treats as a _literal_
  static URI rather than a template. `resources/templates/list` returned nothing, and reading
  either the placeholder URI or a substituted one returned "Resource not found". The URI parsing
  behind them was dead too: `instances` is the **host** of a `whatsapp://` URI, not a path
  segment, so `pathname.split("/").indexOf("instances")` was always `-1` and the extracted
  instance id was always `""`. All ten now use `registerResource`, the nine per-instance ones with
  a real `ResourceTemplate`, and variables arrive parsed instead of scraped from the path.
- Per-instance resources now supply a `list` callback, so `resources/list` shows a **concrete URI
  per existing instance** rather than only a `{id}` placeholder an agent cannot act on.
- **The Cloud API channel could not be configured at all.** `wa_set_cloud_credentials` required an
  adapter that only `wa_connect_instance` created, while `wa_connect_instance` refused to run
  without credentials — a closed loop. The tool's own description says credentials are "required
  before connecting", which was impossible. `InstanceManager.ensureAdapter()` now materializes the
  adapter for configuration without connecting, and `connectInstance()` was refactored onto it.
- The Cloud API error told agents to "Call setCredentials() first" — an internal method name that
  is not a tool. It now names `wa_set_cloud_credentials`.
- Queue stats are reachable again as a side effect of the resource fix: `whatsapp://instances/{id}`
  carries outbound waiting/active/completed/failed counts, which is the only way for an agent to
  learn whether a `{ status: "queued" }` send actually went through. Its description now says so.

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
