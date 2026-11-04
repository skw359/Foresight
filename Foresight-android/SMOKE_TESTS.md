# Foresight Android — Manual smoke tests

Device/emulator checklist for what JVM tests can't cover. Prereqs: backend on
`:3199`, LiveKit on `:7880`, a Camera Client iPhone, and (for E2EE cases) a
Home activated from the web dashboard.

Emulator note: the default base URL `http://10.0.2.2:3199` reaches the host.
The backend-minted `livekitUrl` must also be reachable from the device — use
the host's LAN IP in the server's pairing/settings config, not `localhost`.

## Auth & session

- [ ] Register with a fresh identifier (email or username — single field) and a
      trivially short password (no complexity rules) → lands on Homes.
- [ ] First login generates E2EE keys silently (POST /me/keys — verify a
      `keyVault` on the account afterwards, e.g. via web login).
- [ ] Log out (Settings → Sign Out) → back to auth; token gone after relaunch.
- [ ] Log in with an account created on the **web** (same password) → the
      web-created vault unlocks here (cross-platform Argon2id parity).
- [ ] Kill + relaunch the app → still authenticated (Keystore-persisted JWT),
      Homes list loads.

## Homes

- [ ] Create Home (+) → appears at top; pull-to-refresh reloads.
- [ ] Empty state shows "Create Home" CTA on a fresh account.
- [ ] E2EE-activated Homes show a lock glyph in the row.

## Pairing (QR)

- [ ] Add Camera → QR renders within ~2 s; "New Code" mints a different one.
- [ ] Camera Client scans it → camera claims, appears in the grid after the
      ~10 s REST poll (or reopening the Home).
- [ ] In an E2EE Home the sheet shows the "grant the key from the web
      dashboard" note.

## Grid & live viewing

- [ ] Tiles show live video (LOW layer), name, online dot, battery/Wi-Fi/
      thermal badges, viewer count; REC dot while the camera reports recording.
- [ ] Offline camera shows the "Offline" placeholder; freshly-subscribed shows
      "Connecting…".
- [ ] Backgrounding the app and returning resumes tiles.

## E2EE states (activated Home, keyEpoch ≥ 1)

- [ ] Cold launch → open E2EE Home → **biometric prompt** restores the identity
      (no password); video decrypts.
- [ ] Cancel the biometric → "Unlock required" banner → Unlock → password
      dialog restores; wrong password shows an inline error and lets you retry.
- [ ] New member added to the Home but not yet granted → "Waiting for access"
      banner; after a web member grants the key, "Check again" (or the 6 s
      retry) connects and decrypts.
- [ ] Never any plaintext connect into an activated Home (verify server-side:
      the viewer participant only appears with E2EE frames).
- [ ] Rotate the Home key from the web while viewing → sub-second "Decrypting…"
      blip, then video resumes (rekey handled on the same key provider).
- [ ] Enroll an extra fingerprint/face in system settings → the cached identity
      is invalidated → next unlock falls back to password (by design).

## Full-screen controls (capabilities-gated)

- [ ] Flashlight toggles (rear-capable cameras only) and syncs across viewers.
- [ ] Lens button cycles the camera's real lens set (e.g. 0.5×/1×/2×).
- [ ] Digital zoom slider is smooth; camera zoom follows at ~120 ms cadence and
      settles exactly on release.
- [ ] Pinch-to-zoom + pan magnify locally (no camera command), clamped at
      edges, reset on reopen.
- [ ] Quality Auto/480p/1080p/Max apply (camera state echoes back); Pure 4K
      toggle appears only for ≥ 3840×2160 cameras, shows the fallback toast if
      the camera drops to Max, and restores Max when leaving full-screen.
- [ ] Listen: audio auto-plays on open (when supported), toggles mute, stops on
      exit.
- [ ] Hold to Talk: first use asks for the mic permission; camera plays your
      voice + shows "Viewer is speaking"; releasing stops publishing
      (check the mic indicator disappears).
- [ ] Snapshot → "Saved to gallery" → photo in Pictures/Foresight (correct
      orientation).
- [ ] Record → REC dot; Stop → video-only MP4 in Movies/Foresight that plays
      (also try while E2EE-decrypting — capture sees decrypted frames).
- [ ] Rename updates the title + tile immediately; Remove confirms, unpairs,
      and returns to the grid.

## Resilience

- [ ] Kill the LiveKit server mid-view → "Can't connect"/disconnected banner;
      Retry recovers once it's back.
- [ ] Wrong base URL in Settings → clean failure surfaces; fixing it recovers
      without app restart.
