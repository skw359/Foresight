/**
 * Server-side HomeKey lookups. These read row EXISTENCE only — the sealed bytes
 * are never inspected (the server is zero-knowledge; see shared/E2EE.md
 * §7.1). Recorder consent is modelled as "a HomeKey row with holderType
 * 'recorder' exists at the Home's current epoch" (§4) — computed, never stored.
 */
import { prisma } from "../db.js";

/** True when the recorder holds a sealed HMK copy at the Home's current epoch. */
export async function isRecorderConsented(homeId: string, keyEpoch: number): Promise<boolean> {
  if (keyEpoch < 1) return false;
  const row = await prisma.homeKey.findFirst({
    where: { homeId, epoch: keyEpoch, holderType: "recorder" },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Batch variant for list endpoints: homeId → recorderConsented. One query for
 * the whole set (only Homes that have activated E2EE can be consented).
 */
export async function recorderConsentMap(
  homes: { id: string; keyEpoch: number }[],
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  for (const h of homes) map.set(h.id, false);

  const activated = homes.filter((h) => h.keyEpoch >= 1);
  if (activated.length === 0) return map;

  const rows = await prisma.homeKey.findMany({
    where: { holderType: "recorder", homeId: { in: activated.map((h) => h.id) } },
    select: { homeId: true, epoch: true },
  });
  const epochsByHome = new Map<string, Set<number>>();
  for (const r of rows) {
    let set = epochsByHome.get(r.homeId);
    if (!set) {
      set = new Set();
      epochsByHome.set(r.homeId, set);
    }
    set.add(r.epoch);
  }
  for (const h of activated) {
    map.set(h.id, epochsByHome.get(h.id)?.has(h.keyEpoch) ?? false);
  }
  return map;
}
