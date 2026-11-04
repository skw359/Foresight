import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

// The dashboard talks to the Foresight backend (default :3199). The LiveKit
// ws URL is never hardcoded here — it always arrives in /rt/token responses.

const require = createRequire(import.meta.url);

// libsodium-wrappers-sumo's ESM build does a nested bare `import "libsodium-sumo"`
// that Vite 8 / rolldown mis-resolves: it rewrites the bare specifier to a
// non-existent relative sibling `./libsodium-sumo.mjs` before any alias can
// intercept it (breaks both the browser build and Vitest). Aliasing the whole
// package to its CJS entry sidesteps the bug — Node/rolldown resolve the CJS
// `require("libsodium-sumo")` correctly, and the package's `browser` field stubs
// the Node builtins for the web bundle. The lazy dynamic-import in
// src/crypto/sodium.ts (which normalizes `.default ?? mod`) is unaffected.
const libsodiumCjs = require.resolve("libsodium-wrappers-sumo").replace(/\\/g, "/");

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "libsodium-wrappers-sumo": libsodiumCjs } },
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
  },
  test: {
    // Node env for the M0 crypto parity gate (node:crypto + libsodium WASM).
    environment: "node",
  },
});
