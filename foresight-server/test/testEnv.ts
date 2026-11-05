/**
 * Shared test secrets. Long, random-looking values so the server's
 * placeholder/short-secret boot check (lib/secrets.ts) accepts them — tests
 * exercise the production configuration path, not FORESIGHT_INSECURE_DEV.
 */
export const TEST_JWT_SECRET = "test-jwt-0f3c9a7e5b2d4c1a8e6f0b9d7c5a3e1f2b4d6c8a";
export const TEST_LIVEKIT_SECRET = "test-lk-9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d";
export const TEST_RECORDER_SECRET = "test-rec-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

/**
 * Apply the common test environment. Registration is opened and rate limits
 * disabled for the functional suites (they create many accounts from one
 * address); security.test.ts covers both policies with them ON.
 */
export function applyTestEnv(opts: { open?: boolean; rateLimit?: boolean } = {}): void {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.LIVEKIT_API_KEY = "test-key";
  process.env.LIVEKIT_API_SECRET = TEST_LIVEKIT_SECRET;
  process.env.ALLOW_REGISTRATION = opts.open === false ? "" : "true";
  process.env.RATE_LIMIT = opts.rateLimit ? "true" : "false";
  delete process.env.FORESIGHT_INSECURE_DEV;
}
