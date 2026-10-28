# Native OTP delivery

`wa_send_otp` sends the native WhatsApp authentication template, including its OTP copy-code button.
It uses a **Cloud API** instance. Baileys cannot send that native template and returns an actionable
unsupported-channel error. No normal-text fallback is sent.

## Setup

1. Configure a Cloud API instance and an approved `AUTHENTICATION` template in Meta with an OTP
   copy-code/URL button at index 0. Use its exact name and approved locale. This tool does not create
   or approve templates, and does not support zero-tap or mobile-app handshake provisioning.
2. Configure a private `WA_OTP_ENCRYPTION_KEY` in the WAMCP process: a 32-byte key encoded as 64 hex
   characters. Generate it with `openssl rand -hex 32`, store it in your secret manager/environment,
   and never commit it. Producers and workers must use the same key across restarts. Changing the
   key makes pending encrypted payloads unreadable; issue a new code through your backend.
3. Your trusted authentication backend generates a cryptographically random code, binds it to the
   intended user/session/purpose, limits issuance and verification attempts, and enforces expiry
   and single use. Call WAMCP from that backend; do not ask an LLM to generate production codes or
   include them in model prompts, memory or application logs.

Synthetic example:

```json
{
  "instanceId": "cloud-instance",
  "to": "5500000000001",
  "templateName": "login_code",
  "languageCode": "pt_BR",
  "otpCode": "A1B2C3",
  "requestId": "backend-request-123",
  "deliveryTtlSeconds": 120
}
```

The response contains `status: queued`, `jobId` and an absolute `deliverBefore`. It never returns
the code. Queued does not mean delivered. Use a fresh request ID for every issuance, and reuse an
ID only when checking/retrying submission of the same code/template to the same recipient. Queue
records retain that ID for 24 hours; do not reuse IDs after their retention window.

## Storage and failure handling

The payload is encrypted with AES-256-GCM before Redis sees it; instance, recipient and queue
expiry are authenticated as additional data. A keyed digest detects request-ID reuse with another
code/template without storing a plaintext code or an easily brute-forced unkeyed OTP hash.
Groups, LIDs, newsletters and status broadcasts are refused.

The per-instance Cloud API limiter applies. A worker refuses an expired envelope, persists its
consumption **before** calling Meta, and does not automatically retry OTP delivery. Thus an
interrupted worker cannot resend a code whose delivery may already have happened. A crash after
consumption but before sending can lose a delivery: the caller must handle that uncertain outcome
through its normal authentication flow. Do not manually retry the old job or infer success from
`queued`. A new issuance should invalidate the old code in the authentication backend.

Consumed envelopes are removed from the job. If cleanup cannot run, only ciphertext remains until
queue retention removes the record. Redis persistence/backups can also retain ciphertext; protect
and manage the encryption key separately. Provider errors are replaced by generic OTP errors so
an error response cannot echo the code. WAMCP's structured logger redacts `otpCode`; callers must
also avoid logging their MCP request bodies.

This path does not write an outgoing plaintext message into WAMCP's message history. It cannot
control Meta's processing, recipients' devices, their notification previews, external client logs
or your backend's storage. Do not claim complete erasure of all copies.

`deliveryTtlSeconds` only bounds the local queue wait. It does not change Meta's approved template
footer, the application's verification expiry, or the recipient's message history. Delivered OTP
messages are not automatically deleted. Sending and answering a code in the same compromised
WhatsApp account does not provide an independent second factor.

## Validation

Unit tests cover strict input validation, correct native template payload, rejection of Baileys
and groups, encrypted queue contents, code-free responses/errors, stable request IDs, payload
binding, queue deadlines, key changes, failed consumption writes and stalled-worker replays.
No real WhatsApp recipient or paid Cloud API send is used in these tests.

References: [Meta's authentication template collection](https://www.postman.com/meta/whatsapp-business-platform/folder/huymv7d/templates),
[authentication template parameters](https://www.twilio.com/docs/content/whatsappauthentication),
and [OWASP OTP handling](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html#one-time-password-otp-handling-and-storage).
