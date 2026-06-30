import { describe, it, expect, vi, afterEach } from "vitest";
import { safeUUID } from "./uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const realCrypto = globalThis.crypto;

afterEach(() => vi.unstubAllGlobals());

describe("safeUUID", () => {
  it("returns a well-formed v4 UUID", () => {
    expect(safeUUID()).toMatch(V4);
  });

  it("is unique across many calls", () => {
    const set = new Set(Array.from({ length: 1000 }, () => safeUUID()));
    expect(set.size).toBe(1000);
  });

  // The whole point: over plain HTTP on a LAN, crypto.randomUUID is undefined.
  // getRandomValues is NOT secure-context-gated, so the fallback must still work.
  it("works when randomUUID is unavailable (non-secure context)", () => {
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a) });
    expect(safeUUID()).toMatch(V4);
  });

  it("works when Web Crypto is entirely absent", () => {
    vi.stubGlobal("crypto", undefined);
    expect(safeUUID()).toMatch(V4);
  });
});
