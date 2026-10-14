# Text-to-speech voice notes

`wa_send_voice` converts text into a WhatsApp push-to-talk voice note. TTS is off by default and
uses ElevenLabs first; the provider interface under `src/tts/` allows another provider to be added.
Voice notes currently require a Baileys instance because the Cloud API does not expose Baileys'
`ptt` flag.

## Setup

1. Create an API key in ElevenLabs and choose a voice from your account.
2. Set `WA_TTS_ENABLED=true`, `WA_TTS_API_KEY`, and `WA_TTS_DEFAULT_VOICE_ID` in the server's
   environment. Keep the key out of source control.
3. Restart the server, then call `wa_send_voice` with an instance ID, recipient, and text.

Voice Design voices must first be created in ElevenLabs. Once created, use the voice's `voice_id`
as `WA_TTS_DEFAULT_VOICE_ID` or pass it as `voiceId`. `wa_tts_list_voices` lists the voices
available to the configured API key, including created voices.

```json
{
  "instanceId": "my-baileys-instance",
  "to": "<recipient-phone-number>",
  "text": "Your appointment is confirmed.",
  "languageCode": "en",
  "stability": 0.5,
  "similarityBoost": 0.75,
  "quotedMessageId": "message-to-reply-to"
}
```

`wa_tts_preview` accepts text and the same voice options, and returns base64 audio without sending a
message. Both synthesis tools can override `voiceId`, `modelId`, and `languageCode`; voice settings
include `stability`, `similarityBoost`, `style`, `speed`, and `useSpeakerBoost`.

## Models and audio format

The default model is `eleven_v3`. Set `WA_TTS_MODEL` or pass `modelId` to select another supported
ElevenLabs model: `eleven_v4`, `eleven_v4_turbo`, `eleven_v3`, `eleven_v3_conversational`,
`eleven_multilingual_v2`, or `eleven_flash_v2_5`.

The default output format is `opus_48000_64`, which requests OGG/Opus directly. The service checks
the `OggS` container signature before reusing provider output. Other formats, and all multi-chunk
output, are converted or joined with ffmpeg as mono 48 kHz Opus in an OGG container. Install system
ffmpeg or set `WA_TTS_FFMPEG_PATH` to its executable. The Docker runtime image includes ffmpeg.
ElevenLabs supports Opus output formats from `opus_48000_32` through `opus_48000_192`, and
`mp3_44100_128`.

Baileys voice notes include a 64-bar waveform and whole-second duration when ffmpeg can decode the
audio. `wa_send_audio` uses the same behavior with `ptt: true`; non-Opus PTT audio is converted to
mono 48 kHz OGG/Opus first. Waveform analysis decodes mono 16 kHz PCM, and `WA_TTS_FFMPEG_PATH`
and `WA_TTS_TIMEOUT_MS` apply to this work too. If conversion or analysis fails, the message is
still sent with the existing PTT behavior, without waveform or duration. Non-PTT audio sends and
Cloud API audio behavior are unchanged.

Long text is split into chunks with neighboring text sent to the provider for continuity. The full
input is limited by `WA_TTS_MAX_CHARS` (default 5000). Failed requests are retried with backoff and
jitter only for HTTP 429 and 5xx responses. `WA_TTS_TIMEOUT_MS` applies to each provider request
and ffmpeg conversion or waveform decode. `TTS_CONCURRENCY` (default 2) limits simultaneous
synthesis and conversion work across `wa_send_voice` and `wa_tts_preview`.
`WA_TTS_BASE_URL` accepts a host such as `https://api.eu.residency.elevenlabs.io`; `/v1` is added
automatically, or retained if included in the configured URL. HTTPS is required except for local
testing with `http://localhost` or `http://127.0.0.1`.

## Cost notes

ElevenLabs usage is billed according to the account's plan and the selected model's current pricing.
Generated text consumes provider usage, including each chunk sent for a long request. Keep
`WA_TTS_MAX_CHARS` conservative and use `wa_tts_preview` for short checks. Check the ElevenLabs
dashboard for current rates, plan limits, and remaining quota. HTTP 402 and exhausted 429 responses
return a quota or rate-limit error.

## Environment variables

| Variable                  | Default                     | Purpose                                                       |
| ------------------------- | --------------------------- | ------------------------------------------------------------- |
| `WA_TTS_ENABLED`          | `false`                     | Feature gate                                                  |
| `WA_TTS_PROVIDER`         | `elevenlabs`                | Provider registry selection                                   |
| `WA_TTS_API_KEY`          | unset                       | ElevenLabs API key                                            |
| `WA_TTS_DEFAULT_VOICE_ID` | unset                       | Voice used when a call omits `voiceId`                        |
| `WA_TTS_MODEL`            | `eleven_v3`                 | Default synthesis model                                       |
| `WA_TTS_LANGUAGE`         | unset                       | Default language code                                         |
| `WA_TTS_OUTPUT_FORMAT`    | `opus_48000_64`             | ElevenLabs response format; supports its Opus and MP3 formats |
| `WA_TTS_MAX_CHARS`        | `5000`                      | Maximum input text length                                     |
| `WA_TTS_BASE_URL`         | `https://api.elevenlabs.io` | Provider host; supports residency hosts                       |
| `WA_TTS_TIMEOUT_MS`       | `60000`                     | Provider, conversion, and waveform ffmpeg timeout             |
| `TTS_CONCURRENCY`         | `2`                         | Maximum simultaneous synthesis and ffmpeg conversions         |
| `WA_TTS_FFMPEG_PATH`      | `ffmpeg` from `PATH`        | ffmpeg executable for conversion and PTT waveform analysis    |
