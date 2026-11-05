#!/usr/bin/env node
/**
 * Online backup of the Foresight SQLite database (accounts, Homes, cameras and
 * every user's E2EE key vault + sealed Home keys). Losing this file locks every
 * user out of their E2EE Homes, so back it up — and copy the backups OFF this
 * machine (another disk, NAS, or cloud storage).
 *
 *   node scripts/backup-db.mjs                 # → foresight-server/backups/
 *   BACKUP_DIR=/mnt/nas/foresight node scripts/backup-db.mjs
 *   BACKUP_KEEP=30 node scripts/backup-db.mjs  # keep the newest 30 (default 14)
 *
 * Uses SQLite's online backup API (via better-sqlite3), so it is safe while the
 * server is running. infra/systemd/install-user-units.sh installs a daily timer.
 * Restore: stop foresight-server, copy a backup over the DATABASE_URL file
 * (delete any -wal/-shm siblings), start it again.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.DATABASE_URL ?? "file:./dev.db";
const raw = url.replace(/^file:/, "");
const dbPath = path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
const backupDir = path.resolve(process.env.BACKUP_DIR ?? path.join(projectRoot, "backups"));
const keep = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14) || 14);

if (!fs.existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`);
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const dest = path.join(backupDir, `foresight-${stamp}.db`);

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  await db.backup(dest);
} finally {
  db.close();
}
fs.chmodSync(dest, 0o600);

// Verify the copy opens and passes an integrity check before trusting it.
const check = new Database(dest, { readonly: true });
const result = check.pragma("integrity_check", { simple: true });
check.close();
if (result !== "ok") {
  console.error(`backup integrity check FAILED (${result}): ${dest}`);
  process.exit(1);
}

const old = fs
  .readdirSync(backupDir)
  .filter((n) => /^foresight-\d{8}-\d{6}\.db$/.test(n))
  .sort()
  .reverse()
  .slice(keep);
for (const name of old) fs.rmSync(path.join(backupDir, name), { force: true });

console.log(`backup ok: ${dest} (${fs.statSync(dest).size} bytes; pruned ${old.length})`);
