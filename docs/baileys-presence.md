# Baileys presence

`WA_PRESENCE_MODE` controls the linked account's global presence and defaults to
`on_activity`. The accepted values are `on_activity` and `always`.

In `on_activity`, Baileys sends global `unavailable` once after a socket opens.
Before each outgoing message or typing/recording indicator, it sends global
`available` if needed and resets the idle timer. When no activity occurs for
`WA_PRESENCE_IDLE_SECONDS` (default `30`), it sends global `unavailable`. The
idle value must be a positive integer. Explicit `available` presence requests
also start or reset this timer.

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
