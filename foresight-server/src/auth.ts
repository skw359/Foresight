/**
 * Authentication helpers: password hashing (argon2), session JWTs, and a
 * Fastify preHandler that loads the authenticated user from the
 * `Authorization: Bearer <token>` header.
 */
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { unauthorized } from "./lib/errors.js";
import type { User } from "@prisma/client";

const TOKEN_TTL = "30d";

/** Passwords have no complexity rules (product decision); we just hash them. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password).catch(() => false);
}

/** Camera device secrets are hashed the same way as passwords. */
export const hashSecret = hashPassword;
export const verifySecret = verifyPassword;

export function signSession(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: TOKEN_TTL });
}

export function verifySession(token: string): string | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by `requireUser` for authenticated routes. */
    user?: User;
  }
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

/**
 * Fastify preHandler: require a valid session and attach `request.user`.
 * Use as `{ preHandler: requireUser }` on protected routes.
 */
export async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = bearer(req);
  const userId = token ? verifySession(token) : null;
  if (!userId) throw unauthorized();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw unauthorized();
  req.user = user;
}
