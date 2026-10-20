# Passkey pairing and ARM images

Investigation for issue 131. Passkey pairing is not implemented. The multi-arch image is.

## Passkey pairing

**Feasibility:** not viable on the Baileys version this server pins, and not viable on current
Baileys master either.

**Effort:** a protocol port inside Baileys (or a fork of an unmerged branch), plus a WebAuthn
ceremony that has to run in the account owner's browser. GOWA only adds three HTTP routes because
whatsmeow already speaks the handshake. This repository does not have that handshake. No environment
flag is added.

**Proposal:** keep linking on `wa_get_qr_code` and `wa_get_pairing_code`. Do not fork Baileys and do
not import an existing WhatsApp Web session. Revisit only after a published Baileys release exposes
the companion passkey methods and events. Existing installs keep their database, auth state, and
volumes exactly where they are.

### What GOWA and whatsmeow do

GOWA (go-whatsapp-web-multidevice) exposes phone-initiated passkey linking as three routes on top of
whatsmeow: `GET /app/passkey`, `POST /app/passkey/response`, and `POST /app/passkey/confirm`. The
server stores a pending WebAuthn challenge. The assertion is produced outside GOWA, because a page
on GOWA's own origin cannot satisfy WhatsApp's relying-party id. If the assertion arrives inside
whatsmeow's five-minute handoff window, pairing confirms without a second code; otherwise the phone
shows a code and `POST /app/passkey/confirm` finishes it.

`pair-passkey.go` in whatsmeow (current `main`) is the companion side of that handshake:

1. A server notification carries `passkey_request_options` (JSON WebAuthn public key). If parsing
   fails, the client sends IQ get `passkey_request_options`. It then emits `PairPasskeyRequest`.
2. Before emitting, it derives an HMAC key from the current ADV secret with info
   `shortcake-passkey-handoff-v1`, stores that key for five minutes, and replaces the ADV secret.
3. `SendPasskeyResponse` fetches a companion `ref`, builds an ephemeral X25519 identity and a
   32-byte nonce, and sends IQ set `passkey_prologue` with `credential_id`, `webauthn_assertion`,
   `prologue_payload`, and, when the handoff key is still valid, `pairing_handoff_proof`.
4. A continuation notification carries `primary_ephemeral_identity`. The client computes the X25519
   shared secret, sends IQ set `companion_nonce`, derives the pairing encryption key, and emits
   `PairPasskeyConfirmation` with a short code and a skip-handoff flag.
5. `SendPasskeyConfirmation` AES-GCM-encrypts a `PairingRequest` (noise key, identity key, ADV
   secret) and sends IQ set `encrypted_pairing_request`.

The assertion itself is not computed by whatsmeow. It has to come from an authenticator registered
for `whatsapp.com`.

### What Baileys rc14 and master contain

`package-lock.json` pins `@whiskeysockets/baileys` **7.0.0-rc14** (tag commit `7e7b075`, released
2026-07-29). Master at `0af2386` (2026-08-04, "advertise WIN_HYBRID") is two commits ahead of that
tag. `src/Socket/messages-recv.ts` is byte-identical between the tag and master. Neither tree has a
file, type, or symbol named passkey, WebAuthn, or shortcake.

What linking does exist:

- QR codes arrive on `connection.update` and are served by `wa_get_qr_code`.
- `wa_get_pairing_code` calls `requestPairingCode`. The notification handler only implements
  `link_code_companion_reg`: it requires `link_code_pairing_ref`, `primary_identity_pub`, and
  `link_code_pairing_wrapped_primary_ephemeral_pub`, then sends `companion_finish`. Accounts that
  send that notification without those children throw `Invalid buffer` inside `toRequiredBuffer`.
- `processNotification` has no default branch. Any other notification type, including a passkey
  prologue, produces no event. `handleNotification` still acknowledges the stanza, so the link
  stalls with the phone waiting on "continue on the other device".

Two upstream pull requests tried to close that gap and were closed without merging:

