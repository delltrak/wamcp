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
| `WA_CHATWOOT_ALLOW_LEGACY_SECRET` | `false` | Accept `?secret=` and the older secret headers |
| `WA_CHATWOOT_BLOCK_GROUP_REPLIES` | `false` | Drop agent replies whose destination is a group |
| `WA_CHATWOOT_TIMEOUT_MS` | `10000` | HTTP timeout, 1–120000 ms |

HTTPS and a public host are required unless the matching allow flag is set. Credentials in the URL are rejected. Link-local and cloud metadata addresses are rejected even when private URLs are allowed.

Database path, Baileys auth, and Docker volumes are unchanged. Chatwoot state is not stored in SQLite; the bridge asks Chatwoot for the contact and conversation and keeps an in-memory cache for the life of the process.

## Chatwoot inbox

1. In Chatwoot, add an inbox and choose **API**.
2. Set the inbox webhook URL to `https://<your-wamcp-host>/chatwoot/webhook` with no query string. Chatwoot generates the API inbox webhook secret. Copy that value into `WA_CHATWOOT_WEBHOOK_SECRET`.
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
| `X-Chatwoot-Delivery` | Delivery id. Repeats are ignored until the timestamp leaves the 300 second window |

The timestamp must be within 300 seconds of the server clock. The comparison uses `timingSafeEqual`. A missing or wrong signature returns `401` and does not send a WhatsApp message. A valid agent reply is answered `202` before attachments are downloaded, so Chatwoot's own timeout does not mark the message failed.

`?secret=`, `X-Chatwoot-Webhook-Secret`, and `X-Wa-Chatwoot-Secret` authenticate only when `WA_CHATWOOT_ALLOW_LEGACY_SECRET=true` and the signature headers are absent. Leave that flag off. A query secret is stored in proxy and access logs. `X-Hub-Signature-256` is not accepted. The MCP API key is not used for this route.

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
- the contact-inbox `source_id` is a WhatsApp JID (`…@s.whatsapp.net`, `…@g.us`, or `…@lid`), or `inst_<id>|<jid>` with a real instance id
- that instance already exists
- the destination chat is not filtered
- the destination is not a group when `WA_CHATWOOT_BLOCK_GROUP_REPLIES=true`

`@lid` is accepted because Baileys keeps that remote JID when the chat has no phone alternate. A destination ending in `@newsletter` is ignored with HTTP 200 and a log line. A missing instance returns `422` before the reply is accepted.

The webhook returns `202` after authentication and deduplication. Text and attachments are queued afterwards. At most 8 attachments are downloaded, and their bytes together stay within 16 MB. An attachment that does not fit in that budget is skipped and reported, both in the log (`attachment_budget`) and as a private note when the conversation id is known. Each download resolves DNS, pins that address, refuses redirects, and always blocks link-local and metadata addresses. `WA_CHATWOOT_ALLOW_PRIVATE_URL` does not allow a private attachment host other than the configured Chatwoot origin. A URL that fails those checks is not passed to WhatsApp. If the download or the outbound queue fails after the `202`, the bridge posts a private note on the conversation. The Chatwoot application API has no call to mark that accepted message as failed. The Chatwoot API token is sent only when the attachment URL is on that origin. Shutdown waits up to 5 seconds for those background replies.

The reply target is the contact-inbox `source_id` written by this bridge. Conversation `additional_attributes` are not used, because an agent can edit them. The instance is then:

1. the instance encoded in that source id, when the prefix is a valid `inst_…` id
2. `WA_CHATWOOT_INSTANCE_ID`
3. the only configured instance, when exactly one exists

Without a pinned instance, the contact source id is `inst_<id>|<chat jid>`, so two instances can share one inbox and replies return to the instance that received the chat. With `WA_CHATWOOT_INSTANCE_ID` set, both the bare chat JID and `inst_<id>|<chat jid>` for that same instance are accepted. A different instance prefix is rejected. Unknown prefixes are not treated as the chat id.

## Not included

History import, direct writes to the Chatwoot database, automatic inbox creation, and edit or delete mirroring are not part of this bridge. Live messages and agent replies use the Chatwoot REST API only.
