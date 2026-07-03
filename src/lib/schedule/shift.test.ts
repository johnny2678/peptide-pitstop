import { describe, it, expect } from "vitest";
import { shiftWeekday, shiftSchedule } from "./shift";
import { parseSchedule } from "./entries";

const weekly = (days: string[], times: string[] = []) =>
  JSON.stringify([{ dayPattern: { kind: "weekly", byDays: days }, times }]);

describe("shiftWeekday", () => {
  it("rotates forward within the week", () => {
    expect(shiftWeekday("MO", 1)).toBe("TU");
    expect(shiftWeekday("TH", 1)).toBe("FR");
  });

  it("wraps across the week boundary", () => {
    expect(shiftWeekday("SA", 1)).toBe("SU");
    expect(shiftWeekday("SU", 1)).toBe("MO");
    expect(shiftWeekday("FR", 3)).toBe("MO");
  });

  it("handles negative and multi-week deltas", () => {
    expect(shiftWeekday("MO", -1)).toBe("SU");
    expect(shiftWeekday("WE", 7)).toBe("WE");
    expect(shiftWeekday("WE", 8)).toBe("TH");
  });
});

describe("shiftSchedule", () => {
  it("shifts a Mon/Thu weekly schedule to Tue/Fri (the canonical case)", () => {
    const res = shiftSchedule(weekly(["MO", "TH"]), 1);
    expect(res.shiftStartDate).toBe(false);
    const parsed = parseSchedule(res.newRule);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].dayPattern).toEqual({ kind: "weekly", byDays: ["TU", "FR"] });
  });

  it("preserves entry times through the shift", () => {
    const res = shiftSchedule(weekly(["MO"], ["08:00", "20:00"]), 2);
    expect(parseSchedule(res.newRule)[0].times).toEqual(["08:00", "20:00"]);
  });

  it("is a no-op for a full-week delta on weekly schedules", () => {
    expect(shiftSchedule(weekly(["MO", "TH"]), 7)).toEqual({ newRule: null, shiftStartDate: false });
  });

  it("is a no-op for daily schedules", () => {
    const rule = JSON.stringify([{ dayPattern: { kind: "daily" }, times: [] }]);
    expect(shiftSchedule(rule, 1)).toEqual({ newRule: null, shiftStartDate: false });
  });

  it("signals a startDate shift for interval schedules without touching the rule", () => {
    const rule = JSON.stringify([{ dayPattern: { kind: "interval", everyDays: 3 }, times: [] }]);
    expect(shiftSchedule(rule, 1)).toEqual({ newRule: null, shiftStartDate: true });
  });

  it("signals a startDate shift for cycle schedules", () => {
    const rule = JSON.stringify([{ dayPattern: { kind: "cycle", onDays: 5, offDays: 2 }, times: [] }]);
    expect(shiftSchedule(rule, 2)).toEqual({ newRule: null, shiftStartDate: true });
  });

  it("handles mixed weekly + interval schedules (rule change AND anchor shift)", () => {
    const rule = JSON.stringify([
      { dayPattern: { kind: "weekly", byDays: ["MO", "TH"] }, times: [] },
      { dayPattern: { kind: "interval", everyDays: 10 }, times: [] },
    ]);
    const res = shiftSchedule(rule, 1);
    expect(res.shiftStartDate).toBe(true);
    const parsed = parseSchedule(res.newRule);
    expect(parsed[0].dayPattern).toEqual({ kind: "weekly", byDays: ["TU", "FR"] });
    expect(parsed[1].dayPattern).toEqual({ kind: "interval", everyDays: 10 });
  });

  it("normalises legacy RRULE strings when shifting", () => {
    const res = shiftSchedule("FREQ=WEEKLY;BYDAY=MO,TH", 1);
    const parsed = parseSchedule(res.newRule);
    expect(parsed[0].dayPattern).toEqual({ kind: "weekly", byDays: ["TU", "FR"] });
  });

  it("is a no-op for empty/malformed rules and zero delta", () => {
    expect(shiftSchedule(null, 1)).toEqual({ newRule: null, shiftStartDate: false });
    expect(shiftSchedule("", 1)).toEqual({ newRule: null, shiftStartDate: false });
    expect(shiftSchedule(weekly(["MO"]), 0)).toEqual({ newRule: null, shiftStartDate: false });
  });
});
