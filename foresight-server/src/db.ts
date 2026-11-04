/**
 * Shared PrismaClient instance, wired to the official better-sqlite3 driver
 * adapter.
 *
 * Prisma 7's query-compiler client requires a driver adapter. We use the
 * supported `@prisma/adapter-better-sqlite3`, which ships prebuilt native
 * binaries for Windows/macOS/Linux (no compile step) and implements Prisma's
 * transaction semantics correctly — important because nested writes (e.g.
 * creating a Home together with its owner membership) run in a transaction.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { config } from "./config.js";

// Point the adapter at the absolute SQLite path the CLI migrates (config.ts
// resolves relative file: URLs the same way Prisma's CLI does).
const adapter = new PrismaBetterSqlite3({ url: `file:${config.sqlitePath}` });

export const prisma = new PrismaClient({ adapter });

export type Db = typeof prisma;
