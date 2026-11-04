import "dotenv/config";
import path from "node:path";
import { defineConfig, env } from "@prisma/config";

/**
 * Prisma 7 configuration. The connection URL lives here (no longer in
 * schema.prisma). The CLI (migrate/generate) reads `datasource.url`; the
 * runtime PrismaClient is constructed with a driver adapter in src/db.ts.
 */
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
