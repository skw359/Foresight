# Foresight E2EE — design notes ("Model B")

This document is the committed reference for the end-to-end-encryption design.
Code comments cite its sections as `shared/E2EE.md §N` (older comments say
"plan §N"; the numbering is the same). The canonical constants and wire types
live in [`ts/src/e2ee.ts`](./ts/src/e2ee.ts); the REST/realtime contract is in
[`PROTOCOL.md`](./PROTOCOL.md).

## §1 Goal

A Home can opt in to end-to-end encryption of its **media**: video and audio
frames are encrypted by the publishing camera and decrypted only by key
holders (the Home's members, its cameras, and — with the owner's consent — the
24/7 recorder). The SFU (self-hosted LiveKit or LiveKit Cloud) forwards frames
it cannot read.

## §2 Scope

E2EE is per Home and **off by default**: a Home with `keyEpoch = 0` behaves
exactly as before E2EE existed.

### §2.3 Media only (v1)

Only media frames are encrypted (LiveKit `E2EEOptions`). The data channel
(commands, acks, state, telemetry, `rekey`) stays readable by every Foresight
client — LiveKit's newer `EncryptionOptions` would also encrypt data packets,
which breaks interop until every client (web, iOS camera, iOS viewer, Android,
recorder) migrates in the same release. Data packets carry no media or keys.

## §3 Cryptography

- **Identity:** every user has an X25519 keypair. Every camera generates its
  own keypair on the device (the private key stays in its Keychain, §7.3). The
  recorder has one global keypair on the recorder host (§8.3).
- **Home Media Key (HMK):** 32 random bytes per Home per epoch, delivered to
  each holder as `crypto_box_seal(HMK → holder public key)` (80 bytes).
- All crypto is libsodium (libsodium-wrappers-sumo / swift-sodium /
  sodium-native / lazysodium). The server performs **no** crypto: it stores and
  serves opaque base64 blobs and validates only their byte lengths.

### §3.1 The user's key vault

The private key is wrapped with `crypto_secretbox_easy` under a key derived
from the user's **login password** with Argon2id (opslimit 3, memlimit 64 MiB).
The KDF parameters are stored per blob so they can be retuned without breaking
old vaults. Changing the password re-wraps the same keypair (POST
`/me/password`), so no Home key or pin changes.

### §3.2 The locked LiveKit key-application contract

A divergence on any of these produces silent decryption failure (black video):

1. The HMK is applied as `setKey(base64(HMK))` — a base64 **string** (LiveKit's
   PBKDF2 path). Byte-API SDKs (`@livekit/rtc-node`) feed
   `utf8Bytes(base64(HMK))`, never the raw 32 bytes.
2. `keySize = 128`.
3. `encryptionType = AES-GCM`.
4. `sharedKey = true` — one HMK decrypts every camera in a Home.
5. `ratchetSalt = "LKFrameEncryptionKey"`.
6. `ratchetWindowSize = 0` (no automatic ratcheting; rotation re-seals a fresh HMK).
7. `keyIndex = 0` on every platform and every rotation. `Home.keyEpoch` is
   server bookkeeping and is never fed to LiveKit.

`shared/test-vectors/e2ee-parity.json` is checked by every platform's test
suite (§11).

## §4 Data model

`HomeKey(homeId, epoch, holderType, holderId, sealedKey, sealedBy)` — one row
per holder per epoch. `holderId` is polymorphic (user / camera / recorder id)
with **no foreign key**, so cleanup is explicit: removing a member, deleting a
camera or an account deletes that holder's rows, and for an activated Home sets
`Home.keyRotationRequired` until the owner rotates. Recorder consent is not a
column: it is "a recorder row exists at the current epoch".
`Home.recorderConsentRevokedAt` records an explicit revocation, so the recorder
can tell "revoked" from "never consented" / "copy not sealed yet".

## §5 Simulcast layers

(PROTOCOL.md §5: grid tiles pin the low layer, full screen pins high/max; the
recorder pins `RECORD_LAYER`.) Unaffected by E2EE.

## §6 Lifecycle (owner-driven)

- **Activation** (`POST /homes/:id/key/init`, owner): requires every camera to
  have registered a public key. The owner's client generates the HMK, seals it
  to every member/camera with a vault/key, and posts them. The **server**
  broadcasts `rekey` to the room so connected plaintext participants reconnect
  encrypted.
- **Pairing a camera** in an activated Home: the camera waits ("awaiting key")
  and never publishes plaintext; the member who paired it (or the backfill
  sweep) seals the HMK to it.
- **New member:** first-contact grants are owner-only (§10.5).
- **Rotation** (`/key/rotate`, owner): a fresh HMK sealed to **every**
  remaining holder in the one request (`GET /key/holders` lists them). If
  recorder consent is in force the recorder's copy is mandatory (409
  `recorder_key_required`), so a rotation never interrupts recording. The
  server broadcasts `rekey`; clients re-apply the key live at index 0.
- **Removal** of a member/camera/account: rows deleted, sessions evicted from
  the room, `keyRotationRequired` set; the owner's client rotates.
