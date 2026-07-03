import { describe, it, expect } from "vitest";
import { materializePlannedDoses, type PlannedDoseInput, type ProtocolInput } from "./materialize";

// ─── helpers ───────────────────────────────────────────────────────────────

/** Midnight-local Date from YYYY-MM-DD string (avoids UTC-offset skew in tests). */
const d = (s: string): Date => new Date(s + "T00:00:00");

const KEY = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Build a minimal active protocol fixture. */
function proto(overrides: Partial<ProtocolInput> = {}): ProtocolInput {
  return {
    id: "proto-1",
    userId: "user-1",
    status: "active",
    scheduleRule: "FREQ=DAILY",
    targetDose: "500",
    doseInputUnit: "mcg",
    doseBasis: "per_injection",
    rebaseMode: "fixed_anchor",
    adherenceWindowMin: 120,
    startDate: null,
    endDate: null,
    steps: [],
    scheduleType: "fixed_times",
    deliveredLogs: [],
    ...overrides,
  };
}

/** Build a minimal existing PlannedDose row fixture. */
function existing(overrides: Partial<PlannedDoseInput> = {}): PlannedDoseInput {
  return {
    id: "pd-1",
    protocolId: "proto-1",
    scheduledAt: d("2026-06-16"),
    status: "planned",
    hasDoseLog: false,
    ...overrides,
  };
}

// ─── suite 1: 14-day horizon expansion ────────────────────────────────────

