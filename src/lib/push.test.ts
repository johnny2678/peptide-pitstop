import { describe, it, expect, vi, afterEach } from "vitest";
import { isPushConfigured } from "./push";

// getVapidConfig reads env on every call, so stubbing between calls is enough —
// no module-cache gymnastics needed.
afterEach(() => vi.unstubAllEnvs());

describe("isPushConfigured — VAPID env gating", () => {
  it("is false when both keys are unset", () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect(isPushConfigured()).toBe(false);
  });

  it("is false when only the public key is set (all-or-nothing pair)", () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "BPubKey");
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect(isPushConfigured()).toBe(false);
  });

  it("is false when only the private key is set", () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    expect(isPushConfigured()).toBe(false);
  });

  it("is false when keys are whitespace-only", () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "   ");
    vi.stubEnv("VAPID_PRIVATE_KEY", "   ");
    expect(isPushConfigured()).toBe(false);
  });

  it("is true when both keys are set", () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "BPubKey");
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    expect(isPushConfigured()).toBe(true);
  });
});
