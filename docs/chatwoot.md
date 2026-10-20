# Chatwoot

WA MCP can mirror WhatsApp chats into a Chatwoot **API channel** inbox and send agent replies back to WhatsApp.

The bridge is off by default. `WA_CHATWOOT_ENABLED=false` means:

- incoming WhatsApp messages are not copied to Chatwoot
- `POST /chatwoot/webhook` responds `404`
- nothing is queued to WhatsApp on Chatwoot's behalf

Turning the flag on opts in to both directions. Agent replies are WhatsApp writes, so they stay behind this flag rather than `WA_APP_STATE_WRITES_ENABLED`. `WA_EVENT_WEBHOOK_*` is a separate listener and is unchanged.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `WA_CHATWOOT_ENABLED` | `false` | Master switch for inbound sync and agent replies |
| `WA_CHATWOOT_URL` | unset | Chatwoot base URL, no trailing slash required |
| `WA_CHATWOOT_TOKEN` | unset | User API access token (`api_access_token`) |
| `WA_CHATWOOT_ACCOUNT_ID` | unset | Numeric account id from `/app/accounts/<id>/` |
| `WA_CHATWOOT_INBOX_ID` | unset | Numeric API-channel inbox id |
| `WA_CHATWOOT_WEBHOOK_SECRET` | unset | Shared secret for the inbound webhook. At least 16 characters |
| `WA_CHATWOOT_IGNORE_JIDS` | unset | JID filter, comma-separated |
| `WA_CHATWOOT_INSTANCE_ID` | unset | Use only this `inst_…` instance |
| `WA_CHATWOOT_ALLOW_HTTP` | `false` | Allow an `http` URL. Public-host checks still apply |
| `WA_CHATWOOT_ALLOW_PRIVATE_URL` | `false` | Allow a private or single-label Chatwoot host |
| `WA_CHATWOOT_TIMEOUT_MS` | `10000` | HTTP timeout, 1–120000 ms |

HTTPS and a public host are required unless the matching allow flag is set. Credentials in the URL are rejected. Link-local and cloud metadata addresses are rejected even when private URLs are allowed.

Database path, Baileys auth, and Docker volumes are unchanged. Chatwoot state is not stored in SQLite; the bridge asks Chatwoot for the contact and conversation and keeps an in-memory cache for the life of the process.

## Chatwoot inbox

1. In Chatwoot, add an inbox and choose **API**.
2. Set the inbox webhook URL to `https://<your-wamcp-host>/chatwoot/webhook` with no query string. Put the same value in the Chatwoot webhook secret and in `WA_CHATWOOT_WEBHOOK_SECRET`.
3. Copy the numeric account id and inbox id into `WA_CHATWOOT_ACCOUNT_ID` and `WA_CHATWOOT_INBOX_ID`.
4. Copy a user access token into `WA_CHATWOOT_TOKEN`.
5. Set `WA_CHATWOOT_ENABLED=true` and restart WA MCP.

The HTTP transport is required for agent replies. On stdio, inbound sync can still run, and the process logs that replies need `POST /chatwoot/webhook`.

## Webhook secret

Chatwoot v4.13+ signs each API-channel delivery. The webhook URL must not contain the secret.

| Header | Value |
| --- | --- |
| `X-Chatwoot-Timestamp` | Unix time, in seconds |
| `X-Chatwoot-Signature` | `sha256=` plus HMAC-SHA256 of `<timestamp>.<raw body>` using `WA_CHATWOOT_WEBHOOK_SECRET` |
| `X-Chatwoot-Delivery` | Delivery id. A repeat within the process is ignored |

The timestamp must be within 300 seconds of the server clock. The comparison uses `timingSafeEqual`. A missing or wrong signature returns `401` and does not send a WhatsApp message.

`?secret=` still authenticates when the signature headers are absent. Leave it unused: the value is stored in proxy and access logs. `X-Chatwoot-Webhook-Secret` and `X-Wa-Chatwoot-Secret` are the same kind of legacy header, for a caller that is not Chatwoot. `X-Hub-Signature-256` is not accepted. The MCP API key is not used for this route.

## What is synced

For each `message.received` event that passes the instance and JID filters, the bridge:

1. Searches or creates a Chatwoot contact in the configured inbox.
2. Reuses an open conversation for that inbox, reopens a resolved or snoozed one, or creates a conversation.
3. Posts the message. Customer messages are `incoming`. Messages sent by the WhatsApp account are `outgoing` with source id `WAID:<message id>`.

`status@broadcast`, other `@broadcast` chats, and `@newsletter` chats are never copied.

`WA_CHATWOOT_IGNORE_JIDS` accepts:

- an exact JID, such as `15551234567@s.whatsapp.net`
- a suffix that starts with `@`, such as `@g.us` or `@lid`
- a `*` wildcard, such as `*@lid`

A pattern of `*` alone is rejected.

Group messages from other people are prefixed with the sender name (`Ada: hello`).

## Agent replies

Chatwoot `message_created` events are sent only when all of the following are true:

- `message_type` is outgoing (string or `1`)
- the note is not private and not marked deleted
- `source_id` does not start with `WAID:`
- the sender is not a contact
- `conversation.inbox_id` is present and equal to `WA_CHATWOOT_INBOX_ID`
- the destination chat is not filtered

Text is queued with `wa_send_text` semantics through the existing per-instance BullMQ queue. Image, video, audio, and file attachments are downloaded by WA MCP and queued as bytes. The download resolves DNS, pins that address, refuses redirects, and always blocks link-local and metadata addresses. A URL that fails those checks is dropped and is not passed to WhatsApp. The Chatwoot API token is sent only when the attachment URL is on the configured Chatwoot origin.

The reply target is the contact-inbox `source_id` written by this bridge. Conversation `additional_attributes` are not used, because an agent can edit them. The instance is then:

1. the instance encoded in that source id
2. `WA_CHATWOOT_INSTANCE_ID`
3. the only configured instance, when exactly one exists

Without a pinned instance, the contact source id is `inst_<id>|<chat jid>`, so two instances can share one inbox and replies return to the instance that received the chat. With `WA_CHATWOOT_INSTANCE_ID` set, the source id is the bare chat JID and other instances are ignored.

## Not included

History import, direct writes to the Chatwoot database, automatic inbox creation, and edit or delete mirroring are not part of this bridge. Live messages and agent replies use the Chatwoot REST API only.
