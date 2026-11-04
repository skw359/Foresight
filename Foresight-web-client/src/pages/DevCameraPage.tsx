/**
 * Dev Camera harness — simulates an iPhone Camera Client entirely in the
 * browser so the whole system can be tested end-to-end without a physical
 * device.
 *
 * Flow (mirrors PROTOCOL.md §6 + the camera client):
 *  1. Paste a pairing token (from another tab's Add Camera QR, or ?token=...).
 *  2. Claim the pairing, reporting browser-derived CameraCapabilities.
 *  3. Mint a CAMERA rt token (deviceSecret) and join the Home room.
 *  4. Publish the webcam (simulcast) + mic so viewers can watch and listen.
 *  5. Obey `command` data messages (ack everything; reflect torch/record/quality;
 *     play the viewer's audio + show "Viewer is speaking" during push-to-talk).
 *  6. Broadcast `state` on change and `telemetry` every 5s.
 *
 * This is a publisher: it uses a CAMERA token (publish grant), unlike the rest
 * of the dashboard which connects as a viewer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavStage } from "../context/navStage";
import { useSearchParams } from "react-router-dom";
import {
  ConnectionState,
  ExternalE2EEKeyProvider,
  isE2EESupported,
  LocalVideoTrack,
  RemoteTrack,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  createLocalTracks,
  type LocalTrack,
  type RoomOptions,
} from "livekit-client";
import {
  PROTOCOL_VERSION,
  decodeDataMessage,
  encodeDataMessage,
  parseIdentity,
  type AckMessage,
  type CameraCapabilities,
  type CommandMessage,
  type QualityPreset,
  type StateMessage,
  type TelemetryMessage,
  type WifiInfo,
} from "@foresight/contract";

import { Icon } from "../components/Icon";
import { claimPairing, rtToken } from "../api/client";
import { ApiRequestError } from "../api/client";
import { useE2EE } from "../e2ee/E2EEContext";
import { generateBoxKeypairB64 } from "../crypto/homeKey";

type Phase = "setup" | "starting" | "live" | "error";

interface CameraState {
  torchOn: boolean;
  lens: number;
  zoom: number;
  quality: QualityPreset;
  recording: boolean;
  talking: boolean;
}

const INITIAL_STATE: CameraState = {
  torchOn: false,
  lens: 1,
  zoom: 1,
  quality: "auto",
  recording: false,
  talking: false,
};

/** Capabilities a browser "camera" can honestly report. */
function browserCapabilities(width: number, height: number): CameraCapabilities {
  return {
    lenses: [1], // a webcam has a single fixed lens
    maxDigitalZoom: 4,
    torch: false, // no torch in the browser; the flashlight control will hide
    maxResolution: { width, height },
    supportsAudio: true,
  };
}

