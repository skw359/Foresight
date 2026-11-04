/**
 * Auth routes: register + login. `identifier` is a single field (email OR
 * username, the user's choice); passwords have no complexity rules.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthResponse } from "@foresight/contract";
import { prisma } from "../db.js";
import { hashPassword, signSession, verifyPassword } from "../auth.js";
import { conflict, unauthorized } from "../lib/errors.js";
import { toKeyVault, toUserDTO } from "../lib/dto.js";
import { parseBody } from "../lib/validate.js";

const credentials = z.object({
  identifier: z.string().trim().min(1, "identifier is required"),
  password: z.string().min(1, "password is required"),
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

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (req, reply): Promise<AuthResponse> => {
    const { identifier, password, firstName } = parseBody(registration, req.body);

    const existing = await prisma.user.findUnique({ where: { identifier } });
    if (existing) throw conflict("That email or username is already taken");

    const user = await prisma.user.create({
      data: { identifier, firstName, passwordHash: await hashPassword(password) },
    });

    reply.code(201);
    // A brand-new account has no keys yet (keyVault: null) — the client runs
    // first-login key generation and POSTs the vault to /me/keys. The vault is
    // NOT part of RegisterRequest (one code path with first-login migration).
    return { token: signSession(user.id), user: toUserDTO(user), keyVault: toKeyVault(user) };
  });

  app.post("/auth/login", async (req): Promise<AuthResponse> => {
    const { identifier, password } = parseBody(credentials, req.body);

    const user = await prisma.user.findUnique({ where: { identifier } });
    if (!user) throw unauthorized("Invalid credentials");

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) throw unauthorized("Invalid credentials");

    return { token: signSession(user.id), user: toUserDTO(user), keyVault: toKeyVault(user) };
  });
}
