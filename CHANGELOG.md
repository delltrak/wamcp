# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added read-only `wa_get_channel_capabilities`, `wa_list_authentication_templates` and
  `wa_get_job_status`. Agents can inspect implemented channel features/requirements, discover
  Cloud AUTHENTICATION template approval/locales/copy-code compatibility, and correlate retained
  queued jobs with safe WhatsApp message IDs and observed receipt counts. Template discovery
  requires a WABA ID and `whatsapp_business_management` permission; Baileys is unsupported for
  templates. Inspection never starts a worker or retries a send; queue completion does not prove
  recipient delivery, and old or cleaned-up jobs may lack results. Cloud receipts are stored as
  metadata without OTP content. See [discovery and tracking](docs/channel-discovery.md)
  ([#171](https://github.com/delltrak/wamcp/pull/171)).

- Added `wa_send_otp` for native Cloud API AUTHENTICATION templates with an OTP copy-code button.
  Backend-generated codes are encrypted in Redis, have a bounded queue deadline and a request ID,
  and are consumed before sending so uncertain outcomes and stalled workers are not resent.
  Requires `WA_OTP_ENCRYPTION_KEY`, an individual recipient and an approved template. Baileys is
  unsupported. Code validity/one-time use remain the caller's responsibility; template expiry
  text does not implement expiry or auto-delete. Verified with synthetic Cloud API responses and
  queue failure tests, plus real Redis ownership/idempotency regressions
  ([#170](https://github.com/delltrak/wamcp/pull/170)); live Meta template delivery remains unverified.

### Fixed

- Cloud delivery failures are no longer normalized as successful `sent` events. Delivered/read
  receipts persist for job tracking in the same millisecond units as existing Baileys receipts,
  and do not regress when webhooks arrive out of order.

- Updated transitive `body-parser` to 2.4.0 and `qs` to 6.17.0 to address the production
  dependency audit findings GHSA-27r3-jxmh-p828 and GHSA-6pq8-jhm2-2vcw.

- MP4 sticker conversion and video compression read the source from a private temporary file, so an
  MP4 with the `moov` atom after `mdat` decodes. Image and video compression sends the original and
  logs a warning when ffmpeg fails. PNG files with transparency are not re-encoded to JPEG. Image
  edge, JPEG quality, and video edge and CRF are validated only when a message is compressed.
  Cloud API uploads the original base64 bytes with their detected MIME type when compression
  fails or offers no size reduction; original HTTPS links remain links
  ([#133](https://github.com/delltrak/wamcp/pull/133)).

### Added

- `wa_send_sticker` accepts PNG, JPG, GIF, WebP, and short MP4 input and converts it to 512x512 WebP.
  GIF and MP4 sources stay animated, MP4 stickers are capped at 10 seconds, and WhatsApp's 100 KB
  static and 500 KB animated limits still apply. `wa_send_image` and `wa_send_video` can compress
  before sending when `compress` is true or `WA_MEDIA_COMPRESS=true` (default `false`). `hd: true`
  sends the original media. Image edge and JPEG quality, and video edge and CRF, are configurable
  ([#144](https://github.com/delltrak/wamcp/issues/144), [#133](https://github.com/delltrak/wamcp/pull/133)).
  Conversion is checked with local ffmpeg; delivery and rendering on real WhatsApp accounts
  remain unverified.

### Changed

- Added the optional Chatwoot API inbox bridge and local n8n community nodes
  ([#152](https://github.com/delltrak/wamcp/issues/152), [#135](https://github.com/delltrak/wamcp/pull/135)).
  The n8n trigger requires a fresh HMAC signature and emits only verified raw JSON; credential
  tests authenticate through MCP and close the session without calling tools. Chatwoot contact
  conflicts retry exact normalized phones, and conversation reuse requires matching instance/chat
  metadata. HTTP clients use the installed Undici dispatcher. Synthetic/local HTTP validation
  only; real Chatwoot, n8n, and WhatsApp delivery remain unverified, and n8n is not published to npm.

- Updated Undici from 7.30.0 to 8.12.3 and paired outgoing webhook requests with its
  HTTP client, preserving compatibility with the new dispatcher contract on Node 24
  ([#96](https://github.com/delltrak/wamcp/pull/96)).
- The Docker runtime stage now runs `ffmpeg -version` on every architecture the image build
  targets, next to the existing `better-sqlite3` prebuild check. Published tags stay a single
  `linux/amd64` + `linux/arm64` manifest list.

### Added

- Added optional PostgreSQL storage selected by `WA_DATABASE_URL`, while SQLite remains the
  default ([#129](https://github.com/delltrak/wamcp/issues/129),
  [#138](https://github.com/delltrak/wamcp/pull/138)). Both drivers use asynchronous queries;
  the manual snapshot copy preserves Baileys auth keys, skips migration journals and unknown
  tables/columns, and requires an empty target unless `--force` is selected. No data is copied
  automatically. PostgreSQL uses the shared runtime schema rather than SQLite Drizzle files;
  text NUL bytes are stripped and collation can differ. Webhooks, cooldowns, group-history claims,
  and schedules use the selected driver; OAuth keeps its separate local SQLite database.
  Live-account migration remains unverified.
- Added opt-in HTTP authentication and routing for remote MCP clients. `WA_MCP_OAUTH_ENABLED=true`
  enables an OAuth 2.1 authorization-code server with PKCE, discovery metadata, and dynamic client
  registration. `WA_BASIC_AUTH` accepts multiple users, `WA_BASE_PATH` prefixes the HTTP routes, and
  the existing `WA_MCP_API_KEY` behavior is unchanged when the new settings are left unset
  ([#150](https://github.com/delltrak/wamcp/issues/150), [#137](https://github.com/delltrak/wamcp/pull/137)).
  Dashboard and Chatwoot routes follow the same base path; dashboard login limits honor trusted
  proxies and IPv6 `/64` buckets while retaining separate credentials and pairing CSRF checks.
  Validation uses local HTTP clients; real remote-client authorization remains unverified.
- Added five tools for one-shot and daily, weekly, or monthly scheduled sends
  ([#139](https://github.com/delltrak/wamcp/issues/139), [#136](https://github.com/delltrak/wamcp/pull/136)).
  Schedules persist in the selected application database; `WA_SCHEDULER_ENABLED=false` by default.
  Each schedule uses an IANA timezone (default `America/Bahia`), a one-year initial horizon,
  and optional end/occurrence limits. Invalid RFC3339 calendar dates are rejected.
  Pause and cancel remain available with the gate off. Missed occurrences follow `skip` or `send`.
  Sends use the existing outbound limiter; only completed queue jobs count as successful
  occurrences. Persisted job identities reconcile success/failure across restarts, and shutdown
  waits for an active tick. Ambiguous or missing queue outcomes are never submitted again.
  Failed recurring occurrences advance without consuming the success limit. This does not
  guarantee exactly-once delivery across provider timeouts; real-account validation is pending.
- Added an operations dashboard at `/dashboard`, disabled by default and protected by
  separate Basic credentials, login throttling, CSP, and same-origin JSON mutation checks
  ([#149](https://github.com/delltrak/wamcp/issues/149),
  [#154](https://github.com/delltrak/wamcp/pull/154)). It shows redacted connection and webhook
  status and can start pairing only for an existing unpaired Baileys instance. Stored
  credentials that are empty, malformed, or omit a boolean `registered` fail closed.
  It has no instance creation, logout, deletion, message sending, or credential reset action.
  TLS termination is required for remote access; activity and login limits are process-local,
  and real-account pairing remains unverified.
- Added gated `wa_send_group_history_to_member` and opt-in automatic history digests for
  direct-add stubs authored by this account ([#106](https://github.com/delltrak/wamcp/issues/106),
  [#116](https://github.com/delltrak/wamcp/pull/116)). This Baileys-only workaround sends at most
  five text chunks from 25–100 requested local messages. Current PN/LID membership, disappearing
  timers, and unchanged shareable source messages are rechecked at delivery. Received edits, revocations,
  and deletions are persisted with privacy restrictions preserved; view-once, individually disappearing, and unverifiable raw messages
  are excluded. Automatic claims survive restart but can leave partial sends after an ambiguous
  enqueue/crash; queue acceptance is not delivery, and pending workers resume lazily after restart.
  Live-account behavior remains unverified, and approved joins encoded as own direct-add stubs
  cannot be distinguished upstream.
- Added an optional fixed auto-reply, off unless `WA_AUTO_REPLY_ENABLED=true`
  ([#147](https://github.com/delltrak/wamcp/issues/147), [#158](https://github.com/delltrak/wamcp/pull/158)).
  Recent incoming content is queued with per-contact/group cooldowns, per-instance limits,
  PN/LID ignore aliases, and self/echo guards. The listener starts before reconnecting instances.
  Pending enqueues block concurrent replies; cooldowns persist only after enqueue succeeds,
  and failures release the reservation and rate slot for retry. Groups are opt-in.
  Cooldowns track queue acceptance, not delivery; a crash between enqueue and persistence can
  permit another reply. Multi-process coordination and real-account behavior remain unverified.
- Added optional daily Baileys presence pulses, disabled by default, with bounded duration,
  spacing, and a configurable time zone ([#145](https://github.com/delltrak/wamcp/issues/145),
  [#156](https://github.com/delltrak/wamcp/pull/156)). Failed unavailable updates retry every
  5 seconds while the same socket remains connected, including after activity takes over.
  Disconnect cancels pending pulse timers; pulses do not override explicit availability in
  `always` mode. Restarts replan the day, and DST days that cannot fit the configured window
  are skipped. Real-account validation remains pending; presence timing offers no guarantee
  against account restrictions.
- Added optional `WA_PROXY_URL` ([#146](https://github.com/delltrak/wamcp/issues/146),
  [#161](https://github.com/delltrak/wamcp/pull/161)) for a SOCKS5 or HTTP(S) proxy on the
  Baileys WebSocket and media transfers. The connection stays direct when the variable is unset or empty. Proxy
  credentials are redacted from logs, tool errors, and `GET /health`. Local fixture checks cover
  routing and cleanup; live WhatsApp and external-proxy validation remain pending.
- Added opt-in `wa_set_instance_webhook`, `wa_get_instance_webhook`, and
  `wa_delete_instance_webhook` tools for per-instance event destinations, with global
  replacement or merge and duplicate URL suppression
  ([#142](https://github.com/delltrak/wamcp/issues/142), [#160](https://github.com/delltrak/wamcp/pull/160)).
  Instance-only routing retains the shared HMAC secret and JID filters; reads and delivery
  reject invalid stored URL/auth settings, and worker/batch identities isolate colliding IDs.
  Deleted destinations invalidate queued delivery configuration. Authentication values remain
  plaintext in SQLite and are omitted from tool results, logs and health. One configured
  instance satisfies the process-wide required-webhook check; live webhook delivery remains
  unverified, and unmatched URLs with differing global HMAC secrets remain unsigned.
- Added opt-in Baileys webhooks and MCP notifications for group roster joins, label associations,
  and newsletter membership, posts, and mute changes
  ([#141](https://github.com/delltrak/wamcp/issues/141), [#157](https://github.com/delltrak/wamcp/pull/157)).
  Grok Bot keeps these events separate from message batches. Newsletter post deduplication includes
  the channel and suppresses stored append replays. Phone follow/mute notifications remain
  best-effort; local newsletter history still has its existing instance/message-ID collision
  limitation, and real-account validation remains pending.
- Added read-only group-participant CSV export and Channel post media download
  ([#148](https://github.com/delltrak/wamcp/issues/148), [#134](https://github.com/delltrak/wamcp/pull/134)).
  CSV exports retain PN/LID identities, escape spreadsheet formulas, use private permissions, and
  remove exports older than 24 hours on the next export. Saved-name lookup is capped at 5,000
  identities and reports truncation. Export directories must not be symbolic links.
  Channel downloads use rc14 `message_updates` with `since`/`after`, preserving numeric ID
  precision; fallback lookup is capped at 100 posts. Raw and encrypted downloads are restricted to
  the WhatsApp media CDN with redirects refused, a 60-second media timeout, and the configured
  file size cap. Raw bytes require a matching SHA-256. Cloud API rejects both tools; real-account
  validation remains pending.

- Added optional webhook JID ignore rules with exact addresses, user-part wildcards and
  chat-only domain patterns ([#140](https://github.com/delltrak/wamcp/issues/140),
  [#159](https://github.com/delltrak/wamcp/pull/159)). Group sender phone aliases from Baileys
  are retained for filtering even before contact mappings are stored. Message storage and
  lifecycle events are unaffected; real-account validation remains pending.
- Added `wa_mark_played` for stored incoming audio, voice notes, and video on Baileys
  ([#143](https://github.com/delltrak/wamcp/issues/143), [#155](https://github.com/delltrak/wamcp/pull/155)).
  Receipts are limited to user, hosted, and group chats. `WA_AUTO_MARK_PLAYED` defaults to
  `false` and optionally sends the receipt after transcription without delaying its result.
  Cloud API does not support played receipts; real-account receipt behavior remains unverified.
- Added community hierarchy discovery and 16 administration tools for linked-group creation,
  name/description/picture editing, scoped member lists, member/admin changes, join requests,
  invitations (including V4), community settings, and queued text/media announcements to Avisos
  ([#166](https://github.com/delltrak/wamcp/issues/166), [#167](https://github.com/delltrak/wamcp/pull/167)).
  Administrative writes retain the existing write gates and permission checks; member removal
  requires confirmation because it also affects linked groups. Cloud API explicitly rejects
  unsupported community operations.
- Added community metadata and join-request events to MCP notifications and outgoing webhooks,
  with safe metadata filtering and snapshot deduplication. Avisos sends resolve the destination
  from explicit hierarchy metadata and revalidate permissions and destination in the queue worker.
  Real-account validation remains pending; community deactivation and visibility/non-admin
  subgroup-creation controls are not implemented because upstream support is unverified.
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

- OAuth replay detection retains consumed code and refresh-token hashes while their family has
  a live refresh grant, including after the original refresh token expires
  ([#137](https://github.com/delltrak/wamcp/pull/137)).

- Basic Auth password checks no longer block the event loop, and failed sign-in attempts on
  `POST /oauth/authorize` and on Basic authentication for `/mcp` back off per address and per user.
  OAuth tokens are bound to the current Basic Auth credential, so removing or rotating a user
  revokes that user's tokens. `POST /oauth/revoke` revokes a token or a user. Dynamic client
  registration is limited per IP, can be disabled, and can restrict redirect hosts. Reusing an
  authorization code revokes the tokens issued from it. The OAuth database file is mode 0600.
  Native redirect schemes use a reverse-DNS name such as `com.example.app:/cb`. Invalid
  `WA_BASIC_AUTH` does not prevent the stdio transport from starting.
- Sign-in attempts are counted before the password check, so concurrent guesses cannot skip the
  backoff. `WA_TRUST_PROXY` optionally trusts `X-Forwarded-For` from a CIDR list and is unset by
  default. A forwarded hop that is not an IP is ignored. IPv6 limits use a /64 prefix, and
  `::ffff:127.0.0.1` is treated as `127.0.0.1`. Access tokens last 15 minutes, and refresh revokes
  the previous access token. Opening the OAuth database no longer changes the mode of an existing
  directory. Credential versions are an HMAC with a per-install key. Revoking a user invalidates
  unused authorization codes. `/oauth/revoke` sends the same CORS headers as the token endpoint.
  Tokens stored with an empty credential version, including tokens issued before this binding, are
  rejected once, so existing OAuth sessions must sign in again.
- Sign-in backoff keeps its failure count when a lock expires and doubles on the next failure, up
  to 15 minutes. Quiet time starts at the later of the last attempt and the end of the lock, so a
  15 minute lock stays at that ceiling. The attempt that crosses a limit is still checked; if it
  fails, later attempts get 429 with `Retry-After`. A distributed attacker can keep the global
  username lock with about one failure per window. While that continues, only that username at an
  address that signed in during the last hour gets in, and only for a few failures; a wrong
  password removes the exemption. A successful password removes that request's count and the lock
  that request created. If the attempt token was already dropped, the count stays and the exemption
  is still recorded. The strict lock is the client address and the address-plus-username pair. One
  other address cannot lock the name. 128 failures spread across addresses can, for example 16
  IPv6 /64s or NATs using the free attempts. A recent success exempts only that username at that
  address (the whole IPv6 /64 or NAT) for a few failures, and a wrong password removes the
  exemption. The presented username is limited whether or not an account exists. Usernames are kept
  in a fixed table of 65536 buckets chosen by an HMAC with a per-process key, with no eviction. A
  hash collision shares a bucket and only makes the limit stricter. A quiet period halves that
  count instead of clearing it, so the same free attempts once per window eventually lock the name.
  Locking every bucket takes on the order of 11 million spread-out failures. Keeping them locked
  takes about one failure per bucket per 15 minutes: roughly 70 requests per second with a name for
  each bucket, or several hundred per second without that map. While that continues, authorization
  and Basic authentication stay 429 except for a username that signed in from that address in the
  last hour, and an access token that was already issued still works. The `Retry-After` of a
  username lock is the 15 minute ceiling for every bucket. The address maps drop the unlocked entry
  with the fewest failures, the oldest on a tie, and do not drop a live lock. When every address
  slot is an active lock, a new address is counted in one shared overflow bucket, and a recent
  success does not create an address bucket. That overflow does not apply to usernames, so a
  saturated username table does not leave sign-in at 429 after the address locks expire. An attempt that does not finish is
  tied to a bounded token, so it cannot undo a later failure. scrypt work uses a short queue, keeps
  one slot for a recent sign-in, and a rejected attempt still counts. The credential key is linked
  into place so it is never read empty. Back up `oauth.db.mac` with `oauth.db`; losing the key
  signs every session out.
- ([#146](https://github.com/delltrak/wamcp/issues/146), [#161](https://github.com/delltrak/wamcp/pull/161))
  Explicit default proxy ports `:80`/`:443` are accepted, and Baileys native-fetch downloads use
  Undici 8’s compatibility wrapper. Percent-encoded proxy credentials are decoded before the
  SOCKS5 handshake. A discarded dispatcher is destroyed directly, so a stuck request is aborted, and reconnect does not wait for
  that cleanup. `disconnect()` logs a warning if that destroy fails. `WA_PROXY_URL` is validated at
  startup. Usernames and passwords of 4 to 7 characters are redacted as whole words; values of 8 or
  more characters are removed wherever they appear. Shorter ones are removed only from the proxy URL
  and from a user:password pair. History-sync and app-state blob downloads use the proxy dispatcher.
  Baileys rc14 drops download timeout signals; those timeouts remain unsupported.
- Community discovery, description updates and invitation inspection/acceptance now use the
  Baileys group helpers for standard group responses while verifying explicit community markers.
  Missing creation/join acknowledgements remain unknown instead of reporting confirmed success
  or triggering automatic retries. Provider resource-not-found errors are no longer mislabeled
  as missing MCP instances.
- Baileys message operations now resolve full stored keys, including group authorship and ownership.
- Fast Baileys reconnects now persist `status`, `last_connected`, and `last_disconnected`.
  Each socket open stores `connected` and `last_connected`. A close that ends that open stores
  `disconnected` and `last_disconnected`, including automatic reconnects after `408` and `428`.
  Repeated closes that never reach open still keep the original outage start, and a close from a
  replaced socket does not move either timestamp. `wa_get_instance_status` and `GET /health` read
  those stored values. Lifecycle webhook emission is unchanged.
- Baileys keeps reconnecting after a non-logout close such as `unavailableService` (503). The
  current socket is cleared, retries continue every 30s after the exponential cap for a paired
  session, and only one reconnect timer and one connect attempt are pending. A session that never
  paired keeps the bounded 10-attempt retry. The stored status stays `disconnected` until a live socket exists, and
  the health check recovers a `connecting` row older than 2 minutes with no live socket when the
  instance connected before. When the
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

- Chatwoot maps an attachment that exceeds the remaining reply budget to `attachment_budget`
  when the pinned download rejects it for size. Shutdown drains those replies before closing
  the outbound queue and answers `503` to new webhooks. A full delivery-id cache returns `503`
  instead of dropping a live id. `private: "true"` is treated as a private note.
- Chatwoot replies accept `@lid` chats again, ignore `@newsletter` destinations with HTTP 200,
  and return `422` when the instance does not exist before accepting the webhook. A background
  download or queue failure posts a private note. Attachments past the 16 MB budget are reported
  instead of dropped quietly. Shutdown waits up to 5 seconds for those replies.
- The n8n WA MCP Trigger now requires Webhook Secret. An unsigned delivery is answered HTTP 401
  and does not start a workflow. Existing flows that left the secret empty stop receiving events
  until the node secret matches `WA_EVENT_WEBHOOK_SECRET`.
- `WA_CHATWOOT_ALLOW_LEGACY_SECRET` defaults to `false`. `?secret=` and the older Chatwoot secret
  headers are ignored unless it is `true`. `WA_CHATWOOT_BLOCK_GROUP_REPLIES` defaults to `false`
  and drops agent replies whose destination is a group.
- `wa_send_group_mention_all` now sends Baileys' native group `@all` (`mentionAll`, encoded as
  `contextInfo.nonJidMentions`) and does not list every participant. If that flag is unavailable,
  the tool still mentions each current participant individually
  ([#105](https://github.com/delltrak/wamcp/issues/105), [#114](https://github.com/delltrak/wamcp/pull/114)).
  Notification delivery depends on WhatsApp and recipient settings; real-device notification
  behavior has not been verified.
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