- [Baileys #2689](https://github.com/WhiskeySockets/Baileys/pull/2689) (closed 2026-08-20) adds a
  `signPasskeyAssertion` callback and handles `passkey_prologue_request` / `crsc_continuation` on
  the pairing-code path. A reviewer reported that a Chrome extension calling
  `navigator.credentials.get` on `web.whatsapp.com` completed that handshake. The commit is not an
  ancestor of master (`master...e5abc69` is diverged).
- [Baileys #2696](https://github.com/WhiskeySockets/Baileys/pull/2696) (closed 2026-09-04) only
  surfaces that a passkey notification arrived. It does not submit an assertion.

[Baileys #2672](https://github.com/WhiskeySockets/Baileys/issues/2672) is still open: after QR or
pairing code, WhatsApp asks to continue with a passkey and the companion never finishes.

### What is missing, and the risks

Missing on both rc14 and master, relative to `pair-passkey.go`: the notification parser, the
on-demand challenge IQ, WebAuthn request/response types, the prologue IQ, the continuation and
nonce exchange, the encrypted pairing request, ADV rotation for the handoff proof, and events an
application can subscribe to. Also missing in this server: a browser surface whose origin WhatsApp
will accept. A headless process cannot mint the assertion.

Risks of building it here anyway:

- Vendoring the unmerged #2689 branch forks the dependency away from rc14 security fixes, and that
  branch's callback shape is not the whatsmeow event/method shape GOWA uses.
- Accepting an assertion from a caller is only safe when the account owner just produced it for a
  fresh challenge. Persisting it, or importing a logged-in Web session instead, is a different and
  unsafe design. This change does not do that, and it does not touch stored auth.
- A half-implemented handler that stops acknowledging unknown notifications, or that answers the
  prologue incorrectly, can make pairing fail for accounts that still use QR.
- Meta has been moving some accounts onto this check. Those accounts cannot link with the current
  tools until Baileys speaks the protocol. Switching platform type or using the pairing code does
  not skip the server-side check.

## ARM image

**Feasibility:** already in place. No new tag scheme.

**Effort:** `.github/workflows/docker.yml` already sets up QEMU and Buildx and builds
`linux/amd64,linux/arm64` on one manifest. This change adds an `ffmpeg -version` exec to the
runtime stage so that check runs on both platforms. Tags stay `type=ref` (branch), semver
`{{version}}`, semver `{{major}}.{{minor}}`, and `sha`.

**Proposal:** keep a single manifest list. Do not publish architecture-specific tags alongside it,
and do not move the database, Baileys auth, or the `wa-data` volume.

### Native dependencies

`better-sqlite3` 13.0.3 ships N-API prebuilds, including `prebuilds/linuxmusl-arm64.node` and
`prebuilds/linuxmusl-x64.node`. The image is `node:24-alpine` (musl). `npm ci --ignore-scripts`
skips `node-gyp`, which would fail on Alpine because the toolchain is absent even though the
prebuild is in the tarball. The runtime stage opens an in-memory database with that module. On the
2026-10-19 publish ([workflow run 39333657251](https://github.com/delltrak/wamcp/actions/runs/39333657251))
the `linux/arm64` stage printed `better-sqlite3 OK`.

`ffmpeg` is the Alpine package (`apk add ffmpeg`), not an npm module. That same run installed
`ffmpeg` 8.1.2-r0 inside the arm64 stage. The package install does not prove the binary runs, so
the runtime stage now executes `ffmpeg -hide_banner -version` after the sqlite check. A binary for
the wrong architecture fails the build with an exec-format error. Sticker, GIF, and voice-note
conversion keep using that system binary through the existing `WA_MEDIA_FFMPEG_PATH` and
`WA_TTS_FFMPEG_PATH` settings.

The manifest pushed for `ghcr.io/delltrak/wamcp:main` and `:sha-b0120a3` is
`sha256:992f716ce1a104e1d9d63a03696d1d047eef30c86e2486968a55032aa91a57a8`. The index contains
`linux/amd64` and `linux/arm64` (plus the provenance attestations Buildx attaches). Pulling either
tag on an ARM machine still resolves the arm64 image.

### What was not verified

This was not booted on a Raspberry Pi or another physical ARM board. GitHub-hosted Buildx runs the
arm64 stages under QEMU, which is enough to load the sqlite prebuild and, with this change, to exec
ffmpeg. Connecting WhatsApp from that image uses the same Baileys pairing path as amd64. Accounts
that WhatsApp has moved to passkey linking still cannot finish pairing, on either architecture.
