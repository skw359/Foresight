/**
 * KeyManager change classification — what the reconcile loop acts on. Focused
 * on the E2EE-off transition: a Home that drops from epoch ≥ 1 back to 0 must
 * report "disabled" (so its live room reconnects plaintext), whether or not the
 * recorder held a key.
 */
import { describe, expect, it } from "vitest";
import type { RecorderHomeKeyInfo } from "@foresight/contract";
import { KeyManager } from "../src/crypto/keyManager.js";
import type { RecorderIdentity } from "../src/crypto/identity.js";

// Unsealing is out of scope here: any sealed blob "opens" to a fixed HMK.
const identity = { unseal: () => Buffer.alloc(32, 7) } as unknown as RecorderIdentity;

const info = (epoch: number, sealedHmk: string | null, revoked = false): RecorderHomeKeyInfo => ({
  homeId: "h1",
  epoch,
  sealedHmk,
  revoked,
});

describe("KeyManager.ingest", () => {
  it("reports disabled when a keyed Home drops to epoch 0", () => {
    const km = new KeyManager(identity);
    expect(km.ingest([info(2, "sealed")]).get("h1")).toBe("granted");
    expect(km.ingest([info(0, null)]).get("h1")).toBe("disabled");
    expect(km.getHomeKey("h1")).toEqual({ epoch: 0, hmkBase64: null, revoked: false });
    // Steady-state plaintext afterwards needs no action.
    expect(km.ingest([info(0, null)]).get("h1")).toBe("unchanged");
  });

  it("reports disabled for a Home held keyless (awaiting consent) at epoch ≥ 1", () => {
    const km = new KeyManager(identity);
    expect(km.ingest([info(1, null)]).get("h1")).toBe("unchanged");
    expect(km.ingest([info(0, null)]).get("h1")).toBe("disabled");
  });

  it("keeps a never-activated Home unchanged", () => {
    const km = new KeyManager(identity);
    expect(km.ingest([info(0, null)]).get("h1")).toBe("unchanged");
  });
});
