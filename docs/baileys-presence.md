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
account is marked globally available, stays available for `WA_PRESENCE_PULSE_DURATION_MS`
(default 300000, five minutes), then returns to unavailable. The following pulse starts no
sooner than `WA_PRESENCE_PULSE_INTERVAL_MS` (default 86400000, 24 hours) after the previous
pulse finishes. A check runs about once a minute. The first enabled pulse runs as soon as a
connected Baileys adapter exists.

The interval must be an integer from 900000 milliseconds (15 minutes) to 604800000 (7 days).
The duration must be an integer from 5000 milliseconds (5 seconds) to 900000 (15 minutes),
and it must be less than the interval. Blank values use the defaults. Any other value is
rejected at startup with an error that names the variable and the accepted range.

In `on_activity`, the idle timer does not send unavailable while a pulse is holding
presence. An explicit `unavailable` request cancels that hold. If a send or typing
indicator is still in flight, or its idle timer is still pending, when the pulse duration
ends, the pulse leaves that activity in control. In `always`, the pulse still sends global
available and then unavailable. The pulse does not read or write app state. Cloud API
instances have no presence channel and are skipped.
