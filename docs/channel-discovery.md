# Channel discovery and queued-send tracking

These three read-only tools help agents select a supported operation and check its outcome without
starting a worker, retrying a send, changing account settings or exposing message content.

## `wa_get_channel_capabilities`

Input: `{ "instanceId": "inst_example" }`.

Returns `instanceId`, `channel`, `connectionState` and a `features` map. Each feature contains
`supported`, representative `tools`, `requirements` and optional `notes`. It works while the
instance is disconnected. This is a summary of this server's implemented features, not a complete
tool catalog, remote entitlement probe or permission grant. Requirements must still be satisfied
when executing a tool. Existing agent/community/user authorization rules still apply.

For example, Baileys supports presence and group messages, but not native authentication templates.
Cloud API supports approved authentication templates and native interactive buttons/lists; the
current Cloud adapter does not implement presence, group management or participant-level receipts.
Baileys buttons/lists use the existing text fallback. Write gates, account roles, connection status,
Meta messaging rules and account feature availability remain relevant.

## `wa_list_authentication_templates`

Input: `{ "instanceId": "inst_example", "limit": 25, "approvedOnly": true }`.

Requires Cloud API credentials with `businessId` set to the **WhatsApp Business Account (WABA) ID**,
not the Business Portfolio ID, and an access token with `whatsapp_business_management` permission.
Uses `GET /<WABA-ID>/message_templates`. It does not create or approve templates or connect the
instance. Baileys is rejected before any provider request.

Each call scans one Meta page (`limit`: 1–100 records, default 25), filters to `AUTHENTICATION`, and
by default includes only `APPROVED` records. Set `approvedOnly: false` to inspect other approval
states. Returns `{ templates, nextCursor, hasMore }`. A page can be empty after filtering and still
have `hasMore: true`; pass `nextCursor` as `after` to continue. Only opaque cursors are accepted;
provider pagination URLs are never followed or returned. Requests use the fixed Graph API origin,
reject redirects, and have a 15-second deadline.

Template metadata contains `id`, `name`, exact `languageCode`, `status`, `otpButtonType`,
`compatibleWithSendOtp` and optional footer duration as `codeExpirationMinutes` (null if absent).
Compatibility is true only for approved, single-button copy-code templates with recognized OTP/URL
button metadata. Autofill/unknown shapes are not advertised as compatible. Approval can change
after discovery; `wa_send_otp` is still subject to Meta validation. A footer duration does not
implement backend code expiry or message deletion. See [OTP delivery](otp.md).

Template text, example codes, provider error text, credentials and token-bearing pagination URLs
are omitted from results and request logs.

## `wa_get_job_status`

Input: `{ "instanceId": "inst_example", "jobId": "123" }`.

Use the `jobId` returned by a **queued** send. This is different from a WhatsApp `messageId` and from
a schedule ID. Direct operations that return only `messageId` are not BullMQ jobs.

Returns the BullMQ `state` (such as `waiting`, `active`, `delayed`, `completed`, `failed`), `kind`,
`attemptsMade`, `processedAt`, `finishedAt`, `message` and `receipts`. Job timestamps and the send
result timestamp are Unix milliseconds. A missing/removed job returns only
`{ instanceId, jobId, state: "missing" }`; missing does not prove that no message was sent.

Completed message sends now persist a whitelisted result:

```json
{
  "messageId": "wamid.example",
  "timestamp": 1700000000000,
  "status": "sent"
}
```

Older completed jobs and non-message jobs (such as member-label updates) may have `message: null`.
Album results identify the adapter's returned album/message ID, not every media item's delivery.
The queue result is visible after a service restart without starting an outbound worker. The tool
checks instance ownership, never reads job logs, and omits payloads, ciphertext, message text, OTPs,
stack traces and provider failure text. Failed jobs return a generic uncertainty notice and are
never retried by inspection.

`completed` means the worker finished; the returned `sent` result means the adapter accepted the
send. Neither proves delivery or reading by the recipient. `receipts.counts` reports **exclusive
latest stored states** (`delivered`, `read`, `played`) of observed participants. A participant in
`read` is not also counted in `delivered`. `scope: "observed_participants_only"` never implies that
all group members read the message. `latestObservedAt` is an ISO timestamp or null. Missing receipts
do not prove that a recipient has not read it; privacy settings, webhook delivery and local
retention affect observations. Use `wa_get_message_receipts` on Baileys for participant details.

Cloud delivered/read webhooks now persist receipt metadata, including for OTPs without storing
their content. Provider seconds are converted to milliseconds, matching existing Baileys receipt
storage; summaries render either channel's stored milliseconds as ISO timestamps. Out-of-order
events cannot lower a read receipt to delivered. Failed Cloud delivery
webhooks are logged and no longer mislabeled as successful `sent` events. These counts do not
report delivery failures; inspect the existing delivery event/log diagnostics when necessary.

Job visibility follows existing queue cleanup: ordinary completed jobs can be removed after an hour,
failed jobs after 24 hours, and schedules may be reconciled/removed by the scheduler. Mixed-queue
cleanup can remove an OTP job earlier than its separate 24-hour idempotency reservation. The OTP
request reservation is independent and still prevents another send within its window. This tool
is not a permanent audit archive. Redis failures are errors, not `missing`.

## Validation

Synthetic adapter responses verify Cloud API pagination, filtering, metadata redaction and channel
restrictions. Database tests run under both SQLite and PostgreSQL CI and cover out-of-order receipts,
instance isolation and group counts. Queue tests cover old jobs, terminal/pending states, safe worker
results and read-only lookup after restart; the disposable-Redis suite also reads a real completed
BullMQ OTP result from a fresh service. No live Meta calls or real WhatsApp sends are used by tests.

Provider references: [Meta's template API collection](https://www.postman.com/meta/whatsapp-business-platform/request/qtgr0i7/get-all-templates-default-fields),
[BullMQ return values](https://docs.bullmq.io/guide/returning-job-data).
