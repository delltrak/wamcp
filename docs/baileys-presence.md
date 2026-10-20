# Baileys presence

`WA_PRESENCE_MODE` controls the linked account's global presence and defaults to
`on_activity`. The accepted values are `on_activity` and `always`.

In `on_activity`, Baileys sends global `unavailable` once after a socket opens.
Before each outgoing message or typing/recording indicator, it sends global
`available` if needed and resets the idle timer. When no activity occurs for
`WA_PRESENCE_IDLE_SECONDS` (default `30`), it sends global `unavailable`. The
idle value must be a positive integer no greater than `2147483` seconds, the
largest whole-second timeout supported by Node.js timers. In-flight sends and
composing/recording indicators keep the idle timer paused; it restarts when the
operation settles. Explicit `available` presence requests also start or reset
this timer.

In `on_activity`, this behavior takes precedence over
`WA_MARK_ONLINE_ON_CONNECT`: Baileys' `markOnlineOnConnect` option is forced to
`false`, even if that variable is `true`. In `always`, the automatic activity
and idle updates are disabled, and `WA_MARK_ONLINE_ON_CONNECT` retains its
existing behavior. It defaults to `false`; if set, it must be `true` or
`false` (case-insensitive), including when `on_activity` ignores its value.

In `on_activity`, explicit presence tool requests for `available` or
`unavailable` update global presence and the cached activity state. An explicit
`available` request starts or resets the idle timer; `unavailable` cancels it.
Presence updates are best-effort for outgoing messages: failures are logged and
do not prevent a send. Incoming messages and webhook delivery do not alter
presence.

Invalid mode or idle values are rejected when a Baileys adapter is created.

`WA_PRESENCE_PULSE_ENABLED` defaults to `false`. When it is `true`, each connected Baileys
account is marked globally available `WA_PRESENCE_PULSE_TIMES_PER_DAY` times per day (default
2) for `WA_PRESENCE_PULSE_MINUTES` (default 5). The starts are chosen at random inside
`WA_PRESENCE_PULSE_WINDOW` (default `08:00-22:00` on the server's local clock) and each pulse
returns to unavailable when its minutes elapse. A check runs about once a minute. A pulse
only starts while its scheduled slot is still open; a missed slot is not replayed later.
Each start writes one short log line with the instance id and the duration in minutes.

Times per day must be an integer from 1 to 12. Minutes must be an integer from 1 to 15.
The window must match `HH:MM-HH:MM` and end after it starts on the same day. Consecutive
pulses keep at least 15 minutes offline between them, and the whole schedule must fit in
the window. Blank values use the defaults. Any other value is rejected at startup with an
error that names the variable and the accepted range.

The pulse does not change `WA_MARK_ONLINE_ON_CONNECT`. In `on_activity` that option stays
forced off. The idle timer does not send unavailable while a pulse is holding presence.
An explicit `unavailable` request cancels that hold. If a send or typing indicator is
still in flight, or its idle timer is still pending, when the pulse duration ends, the
pulse leaves that activity in control and the idle rule sends unavailable. In `always`,
the pulse still sends global available and then unavailable, and the socket keeps the
configured `markOnlineOnConnect` value. The pulse does not read or write app state.
Cloud API instances have no presence channel and are skipped.
