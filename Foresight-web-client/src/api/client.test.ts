/** OPS-01: a production build must call its own origin, never "localhost". */
import { describe, expect, it } from "vitest";
import { resolveApiUrl } from "./client";

describe("resolveApiUrl", () => {
  it("uses the same origin in a production build when VITE_API_URL is unset", () => {
    expect(resolveApiUrl({ DEV: false })).toBe("");
    expect(resolveApiUrl({ DEV: false, VITE_API_URL: "  " })).toBe("");
  });

  it("honours an explicit VITE_API_URL (trailing slash trimmed)", () => {
    expect(resolveApiUrl({ DEV: false, VITE_API_URL: "https://api.example.com/" })).toBe("https://api.example.com");
  });

  it("targets port 3199 on the page's own host in dev (works from a phone on the LAN)", () => {
    expect(resolveApiUrl({ DEV: true }, { protocol: "http:", hostname: "192.168.1.20" })).toBe(
      "http://192.168.1.20:3199",
    );
    expect(resolveApiUrl({ DEV: true })).toBe("http://localhost:3199");
  });
});