describe("14-day horizon expansion", () => {
  it("generates one row per occurrence in [today, today+13] for a daily protocol", () => {
    const today = d("2026-06-16");
    const horizonStart = today;
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const { upserts } = materializePlannedDoses({
      protocols: [proto()],
      horizonStart,
      horizonEnd,
      existing: [],
      today,
    });

    expect(upserts).toHaveLength(14);
    expect(KEY(upserts[0].scheduledAt)).toBe("2026-06-16");
    expect(KEY(upserts[13].scheduledAt)).toBe("2026-06-29");
  });

  it("generates only matching weekdays for a WEEKLY schedule", () => {
    // NOTE: 2026-06-22 is a Monday (plan used Jun 16 assuming it was Monday —
    // corrected to an actual Monday; day-of-week correctness is required for
    // FREQ=WEEKLY;BYDAY=MO rules to produce the expected dates).
    const today = d("2026-06-22"); // Monday
    const horizonStart = today;
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const { upserts } = materializePlannedDoses({
      protocols: [proto({ scheduleRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" })],
      horizonStart,
      horizonEnd,
      existing: [],
      today,
    });

    const keys = upserts.map((u) => KEY(u.scheduledAt));
    // Mon 22, Wed 24, Fri 26, Mon 29, Wed Jul 1, Fri Jul 3 = 6 occurrences in 14 days
    expect(keys).toEqual([
      "2026-06-22",
      "2026-06-24",
      "2026-06-26",
      "2026-06-29",
      "2026-07-01",
      "2026-07-03",
    ]);
  });

  it("respects protocol startDate — no occurrences before it", () => {
    const today = d("2026-06-16");
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const { upserts } = materializePlannedDoses({
      protocols: [proto({ startDate: d("2026-06-20") })],
      horizonStart: today,
      horizonEnd,
      existing: [],
      today,
    });

    expect(upserts.every((u) => u.scheduledAt >= d("2026-06-20"))).toBe(true);
    expect(upserts[0]).toBeDefined();
    expect(KEY(upserts[0].scheduledAt)).toBe("2026-06-20");
  });

  it("carries targetDose and doseInputUnit onto each upsert row", () => {
    const today = d("2026-06-16");
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const { upserts } = materializePlannedDoses({
      protocols: [proto({ targetDose: "250", doseInputUnit: "mcg" })],
      horizonStart: today,
      horizonEnd,
      existing: [],
      today,
    });

    expect(upserts[0].targetDose).toBe("250");
    expect(upserts[0].doseInputUnit).toBe("mcg");
  });
});

// ─── suite 2: idempotency ──────────────────────────────────────────────────

describe("idempotency — desired upsert set", () => {
  it("same upsert rows on second run (existing rows already present)", () => {
    const today = d("2026-06-16");
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const firstRun = materializePlannedDoses({
      protocols: [proto()],
      horizonStart: today,
      horizonEnd,
      existing: [],
      today,
    });

    // Second run: pretend the first run wrote these rows
    const secondRun = materializePlannedDoses({
      protocols: [proto()],
      horizonStart: today,
      horizonEnd,
      existing: firstRun.upserts.map((u, i) => ({
        id: `pd-${i}`,
        protocolId: u.protocolId,
        scheduledAt: u.scheduledAt,
        status: "planned" as const,
        hasDoseLog: false,
      })),
      today,
    });

    // Same set of scheduledAt values — upsert is stable
    expect(secondRun.upserts.map((u) => KEY(u.scheduledAt))).toEqual(
      firstRun.upserts.map((u) => KEY(u.scheduledAt)),
    );
  });
});

// ─── suite 3: paused / completed exclusion ────────────────────────────────

describe("paused and completed protocol exclusion", () => {
  it("skips paused protocols entirely", () => {
    const today = d("2026-06-16");
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const { upserts } = materializePlannedDoses({
      protocols: [proto({ status: "paused" })],
      horizonStart: today,
      horizonEnd,
      existing: [],
      today,
    });

    expect(upserts).toHaveLength(0);
  });

  it("skips completed protocols entirely", () => {
    const today = d("2026-06-16");
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const { upserts } = materializePlannedDoses({
      protocols: [proto({ status: "completed" })],
      horizonStart: today,
      horizonEnd,
      existing: [],
      today,
    });

    expect(upserts).toHaveLength(0);
  });
});

// ─── suite 4: rebase-override week suppression ────────────────────────────

describe("rebase-override week suppression", () => {
  // Rebase scenario: protocol is Mon/Wed/Fri weekly. The user confirmed a rebase
  // for week of 2026-06-22 (Monday). rebase.ts deleted the original grid rows and
  // wrote shifted ones (e.g., Tue 23, Thu 25, Sat 27). The generator must detect
  // these override rows and suppress grid expansion for that week entirely.
  //
  // Override detection: an existing "planned" row whose scheduledAt is NOT on
  // the protocol's schedule grid triggers suppression for its whole week.

  it("suppresses grid expansion for a week that already has override rows", () => {
    // NOTE: 2026-06-22 is a Monday (plan used Jun 16 assuming it was Monday —
    // corrected to an actual Monday so weekStartOf and BYDAY=MO suppression work).
    const today = d("2026-06-22"); // Mon — start of the rebased week
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000); // ends 2026-07-05

    // Rebase override rows for week of Jun 22 — Tue/Thu/Sat shifted (off-grid for MO,WE,FR)
    const overrideRows: PlannedDoseInput[] = [
      existing({ id: "ov-1", protocolId: "proto-1", scheduledAt: d("2026-06-23"), status: "planned" }), // Tue
      existing({ id: "ov-2", protocolId: "proto-1", scheduledAt: d("2026-06-25"), status: "planned" }), // Thu
      existing({ id: "ov-3", protocolId: "proto-1", scheduledAt: d("2026-06-27"), status: "planned" }), // Sat
    ];

    const { upserts } = materializePlannedDoses({
      protocols: [proto({ scheduleRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" })],
      horizonStart: today,
      horizonEnd,
      existing: overrideRows,
      today,
    });

    // The rebased week (Jun 22–28) must produce ZERO grid upserts
    const rebasedWeekKeys = upserts
      .map((u) => KEY(u.scheduledAt))
      .filter((k) => k >= "2026-06-22" && k <= "2026-06-28");
    expect(rebasedWeekKeys).toHaveLength(0);

    // The following week (Jun 29 – Jul 5) is unaffected — should have Mon/Wed/Fri grid
    const nextWeekKeys = upserts
      .map((u) => KEY(u.scheduledAt))
      .filter((k) => k >= "2026-06-29" && k <= "2026-07-05");
    expect(nextWeekKeys).toEqual(["2026-06-29", "2026-07-01", "2026-07-03"]);
  });

  it("does not suppress a week that has no existing planned rows", () => {
    // NOTE: 2026-06-22 is a Monday
    const today = d("2026-06-22");
    const horizonEnd = new Date(today.getTime() + 6 * 86_400_000); // just this week

    const { upserts } = materializePlannedDoses({
      protocols: [proto({ scheduleRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" })],
      horizonStart: today,
      horizonEnd,
      existing: [], // no overrides
      today,
    });

    const keys = upserts.map((u) => KEY(u.scheduledAt));
    expect(keys).toEqual(["2026-06-22", "2026-06-24", "2026-06-26"]);
  });

  // GHK-Cu prod bug (2026-06-26): a week with BOTH an on-grid row and a stray
  // off-grid one is NOT a genuine rebase (confirmRebase deletes the on-grid rows)
  // — the stray off-grid row must not suppress and lose the live grid for the week.
  it("does NOT suppress a week that has BOTH on-grid and off-grid planned rows (stale artefact)", () => {
    const today = d("2026-06-22"); // Mon
    const horizonEnd = new Date(today.getTime() + 6 * 86_400_000); // just this week

    const rows: PlannedDoseInput[] = [
      existing({ id: "on-1", protocolId: "proto-1", scheduledAt: d("2026-06-22"), status: "planned" }), // Mon — on-grid
      existing({ id: "off-1", protocolId: "proto-1", scheduledAt: d("2026-06-23"), status: "planned" }), // Tue — off-grid (stray)
    ];

    const { upserts } = materializePlannedDoses({
      protocols: [proto({ scheduleRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" })],
      horizonStart: today,
      horizonEnd,
      existing: rows,
      today,
    });

    // Not suppressed → the full M/W/F grid is expanded; the stray Tue doesn't hijack it.
    const keys = upserts.map((u) => KEY(u.scheduledAt));
    expect(keys).toEqual(["2026-06-22", "2026-06-24", "2026-06-26"]);
  });

  it("non-planned existing rows (taken/missed/skipped) do not trigger suppression", () => {
    // NOTE: 2026-06-22 is a Monday
    const today = d("2026-06-22");
    const horizonEnd = new Date(today.getTime() + 6 * 86_400_000);

    // A taken row from a past run — should not suppress the week's grid
    const takenRow: PlannedDoseInput = existing({
      protocolId: "proto-1",
      scheduledAt: d("2026-06-22"),
      status: "taken",
      hasDoseLog: true,
    });

    const { upserts } = materializePlannedDoses({
      protocols: [proto({ scheduleRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" })],
      horizonStart: today,
      horizonEnd,
      existing: [takenRow],
      today,
    });

    // Grid still emits Mon/Wed/Fri — the taken row is an existing record, not an override
    const keys = upserts.map((u) => KEY(u.scheduledAt));
    expect(keys).toContain("2026-06-24");
    expect(keys).toContain("2026-06-26");
  });
});

// ─── suite 5: missed-dose reconciliation ──────────────────────────────────

describe("missed-dose reconciliation", () => {
  it("marks a past 'planned' row with no DoseLog as missed", () => {
    const today = d("2026-06-20"); // Friday
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    // A planned row for Mon Jun 16 — past today, no dose log
    const pastPlanned: PlannedDoseInput = existing({
      id: "pd-past",
      scheduledAt: d("2026-06-16"),
      status: "planned",
      hasDoseLog: false,
    });

    const { statusUpdates } = materializePlannedDoses({
      protocols: [proto()],
      horizonStart: today,
      horizonEnd,
      existing: [pastPlanned],
      today,
    });

    expect(statusUpdates).toHaveLength(1);
    expect(statusUpdates[0].id).toBe("pd-past");
    expect(statusUpdates[0].status).toBe("missed");
  });

  it("does not mark taken rows as missed", () => {
    const today = d("2026-06-20");
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const takenRow: PlannedDoseInput = existing({
      id: "pd-taken",
      scheduledAt: d("2026-06-16"),
      status: "taken",
      hasDoseLog: true,
    });

    const { statusUpdates } = materializePlannedDoses({
      protocols: [proto()],
      horizonStart: today,
      horizonEnd,
      existing: [takenRow],
      today,
    });

    expect(statusUpdates.find((u) => u.id === "pd-taken")).toBeUndefined();
  });

  it("does not mark future planned rows as missed", () => {
    const today = d("2026-06-16");
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const futureRow: PlannedDoseInput = existing({
      id: "pd-future",
      scheduledAt: d("2026-06-20"),
      status: "planned",
      hasDoseLog: false,
    });

    const { statusUpdates } = materializePlannedDoses({
      protocols: [proto()],
      horizonStart: today,
      horizonEnd,
      existing: [futureRow],
      today,
    });

    expect(statusUpdates.find((u) => u.id === "pd-future")).toBeUndefined();
  });

  it("does not mark today's planned row as missed", () => {
    const today = d("2026-06-16");
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const todayRow: PlannedDoseInput = existing({
      id: "pd-today",
      scheduledAt: today,
      status: "planned",
      hasDoseLog: false,
    });

    const { statusUpdates } = materializePlannedDoses({
      protocols: [proto()],
      horizonStart: today,
      horizonEnd,
      existing: [todayRow],
      today,
    });

    expect(statusUpdates.find((u) => u.id === "pd-today")).toBeUndefined();
  });

  it("does not touch skipped rows", () => {
    const today = d("2026-06-20");
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const skipped: PlannedDoseInput = existing({
      id: "pd-skip",
      scheduledAt: d("2026-06-16"),
      status: "skipped",
      hasDoseLog: false,
    });

    const { statusUpdates } = materializePlannedDoses({
      protocols: [proto()],
      horizonStart: today,
      horizonEnd,
      existing: [skipped],
      today,
    });

    expect(statusUpdates.find((u) => u.id === "pd-skip")).toBeUndefined();
  });
});

// ─── suite 7: per_week basis writes per-injection dose (spec §6) ───────────

describe("per_week basis — resolver-derived per-injection targetDose", () => {
  it("writes the per-injection dose (4), NOT the weekly value (8)", () => {
    // 8 mg/week on a Mon/Thu weekly schedule (2 inj/wk) → 4 mg per injection.
    const today = d("2026-06-22"); // Monday
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const { upserts } = materializePlannedDoses({
      protocols: [
        proto({
          scheduleRule: "FREQ=WEEKLY;BYDAY=MO,TH",
          doseBasis: "per_week",
          targetDose: "8",
          doseInputUnit: "mg",
          startDate: today,
        }),
      ],
      horizonStart: today,
      horizonEnd,
      existing: [],
      today,
    });

    expect(upserts.length).toBeGreaterThan(0);
    for (const u of upserts) {
      expect(u.targetDose).toBe("4");
      expect(u.doseInputUnit).toBe("mg");
    }
  });

  it("per_injection basis passes the dose through unchanged", () => {
    const today = d("2026-06-22");
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const { upserts } = materializePlannedDoses({
      protocols: [
        proto({
          scheduleRule: "FREQ=WEEKLY;BYDAY=MO,TH",
          doseBasis: "per_injection",
          targetDose: "250",
          doseInputUnit: "mcg",
          startDate: today,
        }),
      ],
      horizonStart: today,
      horizonEnd,
      existing: [],
      today,
    });

    expect(upserts.length).toBeGreaterThan(0);
    for (const u of upserts) expect(u.targetDose).toBe("250");
  });
});

// ─── suite 8: JSON custom-schedule expansion ──────────────────────────────

describe("JSON scheduleRule (custom-schedules engine)", () => {
  it("expands a weekly MO/TH JSON rule to Mon+Thu only (not daily)", () => {
    // A JSON scheduleRule (starts with "[") must parse via the custom-schedules
    // engine. The legacy engine couldn't read JSON and fell back to DAILY,
    // producing wrong daily rows. Over a 1-week horizon this protocol is due
    // ONLY on Monday and Thursday.
    const today = d("2026-06-22"); // Monday
    const horizonEnd = new Date(today.getTime() + 6 * 86_400_000); // Sun 2026-06-28

    const jsonRule = '[{"dayPattern":{"kind":"weekly","byDays":["MO","TH"]},"times":[]}]';

    const { upserts } = materializePlannedDoses({
      protocols: [proto({ scheduleRule: jsonRule })],
      horizonStart: today,
      horizonEnd,
      existing: [],
      today,
    });

    const keys = upserts.map((u) => KEY(u.scheduledAt));
    // Exactly Mon 22 + Thu 25 — NOT a daily row for every day in the week.
    expect(keys).toEqual(["2026-06-22", "2026-06-25"]);
  });
});

// ─── suite 6: protocol without a scheduleRule ─────────────────────────────

describe("protocol with no scheduleRule", () => {
  it("produces no upserts and no statusUpdates (nothing to expand)", () => {
    const today = d("2026-06-16");
    const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);

    const { upserts, statusUpdates } = materializePlannedDoses({
      protocols: [proto({ scheduleRule: null })],
      horizonStart: today,
      horizonEnd,
      existing: [],
      today,
    });

    expect(upserts).toHaveLength(0);
    expect(statusUpdates).toHaveLength(0);
  });
});

// ─── suite: missed-dose policy (rollover / rollover_shift) ──────────────────
//
// Fixture week: 2026-06-15 = Monday, 06-18 = Thursday, 06-19 = Friday (today).
// Canonical case: Mon/Thu protocol, Thursday missed, pass runs Friday.

const WEEKLY_MON_THU = JSON.stringify([
  { dayPattern: { kind: "weekly", byDays: ["MO", "TH"] }, times: [] },
]);

describe("missed-dose policy", () => {
  const today = d("2026-06-19"); // Friday
  const horizonEnd = new Date(today.getTime() + 13 * 86_400_000);
  const missedThu = () => existing({ id: "pd-thu", scheduledAt: d("2026-06-18") });

  function run(
    policy: string,
    rows: PlannedDoseInput[],
    protocolOverrides: Partial<ProtocolInput> = {},
  ) {
    return materializePlannedDoses({
      protocols: [
        proto({ scheduleRule: WEEKLY_MON_THU, missedDosePolicy: policy, ...protocolOverrides }),
      ],
      horizonStart: today,
      horizonEnd,
      existing: rows,
      today,
    });
  }

  it("policy none (default): marks missed, no make-up, no shift", () => {
    const res = run("none", [missedThu()]);
    expect(res.statusUpdates).toEqual([{ id: "pd-thu", status: "missed" }]);
    expect(res.rollovers).toEqual([]);
    expect(res.scheduleShifts).toEqual([]);
  });

  it("rollover: make-up row the day after the miss, grid untouched", () => {
    const res = run("rollover", [missedThu()]);
    expect(res.statusUpdates).toEqual([{ id: "pd-thu", status: "missed" }]);
    expect(res.rollovers).toHaveLength(1);
    expect(KEY(res.rollovers[0].scheduledAt)).toBe("2026-06-19");
    expect(res.rollovers[0].rolledFromId).toBe("pd-thu");
    expect(res.scheduleShifts).toEqual([]);
    // Grid untouched: next Monday still expands.
    expect(res.upserts.map((u) => KEY(u.scheduledAt))).toContain("2026-06-22");
  });

  it("rollover_shift: make-up + Mon/Thu becomes Tue/Fri", () => {
    const res = run("rollover_shift", [missedThu()]);
    expect(res.rollovers).toHaveLength(1);
    expect(KEY(res.rollovers[0].scheduledAt)).toBe("2026-06-19");
    expect(res.scheduleShifts).toHaveLength(1);
    const rule = JSON.parse(res.scheduleShifts[0].newScheduleRule!);
    expect(rule[0].dayPattern.byDays).toEqual(["TU", "FR"]);
    expect(res.scheduleShifts[0].startDateDeltaDays).toBe(0);
  });

  it("clamps the make-up to today after an outage and shifts by the full slip", () => {
    // Monday 06-15 missed; pass first runs Friday 06-19 → make-up today, delta 4.
    const missedMon = existing({ id: "pd-mon", scheduledAt: d("2026-06-15") });
    const res = run("rollover_shift", [missedMon]);
    expect(KEY(res.rollovers[0].scheduledAt)).toBe("2026-06-19");
    const rule = JSON.parse(res.scheduleShifts[0].newScheduleRule!);
    expect(rule[0].dayPattern.byDays).toEqual(["FR", "MO"]); // MO+4, TH+4
  });

  it("rolls only the most recent miss per protocol", () => {
    const res = run("rollover", [
      missedThu(),
      existing({ id: "pd-mon", scheduledAt: d("2026-06-15") }),
    ]);
    expect(res.statusUpdates).toHaveLength(2);
    expect(res.rollovers).toHaveLength(1);
    expect(res.rollovers[0].rolledFromId).toBe("pd-thu");
  });

  it("does not chain: a missed make-up row spawns no new make-up", () => {
    // An (off-grid) make-up on Wednesday that itself got missed.
    const makeup = existing({
      id: "pd-mk",
      scheduledAt: d("2026-06-17"),
      rolledFromId: "pd-orig",
    });
    const res = run("rollover", [makeup]);
    expect(res.statusUpdates).toEqual([{ id: "pd-mk", status: "missed" }]);
    expect(res.rollovers).toEqual([]);
  });

  it("skips the make-up when the next day already has a dose row", () => {
    const friTaken = existing({
      id: "pd-fri",
      scheduledAt: d("2026-06-19"),
      status: "taken",
      hasDoseLog: true,
    });
    const res = run("rollover", [missedThu(), friTaken]);
    expect(res.rollovers).toEqual([]);
  });

  it("skips the make-up when the next day is already on the grid", () => {
    const monThuFri = JSON.stringify([
      { dayPattern: { kind: "weekly", byDays: ["MO", "TH", "FR"] }, times: [] },
    ]);
    const res = run("rollover", [missedThu()], { scheduleRule: monThuFri });
    expect(res.rollovers).toEqual([]);
  });

  it("interval schedule: shift moves the anchor, not the rule", () => {
    const every3 = JSON.stringify([
      { dayPattern: { kind: "interval", everyDays: 3 }, times: [] },
    ]);
    const res = run("rollover_shift", [missedThu()], {
      scheduleRule: every3,
      startDate: d("2026-06-15"),
    });
    expect(res.rollovers).toHaveLength(1);
    expect(res.scheduleShifts).toEqual([
      { protocolId: "proto-1", newScheduleRule: null, startDateDeltaDays: 1 },
    ]);
  });

  it("no rollover for paused protocols (still marks missed)", () => {
    const res = run("rollover", [missedThu()], { status: "paused" });
    expect(res.statusUpdates).toEqual([{ id: "pd-thu", status: "missed" }]);
    expect(res.rollovers).toEqual([]);
  });

  it("a make-up row does NOT suppress its week's grid; a rebase override still does", () => {
    // Off-grid planned Wednesday NEXT week (week of 06-22).
    const offGrid = { id: "pd-x", scheduledAt: d("2026-06-24"), status: "planned", hasDoseLog: false, protocolId: "proto-1" };
    // With the rolledFromId marker → grid expands normally.
    const withMarker = run("none", [{ ...offGrid, rolledFromId: "pd-orig" }]);
    expect(withMarker.upserts.map((u) => KEY(u.scheduledAt))).toContain("2026-06-22");
    // Same row WITHOUT the marker is a rebase override → suppresses the week.
    const withoutMarker = run("none", [offGrid]);
    expect(withoutMarker.upserts.map((u) => KEY(u.scheduledAt))).not.toContain("2026-06-22");
  });
});
