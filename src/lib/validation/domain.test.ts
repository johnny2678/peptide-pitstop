import { describe, it, expect } from "vitest";
import {
  parsePositiveDecimal,
  parseNonNegativeDecimal,
  parseEnum,
  parseDateOrder,
  clampCloneCount,
  MAX_CLONE_COUNT,
} from "./domain";

describe("parsePositiveDecimal", () => {
  it("accepts a positive integer and canonicalises it", () => {
    expect(parsePositiveDecimal("5")).toBe("5");
    expect(parsePositiveDecimal("5.0")).toBe("5");
  });

  it("accepts a positive fraction and trims surrounding space", () => {
    expect(parsePositiveDecimal("  1.50 ")).toBe("1.5");
  });

  it("rejects zero and negatives", () => {
    expect(parsePositiveDecimal("0")).toBeNull();
    expect(parsePositiveDecimal("-1")).toBeNull();
  });

  it("rejects blank, null, undefined", () => {
    expect(parsePositiveDecimal("")).toBeNull();
    expect(parsePositiveDecimal("   ")).toBeNull();
    expect(parsePositiveDecimal(null)).toBeNull();
    expect(parsePositiveDecimal(undefined)).toBeNull();
  });

  it("rejects non-numeric and non-finite input", () => {
    expect(parsePositiveDecimal("abc")).toBeNull();
    expect(parsePositiveDecimal("1,5")).toBeNull();
    expect(parsePositiveDecimal("Infinity")).toBeNull();
    expect(parsePositiveDecimal("NaN")).toBeNull();
  });
});

describe("parseNonNegativeDecimal", () => {
  it("accepts zero", () => {
    expect(parseNonNegativeDecimal("0")).toBe("0");
    expect(parseNonNegativeDecimal("0.00")).toBe("0");
  });

  it("accepts positives", () => {
    expect(parseNonNegativeDecimal("12.5")).toBe("12.5");
  });

  it("rejects negatives and garbage", () => {
    expect(parseNonNegativeDecimal("-0.01")).toBeNull();
    expect(parseNonNegativeDecimal("abc")).toBeNull();
    expect(parseNonNegativeDecimal("")).toBeNull();
    expect(parseNonNegativeDecimal(null)).toBeNull();
  });
});

describe("parseEnum", () => {
  const units = ["mg", "mcg", "ml"] as const;

  it("returns the value when allowed", () => {
    expect(parseEnum("mg", units)).toBe("mg");
    expect(parseEnum("ml", units)).toBe("ml");
  });

  it("returns null when not allowed", () => {
    expect(parseEnum("kg", units)).toBeNull();
    expect(parseEnum("", units)).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(parseEnum(null, units)).toBeNull();
    expect(parseEnum(undefined, units)).toBeNull();
  });
});

describe("clampCloneCount", () => {
  it("accepts whole numbers in range, as number or string", () => {
    expect(clampCloneCount(1)).toBe(1);
    expect(clampCloneCount(5)).toBe(5);
    expect(clampCloneCount("3")).toBe(3);
    expect(clampCloneCount(" 10 ")).toBe(10);
  });

  it("clamps above the max down to MAX_CLONE_COUNT", () => {
    expect(clampCloneCount(MAX_CLONE_COUNT + 1)).toBe(MAX_CLONE_COUNT);
    expect(clampCloneCount(9999)).toBe(MAX_CLONE_COUNT);
  });

  it("floors fractions toward the whole number", () => {
    expect(clampCloneCount(2.9)).toBe(2);
    expect(clampCloneCount("4.5")).toBe(4);
  });

  it("rejects < 1, zero, negatives, and fractions that floor below 1", () => {
    expect(clampCloneCount(0)).toBeNull();
    expect(clampCloneCount(-3)).toBeNull();
    expect(clampCloneCount(0.5)).toBeNull();
  });

  it("rejects blank, null, undefined, and non-numeric", () => {
    expect(clampCloneCount("")).toBeNull();
    expect(clampCloneCount("   ")).toBeNull();
    expect(clampCloneCount(null)).toBeNull();
    expect(clampCloneCount(undefined)).toBeNull();
    expect(clampCloneCount("abc")).toBeNull();
    expect(clampCloneCount(Infinity)).toBeNull();
    expect(clampCloneCount(NaN)).toBeNull();
  });
});

describe("parseDateOrder", () => {
  it("accepts start before end", () => {
    expect(parseDateOrder("2026-01-01", "2026-02-01")).toEqual({ ok: true });
  });

  it("accepts equal start and end", () => {
    expect(parseDateOrder("2026-01-01", "2026-01-01")).toEqual({ ok: true });
  });

  it("accepts Date objects", () => {
    expect(parseDateOrder(new Date("2026-01-01"), new Date("2026-01-02"))).toEqual({ ok: true });
  });

  it("fails when start is after end", () => {
    const res = parseDateOrder("2026-02-01", "2026-01-01");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/on or before/i);
  });

  it("fails when a date is invalid or missing", () => {
    expect(parseDateOrder("not-a-date", "2026-01-01").ok).toBe(false);
    expect(parseDateOrder("2026-01-01", "").ok).toBe(false);
    expect(parseDateOrder(null, "2026-01-01").ok).toBe(false);
    expect(parseDateOrder("2026-01-01", undefined).ok).toBe(false);
  });
});
