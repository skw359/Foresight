/**
 * Small in-memory fixed-window rate limiter for the unauthenticated endpoints
 * (login, registration, camera token minting, pairing claims, device-secret
 * routes). One server process serves one household, so in-memory state is the
 * right weight — no external store, no extra dependency.
 *
 * Buckets are keyed by an arbitrary string (an IP, an identifier, a Home id)
 * and expire with their window; a periodic sweep keeps the map bounded.
 */
import type { FastifyRequest } from "fastify";
import { config } from "../config.js";
import { HttpError } from "./errors.js";

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    /** Requests allowed per window per key. */
    readonly limit: number,
    /** Window length in ms. */
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until `key` may try again, or 0 when it is under the limit (does not count). */
  retryAfter(key: string): number {
    const b = this.buckets.get(key);
    const t = this.now();
    if (!b || b.resetAt <= t || b.count < this.limit) return 0;
    return Math.max(1, Math.ceil((b.resetAt - t) / 1000));
  }

  /** Count one hit for `key`; returns the retry-after seconds if it is now over the limit. */
  hit(key: string): number {
    const t = this.now();
    this.sweep(t);
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > this.limit) return Math.max(1, Math.ceil((b.resetAt - t) / 1000));
    return 0;
  }

  /** Forget `key` (e.g. after a successful login clears its failure count). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Forget every key (tests). */
  clear(): void {
    this.buckets.clear();
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs && this.buckets.size < 10_000) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) if (b.resetAt <= t) this.buckets.delete(k);
  }
}

export function tooManyRequests(retryAfterSeconds: number): HttpError {
  return new HttpError(429, "rate_limited", "Too many attempts — try again later", {
    retryAfterSeconds,
  });
}

/** Throw 429 if counting this request puts `key` over the limiter's budget. */
export function enforce(limiter: RateLimiter, key: string): void {
  if (!config.rateLimitEnabled) return;
  const wait = limiter.hit(key);
  if (wait > 0) throw tooManyRequests(wait);
}

/** Throw 429 if `key` is already over budget, WITHOUT counting this request. */
export function enforceNoCount(limiter: RateLimiter, key: string): void {
  if (!config.rateLimitEnabled) return;
  const wait = limiter.retryAfter(key);
  if (wait > 0) throw tooManyRequests(wait);
}

/** The client address used as a rate-limit key (honours TRUST_PROXY via req.ip). */
export function clientKey(req: FastifyRequest): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

/** The limiters, shared across routes. Budgets are per key per window. */
export const limits = {
  /** Any /auth/* request per client address. */
  authPerIp: new RateLimiter(30, 60_000),
  /** FAILED logins per identifier — the 6th inside a minute is refused. */
  loginFailuresPerIdentifier: new RateLimiter(5, 60_000),
  /** Account creation per client address. */
  registerPerIp: new RateLimiter(10, 60 * 60_000),
  /** /rt/token per client address (viewers + cameras reconnecting). */
  rtTokenPerIp: new RateLimiter(60, 60_000),
  /** Rejected device secrets per client address. */
  deviceSecretFailuresPerIp: new RateLimiter(10, 60_000),
  /** /pair/claim per client address. */
  pairClaimPerIp: new RateLimiter(10, 60_000),
  /** Device-authenticated camera routes (status, pubkey, unpair) per client address. */
  cameraDevicePerIp: new RateLimiter(120, 60_000),
  /** Password re-authentication (password change, vault replacement) per user. */
  reauthPerUser: new RateLimiter(5, 15 * 60_000),
};
