# WA MCP -- API Reference

> Complete reference for all tools, resources, and notifications exposed by the WA MCP server.

---

## Table of Contents

1. [Overview](#1-overview)
   - [Operations dashboard](#operations-dashboard)
2. [Tools Reference](#2-tools-reference)
   - [Instance Management](#21-instance-management-9-tools)
   - [Messaging](#22-messaging-32-tools)
   - [Chat Management](#23-chat-management-11-tools)
   - [Group Management](#24-group-management-28-tools)
   - [Contact Management](#25-contact-management-8-tools)
   - [Profile Management](#26-profile-management-7-tools)
   - [Status / Stories](#27-status--stories-4-tools)
   - [Newsletter / Channels](#28-newsletter--channels-11-tools)
   - [Call Management](#29-call-management-1-tool)
   - [Message Search](#210-message-search-1-tool)
   - [WhatsApp Business Labels](#211-whatsapp-business-labels-8-tools)
   - [WhatsApp Events](#212-whatsapp-events-2-tools)
   - [Business, Communities, and Catalog](#213-business-communities-and-catalog-16-tools)
   - [Community administration](#214-community-administration-16-tools)
3. [Resources Reference](#3-resources-reference)
4. [Notifications Reference](#4-notifications-reference)
5. [Error Handling](#5-error-handling)
6. [Agent Integration Examples](#6-agent-integration-examples)

---

## 1. Overview

WA MCP is an MCP (Model Context Protocol) server that exposes WhatsApp capabilities as discoverable tools, readable resources, and real-time notifications.

### Transport

- **Protocol:** Streamable HTTP (MCP standard)
- **Endpoint:** `http://<host>:3000/mcp`
- **Method:** HTTP POST for tool calls and resource reads; SSE for server-pushed notifications

### Authentication

All requests require an API key in the `Authorization` header:

```
Authorization: Bearer wamcp_sk_your_key
```

The key is configured via the `WA_API_KEY` environment variable on the server.

### Operations dashboard

`GET /dashboard` redirects to `GET /dashboard/`, an optional browser page on the same HTTP server. It is absent unless `WA_DASHBOARD_ENABLED=true`. Enabling it also requires `WA_TRANSPORT=http` and `WA_DASHBOARD_USERS` (`user:password`, or several entries separated by commas). Each password must be at least 12 characters. A request without a matching `Authorization: Basic` header returns `401` and `WWW-Authenticate`. Wrong credentials also return `401`. With the flag off, `/dashboard` is a normal `404`. Basic authentication repeats the password on every request; terminate TLS in front of the server before exposing the page. Failures are counted per address and username, and again per address across usernames. Eight wrong `Authorization` headers in 15 minutes each return `401`. Further guesses return `429` without `WWW-Authenticate`. A correct login does not clear failures. While an address or username is limited, the password is checked at most once per 60 seconds; anyone who shares the address can take that check, and any other guess, including the right password, is `429` before the password is compared. A username that signed in during the last 15 minutes skips the address total and the process-wide cap until that username fails again. Eight failures of that same username still limit it. The process rejects further failed password checks after 60 in a minute. Successful checks are not counted. During a distributed attack, a correct login from a username that has not signed in during the last 15 minutes can also return `429`. A request that omits `Authorization` is not counted. The counter uses the socket address, with IPv6 grouped by `/64`.

The page shows instance connection state, last connect and disconnect time, disconnect reason, pending pairing method (not the code or QR secret unless pairing is in progress), webhook configuration, dropped event names, and recent delivery successes and failures. It does not show webhook URLs, header names, header values, tokens, or signing secrets. Cloud webhook settings are reported only as configured or not configured. The page calls `api/overview` and `api/instances/{instanceId}/pairing` relative to its own URL.

The page is read-only except `POST /dashboard/api/instances/{instanceId}/pairing`, which starts pairing for an existing unpaired Baileys instance. It does not create instances. The body must be `Content-Type: application/json`, including when it is empty. A `Sec-Fetch-Site: cross-site` header, an `Origin: null` value, or an `Origin` that does not match `Host` is rejected with `403` before any connect. An explicit port 80 matches an `http` origin that omits the port, and 443 matches `https` the same way. Behind nginx, set `proxy_set_header Host $host;` so `Host` is the name the browser used. The default `$proxy_host` is the upstream and makes that check fail. `X-Forwarded-Proto` is not trusted; the scheme is compared only when the socket to this process is TLS. The route refuses a non-Baileys instance, any instance whose stored Baileys credentials are registered, any credential object that does not explicitly set `registered` to `false`, and any instance whose state is `connected`. That refusal does not connect, request a pairing code, or read a QR. The dashboard does not log out, delete, restart, or send messages, and it does not change `WA_DATABASE_PATH`, the auth store, or Docker volumes.

`GET /dashboard/api/overview` returns the same redacted status as JSON for the signed-in operator.

### Channel Types

WA MCP supports two underlying WhatsApp connection methods:

| Channel   | Description                       | Notes                                                                                             |
| --------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `baileys` | Open-source WhatsApp Web protocol | Full feature support. Requires QR code or pairing code auth. Unofficial -- numbers may be banned. |
| `cloud`   | Meta Cloud API (official)         | Subset of features. Requires Meta Business credentials. Production-safe.                          |

Tools marked **Baileys only** are not available on Cloud API instances.

### Common Patterns

- **`instanceId`** -- Every tool requires an `instanceId` identifying which WhatsApp connection to use.
- **`to`** -- Recipient for send operations. Use a phone number (e.g. `"5511999999999"`) or a group JID (e.g. `"120363...@g.us"`).
- **JID** -- Jabber ID, WhatsApp's internal identifier. Individual: `5511999999999@s.whatsapp.net`. Group: `120363...@g.us`.
- **Media** -- Image/video/audio/document fields accept a URL (`https://...`) or base64-encoded data.
  Stickers and GIFs are converted to WhatsApp-compatible formats with ffmpeg. `wa_send_sticker`
  accepts PNG, JPG, GIF, WebP, and short MP4 and produces 512x512 WebP. `wa_send_image` and
  `wa_send_video` send the original media unless `compress` is true or `WA_MEDIA_COMPRESS=true`
  (default `false`). `hd: true` sends the original. Received media can be saved under
  `WA_MEDIA_DOWNLOAD_DIR` (default `data/media-downloads`) or returned as base64.
  `WA_MEDIA_DOWNLOAD_MAX_BYTES` defaults to 25 MB, and base64 mode is capped at 5 MB. Docker
  installs Alpine `ffmpeg` (`libwebp`, `libwebp_anim`, `mjpeg`, `libx264`, `aac`). Sharp and the
  libwebp CLI tools are not required. `WA_MEDIA_FFMPEG_PATH` and `WA_MEDIA_FFMPEG_TIMEOUT_MS`
  configure conversions.
- **Automatic read receipts** -- `WA_AUTO_READ=false` (default), `on_fetch` to mark incoming
  messages read when a tool or resource returns them, or `on_receive` to mark them read when they
  arrive. Invalid values disable the feature and log a warning.
- **Baileys app-state writes** -- `WA_APP_STATE_WRITES_ENABLED=false` by default. It enables
  `wa_archive_chat`, `wa_pin_chat`, `wa_mute_chat`, `wa_delete_chat`, `wa_clear_chat`,
  `wa_mark_chat_unread`, `wa_star_message`, all business-label tools, `wa_update_profile_name`, the three
  quick-reply tools, catalog product writes, private disappearing timers, default
  disappearing-mode privacy changes, and existing group/server operations that share the
  app-state write gate. Per instance, app-state writes are serialized and spaced by
  `WA_APP_STATE_MIN_INTERVAL_MS` (default `1500`). Before dispatch, the adapter checks the open,
  authenticated socket, the current app-state key and its stored key, and resyncs the target
  collection. It refuses to patch if Baileys reports a sync/decode/key/hash failure or if the
  collection lacks a positive version and 128-byte hash. After a successful patch it resyncs once
  and warns if the version did not advance; failed patches are not automatically retried.
- **Group, community, and Channel server writes** -- `WA_GROUP_WRITES_ENABLED=false` by default.
  It enables group creation, membership/settings, invite and join-request changes, community
  changes, and Channel follow/management calls. The inspected Baileys methods use group/community
  IQs, newsletter MEX calls, or message queries; they do not call `appPatch`. It also gates queued
  group member-label protocol messages, which can only set or remove the connected account's own
  label. This flag does not enable chat, profile, business-label, quick-reply, or catalog writes.
  Setting `WA_APP_STATE_WRITES_ENABLED=true` continues to enable app-state and the existing
  group/server writes that share that gate; member-label tools specifically require
  `WA_GROUP_WRITES_ENABLED=true`.
- **Group-history digests** -- `wa_send_group_history_to_member` is a Baileys workaround for the
  unavailable native recent-history sharing feature. It reads local SQLite messages, skips revoked
  and view-once messages, refuses groups with `ephemeralDuration` greater than 0, and queues a
  text digest to a current member's PN when one is known. `WA_GROUP_HISTORY_ON_JOIN` optionally
  enables the same digest from a `GROUP_PARTICIPANT_ADD` stub authored by this account, and still
  requires `WA_GROUP_WRITES_ENABLED=true`. The flag accepts only `true` or `false`.
  `WA_GROUP_HISTORY_ON_JOIN_COUNT` defaults to 50, must be an integer, and is clamped to 25–100.
  Any other value fails startup. Approved joins that rc14 stores as a plain add stub cannot be
  told apart from a direct add.
- **Message keys for chat patches** -- Unread, archive, delete, and clear operations use up to three
  recent stored raw message keys with numeric Unix-second timestamps. The collection index uses the
  latest raw key's `remoteJid`, preserving the PN/LID address used by that message. Invalid rows are
  skipped, and the patch is refused if no usable message remains. Star/unstar also requires the raw
  stored key. These writes remain disabled by default.
- **Issue #71** -- [Baileys PR #2456](https://github.com/WhiskeySockets/Baileys/pull/2456) changed
  sync to skip undecryptable records rather than abort the whole collection. In rc14, resync can log and return after a collection is parked or records are
  skipped, while `appPatch` continues with the local version and hash. A patch encoded on a partial
  or stale base can desynchronize the account. The preflight reduces that risk but cannot prove
  server state in every case. Test enabled writes on a disposable WhatsApp number first; no
  real-number check has been performed for this change.
- **Real WhatsApp checks** -- Run real integration tests only with a throwaway number. Automated
  tests use mocked sockets and do not connect to WhatsApp.

---

## 2. Tools Reference

WA MCP exposes **158 tools** grouped by domain. All tools return MCP-standard responses.
`WA_INSTANCE_WEBHOOK_TOOLS_ENABLED=true` adds three #142 instance webhook tools.

### Success Response Format

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"key\": \"value\"}"
    }
  ]
}
```

### Error Response Format

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Error: Description of what went wrong"
    }
  ]
}
```

---

### 2.1 Instance Management (9 tools, plus 3 when `WA_INSTANCE_WEBHOOK_TOOLS_ENABLED=true`)

Tools for creating, connecting, and managing WhatsApp instances.

#### `wa_create_instance`

Create a new WhatsApp instance.

| Parameter | Type                     | Required                  | Description                                         |
| --------- | ------------------------ | ------------------------- | --------------------------------------------------- |
| `name`    | string                   | Yes                       | Human-friendly instance name (e.g. `"support-bot"`) |
| `channel` | `"baileys"` \| `"cloud"` | No (default: `"baileys"`) | WhatsApp channel type                               |

**Channel support:** Both

**Response:**

```json
{
  "id": "inst_abc123",
  "name": "support-bot",
  "channel": "baileys",
  "status": "disconnected",
  "createdAt": 1709136000000
}
```

---

#### `wa_connect_instance`

Connect a WhatsApp instance. For Baileys instances, this starts the WebSocket connection and generates a QR code for authentication.

| Parameter    | Type   | Required | Description                |
| ------------ | ------ | -------- | -------------------------- |
| `instanceId` | string | Yes      | The instance ID to connect |

**Channel support:** Both

**Response:**

```json
{
  "instanceId": "inst_abc123",
  "status": "connecting"
}
```

---

#### `wa_disconnect_instance`

Gracefully disconnect a WhatsApp instance. The session is preserved for reconnection.

| Parameter    | Type   | Required | Description                   |
| ------------ | ------ | -------- | ----------------------------- |
| `instanceId` | string | Yes      | The instance ID to disconnect |

**Channel support:** Both

**Response:**

```json
{
  "instanceId": "inst_abc123",
  "status": "disconnected"
}
```

---

#### `wa_delete_instance`

Permanently delete a WhatsApp instance and all its data including auth state, messages, contacts, and queue. **This action cannot be undone.**

| Parameter    | Type   | Required | Description                           |
| ------------ | ------ | -------- | ------------------------------------- |
| `instanceId` | string | Yes      | The instance ID to permanently delete |

**Channel support:** Both

**Response:**

```json
{
  "instanceId": "inst_abc123",
  "deleted": true
}
```

---

#### `wa_restart_instance`

Disconnect and reconnect a WhatsApp instance. Useful for recovering from errors.

| Parameter    | Type   | Required | Description                |
| ------------ | ------ | -------- | -------------------------- |
| `instanceId` | string | Yes      | The instance ID to restart |

**Channel support:** Both

**Response:**

```json
{
  "instanceId": "inst_abc123",
  "status": "connecting"
}
```

---

#### `wa_get_qr_code`

Get the QR code as a base64 image for authenticating a Baileys instance. Returns null if no QR code is available (already authenticated or not yet connecting).

| Parameter    | Type   | Required | Description                    |
| ------------ | ------ | -------- | ------------------------------ |
| `instanceId` | string | Yes      | The instance ID (Baileys only) |

**Channel support:** Baileys only

**Response (QR available):**

```json
{
  "instanceId": "inst_abc123",
  "qrCode": "data:image/png;base64,iVBORw0KGgo..."
}
```

**Response (no QR):**

```json
{
  "instanceId": "inst_abc123",
  "qrCode": null,
  "message": "No QR code available"
}
```

---

#### `wa_get_pairing_code`

Get a numeric pairing code for authenticating a Baileys instance. The code is entered on the phone in WhatsApp > Linked Devices > Link with phone number.

| Parameter     | Type   | Required | Description                                        |
| ------------- | ------ | -------- | -------------------------------------------------- |
| `instanceId`  | string | Yes      | The instance ID (Baileys only)                     |
| `phoneNumber` | string | Yes      | Phone number to pair with (e.g. `"5511999999999"`) |

**Channel support:** Baileys only

**Response:**

```json
{
  "instanceId": "inst_abc123",
  "pairingCode": "A1B2-C3D4"
}
```

---

#### `wa_set_cloud_credentials`

Configure Meta Cloud API credentials for a Cloud API instance. Required before connecting a Cloud API instance.

| Parameter       | Type   | Required | Description                      |
| --------------- | ------ | -------- | -------------------------------- |
| `instanceId`    | string | Yes      | The instance ID (Cloud API only) |
| `accessToken`   | string | Yes      | Meta Cloud API access token      |
| `phoneNumberId` | string | Yes      | Meta Phone Number ID             |
| `businessId`    | string | No       | Meta Business ID                 |

**Channel support:** Cloud API only

**Response:**

```json
{
  "instanceId": "inst_abc123",
  "configured": true
}
```

---

#### `wa_set_instance_webhook`

Registered only when `WA_INSTANCE_WEBHOOK_TOOLS_ENABLED=true` (#142). Replace the outgoing event webhook stored for one instance. `auth_value` is saved in plaintext for delivery and is not returned. Omit `events` to inherit `WA_EVENT_WEBHOOK_EVENTS`. An empty event list is rejected. The instance webhook uses `WA_EVENT_WEBHOOK_PRESET`, `WA_EVENT_WEBHOOK_IGNORE_FROM_ME`, and `WA_EVENT_WEBHOOK_SECRET` when that global HMAC secret is set. If global destinations use different HMAC secrets and this URL matches none of them, delivery is unsigned and one warning is logged. The response `endpoint` is the URL origin, not the full URL.

`WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL` defaults to `false`: this instance then uses only this webhook, and a warning is logged when a global destination exists. Set it to `true` to also deliver to the global destinations. A URL that matches a global destination, after lowercasing the host and removing a trailing slash, is delivered once, with this instance's auth header, events, and the global HMAC secret. `WA_INSTANCE_WEBHOOK_ALLOWED_HOSTS` optionally restricts the host. Instances without a stored webhook keep the global destinations. One stored instance webhook satisfies `WA_REQUIRE_EVENT_WEBHOOK` for the whole process. An invalid stored row is skipped so the other destinations keep working.

| Parameter    | Type     | Required | Description                                                                 |
| ------------ | -------- | -------- | --------------------------------------------------------------------------- |
| `instanceId` | string   | Yes      | Instance ID (`inst_` plus 8 hex characters)                                 |
| `url`        | string   | Yes      | Public HTTPS URL. HTTP only when `WA_EVENT_WEBHOOK_ALLOW_HTTP=true`         |
| `authHeader` | string   | No       | Auth header name. Must be set together with `authValue`                     |
| `authValue`  | string   | No       | Auth header value. Write-only; omitted from this response, logs, and health |
| `events`     | string[] | No       | Channel event names. Omit to inherit the global event list                  |

**Channel support:** Both

**Response:**

```json
{
  "configured": true,
  "endpoint": "https://automation.example.com",
  "authHeader": "X-Instance-Token",
  "authConfigured": true,
  "events": null,
  "updatedAt": 1709136000000
}
```

`events: null` means the instance inherits `WA_EVENT_WEBHOOK_EVENTS`. `authHeader` is `null` when no auth header is stored. `endpoint` is the origin only.

---

#### `wa_get_instance_webhook`

Read the webhook stored for one instance. The auth value and full URL are never returned. `configured: false` means the instance uses the global destinations. A stored row that fails validation returns `configured: false` and `invalid: true` instead of an error.

| Parameter    | Type   | Required | Description                                 |
| ------------ | ------ | -------- | ------------------------------------------- |
| `instanceId` | string | Yes      | Instance ID (`inst_` plus 8 hex characters) |

**Channel support:** Both

**Response:**

```json
{
  "configured": true,
  "endpoint": "https://automation.example.com",
  "authHeader": "X-Instance-Token",
  "authConfigured": true,
  "events": ["message.received"],
  "updatedAt": 1709136000000
}
```

---

#### `wa_delete_instance_webhook`

Remove the webhook stored for one instance. Later events for that instance use the global destinations.

| Parameter    | Type   | Required | Description                                 |
| ------------ | ------ | -------- | ------------------------------------------- |
| `instanceId` | string | Yes      | Instance ID (`inst_` plus 8 hex characters) |

**Channel support:** Both

**Response:**

```json
{
  "instanceId": "inst_abc123",
  "deleted": true
}
```

---

### 2.2 Messaging (32 tools)

Tools for sending messages, media, reactions, and managing message state.

#### `wa_send_text`

Send a text message to a WhatsApp contact or group.

| Parameter         | Type   | Required | Description                                                  |
| ----------------- | ------ | -------- | ------------------------------------------------------------ |
| `instanceId`      | string | Yes      | The instance to send from                                    |
| `to`              | string | Yes      | Recipient phone number (e.g. `"5511999999999"`) or group JID |
| `text`            | string | Yes      | Message content (max 65536 chars)                            |
| `quotedMessageId` | string | No       | Message ID to reply to                                       |
| `mentions`        | string[] | No     | Participant phone numbers or JIDs to mention                 |

**Channel support:** Both

**Response:**

```json
{
  "status": "queued",
  "jobId": "job_123"
}
```

---

#### `wa_send_group_mention_all`

Send a group text message with WhatsApp's native `@all` mention. Baileys sends `mentionAll`, which
is encoded as `contextInfo.nonJidMentions = 1`, and does not put every participant in
`mentionedJid`. Notification delivery depends on WhatsApp and recipient settings; generating the
native mention payload does not verify that a notification appeared on each device.
`@all` is appended to `text` when the text does not already contain that token.

If the installed Baileys build does not emit `nonJidMentions`, the tool falls back to mentioning
each current participant through `mentionedJid` (at most 1024 participants).

| Parameter    | Type   | Required | Description |
| ------------ | ------ | -------- | ----------- |
| `instanceId` | string | Yes      | The instance to send from |
| `groupId`    | string | Yes      | Group JID |
| `text`       | string | Yes      | Message text (max 4096 chars) |

**Channel support:** Baileys only. Cloud API does not support participant mentions or native `@all`.

**Response (native):**

```json
{
  "status": "queued",
  "jobId": "job_123",
  "mode": "native"
}
```

**Response (participant fallback):**

```json
{
  "status": "queued",
  "jobId": "job_123",
  "mode": "participants",
  "mentionCount": 12
}
```

---

#### `wa_send_image`

Send an image to a WhatsApp contact or group.

| Parameter         | Type   | Required | Description                         |
| ----------------- | ------ | -------- | ----------------------------------- |
| `instanceId`      | string | Yes      | The instance to send from           |
| `to`              | string | Yes      | Recipient phone number or group JID |
| `image`           | string | Yes      | Image URL or base64-encoded data    |
| `caption`         | string | No       | Image caption                       |
| `quotedMessageId` | string | No       | Message ID to reply to              |
| `mentions`        | string[] | No     | Participant phone numbers or JIDs to mention |
| `compress`        | boolean | No      | Compress before sending. Omit to follow `WA_MEDIA_COMPRESS` (default `false`) |
| `hd`              | boolean | No      | Send the original image. Overrides `compress` and `WA_MEDIA_COMPRESS` |

Compression re-encodes to JPEG, limits the longest edge to `WA_MEDIA_IMAGE_MAX_EDGE` (default 600),
and uses `WA_MEDIA_IMAGE_QUALITY` (default 75). The original is sent when the PNG has transparency,
ffmpeg fails, or the result is not smaller. `hd: true` skips compression. Edge and quality are
validated only when compression runs.

**Channel support:** Both. A compressed Cloud API image is uploaded and sent by media id.

**Response:**

```json
{
  "status": "queued",
  "jobId": "job_124"
}
```

---

#### `wa_send_video`

Send a video to a WhatsApp contact or group.

| Parameter         | Type   | Required | Description                         |
| ----------------- | ------ | -------- | ----------------------------------- |
| `instanceId`      | string | Yes      | The instance to send from           |
| `to`              | string | Yes      | Recipient phone number or group JID |
| `video`           | string | Yes      | Video URL or base64-encoded data    |
| `caption`         | string | No       | Video caption                       |
| `quotedMessageId` | string | No       | Message ID to reply to              |
| `mentions`        | string[] | No     | Participant phone numbers or JIDs to mention |
| `compress`        | boolean | No      | Compress before sending. Omit to follow `WA_MEDIA_COMPRESS` (default `false`) |
| `hd`              | boolean | No      | Send the original video. Overrides `compress` and `WA_MEDIA_COMPRESS` |

Compression re-encodes to H.264/AAC MP4, limits the longest edge to `WA_MEDIA_VIDEO_MAX_EDGE`
(default 720), and uses `WA_MEDIA_VIDEO_CRF` (default 28). The source is read from a private
temporary file so an MP4 with its `moov` atom at the end still decodes. The original is sent when
ffmpeg fails or the result is not smaller. `hd: true` skips compression. Edge and CRF are validated
only when compression runs.

**Channel support:** Both. A compressed Cloud API video is uploaded and sent by media id.

**Response:**

```json
{
  "status": "queued",
  "jobId": "job_125"
}
```

---

#### `wa_send_ptv`

Send a round video note through the normal queued video path. Baileys sends it with `ptv: true`.

| Parameter    | Type     | Required | Description                          |
| ------------ | -------- | -------- | ------------------------------------ |
| `instanceId` | string   | Yes      | The instance to send from            |
| `to`         | string   | Yes      | Recipient phone number or group JID  |
| `video`      | string   | Yes      | Video URL or base64-encoded data     |
| `caption`    | string   | No       | Optional video caption               |
| `mentions`   | string[] | No       | Participant phone numbers or JIDs to mention |

**Channel support:** Baileys only. Cloud API returns an unsupported-operation error.

---

#### `wa_send_sticker`

Send a native WhatsApp sticker. PNG, JPG, GIF, and short MP4 inputs are converted to 512x512 WebP
with transparent padding. GIF and MP4 sources stay animated unless `animated` is false. MP4 input
is read from a private temporary file and trimmed to 10 seconds, including files whose `moov` atom
follows `mdat`. Static stickers are limited to 100 KB and animated stickers to 500 KB.
Static WebP files that are not 512x512 are normalized with ffmpeg; animated WebP passes through only
at 512x512 because ffmpeg cannot safely resize animated WebP. Send a GIF or short MP4 to convert an
animated sticker to 512x512. Correctly sized WebP files pass through unchanged when they are within
their size limit.

| Parameter         | Type    | Required | Description                                      |
| ----------------- | ------- | -------- | ------------------------------------------------ |
| `instanceId`      | string  | Yes      | The instance to send from                        |
| `to`              | string  | Yes      | Recipient phone number or group JID              |
| `sticker`         | string  | Yes      | PNG, JPG, GIF, WebP, or short MP4 URL or base64  |
| `animated`        | boolean | No       | Keep or flatten GIF/MP4 animation                |
| `quotedMessageId` | string  | No       | Message ID to reply to                           |

**Channel support:** Both. Cloud API uploads the prepared WebP before sending it.

**Response:** The standard queued message response.

---

#### `wa_send_gif`

Send a GIF as a looping WhatsApp video. GIF or MP4 input is converted to silent H.264 MP4 with
`yuv420p` pixel format and even dimensions, then sent with Baileys `gifPlayback: true`.

| Parameter         | Type     | Required | Description                          |
| ----------------- | -------- | -------- | ------------------------------------ |
| `instanceId`      | string   | Yes      | The instance to send from            |
| `to`              | string   | Yes      | Recipient phone number or group JID  |
| `gif`             | string   | Yes      | GIF or MP4 URL or base64 data        |
| `caption`         | string   | No       | Optional caption                     |
| `quotedMessageId` | string   | No       | Message ID to reply to               |
| `mentions`        | string[] | No       | Participant phone numbers or JIDs to mention |

**Channel support:** Baileys only. Cloud API does not expose the GIF playback option.

**Response:** The standard queued message response.

---

#### `wa_send_audio`

Send an audio file or voice note to a WhatsApp contact or group.

| Parameter    | Type    | Required              | Description                         |
| ------------ | ------- | --------------------- | ----------------------------------- |
| `instanceId` | string  | Yes                   | The instance to send from           |
| `to`         | string  | Yes                   | Recipient phone number or group JID |
| `audio`      | string  | Yes                   | Audio URL or base64-encoded data    |
| `ptt`        | boolean | No (default: `false`) | Send as voice note (push-to-talk)   |
| `mentions`   | string[] | No                  | Participant phone numbers or JIDs to mention |

**Channel support:** Both

**Response:**

```json
{
  "status": "queued",
  "jobId": "job_126"
}
```

---

#### `wa_send_document`

Send a document/file to a WhatsApp contact or group.

| Parameter    | Type   | Required | Description                                    |
| ------------ | ------ | -------- | ---------------------------------------------- |
| `instanceId` | string | Yes      | The instance to send from                      |
| `to`         | string | Yes      | Recipient phone number or group JID            |
| `document`   | string | Yes      | Document URL or base64-encoded data            |
| `fileName`   | string | Yes      | File name with extension (e.g. `"report.pdf"`) |
| `mimeType`   | string | Yes      | MIME type (e.g. `"application/pdf"`)           |
| `mentions`   | string[] | No     | Participant phone numbers or JIDs to mention    |

**Channel support:** Both

**Response:**

```json
{
  "status": "queued",
  "jobId": "job_127"
}
```

---

#### `wa_download_media`

Download received image, video, audio, document, or sticker media. File mode saves it under
`WA_MEDIA_DOWNLOAD_DIR`; base64 mode returns inline data without writing a file.

| Parameter    | Type            | Required | Description                                      |
| ------------ | --------------- | -------- | ------------------------------------------------ |
| `instanceId` | string          | Yes      | The instance that received the message           |
| `messageId`  | string          | Yes      | Received message ID                              |
| `chatId`     | string          | No       | Chat JID used to verify the message              |
| `mode`       | `file` | `base64` | No (default: `file`) | Return a saved path or base64 data |

**Channel support:** Both. Cloud API downloads media through Meta's media endpoint.

The default maximum is 25 MB (`WA_MEDIA_DOWNLOAD_MAX_BYTES`). Base64 mode has a 5 MB maximum, or
the lower configured download limit. Incoming path separators, `..` sequences, and control
characters are stripped from filenames and names are limited to 120 characters. Saved paths receive
a generated unique prefix and are checked to remain inside the configured directory, so a remote
filename with traversal components cannot choose its save path.

**File response:** `{ "path": "...", "fileName": "report.pdf", "mimeType": "application/pdf", "size": 4096 }`

**Base64 response:** `{ "path": null, "fileName": "report.pdf", "mimeType": "application/pdf", "size": 4096, "base64": "..." }`

---

#### `wa_send_location`

Send a GPS location to a WhatsApp contact or group.

| Parameter    | Type   | Required | Description                         |
| ------------ | ------ | -------- | ----------------------------------- |
| `instanceId` | string | Yes      | The instance to send from           |
| `to`         | string | Yes      | Recipient phone number or group JID |
| `latitude`   | number | Yes      | GPS latitude (-90 to 90)            |
| `longitude`  | number | Yes      | GPS longitude (-180 to 180)         |
| `name`       | string | No       | Location name                       |
| `address`    | string | No       | Location address                    |

**Channel support:** Both

**Response:**

```json
{
  "status": "queued",
  "jobId": "job_128"
}
```

---

#### `wa_send_live_location`

Send a live location with the current coordinates and optional accuracy and comment. Baileys only.

| Parameter          | Type   | Required | Description                         |
| ------------------ | ------ | -------- | ----------------------------------- |
| `instanceId`       | string | Yes      | The instance to send from           |
| `to`               | string | Yes      | Recipient phone number or group JID |
| `latitude`         | number | Yes      | Current latitude (-90 to 90)        |
| `longitude`        | number | Yes      | Current longitude (-180 to 180)     |
| `accuracyInMeters` | number | No       | Location accuracy                   |
| `comment`          | string | No       | Optional note (max 256 chars)       |

**Channel support:** Baileys only. Cloud API does not support live location messages.

**Response:** The standard queued message response.

---

#### `wa_send_contact`

Send one vCard or an array of up to 20 vCards to a WhatsApp contact or group. Use either the
legacy `contactName`/`contactPhone` pair or the `contacts` array.

| Parameter      | Type              | Required | Description                                    |
| -------------- | ----------------- | -------- | ---------------------------------------------- |
| `instanceId`   | string            | Yes      | The instance to send from                      |
| `to`           | string            | Yes      | Recipient phone number or group JID            |
| `contactName`  | string            | One form | Legacy display name for one vCard              |
| `contactPhone` | string            | One form | Legacy phone number for one vCard              |
| `contacts`     | `{name, phone}[]` | One form | 1-20 contacts; cannot combine with legacy fields |

**Channel support:** Both. Cloud API supports multiple contact cards.

**Response:**

```json
{
  "status": "queued",
  "jobId": "job_129"
}
```

---

#### `wa_send_poll`

Create and send a poll to a WhatsApp contact or group.

| Parameter     | Type     | Required              | Description                         |
| ------------- | -------- | --------------------- | ----------------------------------- |
| `instanceId`  | string   | Yes                   | The instance to send from           |
| `to`          | string   | Yes                   | Recipient phone number or group JID |
| `question`    | string   | Yes                   | Poll question                       |
| `options`     | string[] | Yes                   | Poll options (2-12 choices)         |
| `multiSelect` | boolean  | No (default: `false`) | Allow multiple selections           |

**Channel support:** Baileys only. Cloud API does not support poll creation.

**Response:**

```json
{
  "status": "queued",
  "jobId": "job_130"
}
```

---

#### `wa_get_poll_results`

Read decrypted votes for a locally stored poll. Incoming poll message secrets and decrypted vote
updates are retained with the poll message so results remain available after reconnecting.

| Parameter    | Type   | Required | Description                 |
| ------------ | ------ | -------- | --------------------------- |
| `instanceId` | string | Yes      | The instance ID              |
| `chatId`     | string | Yes      | Chat JID containing the poll |
| `messageId`  | string | Yes      | Poll creation message ID     |

**Channel support:** Baileys only. Cloud API does not expose poll votes.

**Response:** `{ "chatId": "...", "messageId": "...", "question": "Dinner?", "options": [{ "name": "Pizza", "count": 2, "voters": ["..."] }], "totalVotes": 2, "totalVoters": 2 }`

---

#### `wa_send_reaction`

React to a message with an emoji. Send an empty string emoji to remove a reaction.

| Parameter    | Type   | Required | Description                                  |
| ------------ | ------ | -------- | -------------------------------------------- |
| `instanceId` | string | Yes      | The instance to send from                    |
| `chatId`     | string | Yes      | Chat JID where the message is                |
| `messageId`  | string | Yes      | Message ID to react to                       |
| `emoji`      | string | Yes      | Emoji to react with (empty string to remove) |

**Channel support:** Both

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_send_link_preview`

Send a text message with a rich link preview.

| Parameter     | Type   | Required | Description |
| ------------- | ------ | -------- | ----------- |
| `instanceId`  | string | Yes      | The instance to send from |
| `to`          | string | Yes      | Recipient phone number or group JID |
| `text`        | string | Yes      | Message text content; the URL is appended if missing |
| `url`         | string | Yes      | HTTP or HTTPS URL for the preview |
| `title`       | string | No       | Custom preview title |
| `description` | string | No       | Custom preview description |
| `thumbnail`   | string | No       | JPEG thumbnail image as base64 or a JPEG data URI |

**Channel support:** Both. Baileys generates preview metadata and thumbnails from the URL when
custom fields are omitted. Cloud API generates its own preview; custom metadata and thumbnails are
not supported.

**Response:**

```json
{
  "messageId": "msg_abc123",
  "timestamp": 1709136000
}
```

---

#### `wa_send_buttons`

Send up to three reply buttons. Cloud API sends a native interactive button message; Baileys sends a
numbered text message that lists each reply ID.

| Parameter    | Type   | Required | Description |
| ------------ | ------ | -------- | ----------- |
| `instanceId` | string | Yes      | The instance to send from |
| `to`         | string | Yes      | Recipient phone number or group JID |
| `text`       | string | Yes      | Message body (max 1024 chars) |
| `footer`     | string | No       | Optional footer (max 60 chars) |
| `buttons`    | object[] | Yes    | One to three `{ "id", "text" }` reply buttons |

**Channel support:** Both. Baileys uses the text fallback because rc14 does not send native reply
buttons.

---

#### `wa_send_list`

Send a selectable list. Cloud API sends a native interactive list; Baileys sends a readable text
fallback with each row ID.

| Parameter    | Type   | Required | Description |
| ------------ | ------ | -------- | ----------- |
| `instanceId` | string | Yes      | The instance to send from |
| `to`         | string | Yes      | Recipient phone number or group JID |
| `text`       | string | Yes      | Message body |
| `footer`     | string | No       | Optional footer |
| `buttonText` | string | Yes      | Text for the list-open button |
| `sections`   | object[] | Yes    | Sections with titles and rows; at most 10 rows total |

**Channel support:** Both. Baileys uses the text fallback because rc14 does not send native lists.

---

#### `wa_send_media_album`

Send two to ten images as one Baileys album.

| Parameter    | Type   | Required | Description |
| ------------ | ------ | -------- | ----------- |
| `instanceId` | string | Yes      | The instance to send from |
| `to`         | string | Yes      | Recipient phone number or group JID |
| `images`     | object[] | Yes    | Two to ten `{ "image", "caption?" }` entries |

**Channel support:** Baileys only. Cloud API does not group media into albums.

**Response:** `{ "status": "queued", "jobId": "..." }`. Album sends use the per-instance
`WA_BAILEYS_RATE_LIMIT` queue; each album is bounded to ten images.

---

#### `wa_reply_privately_to_group_message`

Send a direct message to the author of a group message stored in local history.

| Parameter    | Type   | Required | Description |
| ------------ | ------ | -------- | ----------- |
| `instanceId` | string | Yes      | The instance to send from |
| `groupId`    | string | Yes      | Group JID containing the original message |
| `messageId`  | string | Yes      | Stored group message ID |
| `text`       | string | Yes      | Private reply text |

**Channel support:** Baileys only. The group message must be present in local history.

---

#### `wa_get_message_receipts`

List per-participant delivery receipts observed and stored locally for a message. Group receipts
include each participant; status story reads are returned by `wa_get_status_viewers`.

| Parameter    | Type   | Required | Description |
| ------------ | ------ | -------- | ----------- |
| `instanceId` | string | Yes      | The instance ID |
| `chatId`     | string | Yes      | Chat or group JID |
| `messageId`  | string | Yes      | Message ID |

Receipt `status` is `delivered`, `read`, or `played`; `timestamp` is Unix milliseconds. Receipts
are available only after this server observes the receipt event.

**Channel support:** Baileys only. Cloud API does not provide participant-level receipts.

---

#### `wa_get_message_reactions`

List the latest locally observed reaction from each participant for a message. Removed reactions
are omitted.

| Parameter    | Type   | Required | Description |
| ------------ | ------ | -------- | ----------- |
| `instanceId` | string | Yes      | The instance ID |
| `chatId`     | string | Yes      | Chat or group JID |
| `messageId`  | string | Yes      | Message ID |

**Channel support:** Baileys only. Cloud API does not expose reaction history here.

---

#### `wa_forward_message`

Forward an existing message with its original content to another chat. Baileys forwards stored
media content when available; older media messages without stored content return an error. WhatsApp
may omit the "Forwarded" label when the source message was sent by this account. The API records the
forwarded metadata returned with the sent message and does not force that label.

| Parameter    | Type   | Required | Description                                       |
| ------------ | ------ | -------- | ------------------------------------------------- |
| `instanceId` | string | Yes      | The instance to send from                         |
| `to`         | string | Yes      | Recipient phone number or group JID to forward to |
| `messageId`  | string | Yes      | Message ID to forward                             |
| `fromChatId` | string | Yes      | Chat JID where the original message is            |

**Channel support:** Both

**Response:**

```json
{
  "messageId": "msg_fwd_456",
  "timestamp": 1709136000
}
```

---

#### `wa_edit_message`

Edit a previously sent message. Only text messages sent by this instance can be edited.

| Parameter    | Type   | Required | Description                      |
| ------------ | ------ | -------- | -------------------------------- |
| `instanceId` | string | Yes      | The instance ID                  |
| `chatId`     | string | Yes      | Chat JID where the message is    |
| `messageId`  | string | Yes      | Message ID to edit               |
| `newText`    | string | Yes      | New text content for the message |

**Channel support:** Baileys only. Cloud API does not support message edits.

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_delete_message`

Delete a message for everyone in the chat. Only messages sent by this instance can be deleted.
For `status@broadcast`, Baileys sends the revocation to the audience saved when the status was
posted. Older statuses without a saved audience use the account's own JID and known individual
contacts.

| Parameter       | Type     | Required | Description                                                                                              |
| --------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `instanceId`    | string   | Yes      | The instance ID                                                                                          |
| `chatId`        | string   | Yes      | Chat JID where the message is; use `status@broadcast` for a status                                       |
| `messageId`     | string   | Yes      | Message ID to delete for everyone                                                                        |
| `statusJidList` | string[] | No       | Status deletion audience; valid only for `status@broadcast`. The account's own JID is always included. |

When provided, `statusJidList` accepts individual phone numbers or user JIDs and overrides the
stored/default audience. The local message status is set to `revoked` after Baileys confirms the
delete. Status deletion is supported by Baileys.

**Channel support:** Baileys only. Cloud API does not support delete-for-everyone.

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_pin_message`

Pin or unpin a message in a chat.

| Parameter    | Type    | Required | Description                     |
| ------------ | ------- | -------- | ------------------------------- |
| `instanceId` | string  | Yes      | The instance ID                 |
| `chatId`     | string  | Yes      | Chat JID where the message is   |
| `messageId`  | string  | Yes      | Message ID to pin or unpin      |
| `pin`        | boolean | Yes      | `true` to pin, `false` to unpin |

**Channel support:** Baileys only. Cloud API does not support pinning messages.

**Response:**

```json
{
  "success": true,
  "pinned": true
}
```

---

#### `wa_send_view_once`

Send a view-once image, video, or audio message. The media disappears after the recipient views or plays it once.

| Parameter    | Type                   | Required | Description                         |
| ------------ | ---------------------- | -------- | ----------------------------------- |
| `instanceId` | string                 | Yes      | The instance to send from           |
| `to`         | string                 | Yes      | Recipient phone number or group JID |
| `media`      | string                 | Yes      | Media URL or base64-encoded data    |
| `type`       | `"image"` \| `"video"` \| `"audio"` | Yes | Media type                          |

**Channel support:** Baileys only. Cloud API does not support view-once media.

**Response:**

```json
{
  "messageId": "msg_vo_789",
  "timestamp": 1709136000
}
```

---

#### `wa_send_presence`

Send a presence status (typing, recording, etc.) to a chat.

| Parameter    | Type                                                                             | Required | Description                  |
| ------------ | -------------------------------------------------------------------------------- | -------- | ---------------------------- |
| `instanceId` | string                                                                           | Yes      | The instance ID              |
| `chatId`     | string                                                                           | Yes      | Chat JID to send presence to |
| `status`     | `"typing"` \| `"composing"` \| `"recording"` \| `"paused"` \| `"available"` \| `"unavailable"` | Yes | Presence status; `typing` maps to Baileys `composing` |

**Channel support:** Both

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_subscribe_presence`

Subscribe to contact or group presence updates. Subsequent updates arrive as
`whatsapp/presence.updated` notifications and can be forwarded to configured event webhooks.

| Parameter    | Type   | Required | Description |
| ------------ | ------ | -------- | ----------- |
| `instanceId` | string | Yes      | The instance ID |
| `chatId`     | string | Yes      | Contact or group JID to subscribe to |

**Channel support:** Baileys only. Cloud API does not expose presence subscriptions.

---

#### `wa_mark_read`

Mark specific messages as read in a chat.

| Parameter     | Type     | Required | Description                                                      |
| ------------- | -------- | -------- | ---------------------------------------------------------------- |
| `instanceId`  | string   | Yes      | The instance ID                                                  |
| `chatId`      | string   | Yes      | Chat JID containing the messages                                 |
| `messageIds`  | string[] | Yes      | Message IDs to mark as read (min 1)                              |
| `participant` | string   | No       | Sender JID for group messages; defaults to the stored message sender |

**Channel support:** Both

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_mark_played`

Send WhatsApp's played receipt for stored incoming audio, voice notes (PTT), or video. The tool is always available. Each ID must already be stored for the instance and chat, must be incoming playable media, and group messages need a sender JID from storage or `participant`. `chatJid` must be `@s.whatsapp.net`, `@lid`, or `@g.us` (`@hosted` and `@hosted.lid` are also accepted). Status broadcasts and newsletters are rejected. Set `WA_AUTO_MARK_PLAYED=true` to also send this receipt after a stored incoming audio message is transcribed. That flag defaults to `false`, and the receipt does not delay the transcription text.

| Parameter     | Type     | Required | Description                                                      |
| ------------- | -------- | -------- | ---------------------------------------------------------------- |
| `instanceId`  | string   | Yes      | The instance ID                                                  |
| `chatJid`     | string   | Yes      | Chat JID containing the audio, voice, or video messages          |
| `messageIds`  | string[] | Yes      | Stored incoming audio, voice-note, or video IDs (1-100)          |
| `participant` | string   | No       | Sender JID for a group message when storage has no sender        |

**Channel support:** Baileys only. Cloud API does not support played receipts.

**Response:**

```json
{
  "success": true,
  "count": 1
}
```

---

### 2.3 Chat Management (11 tools)

Tools for organizing the chat list and retrieving message history.

#### `wa_get_messages`

Get recent messages from a chat. Returns messages ordered by most recent first, with sender, content, type, and timestamp. Messages are persisted automatically as they are sent and received.

| Parameter    | Type   | Required | Description                                    |
| ------------ | ------ | -------- | ---------------------------------------------- |
| `instanceId` | string | Yes      | The instance ID                                |
| `chatId`     | string | Yes      | Chat JID (e.g. `5511999999999@s.whatsapp.net`) |
| `limit`      | number | No       | Max messages to return (default 50, max 100)   |

**Response:**

```json
{
  "chatId": "5511999999999@s.whatsapp.net",
  "count": 3,
  "messages": [
    {
      "id": "3EB0ABC123",
      "chatId": "5511999999999@s.whatsapp.net",
      "senderId": "5511999999999@s.whatsapp.net",
      "type": "text",
      "content": "Hello!",
      "mediaUrl": null,
      "quotedMessageId": null,
      "isFromMe": false,
      "isForwarded": false,
      "status": "received",
      "timestamp": 1772314262
    }
  ]
}
```

Business template, interactive, button, and list messages return readable text in `content`,
joined from their available heading, body, footer, and button labels. Messages with actions may
also include the optional `buttons` array (`type`, `text`, and any `url`, `id`, or `phone`).
Header media uses the message's existing `type`, `mediaUrl`, and optional `mediaMimetype` fields.
Unknown Baileys message types use `type: "text"` and include their source content name in the
optional `rawType` field.

```json
{
  "type": "image",
  "content": "Synthetic account notice\nReview the details below.\nButton: See details — https://example.com/details",
  "mediaUrl": "https://example.com/synthetic-header.jpg",
  "mediaMimetype": "image/jpeg",
  "buttons": [
    {
      "type": "url",
      "text": "See details",
      "url": "https://example.com/details"
    }
  ]
}
```

#### `wa_archive_chat`

Archive or unarchive a chat. Archived chats are hidden from the main chat list.

| Parameter    | Type    | Required | Description                             |
| ------------ | ------- | -------- | --------------------------------------- |
| `instanceId` | string  | Yes      | The instance ID                         |
| `chatId`     | string  | Yes      | Chat JID to archive or unarchive        |
| `archive`    | boolean | Yes      | `true` to archive, `false` to unarchive |

**Channel support:** Both

**Response:**

```json
{
  "success": true,
  "archived": true
}
```

---

#### `wa_pin_chat`

Pin or unpin a chat. Pinned chats appear at the top of the chat list.

| Parameter    | Type    | Required | Description                     |
| ------------ | ------- | -------- | ------------------------------- |
| `instanceId` | string  | Yes      | The instance ID                 |
| `chatId`     | string  | Yes      | Chat JID to pin or unpin        |
| `pin`        | boolean | Yes      | `true` to pin, `false` to unpin |

**Channel support:** Both

**Response:**

```json
{
  "success": true,
  "pinned": true
}
```

---

#### `wa_mute_chat`

Mute or unmute a chat.

| Parameter    | Type    | Required | Description                                                          |
| ------------ | ------- | -------- | -------------------------------------------------------------------- |
| `instanceId` | string  | Yes      | The instance ID                                                      |
| `chatId`     | string  | Yes      | Chat JID to mute or unmute                                           |
| `mute`       | boolean | Yes      | `true` to mute, `false` to unmute                                    |
| `muteUntil`  | number  | No       | Unix timestamp in ms when the mute expires (required if `mute=true`) |

**Channel support:** Both

**Response:**

```json
{
  "success": true,
  "muted": true
}
```

---

#### `wa_delete_chat`

Delete an entire chat for this account. **This cannot be undone.**

| Parameter    | Type   | Required | Description        |
| ------------ | ------ | -------- | ------------------ |
| `instanceId` | string | Yes      | The instance ID    |
| `chatId`     | string | Yes      | Chat JID to delete |

**Channel support:** Both

**Response:**

```json
{
  "success": true,
  "deleted": true
}
```

---

#### `wa_clear_chat`

Clear all messages in a chat. The chat remains but all messages are removed.

| Parameter    | Type   | Required | Description                         |
| ------------ | ------ | -------- | ----------------------------------- |
| `instanceId` | string | Yes      | The instance ID                     |
| `chatId`     | string | Yes      | Chat JID to clear all messages from |

**Channel support:** Both

**Response:**

```json
{
  "success": true,
  "cleared": true
}
```

---

#### `wa_list_chats`

List locally cached chats. Each entry includes the active Business labels associated with that chat.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `instanceId` | string | Yes | The instance ID |

**Channel support:** Baileys only. Chat listing is not available on the Cloud API adapter.

---

#### `wa_mark_chat_unread`

Mark a chat unread. The adapter passes up to three recent stored raw message keys in Baileys' reverse-chronological `lastMessages` range, with numeric Unix-second timestamps and the same PN/LID address in the patch index as the latest raw key.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID to mark unread |

**Channel support:** Baileys only. Invalid raw message rows are skipped; the write is refused if no valid stored raw key and timestamp are available.

---

#### `wa_star_message`

Star or unstar a message in a chat.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID containing the message |
| `messageId` | string | Yes | Stored message ID |
| `star` | boolean | Yes | `true` to star; `false` to unstar |

**Channel support:** Baileys only. The stored raw message key is required and supplies the PN/LID address and sender fields. The local message record retains the starred state after Baileys confirms the operation.

---

#### `wa_fetch_message_history`

Request older messages from Baileys' on-demand history sync. The oldest stored message in the chat is used as the anchor. The tool waits for `ON_DEMAND` results up to the configured timeout.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID whose older messages should be fetched |
| `count` | number | No | Requested message count (default 50, max 100) |
| `timeoutMs` | number | No | Wait limit from 1000 to 30000 ms (default 10000) |

**Channel support:** Baileys only. Results are deduplicated by instance and message ID. The response includes `requested`, `stored`, and `timedOut`; a timed-out response can report partial results.

---

#### `wa_set_disappearing_messages`

Set a disappearing-message duration in a private chat. Baileys sends the protocol control message
through `sendMessage`; this does not call `chatModify` or write app state. The account/server change
is blocked unless `WA_APP_STATE_WRITES_ENABLED=true`.

| Parameter    | Type                              | Required | Description                                                     |
| ------------ | --------------------------------- | -------- | --------------------------------------------------------------- |
| `instanceId` | string                            | Yes      | The instance ID                                                 |
| `chatId`     | phone number or individual JID    | Yes      | Private contact; group, Channel, and broadcast IDs are rejected |
| `duration`   | `0`, `86400`, `604800`, `7776000` | Yes      | Off, 24 hours, 7 days, or 90 days                               |

**Channel support:** Baileys only. Cloud API does not support this operation.

---

### 2.4 Group Management (28 tools)

Tools for creating and managing WhatsApp groups.

Group creation, settings, membership changes, join-request decisions, picture updates, invite-link
revocations, group joins, and creating a group from another group's members are blocked unless
`WA_GROUP_WRITES_ENABLED=true` or `WA_APP_STATE_WRITES_ENABLED=true`. Group changes use Baileys
group IQ methods. Group listing, metadata, pending-request reads, and invite-code reads remain
available while both flags are disabled. Private disappearing-message changes still require
`WA_APP_STATE_WRITES_ENABLED=true`;
group disappearing-message changes use the group write gate. Sending a group-invitation card uses
the regular message-send path and remains available while both flags are disabled.

Member labels use Baileys protocol messages and require `WA_GROUP_WRITES_ENABLED=true`. WhatsApp
member labels are self-assigned: these tools can only set or remove the connected account's own
label, not another participant's label. Updates are queued and rate limited per instance.

`wa_send_group_history_to_member` sends a readable digest of recent locally stored group messages
to a current member's direct chat. Baileys rc14 cannot use WhatsApp's native recent-history
sharing, so this sends plain text as a workaround. It requires `WA_GROUP_WRITES_ENABLED=true`; the
app-state write flag alone does not enable it. The participant must match a current group
participant by PN or LID. The direct message is addressed to the member's phone JID when group
metadata has one. Unverified phone aliases from join stubs are never used as destinations. Groups with `ephemeralDuration` greater than
0 are refused entirely, so disappearing messages are never copied into a permanent chat. Revoked
messages, view-once messages, individually disappearing messages (even after the group timer is
disabled), and rows without a verifiable raw payload are skipped; the read widens until the requested count of shareable
messages is reached or 1,000 stored rows have been scanned. Each digest line is truncated to 400
characters. At most 5 chunks are queued. Chunks are numbered `(2/4)` when there is more than one.
If the cap is reached, the oldest messages are omitted with a `…mais N` line and the newest are
sent in chronological order. If enqueue fails after at least one
chunk was accepted, the tool still returns that `chunksSent` count. Digest chunks use the
per-instance outbound message limiter.

`chunksSent` counts chunks accepted by Redis, not confirmed WhatsApp deliveries. Before every
chunk the worker rechecks current PN/LID membership, the group timer, and source-message
fingerprints against at most 1,000 stored rows. Revocation, edits, disappearance, unverifiable
raw content, or a source falling outside that window cancel the remaining job. Old persisted
jobs without validation context fail closed. Each chunk has one normal queue attempt because
an ambiguous send failure may already have delivered it; stalled-job recovery can still replay
a job, so exactly-once delivery is not guaranteed.

The automatic stub claim is durable and made after preparation, immediately before queueing.
A crash or enqueue failure after the claim can leave an incomplete digest; redelivery does not
automatically resend it. Review the received chunks before manually requesting another digest.
Outbound workers currently start lazily: after process restart pending jobs resume when another
outbound job starts that instance's worker. This change does not add startup queue recovery.
Live-account delivery remains unverified; all tests use synthetic messages and mocked sockets.


Optional automatic sending is controlled by `WA_GROUP_HISTORY_ON_JOIN` (default `false`, only
`true` or `false`) and `WA_GROUP_HISTORY_ON_JOIN_COUNT` (default `50`, an integer clamped to
25–100). Any other value fails startup. Both still require `WA_GROUP_WRITES_ENABLED=true`.

rc14 does not buffer `group-participants.update` (`Utils/event-buffer.js`). `process-message.js`
emits it immediately, before the buffered `messages.upsert`, so the two events are not in one
batch. Automatic sends are detected from `messages.upsert` only (live `notify` and offline
`append`); `messaging-history.set` is not scanned. The stub must be: `messageStubType`
`GROUP_PARTICIPANT_ADD`, `key.participant` or `key.participantAlt` equal to this account's LID or
PN, and targets in `messageStubParameters`. The stub `key.id` is inserted into `group_history_sends`
before queueing, so a stub redelivered after reconnect is not sent twice.
`GROUP_PARTICIPANT_INVITE` and `GROUP_PARTICIPANT_ADD_REQUEST_JOIN` are ignored, along with stubs
from other authors and targets that are this account. rc14's `group-participants.update` action
`add` has no reason: invite, request-join, and direct-add stubs share that action, and the
notification parser maps an `add` child only to `GROUP_PARTICIPANT_ADD`. An approved join that
WhatsApp delivers as `GROUP_PARTICIPANT_ADD` authored by this account cannot be distinguished from
a direct add and will be sent. Errors are logged without interrupting event processing.

#### `wa_send_group_history_to_member`

Send the latest locally stored group messages as a readable, oldest-first digest in a current
member's direct chat. The sender name uses a stored contact name or message push name, with the JID
number as fallback. Media is represented by Portuguese placeholders such as `[imagem]`, `[áudio]`,
and `[documento: nome]`, followed by any caption. Revoked and view-once messages are omitted. Lines
longer than 400 characters are truncated. The digest is split into at most 5 queued chunks of 4,000
characters, numbered `(1/N)` when split. When messages do not fit, the oldest are left out
(`…mais N`) and the newest are sent in chronological order. If no shareable
local messages are available, nothing is sent and the response includes a note. A group with
disappearing messages enabled is refused before anything is queued.

| Parameter     | Type   | Required | Description |
| ------------- | ------ | -------- | ----------- |
| `instanceId`  | string | Yes      | The instance ID to send from |
| `groupJid`    | string | Yes      | WhatsApp group JID or bare group ID |
| `participant` | string | Yes      | Current member's individual JID (PN or LID) or phone number. Bare phone numbers are normalized to a PN JID. The send is refused when this identity is not a current participant |
| `count`       | number | No       | Requested shareable message count; defaults to 50 and is clamped to 25–100 |

**Channel support:** Baileys only. Requires `WA_GROUP_WRITES_ENABLED=true`.

**Response:** `messagesIncluded`, `chunksSent` (accepted by the outbound queue, including a partial
count when a later enqueue fails), `requestedCount`, `count` (after clamping), `clamped`,
`omittedMessages`, and an optional `note`.

```json
{
  "messagesIncluded": 42,
  "chunksSent": 2,
  "requestedCount": 50,
  "count": 50,
  "clamped": false,
  "omittedMessages": 0
}
```

#### `wa_list_groups`

List the groups the connected account participates in, ordered by subject. Each entry includes the
group JID, subject, description, participant count, and whether this account is an admin or
superadmin. Baileys compares the account's PN and LID identities when determining its role.

| Parameter    | Type   | Required | Description     |
| ------------ | ------ | -------- | --------------- |
| `instanceId` | string | Yes      | The instance ID |

**Channel support:** Baileys only

**Response:**

```json
[
  {
    "jid": "120363000000000000@g.us",
    "subject": "Support group",
    "description": "Customer support",
    "participantCount": 8,
    "isAdmin": true,
    "isSuperAdmin": false
  }
]
```

---

#### `wa_get_group_info`

Get group metadata and its participants. Participant roles are `admin`, `superadmin`, or `member`;
phone numbers are included when available, including when a LID can be resolved to a PN. A
`memberLabel` is included when a label has been observed in a group protocol message and persisted
locally.

| Parameter    | Type   | Required | Description                        |
| ------------ | ------ | -------- | ---------------------------------- |
| `instanceId` | string | Yes      | The instance ID                    |
| `groupId`    | string | Yes      | Group JID or bare numeric group ID |

**Channel support:** Baileys only

**Response:**

```json
{
  "jid": "120363000000000000@g.us",
  "subject": "Support group",
  "description": "Customer support",
  "owner": "5511999990000@s.whatsapp.net",
  "ownerJid": "5511999990000@s.whatsapp.net",
  "creation": 1700000000,
  "createdAt": 1700000000,
  "announce": false,
  "restrict": true,
  "ephemeralDuration": 86400,
  "size": 8,
  "participantCount": 8,
  "participants": [
    {
      "jid": "5511999990000@s.whatsapp.net",
      "phone": "5511999990000",
      "role": "superadmin",
      "isAdmin": true,
      "isSuperAdmin": true,
      "memberLabel": "Group coordinator"
    }
  ]
}
```

---

#### `wa_export_group_participants`

Export the participants of a group as a CSV file. The file is written under the data directory
(`<database directory>/exports`, `data/exports` by default) and the response returns that path.
That directory is mode `0700`. On the next export, regular files in it that are older than 24 hours
are deleted. One row is written per participant. Phone is empty when it is not known. `name` is the
saved contact name when one is stored; `push_name` is the name the contact set on WhatsApp. `role`
is `admin`, `superadmin`, or `member`. `contactsTruncated` is true when the saved-name lookup was
limited to the first 5000 identities.

| Parameter    | Type   | Required | Description                        |
| ------------ | ------ | -------- | ---------------------------------- |
| `instanceId` | string | Yes      | The instance ID                    |
| `groupJid`   | string | Yes      | Group JID or bare numeric group ID |

**Channel support:** Baileys only. Read-only; no write flag is required. Cloud API does not support
group participant export.

**Response:**

```json
{
  "groupJid": "120363000000000000@g.us",
  "participantCount": 3,
  "contactsTruncated": false,
  "mimeType": "text/csv",
  "path": "data/exports/group-120363000000000000_g.us-participants.csv",
  "fileName": "group-120363000000000000_g.us-participants.csv",
  "size": 240
}
```

CSV header: `jid,phone,lid,name,push_name,role`.

---

#### `wa_group_set_member_label`

Set a member label for the connected account in a group. WhatsApp member labels are self-assigned;
Baileys does not provide a target participant argument. The request is queued on the instance's
outbound worker and uses the `WA_BAILEYS_RATE_LIMIT` limit.

| Parameter     | Type   | Required | Description                          |
| ------------- | ------ | -------- | ------------------------------------ |
| `instanceId`  | string | Yes      | The instance ID                      |
| `groupId`     | string | Yes      | Group JID or bare numeric group ID   |
| `memberLabel` | string | Yes      | Label for this account, 1–30 characters |

**Channel support:** Baileys only. Requires `WA_GROUP_WRITES_ENABLED=true`.

**Response:** `{ "status": "queued", "jobId": "..." }`

---

#### `wa_group_remove_member_label`

Remove the connected account's own member label from a group. This cannot remove another
participant's label. The request is queued and rate limited per instance.

| Parameter    | Type   | Required | Description                        |
| ------------ | ------ | -------- | ---------------------------------- |
| `instanceId` | string | Yes      | The instance ID                    |
| `groupId`    | string | Yes      | Group JID or bare numeric group ID |

**Channel support:** Baileys only. Requires `WA_GROUP_WRITES_ENABLED=true`.

**Response:** `{ "status": "queued", "jobId": "..." }`

---

#### `wa_get_group_invite_info`

Read group metadata using an invite code or `chat.whatsapp.com` link before joining.

| Parameter    | Type   | Required | Description                   |
| ------------ | ------ | -------- | ----------------------------- |
| `instanceId` | string | Yes      | The instance ID                |
| `inviteCode` | string | Yes      | Invite code or full invite link |

**Channel support:** Baileys only. Cloud API does not expose group invites.

**Response:** Group metadata from the invite, including the group JID, subject, and available details.

---

#### `wa_group_update_picture`

Set a group's picture. The image may be an HTTPS URL or base64-encoded PNG, JPG, GIF, or WebP; it is
size-limited and converted to a square JPEG before upload. The connected account must be a group
admin.

| Parameter    | Type   | Required | Description                        |
| ------------ | ------ | -------- | ---------------------------------- |
| `instanceId` | string | Yes      | The instance ID                    |
| `groupId`    | string | Yes      | Group JID or bare numeric group ID |
| `image`      | string | Yes      | HTTPS URL or base64-encoded image  |

**Channel support:** Baileys only

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_group_remove_picture`

Remove a group's picture. The connected account must be a group admin.

| Parameter    | Type   | Required | Description                        |
| ------------ | ------ | -------- | ---------------------------------- |
| `instanceId` | string | Yes      | The instance ID                    |
| `groupId`    | string | Yes      | Group JID or bare numeric group ID |

**Channel support:** Baileys only

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_create_group`

Create a new WhatsApp group with a name and initial participants.

| Parameter      | Type     | Required | Description                                           |
| -------------- | -------- | -------- | ----------------------------------------------------- |
| `instanceId`   | string   | Yes      | The instance ID                                       |
| `name`         | string   | Yes      | Group name/subject (max 100 chars)                    |
| `participants` | string[] | Yes      | Phone numbers or JIDs of initial participants (min 1) |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "groupId": "120363...@g.us"
}
```

---

#### `wa_create_group_from_group`

Create a new WhatsApp group using members from a source group. If `includeParticipants` is supplied,
only matching source members are kept; `excludeParticipants` removes matching members afterward.
PN and LID identities are matched consistently, duplicate identities are collapsed, and the connected
account is removed because WhatsApp adds the creator automatically. At least one other participant
must remain. WhatsApp allows up to 1,024 members including the creator, so at most 1,023 source
participants can be passed to group creation ([WhatsApp Help Center](https://faq.whatsapp.com/3242937609289432/?cms_platform=web&locale=pt_PT)).

| Parameter              | Type     | Required | Description                                      |
| ---------------------- | -------- | -------- | ------------------------------------------------ |
| `instanceId`            | string   | Yes      | The instance ID                                  |
| `sourceGroupId`         | string   | Yes      | Source group JID or bare numeric group ID        |
| `name`                  | string   | Yes      | New group name (max 100 characters)              |
| `includeParticipants`   | string[] | No       | Phone numbers or JIDs to keep from the source    |
| `excludeParticipants`   | string[] | No       | Phone numbers or JIDs to omit from the new group |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:** The new group ID, the number of members added, and participant JIDs not present in
Baileys' returned participant metadata when that metadata is available.

```json
{
  "groupId": "120363000000000010@g.us",
  "addedCount": 2,
  "failedParticipants": []
}
```

---

#### `wa_group_add_participants`

Add members to a WhatsApp group.

| Parameter      | Type     | Required | Description                          |
| -------------- | -------- | -------- | ------------------------------------ |
| `instanceId`   | string   | Yes      | The instance ID                      |
| `groupId`      | string   | Yes      | Group JID                            |
| `participants` | string[] | Yes      | Phone numbers or JIDs to add (min 1) |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_group_remove_participants`

Remove members from a WhatsApp group.

| Parameter      | Type     | Required | Description                             |
| -------------- | -------- | -------- | --------------------------------------- |
| `instanceId`   | string   | Yes      | The instance ID                         |
| `groupId`      | string   | Yes      | Group JID                               |
| `participants` | string[] | Yes      | Phone numbers or JIDs to remove (min 1) |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_group_promote`

Promote members to group admin.

| Parameter      | Type     | Required | Description                                       |
| -------------- | -------- | -------- | ------------------------------------------------- |
| `instanceId`   | string   | Yes      | The instance ID                                   |
| `groupId`      | string   | Yes      | Group JID                                         |
| `participants` | string[] | Yes      | Phone numbers or JIDs to promote to admin (min 1) |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_group_demote`

Demote group admins to regular members.

| Parameter      | Type     | Required | Description                                        |
| -------------- | -------- | -------- | -------------------------------------------------- |
| `instanceId`   | string   | Yes      | The instance ID                                    |
| `groupId`      | string   | Yes      | Group JID                                          |
| `participants` | string[] | Yes      | Phone numbers or JIDs to demote from admin (min 1) |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_group_update_subject`

Change the name/subject of a WhatsApp group.

| Parameter    | Type   | Required | Description                            |
| ------------ | ------ | -------- | -------------------------------------- |
| `instanceId` | string | Yes      | The instance ID                        |
| `groupId`    | string | Yes      | Group JID                              |
| `subject`    | string | Yes      | New group name/subject (max 100 chars) |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_group_update_description`

Change the description of a WhatsApp group.

| Parameter     | Type   | Required | Description                                                   |
| ------------- | ------ | -------- | ------------------------------------------------------------- |
| `instanceId`  | string | Yes      | The instance ID                                               |
| `groupId`     | string | Yes      | Group JID                                                     |
| `description` | string | Yes      | New group description (max 2048 chars, empty string to clear) |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_group_update_settings`

Change group settings.

| Parameter    | Type    | Required | Description                     |
| ------------ | ------- | -------- | ------------------------------- |
| `instanceId` | string  | Yes      | The instance ID                 |
| `groupId`    | string  | Yes      | Group JID                       |
| `announce`   | boolean | No       | Only admins can send messages   |
| `locked`     | boolean | No       | Only admins can edit group info |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_group_leave`

Leave a WhatsApp group.

| Parameter    | Type   | Required | Description        |
| ------------ | ------ | -------- | ------------------ |
| `instanceId` | string | Yes      | The instance ID    |
| `groupId`    | string | Yes      | Group JID to leave |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_group_get_invite_code`

Get the shareable invite link for a WhatsApp group.

| Parameter    | Type   | Required | Description     |
| ------------ | ------ | -------- | --------------- |
| `instanceId` | string | Yes      | The instance ID |
| `groupId`    | string | Yes      | Group JID       |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "groupId": "120363...@g.us",
  "inviteCode": "AbCdEfGh",
  "link": "https://chat.whatsapp.com/AbCdEfGh"
}
```

---

#### `wa_group_revoke_invite`

Revoke the current invite link for a WhatsApp group, generating a new one.

| Parameter    | Type   | Required | Description     |
| ------------ | ------ | -------- | --------------- |
| `instanceId` | string | Yes      | The instance ID |
| `groupId`    | string | Yes      | Group JID       |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_send_group_invite_message`

Send a WhatsApp group invitation card to an individual or group chat.
This uses the regular outgoing message path and does not modify group membership or invite-link
state.

| Parameter    | Type   | Required | Description                                |
| ------------ | ------ | -------- | ------------------------------------------ |
| `instanceId` | string | Yes      | The instance to send from                   |
| `to`         | string | Yes      | Phone number or group JID receiving it      |
| `groupId`    | string | Yes      | Group JID or bare numeric group ID          |
| `text`       | string | No       | Optional accompanying text (max 1024 chars) |

**Channel support:** Baileys only. Cloud API does not support group invitation cards.

**Response:** `{ "messageId": "...", "timestamp": 1709136000, "status": "sent" }`

---

#### `wa_group_join`

Join a WhatsApp group using an invite code or link.

| Parameter    | Type   | Required | Description                    |
| ------------ | ------ | -------- | ------------------------------ |
| `instanceId` | string | Yes      | The instance ID                |
| `inviteCode` | string | Yes      | Group invite code or full link |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "groupId": "120363...@g.us"
}
```

---

#### `wa_group_toggle_ephemeral`

Enable or disable disappearing messages in a group.

| Parameter    | Type         | Required | Description                                                                                      |
| ------------ | ------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `instanceId` | string       | Yes      | The instance ID                                                                                  |
| `groupId`    | string       | Yes      | Group JID                                                                                        |
| `duration`   | number (int) | Yes      | Duration in seconds (0 to disable). Common values: `86400` (24h), `604800` (7d), `7776000` (90d) |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "success": true,
  "ephemeralDuration": 604800
}
```

---

#### `wa_group_handle_request`

Approve or reject a pending join request for a WhatsApp group.

| Parameter       | Type                      | Required | Description                  |
| --------------- | ------------------------- | -------- | ---------------------------- |
| `instanceId`    | string                    | Yes      | The instance ID              |
| `groupId`       | string                    | Yes      | Group JID                    |
| `participantId` | string                    | Yes      | JID of the requester         |
| `action`        | `"approve"` \| `"reject"` | Yes      | Whether to approve or reject |

**Channel support:** Baileys only. Cloud API does not support group management.

**Response:**

```json
{
  "success": true,
  "action": "approve"
}
```

---

#### `wa_group_list_join_requests`

List pending requests to join a group, including the requester JID and Baileys request attributes.

| Parameter    | Type   | Required | Description                  |
| ------------ | ------ | -------- | ---------------------------- |
| `instanceId` | string | Yes      | The instance ID               |
| `groupId`    | string | Yes      | Group JID or bare numeric ID  |

**Channel support:** Baileys only. Cloud API does not expose group join requests.

**Response:** `{ "groupId": "120363...@g.us", "count": 1, "requests": [{ "jid": "...", "attributes": { "t": "..." } }] }`

---

#### `wa_group_join_approval_mode`

Enable or disable admin approval for group join requests. This group IQ change is blocked unless
`WA_GROUP_WRITES_ENABLED=true` or `WA_APP_STATE_WRITES_ENABLED=true`.

| Parameter    | Type          | Required | Description                 |
| ------------ | ------------- | -------- | --------------------------- |
| `instanceId` | string        | Yes      | The instance ID             |
| `groupId`    | string        | Yes      | Group JID or bare group ID  |
| `mode`       | `on` or `off` | Yes      | Whether join approval is on |

**Channel support:** Baileys only.

---

#### `wa_group_member_add_mode`

Set who can add members to a group. This group IQ change is blocked unless
`WA_GROUP_WRITES_ENABLED=true` or `WA_APP_STATE_WRITES_ENABLED=true`.

| Parameter    | Type                            | Required | Description                |
| ------------ | ------------------------------- | -------- | -------------------------- |
| `instanceId` | string                          | Yes      | The instance ID            |
| `groupId`    | string                          | Yes      | Group JID or bare group ID |
| `mode`       | `admin_add` or `all_member_add` | Yes      | Who may add members        |

**Channel support:** Baileys only.

---

### 2.5 Contact Management (8 tools)

Tools for refreshing and searching contacts, checking phone numbers, blocking/unblocking contacts, and fetching business profiles.

#### `wa_resync_contacts`

Refresh contacts for an already linked Baileys session without pairing again. The tool resyncs each
Baileys app-state collection separately, then supplements the contact cache from locally stored
individual chats and messages. Collection failures are reported individually while the remaining
collections and local recovery continue. Recovered contacts persist in SQLite across server restarts.

Use this on a connected Baileys instance. Call `wa_connect_instance` first to reconnect an existing
stored session, or invoke this tool directly if that session is already connected. The Cloud API
channel returns an unsupported-operation error.

| Parameter    | Type   | Required | Description              |
| ------------ | ------ | -------- | ------------------------ |
| `instanceId` | string | Yes      | The existing instance ID |

**Channel support:** Baileys only

**Response:**

```json
{
  "contactsBefore": 25,
  "contactsAfter": 41,
  "added": 16,
  "sources": {
    "appState": {
      "collections": [
        {
          "collection": "critical_block",
          "success": true,
          "contactsAdded": 0
        },
        {
          "collection": "critical_unblock_low",
          "success": true,
          "contactsAdded": 0
        },
        {
          "collection": "regular_high",
          "success": true,
          "contactsAdded": 2
        },
        {
          "collection": "regular_low",
          "success": true,
          "contactsAdded": 0
        },
        {
          "collection": "regular",
          "success": true,
          "contactsAdded": 0
        }
      ]
    },
    "localStore": {
      "chats": { "candidates": 8, "contactsAdded": 3 },
      "messages": { "candidates": 12, "contactsAdded": 11 }
    }
  }
}
```

Each collection result has a `success` flag; failed collections also include an `error` message.

#### `wa_search_contact`

Search contacts by name or phone number. Supports multi-word fuzzy matching across name, notify name, phone, and LID fields.

| Parameter    | Type   | Required | Description                                       |
| ------------ | ------ | -------- | ------------------------------------------------- |
| `instanceId` | string | Yes      | The instance ID                                   |
| `query`      | string | Yes      | Search term (e.g. "John", "5511999", "John boss") |

**Response:**

```json
{
  "query": "John boss",
  "count": 1,
  "contacts": [
    {
      "jid": "5511999999999@s.whatsapp.net",
      "name": "John (boss)",
      "notifyName": "John",
      "phone": "5511999999999",
      "profilePicUrl": null,
      "isBusiness": false,
      "isBlocked": false
    }
  ]
}
```

#### `wa_check_number_exists`

Check if a phone number is registered on WhatsApp.

| Parameter     | Type   | Required | Description                                    |
| ------------- | ------ | -------- | ---------------------------------------------- |
| `instanceId`  | string | Yes      | The instance ID                                |
| `phoneNumber` | string | Yes      | Phone number to check (e.g. `"5511999999999"`) |

**Channel support:** Both

**Response:**

```json
{
  "exists": true,
  "jid": "5511999999999@s.whatsapp.net"
}
```

---

#### `wa_block_contact`

Block a WhatsApp contact. Blocked contacts cannot send you messages.

| Parameter    | Type   | Required | Description          |
| ------------ | ------ | -------- | -------------------- |
| `instanceId` | string | Yes      | The instance ID      |
| `jid`        | string | Yes      | Contact JID to block |

**Channel support:** Both

**Response:**

```json
{
  "success": true,
  "blocked": true
}
```

---

#### `wa_unblock_contact`

Unblock a previously blocked WhatsApp contact.

| Parameter    | Type   | Required | Description            |
| ------------ | ------ | -------- | ---------------------- |
| `instanceId` | string | Yes      | The instance ID        |
| `jid`        | string | Yes      | Contact JID to unblock |

**Channel support:** Both

**Response:**

```json
{
  "success": true,
  "blocked": false
}
```

---

#### `wa_get_business_profile`

Fetch the business profile information for a WhatsApp Business contact.

| Parameter    | Type   | Required | Description                               |
| ------------ | ------ | -------- | ----------------------------------------- |
| `instanceId` | string | Yes      | The instance ID                           |
| `jid`        | string | Yes      | Contact JID to fetch business profile for |

**Channel support:** Both

**Response:**

```json
{
  "name": "Acme Corp",
  "description": "We make everything",
  "category": "Technology",
  "website": "https://acme.com",
  "email": "contact@acme.com",
  "address": "123 Main St"
}
```

---

#### `wa_list_blocked_contacts`

List blocked contact JIDs with Baileys `fetchBlocklist`, an IQ read.

| Parameter    | Type   | Required | Description     |
| ------------ | ------ | -------- | --------------- |
| `instanceId` | string | Yes      | The instance ID |

**Channel support:** Baileys only. Cloud API does not expose the account blocklist.

---

#### `wa_get_contact_about`

Read a contact's About text with Baileys `fetchStatus`, a USync read.

| Parameter    | Type   | Required | Description                        |
| ------------ | ------ | -------- | ---------------------------------- |
| `instanceId` | string | Yes      | The instance ID                    |
| `jid`        | string | Yes      | Contact phone number or individual JID |

**Channel support:** Baileys only. Cloud API does not support this lookup.

---

### 2.6 Profile Management (7 tools)

Tools for managing the instance's own WhatsApp profile.

#### `wa_get_profile_picture`

Read the current profile-picture URL for a contact or group. This is a Baileys query and is not
available on Cloud API.

| Parameter    | Type   | Required | Description                          |
| ------------ | ------ | -------- | ------------------------------------ |
| `instanceId` | string | Yes      | The instance ID                       |
| `jid`        | string | Yes      | Contact phone number/JID or group JID |

**Channel support:** Baileys only.

**Response:** `{ "jid": "5511999999999@s.whatsapp.net", "url": "https://..." }`

---

#### `wa_update_profile_picture`

Change the profile picture for a WhatsApp instance.

| Parameter    | Type   | Required | Description                                   |
| ------------ | ------ | -------- | --------------------------------------------- |
| `instanceId` | string | Yes      | The instance ID                               |
| `image`      | string | Yes      | Profile picture as base64-encoded data or URL |

**Channel support:** Both

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_remove_profile_picture`

Remove the profile picture for a WhatsApp instance.

| Parameter    | Type   | Required | Description     |
| ------------ | ------ | -------- | --------------- |
| `instanceId` | string | Yes      | The instance ID |

**Channel support:** Both

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_update_profile_name`

Change the display name for a WhatsApp instance.

| Parameter    | Type   | Required | Description                          |
| ------------ | ------ | -------- | ------------------------------------ |
| `instanceId` | string | Yes      | The instance ID                      |
| `name`       | string | Yes      | New display name (max 25 characters) |

**Channel support:** Both

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_update_profile_status`

Change the text status/bio for a WhatsApp instance.

| Parameter    | Type   | Required | Description                              |
| ------------ | ------ | -------- | ---------------------------------------- |
| `instanceId` | string | Yes      | The instance ID                          |
| `status`     | string | Yes      | New text status/bio (max 139 characters) |

**Channel support:** Both

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_update_privacy`

Update one Baileys account privacy setting. `setting` determines the accepted `value` enum. Updating
`defaultDisappearingMode` is blocked unless `WA_APP_STATE_WRITES_ENABLED=true`; other privacy
settings remain available with writes disabled. The Cloud API channel does not support privacy
settings.

| Parameter    | Type                                                                                           | Required | Description               |
| ------------ | ---------------------------------------------------------------------------------------------- | -------- | ------------------------- |
| `instanceId` | string                                                                                         | Yes      | The instance ID           |
| `setting`    | `"lastSeen"` \| `"online"` \| `"profilePic"` \| `"status"` \| `"readReceipts"` \| `"groupAdd"` \| `"calls"` \| `"defaultDisappearingMode"` | Yes | Privacy setting to update; `status` is About/profile text visibility |
| `value`      | Setting-specific enum listed below                                                           | Yes      | New value or duration in seconds |

Accepted `value` options:

| `setting` | `value` |
| --- | --- |
| `lastSeen`, `profilePic` | `"all"`, `"contacts"`, `"contact_blacklist"`, `"none"` |
| `status` (About/profile text visibility) | `"all"`, `"contacts"`, `"contact_blacklist"`, `"none"` |
| `online` | `"all"`, `"match_last_seen"` |
| `readReceipts` | `"all"`, `"none"` |
| `groupAdd` | `"all"`, `"contacts"`, `"contact_blacklist"` |
| `calls` | `"all"`, `"known"` |
| `defaultDisappearingMode` | `0`, `86400`, `604800`, `7776000` (remove, 24 hours, 7 days, 90 days) |

Baileys' `status` privacy category and `updateStatusPrivacy` control About/profile text visibility. Story audiences are configured separately through the status tools' `statusJidList`.

**Channel support:** Baileys only

**Response:**

```json
{
  "success": true,
  "setting": "lastSeen",
  "value": "contacts"
}
```

---

#### `wa_get_privacy_settings`

Read normalized account privacy settings. Reads refresh from WhatsApp by default; `forceRefresh=false` uses cached settings. The `status` field is About/profile text visibility. Baileys does not include the default disappearing duration in `fetchPrivacySettings`, so it cannot be read through this tool.

| Parameter      | Type    | Required | Description |
| -------------- | ------- | -------- | ----------- |
| `instanceId`   | string  | Yes      | The instance ID |
| `forceRefresh` | boolean | No       | Refresh settings from WhatsApp; defaults to `true` |

**Channel support:** Baileys only

**Response:**

```json
{
  "lastSeen": "contacts",
  "online": "all",
  "profilePic": "contacts",
  "status": "contacts",
  "readReceipts": "all",
  "groupAdd": "contacts",
  "calls": "all"
}
```

---

### 2.7 Status / Stories (4 tools)

Tools for posting WhatsApp status/story updates.

By default, Baileys sends a status to the account's own normalized JID and known individual
contacts. Each tool accepts `statusJidList` to restrict the audience; the account's own JID is
always added. Individual LID JIDs are supported by the installed Baileys version. Groups,
broadcasts, newsletters, and `status@broadcast` are not audience recipients. The configurable
`WA_STATUS_MAX_RECIPIENTS` limit defaults to `256`; larger audiences are truncated and the
response reports the omitted count. These tools are unsupported by the Cloud API.

#### `wa_send_text_status`

Post a text status/story update visible to contacts.

| Parameter         | Type         | Required | Description                                  |
| ----------------- | ------------ | -------- | -------------------------------------------- |
| `instanceId`      | string       | Yes      | The instance ID                              |
| `text`            | string       | Yes      | Status text content                          |
| `statusJidList`   | string[]     | No       | Optional individual phone numbers or JIDs; the account's own JID is always included |
| `backgroundColor` | string       | No       | RGB or ARGB hex color (e.g. `"#FF5733"` or `"#FFFF5733"`) |
| `font`            | number (int) | No       | Font style (0-5)                             |

**Channel support:** Baileys only

**Response:**

```json
{
  "success": true,
  "messageId": "BAE5...",
  "recipientCount": 4
}
```

Use the returned `messageId` with `wa_get_status_viewers` to list viewers whose read or played
receipts this server observes.

If the audience exceeds the configured cap, the response also includes `omittedRecipientCount`
and a `warning` describing the truncation.

---

#### `wa_send_image_status`

Post an image status/story update visible to contacts.

| Parameter    | Type   | Required | Description                      |
| ------------ | ------ | -------- | -------------------------------- |
| `instanceId` | string | Yes      | The instance ID                  |
| `image`      | string | Yes      | Image URL or base64-encoded data |
| `statusJidList` | string[] | No   | Optional individual phone numbers or JIDs; the account's own JID is always included |
| `caption`    | string | No       | Image caption                    |

**Channel support:** Baileys only

**Response:**

```json
{
  "success": true,
  "messageId": "BAE5...",
  "recipientCount": 4
}
```

---

#### `wa_send_video_status`

Post a video status/story update visible to contacts.

| Parameter    | Type   | Required | Description                      |
| ------------ | ------ | -------- | -------------------------------- |
| `instanceId` | string | Yes      | The instance ID                  |
| `video`      | string | Yes      | Video URL or base64-encoded data |
| `statusJidList` | string[] | No   | Optional individual phone numbers or JIDs; the account's own JID is always included |
| `caption`    | string | No       | Video caption                    |

**Channel support:** Baileys only

**Response:**

```json
{
  "success": true,
  "messageId": "BAE5...",
  "recipientCount": 4
}
```

---

#### `wa_get_status_viewers`

List contacts whose read or played receipt this server observed for a status/story.

| Parameter    | Type   | Required | Description |
| ------------ | ------ | -------- | ----------- |
| `instanceId` | string | Yes      | The instance ID |
| `messageId`  | string | Yes      | Message ID returned when the status was sent |

**Channel support:** Baileys only. Viewers are available only after this server observes their
receipt; Cloud API does not expose status viewers.

---

### 2.8 Newsletter / Channels (11 tools)

Tools for interacting with WhatsApp Channels (Newsletters). **Baileys only.**

#### `wa_newsletter_follow`

Follow a WhatsApp Channel/Newsletter. This MEX server call is blocked unless
`WA_GROUP_WRITES_ENABLED=true` or `WA_APP_STATE_WRITES_ENABLED=true`.

| Parameter    | Type   | Required | Description                      |
| ------------ | ------ | -------- | -------------------------------- |
| `instanceId` | string | Yes      | The instance ID                  |
| `jid`        | string | Yes      | Newsletter/Channel JID to follow |

**Channel support:** Baileys only

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_newsletter_unfollow`

Unfollow a WhatsApp Channel/Newsletter. This MEX server call is blocked unless
`WA_GROUP_WRITES_ENABLED=true` or `WA_APP_STATE_WRITES_ENABLED=true`.

| Parameter    | Type   | Required | Description                        |
| ------------ | ------ | -------- | ---------------------------------- |
| `instanceId` | string | Yes      | The instance ID                    |
| `jid`        | string | Yes      | Newsletter/Channel JID to unfollow |

**Channel support:** Baileys only

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_newsletter_send`

Send a message to a WhatsApp Channel/Newsletter (must be admin).

| Parameter    | Type   | Required | Description                            |
| ------------ | ------ | -------- | -------------------------------------- |
| `instanceId` | string | Yes      | The instance ID                        |
| `jid`        | string | Yes      | Newsletter/Channel JID (must be admin) |
| `text`       | string | Yes      | Message text content                   |

**Channel support:** Baileys only

**Response:**

```json
{
  "messageId": "msg_nl_123",
  "timestamp": 1709136000
}
```

Channel create/update and post-reaction operations use MEX calls or message queries; community
operations use IQs. They are blocked unless `WA_GROUP_WRITES_ENABLED=true` or
`WA_APP_STATE_WRITES_ENABLED=true`. Catalog writes remain behind `WA_APP_STATE_WRITES_ENABLED`;
read-only metadata and post-fetch calls remain available. Cloud API returns a clear
unsupported-operation error for these Baileys-only operations.

| Tool                               | Inputs                                             | Description                                      |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| `wa_create_newsletter`             | `instanceId`, `name`, optional `description`       | Create a Channel. Gated account/server write.    |
| `wa_get_newsletter_metadata`       | `instanceId`, `type`, `key`                        | Read metadata by JID or invite code.             |
| `wa_newsletter_update_name`        | `instanceId`, `jid`, `name`                        | Update the Channel name. Gated write.            |
| `wa_newsletter_update_description` | `instanceId`, `jid`, `description`                 | Update the Channel description. Gated write.     |
| `wa_newsletter_update_picture`     | `instanceId`, `jid`, `image`                       | Update picture. Gated write.                     |
| `wa_newsletter_react`              | `instanceId`, `jid`, `serverId`, `reaction`        | Add or remove a post reaction. Gated write.       |
| `wa_newsletter_list_posts`         | `instanceId`, `jid`, optional `count`, `since`, `after` | Fetch parsed posts with timestamp and server-ID cursors. |
| `wa_download_newsletter_media`     | `instanceId`, `newsletterJid`, `messageId`         | Download media from a Channel post and return the saved path. |

Channel picture URLs use the existing public-HTTPS validation and media size limits, then are
converted to JPEG before upload.

Post results contain JSON-safe `posts` with `id`, `serverId`, Unix-seconds `timestamp`, message
`type`, extracted `text` or caption, `views`, and reaction counts. `pagination.oldestServerId` and
`pagination.newestServerId` identify the page bounds. `pagination.after` is the newest numeric server
ID; pass it as `after` on the next call to continue through newer posts. `since` accepts a Unix
timestamp lower bound.

#### `wa_download_newsletter_media`

Download image, video, audio, document, sticker, or video-note media from one Channel post. Pass
`serverId` or the post `id` from `wa_newsletter_list_posts` as `messageId`. The bytes are saved with
the same directory, size cap, and file-name rules as `wa_download_media`, and the response returns
that path. Posts that include a media key are decrypted. Posts uploaded without a media key are
downloaded as plaintext from `https://mmg.whatsapp.net` plus the post `directPath`, with the same
size cap and timeout, with redirects refused, and are kept only when the SHA-256 matches
`fileSha256`. URL-only posts are accepted only on that same HTTPS origin. Encrypted downloads
also stay on that origin and refuse redirects. A numeric server ID is looked up with the rc14
`message_updates` stanza and exclusive `after = serverId - 1` cursor (`since = 0`); IDs retain
integer precision. A missing numeric result or a non-numeric ID searches one additional page of
at most 100 posts. History outside that bounded lookup can be unavailable; use `serverId` when
possible. Media download timeout is 60 seconds; configured file-download size limits apply.

| Parameter       | Type   | Required | Description                                      |
| --------------- | ------ | -------- | ------------------------------------------------ |
| `instanceId`    | string | Yes      | The instance ID                                  |
| `newsletterJid` | string | Yes      | Channel JID ending in `@newsletter`              |
| `messageId`     | string | Yes      | Post server ID or message ID                     |

**Channel support:** Baileys only. Read-only; no write flag is required. Cloud API does not support
Channel post media.

**Response:**

```json
{
  "newsletterJid": "123456789012345@newsletter",
  "messageId": "102",
  "mediaType": "image",
  "mimeType": "image/jpeg",
  "mode": "file",
  "path": "data/media-downloads/102.jpg",
  "fileName": "102.jpg",
  "size": 2048
}
```

---

### 2.9 Call Management (1 tool)

#### `wa_reject_call`

Reject an incoming direct voice or video call. The call ID and caller JID are included in the
`whatsapp/call.received` notification. `WA_AUTO_REJECT_CALLS=true` automatically rejects direct
call offers; the default is `false`.

| Parameter    | Type   | Required | Description |
| ------------ | ------ | -------- | ----------- |
| `instanceId` | string | Yes      | The instance ID |
| `callId`     | string | Yes      | The call ID from the notification |
| `callFrom`   | string | No       | Caller JID from the notification; cached offer data is used when omitted |

**Channel support:** Baileys only

**Response:**

```json
{
  "success": true,
  "callId": "call_abc123"
}
```

---

### 2.10 Message Search (1 tool)

#### `wa_search_messages`

Search the local message database for a case-insensitive text substring. Results are ordered by timestamp descending and message ID descending for stable pagination. `%`, `_`, and `\\` in the query are treated as literal characters.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `instanceId` | string | Yes | The instance ID to search |
| `query` | string | Yes | Text substring, 1–500 characters |
| `from` | ISO datetime | No | Inclusive lower timestamp bound |
| `to` | ISO datetime | No | Inclusive upper timestamp bound |
| `sender` | string | No | Exact stored sender ID |
| `chatId` | string | No | Restrict to one chat; omit to search all chats |
| `limit` | number | No | Page size (default 20, max 100) |
| `offset` | number | No | Result offset (default 0) |

**Channel support:** Both. This searches messages already stored locally; it does not request remote Cloud API history.

**Response:** `{ count, limit, offset, hasMore, nextOffset, messages }`.

---

### 2.11 WhatsApp Business Labels (8 tools)

Baileys label tools require a connected WhatsApp Business account. Label changes and associations are stored locally when Baileys emits `labels.edit` and `labels.association`; chat listing and message reads include active assigned labels. Cloud API label operations return an explicit unsupported-operation error.

| Tool | Input | Description |
| ---- | ----- | ----------- |
| `wa_list_labels` | `instanceId`, optional `includeDeleted` | List labels received from Baileys and stored locally |
| `wa_create_label` | `instanceId`, `name`, `color` | Create a label (color ID 0–19); the server generates an ID |
| `wa_edit_label` | `instanceId`, `labelId`, optional `name` and/or `color` | Rename or recolor a label |
| `wa_delete_label` | `instanceId`, `labelId` | Soft-delete using Baileys' `deleted` label flag |
| `wa_add_chat_label` | `instanceId`, `chatId`, `labelId` | Apply a label to a chat |
| `wa_remove_chat_label` | `instanceId`, `chatId`, `labelId` | Remove a label from a chat |
| `wa_add_message_label` | `instanceId`, `chatId`, `messageId`, `labelId` | Apply a label to a message |
| `wa_remove_message_label` | `instanceId`, `chatId`, `messageId`, `labelId` | Remove a label from a message |

**Channel support:** Baileys WhatsApp Business accounts only.

---

### 2.12 WhatsApp Events (2 tools)

#### `wa_send_event`

Send a native Baileys event message. A location text or a voice/video call link can be added; an existing message can be quoted.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `instanceId` | string | Yes | The instance ID |
| `to` | string | Yes | Recipient phone number or chat JID |
| `name` | string | Yes | Event name |
| `description` | string | No | Event description |
| `start` | ISO datetime | Yes | Start datetime with timezone |
| `end` | ISO datetime | No | Optional end datetime, later than start |
| `locationText` | string | No | Location label; mutually exclusive with `callType` |
| `callType` | `voice` or `video` | No | Ask Baileys to generate an audio/video call link |
| `quotedMessageId` | string | No | Stored message to quote in the event message |

**Channel support:** Baileys only. Cloud API does not support native event messages.

---

#### `wa_get_event_responses`

Read event responses persisted from Baileys. Encrypted responses are decrypted with the
`messageSecret` on the original event message. Responses received before that message is
available are retained and retried when the event arrives.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID containing the event |
| `eventMessageId` | string | Yes | Event message ID |

**Channel support:** Baileys only.

The result includes `count`, per-status `counts`, and `responses`. Each response contains
`participant` (the responder JID), `status` (`GOING`, `NOT_GOING`, `MAYBE`, or `UNKNOWN`),
`timestamp` in Unix milliseconds or `null`, `messageId`, and `extraGuestCount` when supplied.
`phone` is included when a phone number can be resolved. `UNKNOWN` means the stored data did not
produce a recognized RSVP status. UNKNOWN responses also include `unknownReason` and `recoverable`:

- `missing_payload`: no response payload was stored; `recoverable` is `false`.
- `missing_event_secret`: the event message or its `messageSecret` was not stored, so the encrypted
  response cannot be decrypted; `recoverable` is `false`.
- `decrypt_failed`: the response payload and event secret are present, but decryption failed;
  `recoverable` is `true` when not all candidate combinations could be tried (for example, when no
  candidates were available), and `attemptedCombinations` reports how many normalized creator and
  responder JID combinations were tried during the latest decryption attempt.
- `decrypt_failed_all_candidates`: every available normalized creator and responder JID combination
  was tried, but decryption failed; `recoverable` is `false`. This usually means the event's stored
  `messageSecret` on this device does not match the response, commonly because the event predates
  re-pairing. The participant must answer the event again.
- `unrecognized_response`: the stored response could not be mapped to a supported RSVP status;
  `recoverable` is `true`.

Responses whose payload was never stored cannot be recovered from local data. The responder can
answer the event again to create a new response.

```json
{
  "chatId": "5511888888888@g.us",
  "eventMessageId": "event_123",
  "count": 1,
  "counts": { "GOING": 1, "NOT_GOING": 0, "MAYBE": 0, "UNKNOWN": 0 },
  "responses": [
    {
      "participant": "5511777777777@s.whatsapp.net",
      "responder": "5511777777777@s.whatsapp.net",
      "phone": "5511777777777",
      "status": "GOING",
      "response": "GOING",
      "timestamp": 1800000123000,
      "messageId": "response_123",
      "extraGuestCount": 1
    }
  ]
}
```

---

### 2.13 Business, Communities, and Catalog (16 tools)

These operations require Baileys. Cloud API calls return unsupported-operation errors. Community
changes use the group write gate (`WA_GROUP_WRITES_ENABLED=true` or
`WA_APP_STATE_WRITES_ENABLED=true`). Catalog product writes require
`WA_APP_STATE_WRITES_ENABLED=true`; read-only listing and order tools remain available.

| Tool                         | Inputs                                                                                                       | Description                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `wa_create_quick_reply`      | `instanceId`, `shortcut`, `message`                                                                          | Create a quick reply. Gated app-state write.          |
| `wa_edit_quick_reply`        | `instanceId`, `timestamp`, `shortcut`, `message`                                                             | Edit by sync timestamp. Gated app-state write.        |
| `wa_delete_quick_reply`      | `instanceId`, `timestamp`                                                                                    | Delete by sync timestamp. Gated app-state write.      |
| `wa_create_community`        | `instanceId`, `name`, optional `description`                                                                 | Create a community. Gated account/server write.       |
| `wa_list_communities`        | `instanceId`                                                                                                | List participating communities.                       |
| `wa_get_community_details`   | `instanceId`, `communityId`                                                                                 | Read community metadata.                              |
| `wa_get_community_hierarchy` | `instanceId`, `communityId` | Read parent metadata, linked groups, and the identifiable Avisos destination. Read-only. |
| `wa_community_link_group`    | `instanceId`, `communityId`, `groupId`                                                                       | Link an existing group. Gated write.                 |
| `wa_community_unlink_group`  | `instanceId`, `communityId`, `groupId`                                                                       | Unlink a group. Gated write.                          |
| `wa_leave_community`         | `instanceId`, `communityId`                                                                                 | Leave a community. Gated write.                       |
| `wa_get_catalog`             | `instanceId`, optional `jid`, `limit`, `cursor`                                                              | List products with cursor pagination.                 |
| `wa_get_catalog_collections` | `instanceId`, optional `jid`, `limit`                                                                        | List catalog collections.                             |
| `wa_create_catalog_product`  | `instanceId`, product fields and `images`; optional `originCountryCode`                                     | Create a product. Gated account/server write.        |
| `wa_update_catalog_product`  | `instanceId`, `productId`, product fields and `images`                                                       | Replace fields/images. Gated write.                  |
| `wa_delete_catalog_products` | `instanceId`, `productIds`                                                                                  | Delete products. Gated account/server write.        |
| `wa_get_order_details`       | `instanceId`, `orderId`, `tokenBase64`                                                                       | Read details using the token from the order message. |

#### Community hierarchy

`wa_get_community_hierarchy` accepts a community parent ID (bare numeric ID or `@g.us` JID).
It rejects ordinary groups, subgroups, and parents without an explicit community marker.
It requires a connected Baileys account but does not require either write flag.

Response fields:

| Field | Meaning |
| --- | --- |
| `community` | Existing group metadata shape plus `isCommunity`, `isCommunityAnnounce`, `linkedParent`, `joinApprovalMode`, and `memberAddMode`. Missing backend fields are `null`. |
| `groups` | Deduplicated server-visible linked groups with `jid`, `subject`, `size`, `creation`, `owner`, and nullable `isCommunityAnnounce`. Unavailable counts and timestamps are `null`, not zero. |
| `announcementGroupJid` | A unique positively identified Avisos JID, or `null`. Never inferred from `announce`, a group name, or list order. |
| `announcementResolution` | `identified`, `unavailable`, or `ambiguous` (multiple positive matches). |
| `visibility` | Always `server_visible`; this is not a complete membership or visibility guarantee. |
| `unresolvedGroupJids` | Groups whose announcement classification is unknown. This does not prove whether the account is a member. |
| `omittedGroupCount` | Entries with missing/invalid IDs or incorrectly referencing the parent itself. |

The linked-groups query supplies summaries, including groups outside the participating list when
visible. One bulk participating-groups query provides explicit announcement markers; there is no
metadata request for each subgroup. Missing or conflicting parent metadata leaves classification
unknown. A failed query returns an error, not an empty successful list. The upstream helper also
performs its own parent metadata lookup. Reads are separate requests, not an atomic snapshot.

The five additional metadata fields also appear in existing community detail/list and group detail
responses. Existing fields retain their meanings. Business tool schemas retain strict validation
through MCP registration, rejecting extra properties rather than silently stripping them.

See [Community management](COMMUNITIES.md) for the implementation and validation roadmap.

Quick reply create/edit/delete call Baileys `addOrEditQuickReply` or `removeQuickReply`, which use
`chatModify` → `appPatch` and the app-state preflight described above. They are blocked unless
`WA_APP_STATE_WRITES_ENABLED=true`. Baileys rc14 has no quick-reply read method, and the server does
not store quick reply sync actions locally, so there is no list tool. Use the WhatsApp Business app
to find an existing reply's timestamp before editing or deleting it.

Catalog image URLs are fetched only from public HTTPS hosts; the media helper enforces input-size
limits before upload.

---

### 2.14 Community administration (16 tools)

All tools below require `instanceId` and Baileys. Administrative writes require the group-write gate
and a verified community admin. Joining/leaving do not require prior admin status; Avisos sending
requires an admin of the actual Avisos group. Read-only operations do not enable writes.

| Tool | Additional inputs | Behavior |
| --- | --- | --- |
| `wa_community_create_group` | `communityId, name, participants?` | Create directly linked group; preserve unknown outcome. |
| `wa_community_update_name` | `communityId, name` | Rename community. |
| `wa_community_update_description` | `communityId, description` | Update/clear description. |
| `wa_community_update_picture` | `communityId, image` | Public HTTPS/base64; null removes photo. |
| `wa_community_list_members` | `communityId, scope?, groupId?` | Read community/Avisos/linked-group members and roles. |
| `wa_community_update_participants` | `communityId, participants, action, confirmLinkedGroupRemoval?` | Add/remove/promote/demote; removal also affects linked groups. |
| `wa_community_list_join_requests` | `communityId` | Read pending requests; admin required. |
| `wa_community_handle_join_requests` | `communityId, participants, action` | Approve/reject with per-member results. |
| `wa_community_get_invite` | `communityId` | Read invitation; admin required. |
| `wa_community_reset_invite` | `communityId` | Revoke and replace invitation. |
| `wa_community_get_invite_info` | `invite` | Inspect code/link without joining. |
| `wa_community_join` | `invite` | Join; verify membership before reporting joined. |
| `wa_community_join_v4` | `communityId, inviter, inviteCode, inviteExpiration` | Verify parent, reject expiry, accept V4 invitation and confirm membership. |
| `wa_community_revoke_member_invite` | `communityId, participant` | Revoke one V4 member invitation. |
| `wa_community_update_settings` | `communityId, change` | One typed setting/value change on the parent. |
| `wa_community_send_announcement` | `communityId, content` | Queue text/image/video/audio/document to verified Avisos. |

`scope` is `community` (default), `announcements`, or `group`; only `group` accepts and requires
`groupId`. `action` is `add/remove/promote/demote` for participants and `approve/reject` for requests.
`confirmLinkedGroupRemoval=true` is mandatory for removal. A mutation returns individual nullable
acknowledgements plus aggregate `success/partial/failed/unknown`, rather than assuming all succeeded.

`change` is one strict `{setting, value}` object: `edit_info`, `send_messages`, and `add_members`
accept `admins/all`; `join_approval` accepts `on/off`; `disappearing_messages` accepts
`0/86400/604800/7776000`. Invalid pairs and extra properties are rejected.

`content` uses `type: text/image/video/audio/document` plus the corresponding fields from the
existing send tool, without `to` or `instanceId`. Text/image/video/audio accept `quotedMessageId`;
mention support is inherited from the corresponding send schema. Queuing returns
`{status: "queued", jobId, to}`. Destination/admin/gate are rechecked by the worker; a changed
destination fails without retargeting. Announcement jobs have one attempt to avoid duplicate broadcasts.

Creation returns `retrySafe: false`; null metadata may mean the operation already succeeded. Child
creation preserves `groupId` if later enrichment fails. Joining only returns `joined` after confirming
own membership; otherwise `unknown`, including pending approval. See [Community management](COMMUNITIES.md)
for limits, events, safe retry behavior, live validation, and examples.

There is no community-deactivation tool: leaving is not deactivation. This version does not expose
arbitrary visibility/non-admin subgroup-creation protocol switches.

---

## 3. Resources Reference

Resources provide read-only data that agents can query for context. All resources return `application/json`.

Access resources by reading the URI through the MCP `resources/read` method.

### 3.1 `whatsapp://instances`

List all WhatsApp instances.

**Description:** List all WhatsApp instances with connection status, phone number, and channel type.

**Response:**

```json
[
  {
    "id": "inst_abc123",
    "name": "support-bot",
    "channel": "baileys",
    "phoneNumber": "+5511999999999",
    "status": "connected",
    "createdAt": 1709136000000,
    "lastConnected": 1709222400000
  }
]
```

---

### 3.2 `whatsapp://instances/{id}`

Single instance details.

**Description:** Single instance details including uptime, message stats, and queue status.

**URI parameters:**
| Parameter | Description |
|-----------|-------------|
| `id` | Instance ID |

**Response:**

```json
{
  "id": "inst_abc123",
  "name": "support-bot",
  "channel": "baileys",
  "phoneNumber": "+5511999999999",
  "status": "connected",
  "createdAt": 1709136000000,
  "lastConnected": 1709222400000,
  "queue": {
    "outbound": {
      "waiting": 0,
      "active": 0,
      "completed": 42,
      "failed": 1
    }
  }
}
```

---

### 3.3 `whatsapp://instances/{id}/chats`

Cached chats for an instance.

**Description:** Cached chats for an instance: JID, name, unread count, pinned, muted, archived, last message timestamp, and active associated Business labels when available.

**URI parameters:**
| Parameter | Description |
|-----------|-------------|
| `id` | Instance ID |

**Response:**

```json
[
  {
    "jid": "5511999999999@s.whatsapp.net",
    "name": "John Doe",
    "isGroup": false,
    "unreadCount": 3,
    "isPinned": true,
    "isMuted": false,
    "isArchived": false,
    "lastMessageAt": 1709222400000,
    "labels": [
      { "id": "label_1", "name": "Follow up", "color": 4, "deleted": false }
    ]
  }
]
```

---

### 3.4 `whatsapp://instances/{id}/messages/{chatId}`

Recent messages in a chat (up to 50 most recent).

**Description:** Recent messages in a chat (paginated): sender, type, content, timestamp, status.

**URI parameters:**
| Parameter | Description |
|-----------|-------------|
| `id` | Instance ID |
| `chatId` | Chat JID |

**Response:**

```json
[
  {
    "id": "msg_001",
    "chatId": "5511999999999@s.whatsapp.net",
    "senderId": "5511999999999@s.whatsapp.net",
    "type": "text",
    "content": "Hello, I need help with my order",
    "mediaUrl": null,
    "quotedMessageId": null,
    "isFromMe": false,
    "isForwarded": false,
    "status": "read",
    "timestamp": 1709222400
  }
]
```

---

### 3.5 `whatsapp://instances/{id}/contacts`

All contacts for an instance.

**Description:** All contacts for an instance: JID, name, phone, business flag.

**URI parameters:**
| Parameter | Description |
|-----------|-------------|
| `id` | Instance ID |

**Response:**

```json
[
  {
    "jid": "5511999999999@s.whatsapp.net",
    "name": "John Doe",
    "notifyName": "John",
    "phone": "+5511999999999",
    "profilePicUrl": "https://...",
    "isBusiness": false,
    "isBlocked": false
  }
]
```

---

### 3.6 `whatsapp://instances/{id}/groups`

All groups for an instance.

**Description:** All groups for an instance: JID, subject, participant count, your role.

**URI parameters:**
| Parameter | Description |
|-----------|-------------|
| `id` | Instance ID |

**Response:**

```json
[
  {
    "jid": "120363...@g.us",
    "name": "Project Team",
    "isGroup": true,
    "unreadCount": 5,
    "isPinned": false,
    "isMuted": false,
    "isArchived": false,
    "lastMessageAt": 1709222400000
  }
]
```

---

### 3.7 `whatsapp://instances/{id}/groups/{groupId}`

Full group metadata.

**Description:** Full group metadata: participants, admins, description, settings, invite link.

**URI parameters:**
| Parameter | Description |
|-----------|-------------|
| `id` | Instance ID |
| `groupId` | Group JID |

**Response:**

```json
{
  "jid": "120363...@g.us",
  "subject": "Project Team",
  "description": "Coordination group for Project X",
  "ownerJid": "5511999999999@s.whatsapp.net",
  "participants": [
    {
      "jid": "5511999999999@s.whatsapp.net",
      "isAdmin": true,
      "isSuperAdmin": true
    },
    {
      "jid": "5511888888888@s.whatsapp.net",
      "isAdmin": false,
      "isSuperAdmin": false
    }
  ],
  "participantCount": 2,
  "isAnnounce": false,
  "isLocked": false,
  "ephemeralDuration": null,
  "inviteCode": "AbCdEfGh",
  "createdAt": 1709136000000
}
```

---

### 3.8 `whatsapp://instances/{id}/profile`

Own profile information.

**Description:** Own profile: name, status, picture URL.

**URI parameters:**
| Parameter | Description |
|-----------|-------------|
| `id` | Instance ID |

**Response:**

```json
{
  "name": "Support Bot",
  "status": "Available 24/7",
  "pictureUrl": "https://..."
}
```

---

### 3.9 `whatsapp://instances/{id}/privacy`

Privacy settings for an instance.

**Description:** Normalized privacy settings including lastSeen, online, profilePic, status (About/profile text visibility), readReceipts, groupAdd, and calls. The default disappearing duration is not exposed by Baileys.

**URI parameters:**
| Parameter | Description |
|-----------|-------------|
| `id` | Instance ID |

**Response:**

```json
{
  "lastSeen": "contacts",
  "online": "all",
  "profilePic": "all",
  "status": "contacts",
  "readReceipts": "all",
  "groupAdd": "contacts",
  "calls": "all"
}
```

---

### 3.10 `whatsapp://instances/{id}/blocklist`

Blocked contacts for an instance.

**Description:** Blocked contacts for an instance.

**URI parameters:**
| Parameter | Description |
|-----------|-------------|
| `id` | Instance ID |

**Response:**

```json
["5511777777777@s.whatsapp.net", "5511666666666@s.whatsapp.net"]
```

---

## 4. Notifications Reference

Notifications are real-time events pushed from the server to connected agents via SSE. They are delivered as MCP `notifications/message` with a `_meta.notificationType` field identifying the event.

Notifications are **fire-and-forget** -- if the agent is disconnected, notifications are lost. For critical use cases, periodically poll the `whatsapp://instances/{id}/messages/{chatId}` resource to catch missed events.

### 4.1 `whatsapp/message.received`

Fired when a new message is received in any chat.

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/message.received" },
  "instanceId": "inst_abc123",
  "chatId": "5511999999999@s.whatsapp.net",
  "message": {
    "id": "msg_001",
    "sender": "5511999999999@s.whatsapp.net",
    "timestamp": 1709222400,
    "type": "image",
    "content": "Synthetic account notice\nReview the details below.\nButton: See details — https://example.com/details",
    "mediaUrl": "https://example.com/synthetic-header.jpg",
    "mediaMimetype": "image/jpeg",
    "mimeType": "image/jpeg",
    "fileName": "photo.jpg",
    "caption": "Review the photo",
    "size": 12345,
    "buttons": [
      {
        "type": "url",
        "text": "See details",
        "url": "https://example.com/details"
      }
    ],
    "quotedMessageId": null,
    "isFromMe": false,
    "isForwarded": false
  }
}
```

`mediaMimetype`, `mimeType`, `fileName`, `caption`, `size`, `isForwarded`, `buttons`, and
`rawType` are optional additions to the message object. Message notifications and outgoing generic
and Grok Bot event webhook payloads expose a boolean `isForwarded`. Media details are included when
available from the channel; media bytes are not copied into notifications or outgoing event
webhooks. Business template, interactive, list, and button messages include their readable text in
`content`; unknown Baileys content types use `type: "text"` and include their source name in
`rawType`.

Outgoing generic and Grok Bot event webhooks also include available media metadata as `mimeType`,
`fileName`, `caption`, and `size`. The top-level `type` field identifies the media type.

---

### 4.2 `whatsapp/message.updated`

Fired when a message delivery status changes (sent, delivered, read, played).

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/message.updated" },
  "instanceId": "inst_abc123",
  "chatId": "5511999999999@s.whatsapp.net",
  "messageId": "msg_001",
  "status": "read"
}
```

**Possible `status` values:** `"received"`, `"sent"`, `"delivered"`, `"read"`, `"played"`

---

### 4.3 `whatsapp/message.deleted`

Fired when a message is deleted (revoked) in a chat.

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/message.deleted" },
  "instanceId": "inst_abc123",
  "chatId": "5511999999999@s.whatsapp.net",
  "messageId": "msg_001",
  "deletedBy": "5511999999999@s.whatsapp.net"
}
```

---

### 4.4 `whatsapp/message.reaction`

Fired when someone reacts to a message with an emoji.

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/message.reaction" },
  "instanceId": "inst_abc123",
  "chatId": "5511999999999@s.whatsapp.net",
  "messageId": "msg_001",
  "emoji": "👍",
  "reactedBy": "5511999999999@s.whatsapp.net"
}
```

---

### 4.5 `whatsapp/message.edited`

Fired when a message is edited.

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/message.edited" },
  "instanceId": "inst_abc123",
  "chatId": "5511999999999@s.whatsapp.net",
  "messageId": "msg_001",
  "newContent": "Updated message text",
  "editedAt": 1709222500
}
```

---

### 4.6 `whatsapp/presence.updated`

Fired when a contact's presence status changes (typing, recording, online, etc.).

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/presence.updated" },
  "instanceId": "inst_abc123",
  "chatId": "5511999999999@s.whatsapp.net",
  "participant": "5511999999999@s.whatsapp.net",
  "status": "composing"
}
```

**Possible `status` values:** `"composing"`, `"recording"`, `"paused"`, `"available"`, `"unavailable"`

---

### 4.7 `whatsapp/chat.updated`

Fired when a chat's metadata changes (e.g. archived, pinned, muted).

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/chat.updated" },
  "instanceId": "inst_abc123",
  "chatId": "5511999999999@s.whatsapp.net",
  "changes": {
    "isArchived": true
  }
}
```

---

### 4.8 `whatsapp/group.updated`

Fired when a group's metadata changes (subject, description, settings).

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/group.updated" },
  "instanceId": "inst_abc123",
  "groupId": "120363...@g.us",
  "changes": {
    "subject": "New Group Name"
  }
}
```

---

### 4.9 `whatsapp/group.participants_changed`

Fired when participants are added, removed, promoted, or demoted in a group.

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/group.participants_changed" },
  "instanceId": "inst_abc123",
  "groupId": "120363...@g.us",
  "action": "add",
  "participants": ["5511888888888@s.whatsapp.net"]
}
```

**Possible `action` values:** `"add"`, `"remove"`, `"promote"`, `"demote"`

---

#### Community/group updates and join requests

`group.updated` includes safe hierarchy/settings fields; duplicate metadata snapshots are suppressed
until their values change or the connection restarts. Invitation codes are excluded. The corresponding
webhook includes `groupChanges`. Participant changes include `modify` and a `participants` array.

`whatsapp/group.join_request` carries `{instanceId, groupId, participant, action, method}`. Actions are
`created`, `revoked`, or `rejected`; methods are `invite_link`, `linked_group_join`, `non_admin_add`, or
`null` when absent. The webhook uses `requestMethod` for the method field. These events only reflect
what the backend emits; they do not guarantee notification of every community/invitation change.

### 4.10 `whatsapp/group.member_label_changed`

Fired when a member's group label changes. The connected account can only set or remove its own
label through the provided tools; changes by other group members are also reported when observed by
Baileys. The event is available to `WA_EVENT_WEBHOOK_EVENTS` without changing existing defaults or
the `grok-bot` preset.

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/group.member_label_changed" },
  "instanceId": "inst_example",
  "groupId": "120363000000000000@g.us",
  "participant": "participant-placeholder@lid",
  "memberLabel": "Group coordinator",
  "action": "set",
  "timestamp": 1700000000
}
```

For a removal, `action` is `removed` and `memberLabel` is `null`.

---

### 4.11 `whatsapp/contact.updated`

Fired when a contact's information changes.

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/contact.updated" },
  "instanceId": "inst_abc123",
  "contactId": "5511999999999@s.whatsapp.net",
  "changes": {
    "name": "New Name"
  }
}
```

---

### 4.12 `whatsapp/connection.changed`

Fired when an instance's connection status changes. Also carries QR code and pairing code data during authentication.

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/connection.changed" },
  "instanceId": "inst_abc123",
  "status": "open",
  "qrCode": null,
  "pairingCode": null
}
```

**Possible `status` values:** `"open"`, `"close"`, `"connecting"`

When `status` is `"connecting"`, `qrCode` may contain a base64-encoded QR code image, and `pairingCode` may contain a numeric pairing code.

---

### 4.13 `whatsapp/call.received`

Fired for call offers and later call-state updates. `status` can be `offer`, `ringing`, `preaccept`,
`transport`, `relaylatency`, `timeout`, `reject`, `accept`, or `terminate`. Use `callId` and
`callerId` with `wa_reject_call` to reject an incoming direct call. Set `WA_AUTO_REJECT_CALLS=true`
to automatically reject direct call offers.

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/call.received" },
  "instanceId": "inst_abc123",
  "chatId": "5511999999999@s.whatsapp.net",
  "callerId": "5511999999999@s.whatsapp.net",
  "isVideo": false,
  "isGroup": false,
  "callId": "call_abc123",
  "timestamp": 1709136000000,
  "status": "offer"
}
```

Outgoing event webhooks use the same `call.received` filter and include `callId`, `callStatus`,
`isVideo`, `isGroup`, and the observed timestamp.

---

### 4.14 `whatsapp/label.updated`

Fired when Baileys reports a label edit or a chat/message label association change.

**Payload:** `instanceId`, `action` (`edited`, `associated`, or `disassociated`), and `label`. Association changes also include `chatId` and `association` (`type`, `chatId`, optional `messageId`).

---

### 4.15 `whatsapp/group.joined`

Fired when a group roster or a participant-add lists this Baileys account (#141). An empty roster
does not emit. `wa_create_group` does not emit this notification. `wa_join_group` waits until a
later roster includes this account. Other participants joining still use
`whatsapp/group.participants_changed`.

**Payload:** `instanceId`, `groupId`, `chatId`, `subject`, `description`, `memberCount`, `author`,
and `timestamp` (Unix seconds). `memberCount` is the size of the list that contained this account.
Member JIDs are not included. `subject` and `description` are null when the add notification does
not include them.

---

### 4.16 `whatsapp/label.association`

Fired when a label is applied to or removed from a chat or message. `whatsapp/label.updated` is
also fired for the same change.

**Payload:** `instanceId`, `labelId`, `labeled`, `chatId`, `label`, and `association`. `messageId`
is included for a message association. `labeled` is true when the label is applied.

---

### 4.17 `whatsapp/newsletter.joined` and `whatsapp/newsletter.left`

Fired when this account subscribes to or leaves a newsletter. Local follow, unfollow, and newsletter
create emit these events. A newsletter participant update emits them only when the affected user is
this account and the action is a join or leave. A follow started on the phone is best-effort on
Baileys 7.0.0-rc14 (#141): that release does not confirm it from the settings stanza.

**Payload:** `instanceId`, `newsletterId`, `chatId`, `name`, `description`, and `role`.

---

### 4.18 `whatsapp/newsletter.message`

Fired for a newsletter post. Append-path posts are not duplicated as `whatsapp/message.received`.

**Payload:** `instanceId`, `newsletterId`, `chatId`, and `message` (`id`, `serverId`, `sender`,
`timestamp`, `type`, `text`, `views`, `isFromMe`). `views` is null when Baileys does not include a
view count. `serverId` is set when the message id is numeric.

---

### 4.19 `whatsapp/newsletter.mute`

Best-effort on Baileys 7.0.0-rc14 (#141). Fired when a newsletter settings object includes `mute`,
`mute_state`, or `muted`. The binary settings stanza on that release carries only name and
description, so a mute or follow started on the phone cannot be confirmed from it.

**Payload:** `instanceId`, `newsletterId`, `chatId`, `mute` (`on` or `off`), and `timestamp`
(Unix seconds).

---

### 4.20 `whatsapp/event.response`

Fired when a Baileys event RSVP is decrypted and stored. A response recovered after its event
message or LID mapping becomes available emits this event at that time.

**Payload:** `instanceId`, `chatId`, `eventMessageId`, `participant`, `responseMessageId`,
`status`, and `timestamp` in Unix milliseconds or `null`. `extraGuestCount` is included when
WhatsApp provides it.

---

## 5. Error Handling

### Error Response Format

All tool errors return a standard MCP error response:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Error: Description of what went wrong"
    }
  ]
}
```

### Common Errors

| Error                                     | Cause                                   | Resolution                                                     |
| ----------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `Instance 'X' not found`                  | Invalid `instanceId`                    | Check `whatsapp://instances` resource for valid IDs            |
| `Instance 'X' is not connected`           | Instance exists but is disconnected     | Call `wa_connect_instance` first                               |
| `No adapter found for instance 'X'`       | Instance not initialized                | Call `wa_connect_instance` to initialize                       |
| `Phone number not registered on WhatsApp` | Number does not have WhatsApp           | Verify with `wa_check_number_exists` before sending            |
| `Not a group admin`                       | Operation requires admin privileges     | Only group admins can modify settings, add/remove participants |
| `Cloud API token expired`                 | Meta access token is invalid or expired | Call `wa_set_cloud_credentials` with a new token               |
| `Rate limit exceeded`                     | Too many messages in a short period     | Wait and retry. Messages are queued with rate limiting.        |
| `Media too large`                         | File exceeds size limits                | See media limits below                                         |

### Media Size Limits

| Media Type | Max Size (Baileys) | Max Size (Cloud API) | Supported Formats                  |
| ---------- | ------------------ | -------------------- | ---------------------------------- |
| Image      | 16 MB              | 5 MB                 | JPEG, PNG, WebP                    |
| Video      | 16 MB              | 16 MB                | MP4, 3GPP                          |
| Audio      | 16 MB              | 16 MB                | OGG (Opus), MP3, AAC, AMR          |
| Document   | 100 MB             | 100 MB               | PDF, DOC, XLS, PPT, TXT, ZIP, etc. |
| Sticker    | 500 KB             | 500 KB               | WebP                               |

### Failure Mode Recovery

| Failure                 | Behavior                                                             | Recovery                                                              |
| ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Instance disconnect     | Auto-reconnect with exponential backoff (1s to 30s), then every 30s until connected, logged out, or `disconnect()` | Health check retries disconnected instances every 5 min and recovers a `connecting` status older than 2 min with no live socket |
| Redis down              | Outbound queue stalls, inbound events dropped                        | Server retries Redis connection every 5s, resumes automatically       |
| SQLite locked           | Write operations retry 3x with 100ms delay                           | Extremely rare with WAL mode. Restart server if persistent.           |
| Cloud API token expired | All Cloud instance operations fail with 401                          | Call `wa_set_cloud_credentials` with new token                        |
| Message send fails      | Job moves to "failed" in BullMQ                                      | Check queue stats via `whatsapp://instances/{id}` resource            |

---

## 6. Agent Integration Examples

### 6.1 Google ADK (Python)

```python
from google.adk import Agent
from google.adk.tools.mcp_tool import McpToolset, SseServerParams

# Connect to WA MCP -- tools are auto-discovered
whatsapp = McpToolset(
    connection_params=SseServerParams(
        url="http://localhost:3000/mcp",
        headers={"Authorization": "Bearer wamcp_sk_your_key"}
    )
)

agent = Agent(
    name="customer_support",
    model="gemini-2.0-flash",
    tools=[whatsapp],
    instruction="""You are a customer support agent for Acme Corp.

    When a customer messages on WhatsApp:
    1. Read the conversation history using whatsapp://instances/main/messages/{chatId}
    2. Understand their question
    3. Reply using wa_send_text
    4. If they send an image, acknowledge it
    5. Always be helpful and professional

    Use wa_send_presence to show "typing" before replying.
    Use wa_mark_read to mark messages as read.
    """
)

# The agent now handles WhatsApp conversations autonomously
```

### 6.2 Claude Desktop (JSON config)

Add to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "whatsapp": {
      "url": "http://localhost:3000/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer wamcp_sk_your_key"
      }
    }
  }
}
```

Once configured, the client will auto-discover all 158 WA MCP tools and can interact with WhatsApp directly.

### 6.3 LangChain (Python)

```python
from langchain_mcp import MCPToolkit

toolkit = MCPToolkit(
    server_url="http://localhost:3000/mcp",
    headers={"Authorization": "Bearer wamcp_sk_your_key"}
)

tools = toolkit.get_tools()
# tools now contains all 158 WA MCP tools, ready for any LangChain agent
```

---

## Appendix: Tool Count Summary

| Domain                            | Tools | Channel                              |
| --------------------------------- | ----- | ------------------------------------ |
| Instance Management              | 9     | Both (2 Baileys only, 1 Cloud only)  |
| Messaging                         | 32    | Both                                 |
| Audio Transcription               | 1     | Both                                 |
| Text-to-speech                    | 3     | Provider-dependent                   |
| Chat Management                   | 11    | Both                                 |
| Message Search                    | 1     | Both                                 |
| WhatsApp Business Labels          | 8     | Baileys                              |
| WhatsApp Events                   | 2     | Baileys                              |
| Group Management                  | 28    | Baileys                              |
| Contact Management                | 8     | Both                                 |
| Profile Management                | 7     | Both                                 |
| Status / Stories                  | 4     | Baileys only                         |
| Newsletter / Channels             | 11    | Baileys only                         |
| Business, Communities, and Catalog| 16    | Baileys only                         |
| Call Management                   | 1     | Baileys only                         |
| Community administration | 16 | Baileys only |
| **Total**                         | **158** |                                    |

| Resources     | 10  |
| ------------- | --- |
| Notifications | 15  |
