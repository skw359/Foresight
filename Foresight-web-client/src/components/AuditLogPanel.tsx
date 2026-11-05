/**
 * Owner-only activity log for a Home: who paired or removed cameras, turned
 * recording on/off, deleted footage, changed membership, or changed the Home's
 * encryption — newest first, paged.
 */
import { useCallback, useEffect, useState } from "react";
import type { AuditEventDTO } from "@foresight/contract";

import { ApiRequestError, getAuditLog } from "../api/client";

const LABELS: Record<string, string> = {
  "camera.pairing_started": "started pairing a camera",
  "camera.paired": "paired camera",
  "camera.renamed": "renamed camera",
  "camera.deleted": "removed camera",
  "camera.unpaired": "unpaired itself",
  "recording.enabled": "turned 24/7 recording on",
  "recording.disabled": "turned 24/7 recording off",
  "recordings.deleted": "deleted recorded footage",
  "member.added": "added member",
  "member.removed": "removed member",
  "member.left": "left the Home",
  "member.role_changed": "changed a member's role",
  "member.account_deleted": "deleted their account",
  "home.ownership_transferred": "transferred ownership",
  "e2ee.activated": "turned on end-to-end encryption",
  "e2ee.rotated": "rotated the encryption key",
  "e2ee.disabled": "turned off end-to-end encryption",
  "e2ee.key_copy_dropped": "re-issued a key",
  "recorder_consent.granted": "let the recorder decrypt",
  "recorder_consent.revoked": "revoked the recorder's access",
};

function describe(e: AuditEventDTO): string {
  const d = (e.details ?? {}) as Record<string, unknown>;
  const what = LABELS[e.action] ?? e.action;
  const subject =
    typeof d.name === "string" ? ` “${d.name}”` : typeof d.identifier === "string" ? ` ${d.identifier}` : "";
  const extra =
    e.action === "member.role_changed" && typeof d.to === "string"
      ? ` → ${d.to}`
      : e.action === "recordings.deleted" && typeof d.from === "string" && typeof d.to === "string"
        ? ` (${new Date(d.from).toLocaleString()} – ${new Date(d.to).toLocaleString()})`
        : "";
  return `${what}${subject}${extra}`;
}

export function AuditLogPanel({ homeId }: { homeId: string }) {
  const [events, setEvents] = useState<AuditEventDTO[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await getAuditLog(homeId, before);
        setEvents((prev) => (before ? [...prev, ...page.events] : page.events));
        setNext(page.nextBefore);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : "Could not load the activity log.");
      } finally {
        setLoading(false);
      }
    },
    [homeId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="field">
      <span>Activity</span>
      {error && (
        <p className="error-box" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
      {!loading && events.length === 0 && !error && (
        <p className="muted" style={{ fontSize: 13 }}>Nothing recorded yet.</p>
      )}
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
        {events.map((e) => (
          <li key={e.id} style={{ padding: "7px 0", fontSize: 13.5 }}>
            <span className="muted" style={{ marginRight: 8, fontVariantNumeric: "tabular-nums" }}>
              {new Date(e.createdAt).toLocaleString()}
            </span>
            <strong style={{ fontWeight: 600 }}>{e.actorLabel ?? (e.actorType === "system" ? "System" : "Unknown")}</strong>{" "}
            {describe(e)}
          </li>
        ))}
      </ul>
      <div className="btn-row">
        <button type="button" className="btn" disabled={loading} onClick={() => void load()}>
          {loading ? <span className="spinner" /> : "Refresh"}
        </button>
        {next && (
          <button type="button" className="btn" disabled={loading} onClick={() => void load(next)}>
            Older
          </button>
        )}
      </div>
    </div>
  );
}
