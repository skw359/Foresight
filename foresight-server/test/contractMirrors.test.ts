/**
 * MAINT-01: the Swift protocol mirror exists as one canonical file
 * (shared/swift) plus a byte-identical copy in each Swift app (their Xcode
 * projects reference those paths). Fail loudly when a copy drifts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = join(fileURLToPath(import.meta.url), "..", "..", "..");
const canonical = readFileSync(join(repo, "shared", "swift", "ForesightProtocol.swift"), "utf8");

describe("Swift protocol mirrors", () => {
  for (const rel of [
    ["Foresight Security Camera Client", "Sources", "Protocol", "ForesightProtocol.swift"],
    ["Foresight", "Foresight", "Models", "ForesightProtocol.swift"],
  ]) {
    it(`${rel.join("/")} matches shared/swift (run shared/scripts/sync-swift-protocol.mjs)`, () => {
      expect(readFileSync(join(repo, ...rel), "utf8")).toBe(canonical);
    });
  }

  it("mirrors PROTOCOL_VERSION from the TypeScript contract", async () => {
    const { PROTOCOL_VERSION } = await import("@foresight/contract");
    expect(canonical).toContain(`public static let protocolVersion = ${PROTOCOL_VERSION}`);
  });
});
