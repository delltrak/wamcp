# Outgoing event webhooks

Outgoing event webhooks let an automation endpoint receive normalized channel
events without keeping an MCP connection open. Delivery uses a dedicated BullMQ
queue. Failed requests time out and retry with exponential backoff; queue or
delivery errors do not interrupt incoming message processing.

## Configuration

Set `WA_EVENT_WEBHOOK_URL` to enable delivery. HTTPS is required by default, and
private or local network targets are rejected. `WA_EVENT_WEBHOOK_ALLOW_HTTP=true`
allows HTTP for a trusted public endpoint while retaining the private-host
check.

| Variable | Default | Description |
| --- | --- | --- |
| `WA_EVENT_WEBHOOK_URL` | unset | Single outgoing event destination; unset disables the feature. |
| `WA_EVENT_WEBHOOK_EVENTS` | `message.received` | Comma-separated channel events to forward. |
| `WA_EVENT_WEBHOOK_IGNORE_FROM_ME` | `true` | Skip messages sent by this WhatsApp instance. |
| `WA_EVENT_WEBHOOK_HEADERS` | unset | JSON object containing additional HTTP headers with string values. |
| `WA_EVENT_WEBHOOK_AUTH_HEADER` | unset | Optional authentication header name; configure with `AUTH_VALUE`. |
| `WA_EVENT_WEBHOOK_AUTH_VALUE` | unset | Authentication header value. Overrides a matching header from `HEADERS`. |
| `WA_EVENT_WEBHOOK_SECRET` | unset | HMAC-SHA256 signing secret. |
| `WA_EVENT_WEBHOOK_ALLOW_HTTP` | `false` | Allow `http://` destinations; private and local targets are still blocked. |
| `WA_EVENT_WEBHOOK_TIMEOUT_MS` | `10000` | Per-request timeout, from 1 to 300000 ms. |
| `WA_EVENT_WEBHOOK_RETRY_ATTEMPTS` | `5` | Total attempts per event, from 1 to 100. |
| `WA_EVENT_WEBHOOK_RETRY_DELAY_MS` | `1000` | Initial exponential backoff delay, from 1 to 300000 ms. |

`WA_EVENT_WEBHOOK_HEADERS` and the auth header pair can be combined. The
explicit auth pair takes precedence when both configure the same header. Header
values and URL query strings are not written to logs.

## Request format

The body for `message.received` is:

```json
{
  "event": "message.received",
  "instanceId": "inst_1234abcd",
  "chat": "5511888888888@s.whatsapp.net",
  "sender": "5511888888888@s.whatsapp.net",
  "type": "text",
  "text": "Hello",
  "timestamp": 1700000000
}
```

When `WA_EVENT_WEBHOOK_SECRET` is configured, requests include
`X-WA-Event-Timestamp` (Unix seconds) and
`X-WA-Event-Signature: sha256=<hex digest>`. The digest is HMAC-SHA256 over the
timestamp, a period, and the exact UTF-8 request body:

```text
HMAC_SHA256(secret, timestamp + "." + body)
```