export function DevCameraPage() {
  const e2ee = useE2EE();
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get("token") ?? "");
  const [name, setName] = useState("Dev Camera");
  const [phase, setPhase] = useState<Phase>("setup");
  const [error, setError] = useState<string | null>(null);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [state, setState] = useState<CameraState>(INITIAL_STATE);
  const [viewerCount, setViewerCount] = useState(0);
  const [log, setLog] = useState<string[]>([]);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const roomRef = useRef<Room | null>(null);
  const cameraIdRef = useRef<string | null>(null);
  const stateRef = useRef<CameraState>(INITIAL_STATE);
  const audioEls = useRef<Map<string, HTMLAudioElement>>(new Map());

  stateRef.current = state;

  const addLog = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 40));
  }, []);

  /* -------------------------------------------- broadcast helpers ------- */

  const broadcastState = useCallback(async (next: CameraState) => {
    const room = roomRef.current;
    const id = cameraIdRef.current;
    if (!room || !id || room.state !== ConnectionState.Connected) return;
    const msg: StateMessage = {
      v: PROTOCOL_VERSION,
      type: "state",
      cameraId: id,
      torchOn: next.torchOn,
      lens: next.lens,
      zoom: next.zoom,
      quality: next.quality,
      recording: next.recording,
      talking: next.talking,
    };
    await room.localParticipant.publishData(encodeDataMessage(msg), { reliable: true });
  }, []);

  const patchState = useCallback(
    (patch: Partial<CameraState>) => {
      setState((prev) => {
        const next = { ...prev, ...patch };
        stateRef.current = next;
        void broadcastState(next);
        return next;
      });
    },
    [broadcastState],
  );

  const sendAck = useCallback(async (commandId: string, ok: boolean, errMsg?: string) => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    const ack: AckMessage = { v: PROTOCOL_VERSION, type: "ack", commandId, ok, error: errMsg };
    await room.localParticipant.publishData(encodeDataMessage(ack), { reliable: true });
  }, []);

  /* -------------------------------------------- command handling -------- */

  const handleCommand = useCallback(
    async (cmd: CommandMessage) => {
      const id = cameraIdRef.current;
      // Only obey commands targeted at this camera.
      if (id && cmd.target && cmd.target !== id) return;

      try {
        switch (cmd.action) {
          case "torch":
            // No real torch in the browser; reflect intent so viewers stay in sync.
            patchState({ torchOn: !!cmd.args?.on });
            addLog(`torch ${cmd.args?.on ? "on" : "off"} (simulated)`);
            break;
          case "switchLens":
            patchState({ lens: cmd.args?.lens ?? 1 });
            addLog(`switch lens → ${cmd.args?.lens}x`);
            break;
          case "setZoom":
            patchState({ zoom: cmd.args?.zoom ?? 1 });
            addLog(`zoom → ${cmd.args?.zoom}x`);
            break;
          case "setQuality":
            patchState({ quality: (cmd.args?.quality as QualityPreset) ?? "auto" });
            addLog(`quality → ${cmd.args?.quality}`);
            break;
          case "startRecord":
            patchState({ recording: true });
            addLog("record start (viewer-side)");
            break;
          case "stopRecord":
            patchState({ recording: false });
            addLog("record stop");
            break;
          case "talkStart":
            patchState({ talking: true });
            addLog("viewer talking…");
            break;
          case "talkStop":
            patchState({ talking: false });
            addLog("viewer stopped talking");
            break;
          case "snapshotHint":
            addLog("viewer took a snapshot");
            break;
          case "alarm":
            addLog(`alarm ${cmd.args?.on ? "on" : "off"} (simulated)`);
            break;
        }
        await sendAck(cmd.id, true);
      } catch (err) {
        await sendAck(cmd.id, false, err instanceof Error ? err.message : "failed");
      }
    },
    [patchState, sendAck, addLog],
  );

  /* -------------------------------------------- start / stop ------------ */

  const start = useCallback(async () => {
    if (!token.trim()) {
      setError("Paste a pairing token first (from Add Camera in another tab).");
      return;
    }
    setPhase("starting");
    setError(null);

    let tracks: LocalTrack[] = [];
    try {
      // 1. Capture the webcam + mic up front so we can report real resolution.
      tracks = await createLocalTracks({ video: true, audio: true });
      const videoTrack = tracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
      const settings = videoTrack?.mediaStreamTrack.getSettings();
      const width = settings?.width ?? 1280;
      const height = settings?.height ?? 720;

      // 2. Generate this "device"'s E2EE identity keypair and claim the pairing.
      // A real camera keeps its sk in the Keychain (§7.3); the dev harness only
      // needs a pubkey to register, because for PUBLISHING it reuses the logged-in
      // member's already-unsealed HMK (§7.2) — the room is shared-key.
      const camKeys = await generateBoxKeypairB64();
      const { camera, deviceSecret } = await claimPairing({
        token: token.trim(),
        name: name.trim() || "Dev Camera",
        capabilities: browserCapabilities(width, height),
        cameraPublicKey: camKeys.publicKeyB64,
      });
      setCameraId(camera.id);
      cameraIdRef.current = camera.id;
      addLog(`claimed pairing → camera ${camera.id.slice(0, 8)}`);

      // 3. Mint a CAMERA token for this camera's Home and connect.
      const rt = await rtToken({ homeId: camera.homeId, role: "camera", deviceSecret });

      const roomOptions: RoomOptions = {
        publishDefaults: {
          simulcast: true, // grid uses low layer, full-screen the high layer
        },
      };

      // When the Home is E2EE-activated, encrypt published frames with the same
      // HMK viewers hold (§7.2). keyEpoch 0 ⇒ publish plaintext exactly as today.
      let e2eeWorker: Worker | null = null;
      if (rt.keyEpoch >= 1) {
        if (!isE2EESupported() || !window.isSecureContext) {
          throw new Error(
            "This Home is end-to-end encrypted, which this browser/context can't do. Use a recent Chromium browser over HTTPS.",
          );
        }
        const { hmkBase64 } = await e2ee.ensureHomeKey(camera.homeId);
        if (!hmkBase64) {
          throw new Error("This Home is encrypted but you don't hold its key yet — activate/seal it from the dashboard first.");
        }
        const keyProvider = new ExternalE2EEKeyProvider();
        e2eeWorker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), { type: "module" });
        await keyProvider.setKey(hmkBase64); // BEFORE connect (§3.2, index 0)
        roomOptions.e2ee = { keyProvider, worker: e2eeWorker };
        addLog(`E2EE active (epoch ${rt.keyEpoch}) — publishing encrypted`);
      }

      const room = new Room(roomOptions);
      wireRoom(room);
      await room.connect(rt.livekitUrl, rt.token);
      if (roomOptions.e2ee) await room.setE2EEEnabled(true);
      roomRef.current = room;

      // 4. Publish webcam + mic.
      for (const t of tracks) {
        await room.localParticipant.publishTrack(t);
      }
      const vt = tracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
      if (vt && videoElRef.current) vt.attach(videoElRef.current);

      setPhase("live");
      addLog("publishing webcam + mic");
      void broadcastState(stateRef.current);
    } catch (err) {
      tracks.forEach((t) => t.stop());
      const msg =
        err instanceof ApiRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to start the dev camera.";
      setError(msg);
      setPhase("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, name, addLog, broadcastState, e2ee]);

  /** Attach room listeners: data commands, viewer audio (PTT), viewer count. */
  const wireRoom = useCallback(
    (room: Room) => {
      const recountViewers = () => {
        let n = 0;
        for (const p of room.remoteParticipants.values()) {
          if (parseIdentity(p.identity)?.role === "viewer") n++;
        }
        setViewerCount(n);
      };

      room
        .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
          const msg = decodeDataMessage(payload);
          if (msg?.type === "command") {
            // Only viewers may command this camera.
            if (participant && parseIdentity(participant.identity)?.role !== "viewer") return;
            void handleCommand(msg);
          }
        })
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
          // Play a viewer's audio (push-to-talk) through the speakers.
          if (track.kind === Track.Kind.Audio && parseIdentity(p.identity)?.role === "viewer") {
            const el = track.attach();
            el.autoplay = true;
            audioEls.current.set(p.identity, el);
            document.body.appendChild(el);
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
          if (track.kind === Track.Kind.Audio) {
            track.detach();
            const el = audioEls.current.get(p.identity);
            el?.remove();
            audioEls.current.delete(p.identity);
          }
        })
        .on(RoomEvent.ParticipantConnected, recountViewers)
        .on(RoomEvent.ParticipantDisconnected, recountViewers)
        .on(RoomEvent.Disconnected, () => setViewerCount(0));
    },
    [handleCommand],
  );

  /* -------------------------------------------- telemetry loop ---------- */

  useEffect(() => {
    if (phase !== "live") return;
    let cancelled = false;

    async function readBattery(): Promise<{ level: number | null; charging: boolean | null }> {
      const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> };
      if (nav.getBattery) {
        try {
          const b = await nav.getBattery();
          return { level: b.level, charging: b.charging };
        } catch {
          /* fall through */
        }
      }
      return { level: 0.9, charging: true }; // browsers without the Battery API
    }

    const tick = async () => {
      const room = roomRef.current;
      const id = cameraIdRef.current;
      if (!room || !id || room.state !== ConnectionState.Connected) return;
      const { level, charging } = await readBattery();
      const wifi: WifiInfo = { level: 4 }; // a wired/Wi-Fi browser; report full bars
      let viewers = 0;
      for (const p of room.remoteParticipants.values()) {
        if (parseIdentity(p.identity)?.role === "viewer") viewers++;
      }
      const msg: TelemetryMessage = {
        v: PROTOCOL_VERSION,
        type: "telemetry",
        cameraId: id,
        battery: level,
        charging,
        wifi,
        thermal: "nominal",
        viewerCount: viewers,
      };
      if (!cancelled) {
        await room.localParticipant.publishData(encodeDataMessage(msg), { reliable: false });
      }
    };

    void tick();
    const handle = setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [phase]);

  /* -------------------------------------------- cleanup on unmount ------ */

  useEffect(() => {
    return () => {
      const room = roomRef.current;
      room?.disconnect().catch(() => undefined);
      roomRef.current = null;
      for (const el of audioEls.current.values()) el.remove();
      audioEls.current.clear();
    };
  }, []);

  /* -------------------------------------------- render ------------------ */

  const stage = useNavStage();
  return (
    <div className={`page nav-fade ${stage}`}>
      <h1>Dev Camera</h1>
        <p className="faint">
          A browser stand-in for an iPhone Camera Client — pair it, then watch &
          control it from the dashboard (open a Home in another tab). No device
          needed.
        </p>

        {phase === "setup" || phase === "error" ? (
          <div className="card" style={{ maxWidth: 520 }}>
            <label className="field">
              <span>Camera name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dev Camera" />
            </label>
            <label className="field">
              <span>Pairing token</span>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste the token from Add Camera"
              />
            </label>
            <p className="faint" style={{ fontSize: 13 }}>
              In another tab: open a Home → <strong>Add Camera</strong> → copy the
              pairing token (shown under the QR code) and paste it here.
            </p>
            {error && <div className="error-box">{error}</div>}
            <button className="btn primary" onClick={() => void start()}>
              Start dev camera
            </button>
          </div>
        ) : (
          <div className="dev-camera-live">
            <div className="dev-camera-stage">
              <video ref={videoElRef} autoPlay muted playsInline className="dev-camera-video" />
              <div className="dev-camera-overlay">
                <span className={`status-dot ${phase === "live" ? "connected" : "connecting"}`} />
                {phase === "live" ? "Streaming" : "Starting…"}
                <span className="pill">{viewerCount} watching</span>
                {state.talking && <span className="pill talk">Viewer is speaking</span>}
                {state.torchOn && (
                  <span className="pill">
                    <Icon name="flashlight" size={13} /> torch
                  </span>
                )}
                {state.recording && (
                  <span className="pill rec">
                    <Icon name="record" size={12} /> REC
                  </span>
                )}
              </div>
            </div>

            <div className="dev-camera-side">
              <div className="kv">
                <span>Camera id</span>
                <code>{cameraId?.slice(0, 12)}…</code>
              </div>
              <div className="kv"><span>Quality</span><code>{state.quality}</code></div>
              <div className="kv"><span>Lens / Zoom</span><code>{state.lens}x / {state.zoom.toFixed(1)}x</code></div>
              <h3>Activity</h3>
              <ul className="dev-camera-log">
                {log.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
    </div>
  );
}
