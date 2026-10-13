# Audio transcription

Audio transcription is optional and disabled by default. It uses an
OpenAI-compatible `POST /audio/transcriptions` endpoint.

Set these environment variables to enable it:

```env
WA_TRANSCRIPTION_ENABLED=true
WA_TRANSCRIPTION_API_KEY=your_api_key
WA_TRANSCRIPTION_BASE_URL=https://api.openai.com/v1
WA_TRANSCRIPTION_MODEL=whisper-1
# Optional language hint, such as en
WA_TRANSCRIPTION_LANGUAGE=en
WA_TRANSCRIPTION_MAX_MB=16
WA_TRANSCRIPTION_TIMEOUT_MS=60000
TRANSCRIPTION_CONCURRENCY=2
```

The provider URL, model, optional language, maximum input size, and timeout can
be changed for compatible providers. `TRANSCRIPTION_CONCURRENCY` limits how many
incoming audio downloads and transcriptions run at once. If transcription is
disabled or the key is missing, `wa_transcribe_audio` returns a
transcription-not-configured error and incoming message notifications omit the
transcription field.

## MCP tool

Use `wa_transcribe_audio` with either an incoming message ID:

```json
{
  "instanceId": "inst_1234abcd",
  "messageId": "message-id-from-whatsapp"
}
```

Or provide audio directly as an HTTPS URL or base64 string:

```json
{
  "audio": "base64-audio-data",
  "mimeType": "audio/ogg"
}
```

When transcription is enabled, incoming audio `whatsapp/message.received`
notifications include `message.transcription` when processing succeeds. This
work runs asynchronously after message ingestion; download or provider errors
leave the normal audio notification intact without that field.

For message-ID downloads, the existing SQLite message row retains Baileys audio
metadata needed to fetch and decrypt the media later, and Cloud API rows retain
the provider media ID. Audio bytes and transcription text are not persisted by
this feature.
