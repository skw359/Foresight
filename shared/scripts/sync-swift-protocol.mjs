#!/usr/bin/env node
/**
 * Copy the canonical Swift protocol (shared/swift/ForesightProtocol.swift) into
 * both Swift apps. Their Xcode projects reference their own copies, so the
 * copies must stay BYTE-IDENTICAL; foresight-server's test suite
 * (test/contractMirrors.test.ts) fails when they drift.
 *
 *   node shared/scripts/sync-swift-protocol.mjs          # write the copies
 *   node shared/scripts/sync-swift-protocol.mjs --check  # exit 1 on drift
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CANONICAL = path.join(repo, "shared", "swift", "ForesightProtocol.swift");
export const COPIES = [
  path.join(repo, "Foresight Security Camera Client", "Sources", "Protocol", "ForesightProtocol.swift"),
  path.join(repo, "Foresight", "Foresight", "Models", "ForesightProtocol.swift"),
];

const check = process.argv.includes("--check");
const source = fs.readFileSync(CANONICAL, "utf8");
let drift = 0;
for (const copy of COPIES) {
  const current = fs.existsSync(copy) ? fs.readFileSync(copy, "utf8") : null;
  if (current === source) continue;
  if (check) {
    console.error(`out of sync: ${path.relative(repo, copy)}`);
    drift++;
  } else {
    fs.writeFileSync(copy, source);
    console.log(`updated ${path.relative(repo, copy)}`);
  }
}
if (check && drift) {
  console.error("run: node shared/scripts/sync-swift-protocol.mjs");
  process.exit(1);
}
