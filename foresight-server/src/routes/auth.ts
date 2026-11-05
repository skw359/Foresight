/**
 * Auth routes: register + login + logout-everywhere. `identifier` is a single
 * field (email OR username, the user's choice); passwords have no complexity
 * rules (product decision).
 *
 * Registration is NOT open by default. The very first account on a server is
 * always allowed and becomes the server admin; after that, new accounts need
 * registration to be open (ALLOW_REGISTRATION=true, or the admin's dashboard
 * toggle). Login, registration and failed logins are rate limited.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthResponse, SessionResponse } from "@foresight/contract";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import {
  burnPasswordCheck,
  hashPassword,
  requireUser,
  signSession,
  verifyPassword,
} from "../auth.js";
import { conflict, forbidden, unauthorized } from "../lib/errors.js";
import { toKeyVault, toUserDTO } from "../lib/dto.js";
import { IDENTIFIER_MAX, PASSWORD_MAX, parseBody } from "../lib/validate.js";
import { clientKey, enforce, enforceNoCount, limits } from "../lib/rateLimit.js";
import { registrationOpen } from "../lib/settings.js";

const credentials = z.object({
  identifier: z.string().trim().min(1, "identifier is required").max(IDENTIFIER_MAX, "identifier is too long"),
  password: z.string().min(1, "password is required").max(PASSWORD_MAX, "password is too long"),
});

const registration = credentials.extend({
  // Optional display name; trimmed, and an empty string is treated as "unset".
  firstName: z
    .string()
    .trim()
    .max(60, "first name is too long")
    .optional()
    .transform((v) => (v ? v : null)),
});

/** Prisma's unique-constraint violation (two racing registrations, etc.). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (req, reply): Promise<AuthResponse> => {
    enforce(limits.authPerIp, clientKey(req));
    const { identifier, password, firstName } = parseBody(registration, req.body);

    const isFirstAccount = (await prisma.user.count()) === 0;
    if (!isFirstAccount && !(await registrationOpen())) {
      throw forbidden("Registration is closed on this server — ask its administrator to open it", {
        reason: "registration_closed",
      });
    }
    enforce(limits.registerPerIp, clientKey(req));

    const existing = await prisma.user.findUnique({ where: { identifier } });
    if (existing) throw conflict("That email or username is already taken");

    let user;
    try {
      user = await prisma.user.create({
        data: { identifier, firstName, passwordHash: await hashPassword(password) },
      });
    } catch (err) {
      // Two concurrent registrations for the same identifier: one wins, the
      // other lands here — a 409, not a 500.
      if (isUniqueViolation(err)) throw conflict("That email or username is already taken");
      throw err;
    }

    // Bootstrap: the first account becomes the server admin. One statement, so
    // two racing first registrations can't both become admin.
    await prisma.$executeRaw`
      UPDATE "User" SET "isAdmin" = true
      WHERE "id" = ${user.id}
        AND "id" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM "User" WHERE "isAdmin" = true)`;
    user = (await prisma.user.findUnique({ where: { id: user.id } })) ?? user;
    if (user.isAdmin) req.log.info({ userId: user.id }, "first account registered — granted server admin");

    reply.code(201);
    // A brand-new account has no keys yet (keyVault: null) — the client runs
    // first-login key generation and POSTs the vault to /me/keys. The vault is
    // NOT part of RegisterRequest (one code path with first-login migration).
    return { token: signSession(user), user: toUserDTO(user), keyVault: toKeyVault(user) };
  });

  app.post("/auth/login", async (req): Promise<AuthResponse> => {
    enforce(limits.authPerIp, clientKey(req));
    const { identifier, password } = parseBody(credentials, req.body);
    const failureKey = identifier.toLowerCase();
    // Too many recent failures for this account: refuse before spending argon2.
    enforceNoCount(limits.loginFailuresPerIdentifier, failureKey);

    const user = await prisma.user.findUnique({ where: { identifier } });
    const ok = user ? await verifyPassword(user.passwordHash, password) : (await burnPasswordCheck(password), false);
    if (!user || !ok) {
      enforce(limits.loginFailuresPerIdentifier, failureKey);
      throw unauthorized("Invalid credentials");
    }
    limits.loginFailuresPerIdentifier.reset(failureKey);

    return { token: signSession(user), user: toUserDTO(user), keyVault: toKeyVault(user) };
  });

  // Sign out every device: bumps tokenVersion, which invalidates every session
  // token issued so far (including stolen ones). Returns a fresh token for the
  // caller so the device that asked stays signed in.
  app.post("/auth/logout-all", { preHandler: requireUser }, async (req): Promise<SessionResponse> => {
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { tokenVersion: { increment: 1 } },
    });
    return { token: signSession(user) };
  });
}
