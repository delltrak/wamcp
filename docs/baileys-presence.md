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
`WA_PRESENCE_PULSE_WINDOW` (default `08:00-22:00`). Those hours are wall-clock times in
`WA_PRESENCE_PULSE_TZ`, an IANA name such as `America/Bahia`. When that variable is unset, the
window uses the process time zone (`TZ`) or, if `TZ` is also unset, the server's local zone.
The Docker image and Compose file do not set `TZ`, so a container otherwise runs in UTC.
Set `TZ` or `WA_PRESENCE_PULSE_TZ` when the window should follow a local clock. An invalid
zone name is rejected at startup. Slot times are built in that zone, including on days when
daylight-saving time shifts the UTC offset.

A check runs about once a minute. A pulse only starts while its scheduled slot is still open;
a missed slot is not replayed later. Each start writes one short log line with the instance
id and the duration in minutes. The plan for an instance is dropped on the next check when
that instance is no longer connected through Baileys. A window that fits at startup can still
be too short on a spring-forward day, when the missing hour shrinks the real span. That day
is skipped and a warning is logged; the next day is planned again. Restarting the process
plans the day again. Slots that start within 3 minutes of startup are skipped, so a restart
does not immediately repeat a pulse. Later slots in the new plan can still run.

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
the socket keeps the configured `markOnlineOnConnect` value. When that value is `true`
the account is already online, so the scheduler does not pulse and logs that once at
startup. Otherwise the pulse sends global available only when the account is not already
explicitly available, and it sends unavailable at the end only when that pulse itself
made the account available. An explicit `available` request through the presence tool is
left in place. The pulse does not read or write app state. Cloud API instances have no
presence channel and are skipped.


Failed `unavailable` updates retry every 5 seconds while the same socket remains connected,
even after the scheduled slot ends. No new pulse starts during cleanup. New activity can
resume control through its idle timer; disconnect cancels the pending pulse wait and retries.
Pulse, retry, and scheduler timers do not keep the process alive during shutdown. Presence
updates remain best-effort: a persistent connection failure can delay the visible offline
state. Real-account behavior is unverified, and this feature offers no protection against
account restrictions.
