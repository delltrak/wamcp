# WA MCP -- API Reference

> Complete reference for all tools, resources, and notifications exposed by the WA MCP server.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Tools Reference](#2-tools-reference)
   - [Instance Management](#21-instance-management-8-tools)
   - [Messaging](#22-messaging-17-tools)
   - [Chat Management](#23-chat-management-5-tools)
   - [Group Management](#24-group-management-14-tools)
   - [Contact Management](#25-contact-management-4-tools)
   - [Profile Management](#26-profile-management-5-tools)
   - [Status / Stories](#27-status--stories-3-tools)
   - [Newsletter / Channels](#28-newsletter--channels-3-tools)
   - [Call Management](#29-call-management-1-tool)
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

| Channel | Description | Notes |
|---------|-------------|-------|
| `baileys` | Open-source WhatsApp Web protocol | Full feature support. Requires QR code or pairing code auth. Unofficial -- numbers may be banned. |
| `cloud` | Meta Cloud API (official) | Subset of features. Requires Meta Business credentials. Production-safe. |

Tools marked **Baileys only** are not available on Cloud API instances.

### Common Patterns

- **`instanceId`** -- Every tool requires an `instanceId` identifying which WhatsApp connection to use.
- **`to`** -- Recipient for send operations. Use a phone number (e.g. `"5511999999999"`) or a group JID (e.g. `"120363...@g.us"`).
- **JID** -- Jabber ID, WhatsApp's internal identifier. Individual: `5511999999999@s.whatsapp.net`. Group: `120363...@g.us`.
- **Media** -- Image/video/audio/document fields accept a URL (`https://...`) or base64-encoded data.

---

## 2. Tools Reference

WA MCP exposes **60 tools** grouped by domain. All tools return MCP-standard responses.

### Success Response Format

```json
{
  "content": [{
    "type": "text",
    "text": "{\"key\": \"value\"}"
  }]
}
```

### Error Response Format

```json
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "Error: Description of what went wrong"
  }]
}
```

---

### 2.1 Instance Management (8 tools)

Tools for creating, connecting, and managing WhatsApp instances.

#### `wa_create_instance`

Create a new WhatsApp instance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Human-friendly instance name (e.g. `"support-bot"`) |
| `channel` | `"baileys"` \| `"cloud"` | No (default: `"baileys"`) | WhatsApp channel type |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID to connect |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID to disconnect |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID to permanently delete |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID to restart |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID (Baileys only) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID (Baileys only) |
| `phoneNumber` | string | Yes | Phone number to pair with (e.g. `"5511999999999"`) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID (Cloud API only) |
| `accessToken` | string | Yes | Meta Cloud API access token |
| `phoneNumberId` | string | Yes | Meta Phone Number ID |
| `businessId` | string | No | Meta Business ID |

**Channel support:** Cloud API only

**Response:**
```json
{
  "instanceId": "inst_abc123",
  "configured": true
}
```

---

### 2.2 Messaging (17 tools)

Tools for sending messages, media, reactions, and managing message state.

#### `wa_send_text`

Send a text message to a WhatsApp contact or group.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `to` | string | Yes | Recipient phone number (e.g. `"5511999999999"`) or group JID |
| `text` | string | Yes | Message content (max 65536 chars) |
| `quotedMessageId` | string | No | Message ID to reply to |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `to` | string | Yes | Recipient phone number or group JID |
| `image` | string | Yes | Image URL or base64-encoded data |
| `caption` | string | No | Image caption |
| `quotedMessageId` | string | No | Message ID to reply to |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `to` | string | Yes | Recipient phone number or group JID |
| `video` | string | Yes | Video URL or base64-encoded data |
| `caption` | string | No | Video caption |
| `quotedMessageId` | string | No | Message ID to reply to |

**Channel support:** Both

**Response:**
```json
{
  "status": "queued",
  "jobId": "job_125"
}
```

---

#### `wa_send_audio`

Send an audio file or voice note to a WhatsApp contact or group.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `to` | string | Yes | Recipient phone number or group JID |
| `audio` | string | Yes | Audio URL or base64-encoded data |
| `ptt` | boolean | No (default: `false`) | Send as voice note (push-to-talk) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `to` | string | Yes | Recipient phone number or group JID |
| `document` | string | Yes | Document URL or base64-encoded data |
| `fileName` | string | Yes | File name with extension (e.g. `"report.pdf"`) |
| `mimeType` | string | Yes | MIME type (e.g. `"application/pdf"`) |

**Channel support:** Both

**Response:**
```json
{
  "status": "queued",
  "jobId": "job_127"
}
```

---

#### `wa_send_location`

Send a GPS location to a WhatsApp contact or group.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `to` | string | Yes | Recipient phone number or group JID |
| `latitude` | number | Yes | GPS latitude (-90 to 90) |
| `longitude` | number | Yes | GPS longitude (-180 to 180) |
| `name` | string | No | Location name |
| `address` | string | No | Location address |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `to` | string | Yes | Recipient phone number or group JID |
| `contactName` | string | Yes | Contact display name |
| `contactPhone` | string | Yes | Contact phone number |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `to` | string | Yes | Recipient phone number or group JID |
| `question` | string | Yes | Poll question |
| `options` | string[] | Yes | Poll options (2-12 choices) |
| `multiSelect` | boolean | No (default: `false`) | Allow multiple selections |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `chatId` | string | Yes | Chat JID where the message is |
| `messageId` | string | Yes | Message ID to react to |
| `emoji` | string | Yes | Emoji to react with (empty string to remove) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `to` | string | Yes | Recipient phone number or group JID |
| `text` | string | Yes | Message text content |
| `url` | string | Yes | URL for the link preview (must be valid URL) |

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

Forward an existing message to another chat.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `to` | string | Yes | Recipient phone number or group JID to forward to |
| `messageId` | string | Yes | Message ID to forward |
| `fromChatId` | string | Yes | Chat JID where the original message is |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID where the message is |
| `messageId` | string | Yes | Message ID to edit |
| `newText` | string | Yes | New text content for the message |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID where the message is |
| `messageId` | string | Yes | Message ID to delete for everyone |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID where the message is |
| `messageId` | string | Yes | Message ID to pin or unpin |
| `pin` | boolean | Yes | `true` to pin, `false` to unpin |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance to send from |
| `to` | string | Yes | Recipient phone number or group JID |
| `media` | string | Yes | Media URL or base64-encoded data |
| `type` | `"image"` \| `"video"` | Yes | Media type |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID to send presence to |
| `status` | `"composing"` \| `"recording"` \| `"paused"` \| `"available"` \| `"unavailable"` | Yes | Presence status |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID containing the messages |
| `messageIds` | string[] | Yes | Message IDs to mark as read (min 1) |

**Channel support:** Both

**Response:**
```json
{
  "success": true
}
```

---

### 2.3 Chat Management (5 tools)

Tools for organizing the chat list (archive, pin, mute, delete, clear).

#### `wa_archive_chat`

Archive or unarchive a chat. Archived chats are hidden from the main chat list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID to archive or unarchive |
| `archive` | boolean | Yes | `true` to archive, `false` to unarchive |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID to pin or unpin |
| `pin` | boolean | Yes | `true` to pin, `false` to unpin |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID to mute or unmute |
| `mute` | boolean | Yes | `true` to mute, `false` to unmute |
| `muteUntil` | number | No | Unix timestamp in ms when the mute expires (required if `mute=true`) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID to delete |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `chatId` | string | Yes | Chat JID to clear all messages from |

**Channel support:** Both

**Response:**
```json
{
  "success": true,
  "cleared": true
}
```

---

### 2.4 Group Management (14 tools)

Tools for creating and managing WhatsApp groups.

#### `wa_create_group`

Create a new WhatsApp group with a name and initial participants.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `name` | string | Yes | Group name/subject (max 100 chars) |
| `participants` | string[] | Yes | Phone numbers or JIDs of initial participants (min 1) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID |
| `participants` | string[] | Yes | Phone numbers or JIDs to add (min 1) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID |
| `participants` | string[] | Yes | Phone numbers or JIDs to remove (min 1) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID |
| `participants` | string[] | Yes | Phone numbers or JIDs to promote to admin (min 1) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID |
| `participants` | string[] | Yes | Phone numbers or JIDs to demote from admin (min 1) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID |
| `subject` | string | Yes | New group name/subject (max 100 chars) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID |
| `description` | string | Yes | New group description (max 2048 chars, empty string to clear) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID |
| `announce` | boolean | No | Only admins can send messages |
| `locked` | boolean | No | Only admins can edit group info |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID to leave |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `inviteCode` | string | Yes | Group invite code or full link |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID |
| `duration` | number (int) | Yes | Duration in seconds (0 to disable). Common values: `86400` (24h), `604800` (7d), `7776000` (90d) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `groupId` | string | Yes | Group JID |
| `participantId` | string | Yes | JID of the requester |
| `action` | `"approve"` \| `"reject"` | Yes | Whether to approve or reject |

**Channel support:** Both

**Response:**
```json
{
  "success": true,
  "action": "approve"
}
```

---

### 2.5 Contact Management (4 tools)

Tools for checking phone numbers, blocking/unblocking contacts, and fetching business profiles.

#### `wa_check_number_exists`

Check if a phone number is registered on WhatsApp.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `phoneNumber` | string | Yes | Phone number to check (e.g. `"5511999999999"`) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `jid` | string | Yes | Contact JID to block |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `jid` | string | Yes | Contact JID to unblock |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `jid` | string | Yes | Contact JID to fetch business profile for |

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

### 2.6 Profile Management (5 tools)

Tools for managing the instance's own WhatsApp profile.

#### `wa_update_profile_picture`

Change the profile picture for a WhatsApp instance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `image` | string | Yes | Profile picture as base64-encoded data or URL |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `name` | string | Yes | New display name (max 25 characters) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `status` | string | Yes | New text status/bio (max 139 characters) |

**Channel support:** Both

**Response:**
```json
{
  "success": true
}
```

---

#### `wa_update_privacy`

Update privacy settings for the instance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `setting` | `"lastSeen"` \| `"online"` \| `"profilePic"` \| `"status"` \| `"readReceipts"` \| `"groupAdd"` | Yes | Privacy setting to update |
| `value` | `"all"` \| `"contacts"` \| `"contact_blacklist"` \| `"none"` | Yes | New value |

**Channel support:** Both

**Response:**
```json
{
  "success": true,
  "setting": "lastSeen",
  "value": "contacts"
}
```

---

### 2.7 Status / Stories (3 tools)

Tools for posting WhatsApp status/story updates.

#### `wa_send_text_status`

Post a text status/story update visible to contacts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `text` | string | Yes | Status text content |
| `backgroundColor` | string | No | Background color hex code (e.g. `"#FF5733"`) |
| `font` | number (int) | No | Font style (0-5) |

**Channel support:** Baileys only

**Response:**
```json
{
  "success": true
}
```

---

#### `wa_send_image_status`

Post an image status/story update visible to contacts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `image` | string | Yes | Image URL or base64-encoded data |
| `caption` | string | No | Image caption |

**Channel support:** Baileys only

**Response:**
```json
{
  "success": true
}
```

---

#### `wa_send_video_status`

Post a video status/story update visible to contacts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `video` | string | Yes | Video URL or base64-encoded data |
| `caption` | string | No | Video caption |

**Channel support:** Baileys only

**Response:**
```json
{
  "success": true
}
```

---

### 2.8 Newsletter / Channels (3 tools)

Tools for interacting with WhatsApp Channels (Newsletters). **Baileys only.**

#### `wa_newsletter_follow`

Follow a WhatsApp Channel/Newsletter.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `jid` | string | Yes | Newsletter/Channel JID to follow |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `jid` | string | Yes | Newsletter/Channel JID to unfollow |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `jid` | string | Yes | Newsletter/Channel JID (must be admin) |
| `text` | string | Yes | Message text content |

**Channel support:** Baileys only

**Response:**
```json
{
  "messageId": "msg_nl_123",
  "timestamp": 1709136000
}
```

---

### 2.9 Call Management (1 tool)

#### `wa_reject_call`

Reject an incoming voice or video call. The call ID is received via the `whatsapp/call.received` notification.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instanceId` | string | Yes | The instance ID |
| `callId` | string | Yes | The call ID (from `whatsapp/call.received` notification) |

**Channel support:** Baileys only

**Response:**
```json
{
  "success": true,
  "callId": "call_abc123"
}
```

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

Active chats for an instance.

**Description:** Active chats for an instance: JID, last message, unread count, pinned, muted, archived.

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
    "lastMessageAt": 1709222400000
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

**Description:** Privacy settings: lastSeen, online, profilePic, status, readReceipts, groupAdd.

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
  "groupAdd": "contacts"
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
[
  "5511777777777@s.whatsapp.net",
  "5511666666666@s.whatsapp.net"
]
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
    "type": "text",
    "content": "Hello!",
    "mediaUrl": null,
    "quotedMessageId": null,
    "isFromMe": false
  }
}
```

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

## 5. Error Handling

### Error Response Format

All tool errors return a standard MCP error response:

```json
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "Error: Description of what went wrong"
  }]
}
```

### Common Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| `Instance 'X' not found` | Invalid `instanceId` | Check `whatsapp://instances` resource for valid IDs |
| `Instance 'X' is not connected` | Instance exists but is disconnected | Call `wa_connect_instance` first |
| `No adapter found for instance 'X'` | Instance not initialized | Call `wa_connect_instance` to initialize |
| `Phone number not registered on WhatsApp` | Number does not have WhatsApp | Verify with `wa_check_number_exists` before sending |
| `Not a group admin` | Operation requires admin privileges | Only group admins can modify settings, add/remove participants |
| `Cloud API token expired` | Meta access token is invalid or expired | Call `wa_set_cloud_credentials` with a new token |
| `Rate limit exceeded` | Too many messages in a short period | Wait and retry. Messages are queued with rate limiting. |
| `Media too large` | File exceeds size limits | See media limits below |

### Media Size Limits

| Media Type | Max Size (Baileys) | Max Size (Cloud API) | Supported Formats |
|------------|-------------------|---------------------|-------------------|
| Image | 16 MB | 5 MB | JPEG, PNG, WebP |
| Video | 16 MB | 16 MB | MP4, 3GPP |
| Audio | 16 MB | 16 MB | OGG (Opus), MP3, AAC, AMR |
| Document | 100 MB | 100 MB | PDF, DOC, XLS, PPT, TXT, ZIP, etc. |
| Sticker | 500 KB | 500 KB | WebP |

### Failure Mode Recovery

| Failure | Behavior | Recovery |
|---------|----------|----------|
| Instance disconnect | Auto-reconnect with exponential backoff (1s to 30s max, 10 attempts) | `wa_restart_instance` to retry, or `wa_connect_instance` for fresh QR |
| Redis down | Outbound queue stalls, inbound events dropped | Server retries Redis connection every 5s, resumes automatically |
| SQLite locked | Write operations retry 3x with 100ms delay | Extremely rare with WAL mode. Restart server if persistent. |
| Cloud API token expired | All Cloud instance operations fail with 401 | Call `wa_set_cloud_credentials` with new token |
| Message send fails | Job moves to "failed" in BullMQ | Check queue stats via `whatsapp://instances/{id}` resource |

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

Once configured, Claude will auto-discover all 60 WA MCP tools and can interact with WhatsApp directly.

### 6.3 LangChain (Python)

```python
from langchain_mcp import MCPToolkit

toolkit = MCPToolkit(
    server_url="http://localhost:3000/mcp",
    headers={"Authorization": "Bearer wamcp_sk_your_key"}
)

tools = toolkit.get_tools()
# tools now contains all 60 WA MCP tools, ready for any LangChain agent
```

---

## Appendix: Tool Count Summary

| Domain | Tools | Channel |
|--------|-------|---------|
| Instance Management | 8 | Both (2 Baileys only, 1 Cloud only) |
| Messaging | 17 | Both |
| Chat Management | 5 | Both |
| Group Management | 14 | Both |
| Contact Management | 4 | Both |
| Profile Management | 5 | Both |
| Status / Stories | 3 | Baileys only |
| Newsletter / Channels | 3 | Baileys only |
| Call Management | 1 | Baileys only |
| **Total** | **60** | |

| Resources | 10 |
|-----------|-----|
| Notifications | 12 |
