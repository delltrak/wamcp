# Baileys presence

Set `WA_MARK_ONLINE_ON_CONNECT=true` to have Baileys mark the linked WhatsApp
account online when its socket connects. It defaults to `false`, preserving the
existing behavior when the variable is unset or blank. The value must be
`true` or `false` (case-insensitive); other values are rejected when a Baileys
adapter is created.

To control presence manually, use the `wa_send_presence` tool with `available`
or `unavailable`. Automatic presence changes during tool activity and after an
idle timeout are not enabled by this setting.
