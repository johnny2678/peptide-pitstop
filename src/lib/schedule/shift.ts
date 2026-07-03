/**
 * Pure schedule shifting — the "rollover_shift" missed-dose policy: when a
 * missed dose is made up `deltaDays` later, the protocol's future cadence
 * re-anchors by the same delta (Mon/Thu missed Thu, taken Fri → Tue/Fri).
 *
 * Per-pattern semantics:
 *   weekly   — each weekday rotates by delta (MO+1→TU … SU+1→MO).
 *   interval — the pattern is anchored on Protocol.startDate; the caller moves
 *              startDate by delta instead (signalled via `shiftStartDate`).
 *   cycle    — same anchor mechanics as interval.
 *   daily    — no-op (every day already doses; nothing to shift).
 *
 * The shifted rule is re-serialised as JSON entries — legacy RRULE strings are
 * normalised in the process (safe: every reader goes through parseSchedule,
 * which accepts both).
 */
import { WEEKDAYS, type WeekdayCode } from "./schedule";
import { parseSchedule, type Schedule } from "./entries";

export interface ShiftResult {
  /** Re-serialised rule, or null when no entry changed (rule stays as-is). */
  newRule: string | null;
  /**
   * True when the schedule contains interval/cycle entries, whose anchor is
   * Protocol.startDate — the caller must move startDate by the same delta.
   */
  shiftStartDate: boolean;
}

/** Rotate a weekday code by `deltaDays` calendar days (handles negatives). */
export function shiftWeekday(day: WeekdayCode, deltaDays: number): WeekdayCode {
  const idx = WEEKDAYS.indexOf(day);
  if (idx === -1) return day; // malformed code — leave untouched
  return WEEKDAYS[(idx + ((deltaDays % 7) + 7)) % 7];
}

/**
 * Shift a protocol's scheduleRule by `deltaDays`. Returns what changed —
 * `{ newRule: null, shiftStartDate: false }` means the shift is a complete
 * no-op (daily-only schedule, or empty/malformed rule) and the caller should
 * degrade to a plain rollover.
 */
export function shiftSchedule(
  scheduleRule: string | null | undefined,
  deltaDays: number,
): ShiftResult {
  const entries = parseSchedule(scheduleRule);
  if (entries.length === 0 || deltaDays === 0) {
    return { newRule: null, shiftStartDate: false };
  }

  let weekliesChanged = false;
  let hasAnchored = false;

  const shifted: Schedule = entries.map((e) => {
    const p = e.dayPattern;
    switch (p.kind) {
      case "weekly": {
        if (deltaDays % 7 === 0) return e; // full-week shift lands on the same days
        weekliesChanged = true;
        return { ...e, dayPattern: { ...p, byDays: p.byDays.map((d) => shiftWeekday(d, deltaDays)) } };
      }
      case "interval":
      case "cycle":
        hasAnchored = true; // caller re-anchors via startDate; pattern itself is unchanged
        return e;
      case "daily":
        return e;
    }
  });

  return {
    newRule: weekliesChanged ? JSON.stringify(shifted) : null,
    shiftStartDate: hasAnchored,
  };
}