- **Recorder consent:** granted by sealing the current HMK to the recorder;
  revoked by deleting its rows, disarming recording, then rotating.
- **Disable** (`/key/disable`): all rows dropped, `keyEpoch → 0`, `rekey 0`
  broadcast; everyone reconnects plaintext. Epochs never repeat after
  re-activation (`lastKeyEpoch`).

## §7 Components

### §7.1 Server

Key directory + storage of opaque blobs; validates shapes, sizes and holder
legitimacy, enforces the owner-only rules, broadcasts `rekey`, and hands each
token request the caller's sealed copy (`RtTokenResponse.sealedHomeKey`).

### §7.2 Web dashboard

Unwraps the vault in a Web Worker (§9.2). Optional "keep me unlocked" caches the
identity in IndexedDB under a non-extractable device key (threat notes in
`Foresight-web-client/src/crypto/keystore.ts`).

### §7.3 Camera

Keypair generated on-device, private key in the Keychain
(`…AfterFirstUnlockThisDeviceOnly`: available to an unattended camera after a
reboot, never in a backup).

### §7.4 Native viewers

The identity is restored on a cold launch from a biometric-gated Keychain /
Keystore item, or by re-entering the password. They never connect plaintext to
an activated Home.

## §8 Recorder

### §8.2 Key handling

The recorder learns each Home's state from its reconcile (`epoch`,
`sealedHmk`, `revoked`). No key → it does not connect that Home at all
(awaiting consent / revoked). A key change is applied live at index 0 with a
clean segment boundary. A frame watchdog marks a silent (keyless) stream
`stalled`.

### §8.3 Recorder identity

`sk||pk` lives in `RECORDER_KEY_PATH` (outside `RECORDINGS_DIR`, mode 0600) and
**is** the consent boundary. A changed recorder public key voids all consent
everywhere; Homes must re-consent.

### §8.4 Live rotation

`setSharedKey(utf8(base64(HMK)), 0)` on the existing key provider; reconnect
only if that fails.

## §9 Performance

### §9.2

The sealed HMK rides the token response (zero extra round trips on join); the
Argon2id KDF runs off the UI thread.

## §10 Behaviour and safety

- **§10.2** A rotation is a sub-second blip while clients re-apply the key.
- **§10.3** UIs show "Waiting for key…", "Decrypting…" or "Locked" rather
  than black video.
- **§10.4** A cross-platform key-parameter mismatch shows up as silent black
  video, hence the locked constants, start-up self-tests and parity vector;
  a vault whose public key doesn't match its private key is a loud tamper alarm.
- **§10.5** Authority: any member may seal to a camera they paired and backfill
  holders that already had access; **first-contact** grants to users or the
  recorder are owner-only (403 `first_contact_owner_only`). Clients pin
  (TOFU) every holder key they seal to and refuse — with a visible alert — to
  seal to a holder whose key changed.

## §11 Parity gate

`shared/test-vectors/e2ee-parity.json` (generated by
`shared/ts/scripts/generate-e2ee-vector.mjs`) is verified by the web, recorder,
iOS and Android test suites.

## §12 Threat model — what E2EE does and does NOT protect against

**Protects** media against: the SFU operator (e.g. LiveKit Cloud) and anyone
on the media path; anyone who obtains only the sealed-key blobs or the
`HomeKey` table.

**Does not protect** against:

1. **A compromised or malicious Foresight server.** The vault key is derived
   from the *login password*, and the password is sent to the server at every
   sign-in. A server that logs it can unwrap that user's vault. Use TLS for the
   API (on a plain-HTTP LAN, anyone who can sniff the network can too).
2. **The key directory.** The server tells clients which public key belongs to
   which member or camera. A client that has never pinned a holder trusts what
   the server returns (TOFU); pins only catch keys that *change* on a device
   that already pinned them. Compare fingerprints out of band when it matters
   (the recorder's fingerprint is shown in the Security tab).
3. **Offline guessing.** A database dump allows offline guessing of weak
   passwords against both the login hash and the vault.

Hardening already in place: replacing an existing vault requires the account
password (a stolen session token alone cannot swap in an attacker's public key,
409 `vault_exists`); sessions are revocable; login is rate limited.

Not yet done (tracked follow-ups): deriving separate authentication and vault
keys on the client (so the server never sees the vault-unlocking secret — e.g.
OPAQUE), and fingerprint verification for every holder.

**Residual risk — camera credentials can subscribe.** A camera's LiveKit token
must allow subscribing (to hear push-to-talk), and LiveKit grants can't limit
*which* tracks a subscriber takes. The camera app subscribes only to the mic of
a viewer talking to it, but a STOLEN camera credential could subscribe to the
Home's other cameras. Per-track subscription permissions can't fix this without
breaking the hidden recorder (its identity is unknown to the cameras). Device
secrets are therefore kept in `ThisDeviceOnly` Keychain items, cameras can be
revoked instantly (delete → eviction), and an E2EE Home rotates its key when a
camera is removed.

## §13 Compatibility

- Homes with `keyEpoch = 0` are untouched by E2EE: no consent is needed to
  record them and nothing about their media changes.
- Older clients ignore `rekey` and recover on their next reconnect.
