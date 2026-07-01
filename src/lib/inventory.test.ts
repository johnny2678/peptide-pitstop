import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { resolveTitration } from "./titration/resolve";
import { buildResolveInput } from "./titration/from-protocol";
import { groupVials, type VialView } from "./inventory";

// getInventory is DB-bound; this guards the resolver contract its forecast
// relies on: a per_week dose MUST be divided to per-injection before the volume
// math, or remainingDoses/daysLeft under-forecast by the injections/week factor
// (a 7× error for a weekly dose taken twice-weekly etc.).
const d = (s: string) => new Date(s + "T00:00:00");
const wk = JSON.stringify([{ dayPattern: { kind: "weekly", byDays: ["MO", "TH"] }, times: [] }]);

describe("inventory per_week forecast", () => {
  it("per_week dose is divided before volume math (8mg/wk @ 2/wk → 4mg per injection)", () => {
    const now = d("2026-06-15");
    const r = resolveTitration(
      buildResolveInput({
        protocol: {
          doseBasis: "per_week",
          targetDose: new Decimal("8"),
          doseInputUnit: "mg",
          scheduleRule: wk,
          rebaseMode: "fixed_anchor",
          startDate: now,
          endDate: null,
          adherenceWindowMin: 120,
          steps: [{ stepIndex: 0, dose: new Decimal("8"), doseInputUnit: "mg", durationDays: null }],
        },
        deliveredLogs: [],
        range: { start: now, end: now },
        now,
      }),
    );
    expect(r.slots[0].perInjectionValue).toBe("4");
    expect(r.slots[0].perInjectionUnit).toBe("mg");
  });

  it("non-titration per_injection passes the target dose through unchanged", () => {
    const now = d("2026-06-15");
    const r = resolveTitration(
      buildResolveInput({
        protocol: {
          doseBasis: "per_injection",
          targetDose: new Decimal("250"),
          doseInputUnit: "mcg",
          scheduleRule: wk,
          rebaseMode: "fixed_anchor",
          startDate: now,
          endDate: null,
          adherenceWindowMin: 120,
          steps: [],
        },
        deliveredLogs: [],
        range: { start: now, end: now },
        now,
      }),
    );
    expect(r.slots[0].perInjectionValue).toBe("250");
    expect(r.slots[0].perInjectionUnit).toBe("mcg");
  });
});

// groupVials collapses fungible vials into badge-counted stacks. The inventory
// page keys unprepared stacks on peptide + strength + lot + expiry so no lot or
// use-by date is ever hidden inside a group.
const PREP_KEY = (v: VialView) => `${v.peptideId}|${v.labelStrengthMg}|${v.lot ?? ""}|${v.expiry ?? ""}`;

function vial(over: Partial<VialView> & Pick<VialView, "id" | "peptideId" | "labelStrengthMg">): VialView {
  return {
    peptideName: "Test",
    status: "sealed",
    lot: null,
    expiry: null,
    expired: false,
    prescriptionId: null,
    prescriptionLabel: null,
    prepared: false,
    prepType: null,
    concentrationMcgPerMl: null,
    remainingMl: null,
    beyondUseDate: null,
    beyondUsePassed: false,
    remainingDoses: null,
    daysLeft: null,
    recon: null,
    ...over,
  };
}

describe("groupVials", () => {
  it("collapses clones sharing peptide + strength + lot + expiry into one stack", () => {
    const groups = groupVials(
      [
        vial({ id: "a", peptideId: "klow", labelStrengthMg: "80", lot: "L1", expiry: "2030-05-01" }),
        vial({ id: "b", peptideId: "klow", labelStrengthMg: "80", lot: "L1", expiry: "2030-05-01" }),
        vial({ id: "c", peptideId: "klow", labelStrengthMg: "80", lot: "L1", expiry: "2030-05-01" }),
      ],
      PREP_KEY,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].rep.id).toBe("a"); // first member drives the card + prep
    expect(groups[0].ids).toEqual(["a", "b", "c"]);
  });

  it("collapses vials with null lot and null expiry (seeded/cloned defaults)", () => {
    const groups = groupVials(
      [
        vial({ id: "a", peptideId: "ipa", labelStrengthMg: "10" }),
        vial({ id: "b", peptideId: "ipa", labelStrengthMg: "10" }),
      ],
      PREP_KEY,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
  });

  it("splits a differing lot or expiry into separate stacks", () => {
    const groups = groupVials(
      [
        vial({ id: "a", peptideId: "klow", labelStrengthMg: "80", lot: "L1", expiry: "2030-05-01" }),
        vial({ id: "b", peptideId: "klow", labelStrengthMg: "80", lot: "L2", expiry: "2030-05-01" }),
        vial({ id: "c", peptideId: "klow", labelStrengthMg: "80", lot: "L1", expiry: "2031-01-01" }),
      ],
      PREP_KEY,
    );
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1]);
    expect(groups.map((g) => g.rep.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps different peptides and strengths in distinct stacks, preserving input order", () => {
    const groups = groupVials(
      [
        vial({ id: "a", peptideId: "cjc", labelStrengthMg: "5" }),
        vial({ id: "b", peptideId: "cjc", labelStrengthMg: "5" }),
        vial({ id: "c", peptideId: "test", labelStrengthMg: "200" }),
        vial({ id: "d", peptideId: "cjc", labelStrengthMg: "10" }),
      ],
      PREP_KEY,
    );
    expect(groups.map((g) => [g.rep.peptideId, g.rep.labelStrengthMg, g.count])).toEqual([
      ["cjc", "5", 2],
      ["test", "200", 1],
      ["cjc", "10", 1],
    ]);
  });
});
