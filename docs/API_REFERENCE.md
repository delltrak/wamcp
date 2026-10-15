# WA MCP -- API Reference

> Complete reference for all tools, resources, and notifications exposed by the WA MCP server.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Tools Reference](#2-tools-reference)
   - [Instance Management](#21-instance-management-8-tools)
   - [Messaging](#22-messaging-21-tools)
   - [Chat Management](#23-chat-management-11-tools)
   - [Group Management](#24-group-management-20-tools)
   - [Contact Management](#25-contact-management-8-tools)
   - [Profile Management](#26-profile-management-6-tools)
   - [Status / Stories](#27-status--stories-3-tools)
   - [Newsletter / Channels](#28-newsletter--channels-10-tools)
   - [Call Management](#29-call-management-1-tool)
   - [Message Search](#210-message-search-1-tool)
   - [WhatsApp Business Labels](#211-whatsapp-business-labels-8-tools)
   - [WhatsApp Events](#212-whatsapp-events-2-tools)
   - [Business, Communities, and Catalog](#213-business-communities-and-catalog-15-tools)
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
  Stickers and GIFs are converted to WhatsApp-compatible formats with ffmpeg. Received media can
  be saved under `WA_MEDIA_DOWNLOAD_DIR` (default `data/media-downloads`) or returned as base64.
  `WA_MEDIA_DOWNLOAD_MAX_BYTES` defaults to 25 MB, and base64 mode is capped at 5 MB. Docker
  includes ffmpeg; `WA_MEDIA_FFMPEG_PATH` and `WA_MEDIA_FFMPEG_TIMEOUT_MS` configure conversions.
- **Automatic read receipts** -- `WA_AUTO_READ=false` (default), `on_fetch` to mark incoming
  messages read when a tool or resource returns them, or `on_receive` to mark them read when they
  arrive. Invalid values disable the feature and log a warning.
- **Baileys account, server, and app-state writes** -- `WA_APP_STATE_WRITES_ENABLED=false` by
  default. Set it to `true` to enable `wa_archive_chat`, `wa_pin_chat`, `wa_mute_chat`,
  `wa_delete_chat`, `wa_clear_chat`, `wa_mark_chat_unread`, `wa_star_message`, `wa_create_label`,
  `wa_edit_label`, `wa_delete_label`, `wa_add_chat_label`, `wa_remove_chat_label`,
  `wa_add_message_label`, `wa_remove_message_label`, `wa_update_profile_name`,
  `wa_create_quick_reply`, `wa_edit_quick_reply`, `wa_delete_quick_reply`,
  `wa_create_community`, `wa_community_link_group`, `wa_community_unlink_group`,
  `wa_leave_community`, `wa_create_newsletter`, `wa_newsletter_update_name`,
  `wa_newsletter_update_description`, `wa_newsletter_update_picture`, `wa_newsletter_react`,
  `wa_create_catalog_product`, `wa_update_catalog_product`, `wa_delete_catalog_products`,
  `wa_group_join_approval_mode`, and `wa_group_member_add_mode`. The flag covers account/server
  changes even when Baileys uses IQ or MEX queries instead of an app-state patch. These changes can
  get the linked device removed. Read-only calls, normal message sends, and disappearing-message
  control messages sent through `sendMessage` are not gated.
- **Protocol classification for issue #74 operations** -- `wa_set_disappearing_messages` sends a
  `sendMessage` protocol control message; blocklist/About are reads; communities use `w:g2` IQs;
  Channel metadata/posts/reactions use newsletter/MEX queries or message nodes; group modes use IQs;
  catalog operations use IQ/MEX queries; and PTV sends a video message with `ptv: true`. Only quick
  reply create/edit/delete use `chatModify` → `appPatch` and are gated above.
- **Real WhatsApp checks** -- Run real integration tests only with a throwaway number. Automated
  tests use mocked sockets and do not connect to WhatsApp.

---

## 2. Tools Reference

WA MCP exposes **118 tools** grouped by domain. All tools return MCP-standard responses.

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

### 2.1 Instance Management (8 tools)

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

### 2.2 Messaging (21 tools)

Tools for sending messages, media, reactions, and managing message state.

#### `wa_send_text`

Send a text message to a WhatsApp contact or group.

| Parameter         | Type   | Required | Description                                                  |
| ----------------- | ------ | -------- | ------------------------------------------------------------ |
| `instanceId`      | string | Yes      | The instance to send from                                    |
| `to`              | string | Yes      | Recipient phone number (e.g. `"5511999999999"`) or group JID |
| `text`            | string | Yes      | Message content (max 65536 chars)                            |
| `quotedMessageId` | string | No       | Message ID to reply to                                       |

**Channel support:** Both

**Response:**

```json
{
  "status": "queued",
  "jobId": "job_123"
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

**Channel support:** Both

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

**Channel support:** Both

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

| Parameter    | Type   | Required | Description                         |
| ------------ | ------ | -------- | ----------------------------------- |
| `instanceId` | string | Yes      | The instance to send from           |
| `to`         | string | Yes      | Recipient phone number or group JID |
| `video`      | string | Yes      | Video URL or base64-encoded data    |
| `caption`    | string | No       | Optional video caption              |

**Channel support:** Baileys only. Cloud API returns an unsupported-operation error.

---

#### `wa_send_sticker`

Send a native WhatsApp sticker. PNG/JPG images and GIFs are converted to 512x512 WebP with
transparent padding. Static stickers are limited to 100 KB and animated stickers to 500 KB. Static
WebP files that are not 512x512 are normalized with ffmpeg; animated WebP passes through only at
512x512 because ffmpeg cannot safely resize animated WebP. Send a GIF to convert an animated sticker
to 512x512. Correctly sized WebP files pass through unchanged when they are within their size limit.

| Parameter         | Type    | Required | Description                                      |
| ----------------- | ------- | -------- | ------------------------------------------------ |
| `instanceId`      | string  | Yes      | The instance to send from                        |
| `to`              | string  | Yes      | Recipient phone number or group JID              |
| `sticker`         | string  | Yes      | PNG, JPG, GIF, or WebP URL or base64 data        |
| `animated`        | boolean | No       | Hint to retain or flatten GIF animation          |
| `quotedMessageId` | string  | No       | Message ID to reply to                           |

**Channel support:** Both. Cloud API uploads the prepared WebP before sending it.

**Response:** The standard queued message response.

---

#### `wa_send_gif`

Send a GIF as a looping WhatsApp video. GIF or MP4 input is converted to silent H.264 MP4 with
`yuv420p` pixel format and even dimensions, then sent with Baileys `gifPlayback: true`.

| Parameter         | Type   | Required | Description                          |
| ----------------- | ------ | -------- | ------------------------------------ |
| `instanceId`      | string | Yes      | The instance to send from            |
| `to`              | string | Yes      | Recipient phone number or group JID  |
| `gif`             | string | Yes      | GIF or MP4 URL or base64 data        |
| `caption`         | string | No       | Optional caption                     |
| `quotedMessageId` | string | No       | Message ID to reply to               |

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

#### `wa_send_contact`

Send a vCard contact to a WhatsApp contact or group.

| Parameter      | Type   | Required | Description                         |
| -------------- | ------ | -------- | ----------------------------------- |
| `instanceId`   | string | Yes      | The instance to send from           |
| `to`           | string | Yes      | Recipient phone number or group JID |
| `contactName`  | string | Yes      | Contact display name                |
| `contactPhone` | string | Yes      | Contact phone number                |

**Channel support:** Both

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

**Channel support:** Both

**Response:**

```json
{
  "status": "queued",
  "jobId": "job_130"
}
```

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

| Parameter    | Type   | Required | Description                                  |
| ------------ | ------ | -------- | -------------------------------------------- |
| `instanceId` | string | Yes      | The instance to send from                    |
| `to`         | string | Yes      | Recipient phone number or group JID          |
| `text`       | string | Yes      | Message text content                         |
| `url`        | string | Yes      | URL for the link preview (must be valid URL) |

**Channel support:** Both

**Response:**

```json
{
  "messageId": "msg_abc123",
  "timestamp": 1709136000
}
```

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

**Channel support:** Both

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

**Channel support:** Both

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

**Channel support:** Both

**Response:**

```json
{
  "success": true,
  "pinned": true
}
```

---

#### `wa_send_view_once`

Send a view-once image or video. The media disappears after the recipient views it once.

| Parameter    | Type                   | Required | Description                         |
| ------------ | ---------------------- | -------- | ----------------------------------- |
| `instanceId` | string                 | Yes      | The instance to send from           |
| `to`         | string                 | Yes      | Recipient phone number or group JID |
| `media`      | string                 | Yes      | Media URL or base64-encoded data    |
| `type`       | `"image"` \| `"video"` | Yes      | Media type                          |

**Channel support:** Both

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
| `status`     | `"composing"` \| `"recording"` \| `"paused"` \| `"available"` \| `"unavailable"` | Yes      | Presence status              |

**Channel support:** Both

**Response:**

```json
{
  "success": true
}
```

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

Mark a chat unread. The adapter passes recent stored messages in Baileys' required reverse-chronological `lastMessages` range.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID to mark unread |

**Channel support:** Baileys only. A chat without a locally stored message cannot provide Baileys' required message range.

---

#### `wa_star_message`

Star or unstar a message in a chat.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID containing the message |
| `messageId` | string | Yes | Stored message ID |
| `star` | boolean | Yes | `true` to star; `false` to unstar |

**Channel support:** Baileys only. The local message record retains the starred state after Baileys confirms the operation.

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
through `sendMessage`; this does not call `chatModify` or write app state.

| Parameter    | Type                              | Required | Description                                                     |
| ------------ | --------------------------------- | -------- | --------------------------------------------------------------- |
| `instanceId` | string                            | Yes      | The instance ID                                                 |
| `chatId`     | phone number or individual JID    | Yes      | Private contact; group, Channel, and broadcast IDs are rejected |
| `duration`   | `0`, `86400`, `604800`, `7776000` | Yes      | Off, 24 hours, 7 days, or 90 days                               |

**Channel support:** Baileys only. Cloud API does not support this operation.

---

### 2.4 Group Management (20 tools)

Tools for creating and managing WhatsApp groups.

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
phone numbers are included when available, including when a LID can be resolved to a PN.

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
      "isSuperAdmin": true
    }
  ]
}
```

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

**Channel support:** Both

**Response:**

```json
{
  "groupId": "120363...@g.us",
  "inviteCode": "AbCdEfGh"
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

**Channel support:** Both

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

**Channel support:** Both

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

**Channel support:** Both

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

**Channel support:** Both

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

**Channel support:** Both

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

**Channel support:** Both

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

**Channel support:** Both

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

**Channel support:** Both

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

**Channel support:** Both

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

**Channel support:** Both

**Response:**

```json
{
  "success": true
}
```

---

#### `wa_group_join`

Join a WhatsApp group using an invite code or link.

| Parameter    | Type   | Required | Description                    |
| ------------ | ------ | -------- | ------------------------------ |
| `instanceId` | string | Yes      | The instance ID                |
| `inviteCode` | string | Yes      | Group invite code or full link |

**Channel support:** Both

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

**Channel support:** Both

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

**Channel support:** Both

**Response:**

```json
{
  "success": true,
  "action": "approve"
}
```

---

#### `wa_group_join_approval_mode`

Enable or disable admin approval for group join requests. This account/server change is blocked
unless `WA_APP_STATE_WRITES_ENABLED=true`, even though Baileys sends it through an IQ query.

| Parameter    | Type          | Required | Description                 |
| ------------ | ------------- | -------- | --------------------------- |
| `instanceId` | string        | Yes      | The instance ID             |
| `groupId`    | string        | Yes      | Group JID or bare group ID  |
| `mode`       | `on` or `off` | Yes      | Whether join approval is on |

**Channel support:** Baileys only.

---

#### `wa_group_member_add_mode`

Set who can add members to a group. This account/server change is blocked unless
`WA_APP_STATE_WRITES_ENABLED=true`, even though Baileys sends it through an IQ query.

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

### 2.6 Profile Management (6 tools)

Tools for managing the instance's own WhatsApp profile.

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

Update one Baileys account privacy setting. `setting` determines the accepted `value` enum. The Cloud API channel does not support privacy settings.

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

### 2.7 Status / Stories (3 tools)

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
  "recipientCount": 4
}
```

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
  "recipientCount": 4
}
```

---

### 2.8 Newsletter / Channels (10 tools)

Tools for interacting with WhatsApp Channels (Newsletters). **Baileys only.**

#### `wa_newsletter_follow`

Follow a WhatsApp Channel/Newsletter.

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

Unfollow a WhatsApp Channel/Newsletter.

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

Channel create/update, post-reaction, community, catalog-write, and group-mode operations change
account or server state and are blocked unless `WA_APP_STATE_WRITES_ENABLED=true`, regardless of
whether Baileys sends them through newsletter/MEX queries, IQs, or message nodes. Cloud API returns
a clear unsupported-operation error. Metadata and post-fetch calls are read-only.

| Tool                               | Inputs                                             | Description                                      |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| `wa_create_newsletter`             | `instanceId`, `name`, optional `description`       | Create a Channel. Gated account/server write.    |
| `wa_get_newsletter_metadata`       | `instanceId`, `type`, `key`                        | Read metadata by JID or invite code.             |
| `wa_newsletter_update_name`        | `instanceId`, `jid`, `name`                        | Update the Channel name. Gated write.            |
| `wa_newsletter_update_description` | `instanceId`, `jid`, `description`                 | Update the Channel description. Gated write.     |
| `wa_newsletter_update_picture`     | `instanceId`, `jid`, `image`                       | Update picture. Gated write.                     |
| `wa_newsletter_react`              | `instanceId`, `jid`, `serverId`, `reaction`        | Add or remove a post reaction. Gated write.       |
| `wa_newsletter_list_posts`         | `instanceId`, `jid`, optional `count`, `since`, `after` | Fetch parsed posts with timestamp and server-ID cursors. |

Channel picture URLs use the existing public-HTTPS validation and media size limits, then are
converted to JPEG before upload.

Post results contain JSON-safe `posts` with `id`, `serverId`, Unix-seconds `timestamp`, message
`type`, extracted `text` or caption, `views`, and reaction counts. `pagination.oldestServerId` and
`pagination.newestServerId` identify the page bounds. `pagination.after` is the newest numeric server
ID; pass it as `after` on the next call to continue through newer posts. `since` accepts a Unix
timestamp lower bound.

---

### 2.9 Call Management (1 tool)

#### `wa_reject_call`

Reject an incoming voice or video call. The call ID is received via the `whatsapp/call.received` notification.

| Parameter    | Type   | Required | Description                                              |
| ------------ | ------ | -------- | -------------------------------------------------------- |
| `instanceId` | string | Yes      | The instance ID                                          |
| `callId`     | string | Yes      | The call ID (from `whatsapp/call.received` notification) |

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
`phone` is included when a phone number can be resolved. `UNKNOWN` indicates that an encrypted
response is stored but its event secret or author mapping is not available yet.

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

### 2.13 Business, Communities, and Catalog (15 tools)

These operations require Baileys. Cloud API calls return unsupported-operation errors. Community
changes and catalog product writes change account/server state and are blocked unless
`WA_APP_STATE_WRITES_ENABLED=true`; read-only listing and order tools remain available.

| Tool                         | Inputs                                                                                                       | Description                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `wa_create_quick_reply`      | `instanceId`, `shortcut`, `message`                                                                          | Create a quick reply. Gated app-state write.          |
| `wa_edit_quick_reply`        | `instanceId`, `timestamp`, `shortcut`, `message`                                                             | Edit by sync timestamp. Gated app-state write.        |
| `wa_delete_quick_reply`      | `instanceId`, `timestamp`                                                                                    | Delete by sync timestamp. Gated app-state write.      |
| `wa_create_community`        | `instanceId`, `name`, optional `description`                                                                 | Create a community. Gated account/server write.       |
| `wa_list_communities`        | `instanceId`                                                                                                | List participating communities.                       |
| `wa_get_community_details`   | `instanceId`, `communityId`                                                                                 | Read community metadata.                              |
| `wa_community_link_group`    | `instanceId`, `communityId`, `groupId`                                                                       | Link an existing group. Gated write.                 |
| `wa_community_unlink_group`  | `instanceId`, `communityId`, `groupId`                                                                       | Unlink a group. Gated write.                          |
| `wa_leave_community`         | `instanceId`, `communityId`                                                                                 | Leave a community. Gated write.                       |
| `wa_get_catalog`             | `instanceId`, optional `jid`, `limit`, `cursor`                                                              | List products with cursor pagination.                 |
| `wa_get_catalog_collections` | `instanceId`, optional `jid`, `limit`                                                                        | List catalog collections.                             |
| `wa_create_catalog_product`  | `instanceId`, product fields and `images`; optional `originCountryCode`                                     | Create a product. Gated account/server write.        |
| `wa_update_catalog_product`  | `instanceId`, `productId`, product fields and `images`                                                       | Replace fields/images. Gated write.                  |
| `wa_delete_catalog_products` | `instanceId`, `productIds`                                                                                  | Delete products. Gated account/server write.        |
| `wa_get_order_details`       | `instanceId`, `orderId`, `tokenBase64`                                                                       | Read details using the token from the order message. |

Quick reply create/edit/delete call Baileys `addOrEditQuickReply` or `removeQuickReply`, which use
`chatModify` → `appPatch`. They fail before the socket is touched unless
`WA_APP_STATE_WRITES_ENABLED=true`. Baileys rc14 has no quick-reply read method, and the server does
not store quick reply sync actions locally, so there is no list tool. Use the WhatsApp Business app
to find an existing reply's timestamp before editing or deleting it.

Catalog image URLs are fetched only from public HTTPS hosts; the media helper enforces input-size
limits before upload.

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

### 4.10 `whatsapp/contact.updated`

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

### 4.11 `whatsapp/connection.changed`

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

### 4.12 `whatsapp/call.received`

Fired when an incoming voice or video call is received. Use the `callId` with `wa_reject_call` to reject the call.

**Payload:**

```json
{
  "_meta": { "notificationType": "whatsapp/call.received" },
  "instanceId": "inst_abc123",
  "callerId": "5511999999999@s.whatsapp.net",
  "isVideo": false,
  "callId": "call_abc123"
}
```

---

### 4.13 `whatsapp/label.updated`

Fired when Baileys reports a label edit or a chat/message label association change.

**Payload:** `instanceId`, `action` (`edited`, `associated`, or `disassociated`), and `label`. Association changes also include `chatId` and `association` (`type`, `chatId`, optional `messageId`).

---

### 4.14 `whatsapp/event.response`

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
| Instance disconnect     | Auto-reconnect with exponential backoff (1s to 30s max, 10 attempts) | `wa_restart_instance` to retry, or `wa_connect_instance` for fresh QR |
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

Once configured, Claude will auto-discover all 118 WA MCP tools and can interact with WhatsApp directly.

### 6.3 LangChain (Python)

```python
from langchain_mcp import MCPToolkit

toolkit = MCPToolkit(
    server_url="http://localhost:3000/mcp",
    headers={"Authorization": "Bearer wamcp_sk_your_key"}
)

tools = toolkit.get_tools()
# tools now contains all 118 WA MCP tools, ready for any LangChain agent
```

---

## Appendix: Tool Count Summary

| Domain                            | Tools | Channel                              |
| --------------------------------- | ----- | ------------------------------------ |
| Instance Management              | 8     | Both (2 Baileys only, 1 Cloud only)  |
| Messaging                         | 21    | Both                                 |
| Audio Transcription               | 1     | Both                                 |
| Text-to-speech                    | 3     | Provider-dependent                   |
| Chat Management                   | 11    | Both                                 |
| Message Search                    | 1     | Both                                 |
| WhatsApp Business Labels          | 8     | Baileys                              |
| WhatsApp Events                   | 2     | Baileys                              |
| Group Management                  | 20    | Baileys                              |
| Contact Management                | 8     | Both                                 |
| Profile Management                | 6     | Both                                 |
| Status / Stories                  | 3     | Baileys only                         |
| Newsletter / Channels             | 10    | Baileys only                         |
| Business, Communities, and Catalog| 15    | Baileys only                         |
| Call Management                   | 1     | Baileys only                         |
| **Total**                         | **118** |                                    |

| Resources     | 10  |
| ------------- | --- |
| Notifications | 13  |
