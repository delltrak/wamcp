[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/delltrak-wamcp-badge.png)](https://mseep.ai/app/delltrak-wamcp)

<p align="center">
  <img src="https://img.shields.io/badge/WhatsApp-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="WhatsApp" />
  <img src="https://img.shields.io/badge/MCP-000000?style=for-the-badge&logo=anthropic&logoColor=white" alt="MCP" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" />
</p>

<h1 align="center">🟢 WA MCP</h1>

<p align="center">
  <strong>The first WhatsApp integration built natively for AI Agents.</strong>
  <br />
  <em>Full MCP server exposing WhatsApp as discoverable tools, resources, and real-time notifications.</em>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-features">Features</a> •
  <a href="#-tools">Tools</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#%EF%B8%8F-configuration">Configuration</a> •
  <a href="#-docker">Docker</a> •
  <a href="#-contributing">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/delltrak/wamcp/actions/workflows/ci.yml"><img src="https://github.com/delltrak/wamcp/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/github/license/delltrak/wamcp?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square" alt="Node" />
  <img src="https://img.shields.io/badge/MCP-Streamable%20HTTP-blue?style=flat-square" alt="Transport" />
</p>

---

## 🤖 What is WA MCP?

**WA MCP** is a WhatsApp MCP server built with TypeScript that gives AI agents full access to WhatsApp through the [Model Context Protocol](https://modelcontextprotocol.io). It supports both **Baileys** (WhatsApp Web) and **Meta Cloud API** as dual-channel backends, deployable with **Docker** in a single command.

Your agent connects once and auto-discovers **63 tools**, **10 resources**, and **12 real-time events** — zero configuration, zero REST wrappers, zero glue code.

```
Your AI Agent ←→ MCP Protocol ←→ WA MCP ←→ WhatsApp
```

Instead of writing HTTP clients, parsing webhook payloads, and mapping endpoints to tools manually — your agent just **connects and goes**. Works out of the box with **Claude**, **Google ADK**, **LangChain**, and any MCP-compatible AI agent framework.

> 💡 **MCP** (Model Context Protocol) is the open standard for connecting AI agents to tools and data. WA MCP speaks MCP natively via Streamable HTTP and stdio transports.

---

## 🚀 Quick Start

### One command with Docker

```bash
docker compose up
```

That's it. WA MCP + Redis, ready on `http://localhost:3000/mcp`.

### Or run locally

```bash
# Prerequisites: Node.js >= 22, Redis running
npm install
cp .env.example .env

# Development (stdio transport)
npm run dev

# Production (HTTP transport)
npm run build && npm start
```

### Connect your agent

<details>
<summary>🐍 Google ADK (Python)</summary>

```python
from google.adk.tools.mcp_tool import McpToolset

tools = McpToolset(url="http://localhost:3000/mcp")

# Agent auto-discovers 63 WhatsApp tools
# wa_create_instance, wa_send_text, wa_send_image, ...
```

</details>

<details>
<summary>🦜 LangChain</summary>

```python
from langchain_mcp import McpToolkit

toolkit = McpToolkit(server_url="http://localhost:3000/mcp")
tools = toolkit.get_tools()
```

</details>

<details>
<summary>💻 Claude Desktop</summary>

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["path/to/wa-mcp/dist/index.js"],
      "env": {
        "WA_TRANSPORT": "stdio",
        "WA_REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

</details>

---

## ✨ Features

|     | Feature                | Description                                                                                               |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| 🔌  | **MCP-native**         | Streamable HTTP + stdio transports. No REST, no webhooks.                                                 |
| 📱  | **Dual-channel**       | Baileys (WhatsApp Web) + Meta Cloud API — same interface.                                                 |
| 🔄  | **Multi-instance**     | Run 1–50 WhatsApp numbers from a single server.                                                           |
| 📨  | **Full messaging**     | Text, images, video, audio, documents, polls, reactions, replies, forwards, edits, deletes, view-once.    |
| 👥  | **Groups**             | Create, manage members, promote/demote admins, settings, invite links, join requests, ephemeral messages. |
| 👤  | **Contacts & Profile** | Number check, block/unblock, business profiles, privacy, status updates.                                  |
| 📡  | **Real-time events**   | 12 notification types via SSE: messages, typing, groups, calls, connection status.                        |
| ⚡  | **Rate limiting**      | BullMQ queues prevent WhatsApp bans (20 msg/min Baileys, 80 msg/min Cloud).                               |
| 🔁  | **Auto-reconnect**     | Automatic reconnection with exponential backoff.                                                          |
| 🗃️  | **Persistent**         | SQLite storage for sessions, messages, contacts, groups.                                                  |
| 🐳  | **Single container**   | `docker compose up` — only Redis as external dependency.                                                  |

---

## 🛠️ Tools

WA MCP exposes **63 tools** across 9 domains. All tools use the `wa_` prefix.

<details>
<summary>📋 <strong>Instance Management</strong> (8 tools)</summary>

| Tool                       | Description                      |
| -------------------------- | -------------------------------- |
| `wa_create_instance`       | Create a new WhatsApp connection |
| `wa_connect_instance`      | Connect (generates QR code)      |
| `wa_disconnect_instance`   | Gracefully disconnect            |
| `wa_delete_instance`       | Permanently remove instance      |
| `wa_restart_instance`      | Disconnect + reconnect           |
| `wa_get_qr_code`           | Get QR as base64 (Baileys)       |
| `wa_get_pairing_code`      | Get pairing code (Baileys)       |
| `wa_set_cloud_credentials` | Set Cloud API token              |

</details>

<details>
<summary>💬 <strong>Messaging</strong> (17 tools)</summary>

| Tool                   | Description             |
| ---------------------- | ----------------------- |
| `wa_send_text`         | Send text message       |
| `wa_send_image`        | Send image with caption |
| `wa_send_video`        | Send video with caption |
| `wa_send_audio`        | Send audio / voice note |
| `wa_send_document`     | Send file / document    |
| `wa_send_location`     | Send GPS location       |
| `wa_send_contact`      | Send vCard contact      |
| `wa_send_poll`         | Create a poll           |
| `wa_send_reaction`     | React with emoji        |
| `wa_send_link_preview` | Send URL with preview   |
| `wa_forward_message`   | Forward a message       |
| `wa_edit_message`      | Edit sent message       |
| `wa_delete_message`    | Delete message          |
| `wa_pin_message`       | Pin a message           |
| `wa_send_view_once`    | Send view-once media    |
| `wa_send_presence`     | Show typing / recording |
| `wa_mark_read`         | Mark messages as read   |

</details>

<details>
<summary>💭 <strong>Chat Management</strong> (6 tools)</summary>

| Tool              | Description              |
| ----------------- | ------------------------ |
| `wa_get_messages` | Get chat message history |
| `wa_archive_chat` | Archive / unarchive      |
| `wa_pin_chat`     | Pin / unpin chat         |
| `wa_mute_chat`    | Mute / unmute            |
| `wa_delete_chat`  | Delete chat              |
| `wa_clear_chat`   | Clear chat history       |

</details>

<details>
<summary>👥 <strong>Groups</strong> (14 tools)</summary>

| Tool                           | Description                   |
| ------------------------------ | ----------------------------- |
| `wa_create_group`              | Create group                  |
| `wa_group_add_participants`    | Add members                   |
| `wa_group_remove_participants` | Remove members                |
| `wa_group_promote`             | Promote to admin              |
| `wa_group_demote`              | Demote from admin             |
| `wa_group_update_subject`      | Change group name             |
| `wa_group_update_description`  | Change description            |
| `wa_group_update_settings`     | Change settings               |
| `wa_group_leave`               | Leave group                   |
| `wa_group_get_invite_code`     | Get invite link               |
| `wa_group_revoke_invite`       | Revoke invite link            |
| `wa_group_join`                | Join via invite code          |
| `wa_group_toggle_ephemeral`    | Toggle disappearing messages  |
| `wa_group_handle_request`      | Approve / reject join request |

</details>

<details>
<summary>📇 <strong>Contacts</strong> (5 tools)</summary>

| Tool                      | Description                      |
| ------------------------- | -------------------------------- |
| `wa_search_contact`       | Search contacts by name or phone |
| `wa_check_number_exists`  | Check if number is on WhatsApp   |
| `wa_block_contact`        | Block contact                    |
| `wa_unblock_contact`      | Unblock contact                  |
| `wa_get_business_profile` | Get business profile             |

</details>

<details>
<summary>👤 <strong>Profile</strong> (5 tools)</summary>

| Tool                        | Description             |
| --------------------------- | ----------------------- |
| `wa_update_profile_picture` | Set profile picture     |
| `wa_remove_profile_picture` | Remove profile picture  |
| `wa_update_profile_name`    | Change display name     |
| `wa_update_profile_status`  | Change status text      |
| `wa_update_privacy`         | Update privacy settings |

</details>

<details>
<summary>📢 <strong>Status / Stories</strong> (3 tools)</summary>

| Tool                   | Description       |
| ---------------------- | ----------------- |
| `wa_send_text_status`  | Post text status  |
| `wa_send_image_status` | Post image status |
| `wa_send_video_status` | Post video status |

</details>

<details>
<summary>📰 <strong>Newsletter</strong> (3 tools)</summary>

| Tool                     | Description           |
| ------------------------ | --------------------- |
| `wa_newsletter_follow`   | Follow a newsletter   |
| `wa_newsletter_unfollow` | Unfollow a newsletter |
| `wa_newsletter_send`     | Send to newsletter    |

</details>

<details>
<summary>📞 <strong>Calls</strong> (1 tool)</summary>

| Tool             | Description          |
| ---------------- | -------------------- |
| `wa_reject_call` | Reject incoming call |

</details>

---

## 📖 Resources

Resources expose read-only WhatsApp state via `whatsapp://` URIs:

| URI                                           | Description                    |
| --------------------------------------------- | ------------------------------ |
| `whatsapp://instances`                        | List all instances             |
| `whatsapp://instances/{id}`                   | Instance details + queue stats |
| `whatsapp://instances/{id}/contacts`          | All contacts                   |
| `whatsapp://instances/{id}/chats`             | Active conversations           |
| `whatsapp://instances/{id}/groups`            | All groups                     |
| `whatsapp://instances/{id}/groups/{gid}`      | Group metadata                 |
| `whatsapp://instances/{id}/messages/{chatId}` | Message history                |
| `whatsapp://instances/{id}/profile`           | Own profile                    |
| `whatsapp://instances/{id}/privacy`           | Privacy settings               |
| `whatsapp://instances/{id}/blocklist`         | Blocked contacts               |

---

## 📡 Real-time Notifications

Events are pushed to agents via SSE (Server-Sent Events):

| Event                                 | Trigger                                        |
| ------------------------------------- | ---------------------------------------------- |
| `whatsapp/message.received`           | New incoming message                           |
| `whatsapp/message.updated`            | Status change (sent → delivered → read)        |
| `whatsapp/message.deleted`            | Message deleted                                |
| `whatsapp/message.reaction`           | Emoji reaction added/removed                   |
| `whatsapp/message.edited`             | Message edited                                 |
| `whatsapp/presence.updated`           | Typing / recording / online                    |
| `whatsapp/chat.updated`               | Chat metadata changed                          |
| `whatsapp/group.updated`              | Group info changed                             |
| `whatsapp/group.participants_changed` | Member add/remove/promote/demote               |
| `whatsapp/contact.updated`            | Contact info changed                           |
| `whatsapp/connection.changed`         | Instance status change (includes QR as base64) |
| `whatsapp/call.received`              | Incoming call                                  |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│              AI Agent Runtime               │
│    (Google ADK, Claude, LangChain, ...)     │
└──────────────────┬──────────────────────────┘
                   │  MCP Streamable HTTP
┌──────────────────▼──────────────────────────┐
│              WA MCP Server                  │
│                                             │
│  ┌────────────────────────────────────────┐ │
│  │  Layer 1 — MCP Transport (HTTP/stdio) │ │
│  ├────────────────────────────────────────┤ │
│  │  Layer 2 — MCP Core                   │ │
│  │  63 Tools │ 10 Resources │ 12 Events  │ │
│  ├────────────────────────────────────────┤ │
│  │  Layer 3 — Services                   │ │
│  │  Instance Manager │ Queue │ Dedup     │ │
│  ├────────────────────────────────────────┤ │
│  │  Layer 4 — Channel Abstraction        │ │
│  │  ┌──────────────┐ ┌────────────────┐  │ │
│  │  │   Baileys    │ │   Cloud API    │  │ │
│  │  │  (WebSocket) │ │    (HTTPS)     │  │ │
│  │  └──────────────┘ └────────────────┘  │ │
│  └────────────────────────────────────────┘ │
│       SQLite (Drizzle)    BullMQ (Redis)    │
└─────────────────────────────────────────────┘
                   │
                   ▼  WebSocket / HTTPS
          WhatsApp Servers
```

### Dual-Channel Design

|            | Baileys                  | Cloud API                |
| ---------- | ------------------------ | ------------------------ |
| Protocol   | WhatsApp Web (WebSocket) | Meta Official (HTTPS)    |
| Auth       | QR Code / Pairing Code   | Access Token             |
| Cost       | Free                     | Per-conversation pricing |
| Compliance | Unofficial               | Meta-approved            |
| Best for   | Dev, testing, low volume | Production, enterprise   |

Both backends implement the same `ChannelAdapter` interface. Your agent doesn't know or care which one is active — the tools work identically.

---

## ⚙️ Configuration

Copy `.env.example` to `.env` and configure:

| Variable                    | Default                  | Description                              |
| --------------------------- | ------------------------ | ---------------------------------------- |
| `WA_TRANSPORT`              | `http`                   | `http` (Streamable HTTP) or `stdio`      |
| `WA_MCP_API_KEY`            | —                        | Bearer token auth. Unset = no auth (dev) |
| `WA_MCP_PORT`               | `3000`                   | HTTP server port                         |
| `WA_REDIS_URL`              | `redis://localhost:6379` | Redis for BullMQ queues                  |
| `WA_LOG_LEVEL`              | `info`                   | `debug` \| `info` \| `warn` \| `error`   |
| `WA_BAILEYS_RATE_LIMIT`     | `20`                     | Messages/min per Baileys instance        |
| `WA_CLOUD_RATE_LIMIT`       | `80`                     | Messages/min per Cloud API instance      |
| `WA_MESSAGE_RETENTION_DAYS` | `30`                     | Auto-delete old messages                 |
| `WA_AUTO_RECONNECT`         | `true`                   | Auto-reconnect on disconnect             |
| `WA_MEDIA_CACHE_MAX_MB`     | `500`                    | Media cache size limit                   |
| `WA_CLOUD_WEBHOOK_SECRET`   | —                        | Meta webhook verification                |
| `WA_CLOUD_WEBHOOK_PORT`     | `3001`                   | Webhook receiver port                    |
| `WA_VERSION_CHECK`          | `true`                   | Daily WhatsApp Web version check         |

---

## 🐳 Docker

### Production

```bash
docker compose up -d
```

Services:

- **wa-mcp** — The MCP server on port `3000`
- **redis** — BullMQ backend with AOF persistence

### Health Check

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "uptime": 3600,
  "instances": { "total": 3, "connected": 2, "disconnected": 1 },
  "version": "1.0.0"
}
```

### Resource Requirements

| Instances | RAM    | CPU      | Disk  |
| --------- | ------ | -------- | ----- |
| 1–5       | 256 MB | 0.5 vCPU | 1 GB  |
| 5–20      | 512 MB | 1 vCPU   | 5 GB  |
| 20–50     | 1 GB   | 2 vCPU   | 10 GB |

---

## 📁 Project Structure

```
src/
├── index.ts                     # Entry point (HTTP/stdio)
├── constants.ts                 # Defaults and limits
├── server/mcp.ts                # MCP server setup
├── tools/                       # 🔧 63 MCP tools (9 files)
├── resources/                   # 📖 10 MCP resources (8 files)
├── notifications/events.ts      # 📡 12 event types
├── channels/
│   ├── channel.interface.ts     # ChannelAdapter contract
│   ├── baileys/                 # Baileys implementation
│   └── cloud-api/               # Cloud API implementation
├── services/
│   ├── instance-manager.ts      # Instance lifecycle
│   ├── message-queue.ts         # BullMQ rate limiting
│   ├── dedup.ts                 # Message deduplication
│   └── media.ts                 # Media handling
├── db/
│   ├── schema.ts                # Drizzle table definitions
│   └── client.ts                # SQLite connection
├── schemas/                     # Zod validation (9 files)
└── types/                       # TypeScript definitions
```

---

## 🗺️ Roadmap

- [x] **Phase 1** — Foundation: Baileys adapter, text messaging, QR auth, instance management
- [x] **Phase 2** — Full messaging: all media types, dedup, reactions, edits, forwards
- [x] **Phase 3** — Groups, contacts, profile, status/stories, newsletters
- [x] **Phase 4** — Cloud API adapter: dual-channel unified interface
- [x] **Phase 5** — Hardening: error recovery, CI/CD, tests, docs, v1.0 release
- [x] **Phase 6** — Baileys v7 upgrade, LID support, contact sync, message persistence

---

## 🤝 Contributing

Contributions are welcome! Here's how the codebase is organized:

1. **One file per domain** — tools, resources, schemas, and channels each have domain-specific files
2. **Zod schemas for everything** — all tool inputs are validated with strict Zod schemas in `src/schemas/`
3. **Both adapters** — new features should be implemented in Baileys and stubbed in Cloud API
4. **Layered architecture** — tools → services → channels. No cross-layer imports.
5. **Structured logging** — use Pino, never `console.log`

```bash
# Development
npm run dev          # Start with stdio transport
npm run build        # Type-check + compile
npx tsc --noEmit     # Type-check only
```

---

## 📄 License

MIT — do whatever you want.

---

<p align="center">
  <strong>Built for the agentic era.</strong>
  <br />
  <em>Stop writing REST wrappers. Let your agent discover WhatsApp.</em>
</p>
