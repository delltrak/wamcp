# n8n-nodes-wamcp

Community nodes for [WA MCP](https://github.com/delltrak/wamcp). The package stays in this repository and is **not published to npm**.

It talks to the existing Streamable HTTP MCP endpoint (`POST /mcp`). It does not add a second WhatsApp API.

## Install locally

From an n8n installation that allows community nodes:

```bash
npm install /absolute/path/to/wamcp/integrations/n8n-nodes-wamcp
```

Restart n8n. The palette then contains **WA MCP** and **WA MCP Trigger**.

## Credential

| Field | Value |
| --- | --- |
| Base URL | Origin of the WA MCP HTTP server, for example `http://localhost:3000` |
| API Key | `WA_MCP_API_KEY`, or empty when the server does not require one |
| Default Instance ID | Optional `inst_…` used when a node leaves Instance ID blank |

The credential test calls `GET /health`.

## Trigger

**WA MCP Trigger** exposes `POST /webhook/wamcp` (the production URL is shown on the node).

Point the existing event webhook at that URL and set **Webhook Secret** to the same value as `WA_EVENT_WEBHOOK_SECRET` for that destination. This does not replace or wrap `WA_EVENT_WEBHOOK_*`; it is one more destination you configure yourself.

```bash
WA_EVENT_WEBHOOK_URL=https://n8n.example.com/webhook/wamcp
WA_EVENT_WEBHOOK_EVENTS=message.received
WA_EVENT_WEBHOOK_SECRET=replace-with-a-long-random-secret
```

The trigger checks `x-wa-event-timestamp` and `x-wa-event-signature`. The signature is HMAC-SHA256 of `<timestamp>.<raw body>` using the node secret, compared with `timingSafeEqual`, and the timestamp must be within 300 seconds. A missing raw body or a bad signature is answered with HTTP 401 from the webhook response object and does not start the workflow. Webhook Secret is required. Flows that were saved without it stop receiving events until the secret is set. The node does not rebuild the signed payload from the parsed JSON.

The trigger emits one item per event. Batches posted as `{ "events": [...] }` or `{ "messages": [...] }` are expanded. Each item includes `event`, `instanceId`, `chat` (copied from `chatId` when needed), and `text`. `message.received` from WA MCP also includes `isFromMe`.

The Events field is a comma-separated allowlist. The default is `message.received`.

## Actions

| Operation | MCP tool |
| --- | --- |
| Send Text | `wa_send_text` |
| Send Image | `wa_send_image` |
| Send Audio | `wa_send_audio` |
| Send Document | `wa_send_document` |
| Get Instance Status | `wa_get_instance_status` |

Sends go through the normal WA MCP queue and return `{ "status": "queued", "jobId": "..." }`.

## Example flow

Import [`examples/reply-on-message.json`](examples/reply-on-message.json).

1. The trigger receives `message.received` after the signature check.
2. **Direct chats only** drops groups (`@g.us`), newsletters (`@newsletter`), status broadcasts (`status@broadcast` and other `@broadcast` chats), and events with `isFromMe` or `fromMe`.
3. **Send text** replies in the remaining direct chat.

If two automations both reply, they can loop. Add a per-chat cooldown in the workflow, and skip a chat that was already answered in the last few minutes, before Send text.

Replace the credential placeholder and the trigger secret, set `WA_EVENT_WEBHOOK_URL` and `WA_EVENT_WEBHOOK_SECRET`, and activate the workflow. A pinned sample item is included so the send node can be inspected before a live event arrives.
