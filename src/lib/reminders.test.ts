import { describe, it, expect } from "vitest";
import {
  dueReminders,
  REMINDER_GRACE_MINUTES,
  REMINDER_RENUDGE_MINUTES,
  REMINDER_MAX_NUDGES,
  REMINDER_RENUDGE_EXPIRY_MINUTES,
  type ReminderCandidate,
} from "./reminders";

// ─── helpers ───────────────────────────────────────────────────────────────

const MIN = 60_000;

/** Build a candidate at `offsetMinutes` relative to `now`. */
function cand(
  offsetMinutes: number,
  overrides: Partial<ReminderCandidate> = {},
  now = NOW,
): ReminderCandidate {
  return {
    scheduledAt: new Date(now.getTime() + offsetMinutes * MIN),
    status: "planned",
    reminderSentAt: null,
    reminderCount: 0,
    ...overrides,
  };
}

/** A Date `minutesAgo` minutes before NOW. */
function ago(minutesAgo: number, now = NOW): Date {
  return new Date(now.getTime() - minutesAgo * MIN);
}

const NOW = new Date("2026-06-21T06:00:00+10:00");
const LOOKAHEAD = 30;

// ─── suite: first-nudge window membership ───────────────────────────────────

describe("dueReminders — first-nudge window membership", () => {
  it("includes a planned, un-nudged dose due within the lookahead", () => {
    const c = cand(10);
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([c]);
  });

  it("includes a dose due exactly at now", () => {
    const c = cand(0);
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([c]);
  });

  it("includes a dose at exactly now + lookahead (inclusive upper bound)", () => {
    const c = cand(LOOKAHEAD);
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([c]);
  });

  it("excludes a dose just past the lookahead", () => {
    const c = cand(LOOKAHEAD + 1);
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([]);
  });

  it("includes a recently-past dose still inside the grace window", () => {
    const c = cand(-(REMINDER_GRACE_MINUTES - 1));
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([c]);
  });

  it("includes a dose at exactly now - grace (inclusive lower bound)", () => {
    const c = cand(-REMINDER_GRACE_MINUTES);
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([c]);
  });

  it("excludes a dose older than the grace window", () => {
    const c = cand(-(REMINDER_GRACE_MINUTES + 1));
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([]);
  });
});

// ─── suite: status filter ────────────────────────────────────────────────────

describe("dueReminders — status filter", () => {
  it.each(["taken", "missed", "skipped"])(
    "excludes a dose with status %s even when in-window",
    (status) => {
      const c = cand(10, { status });
      expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([]);
    },
  );

  it.each(["taken", "missed", "skipped"])(
    "excludes a re-nudge candidate once its status becomes %s (loop closes on logging)",
    (status) => {
      const c = cand(-10, {
        status,
        reminderSentAt: ago(REMINDER_RENUDGE_MINUTES + 5),
        reminderCount: 1,
      });
      expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([]);
    },
  );

  it("returns an empty array for empty input", () => {
    expect(dueReminders([], NOW, LOOKAHEAD)).toEqual([]);
  });
});

// ─── suite: re-nudges (repeat until logged) ─────────────────────────────────

describe("dueReminders — re-nudges", () => {
  it("re-nudges a still-planned dose once the interval has elapsed", () => {
    const c = cand(-40, { reminderSentAt: ago(REMINDER_RENUDGE_MINUTES + 1), reminderCount: 1 });
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([c]);
  });

  it("re-nudges at exactly the interval boundary (inclusive)", () => {
    const c = cand(-40, { reminderSentAt: ago(REMINDER_RENUDGE_MINUTES), reminderCount: 1 });
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([c]);
  });

  it("does NOT re-nudge before the interval has elapsed", () => {
    const c = cand(-10, { reminderSentAt: ago(REMINDER_RENUDGE_MINUTES - 1), reminderCount: 1 });
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([]);
  });

  it("re-nudges a dose that has left the first-nudge grace window", () => {
    // scheduled 45 min ago (outside grace) — irrelevant for re-nudges, which
    // only respect the staleness expiry.
    const c = cand(-(REMINDER_GRACE_MINUTES + 15), {
      reminderSentAt: ago(REMINDER_RENUDGE_MINUTES + 5),
      reminderCount: 1,
    });
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([c]);
  });

  it("allows the final nudge at count MAX-1", () => {
    const c = cand(-60, {
      reminderSentAt: ago(REMINDER_RENUDGE_MINUTES + 5),
      reminderCount: REMINDER_MAX_NUDGES - 1,
    });
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([c]);
  });

  it("stops at the nudge cap", () => {
    const c = cand(-60, {
      reminderSentAt: ago(REMINDER_RENUDGE_MINUTES + 5),
      reminderCount: REMINDER_MAX_NUDGES,
    });
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([]);
  });

  it("stays quiet for stale doses (scheduled past the expiry bound)", () => {
    const c = cand(-(REMINDER_RENUDGE_EXPIRY_MINUTES + 1), {
      reminderSentAt: ago(REMINDER_RENUDGE_MINUTES + 5),
      reminderCount: 1,
    });
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([]);
  });

  it("re-nudges at exactly the expiry boundary (inclusive)", () => {
    const c = cand(-REMINDER_RENUDGE_EXPIRY_MINUTES, {
      reminderSentAt: ago(REMINDER_RENUDGE_MINUTES + 5),
      reminderCount: 1,
    });
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([c]);
  });

  it("treats pre-migration rows (sentAt set, count 0) as re-nudge candidates", () => {
    const c = cand(-40, { reminderSentAt: ago(REMINDER_RENUDGE_MINUTES + 5), reminderCount: 0 });
    expect(dueReminders([c], NOW, LOOKAHEAD)).toEqual([c]);
  });
});

// ─── suite: mixed set + generic passthrough ─────────────────────────────────

describe("dueReminders — mixed sets", () => {
  it("returns only the due subset from a mixed batch", () => {
    const due1 = cand(5);
    const due2 = cand(20);
    const dueRenudge = cand(-40, { reminderSentAt: ago(REMINDER_RENUDGE_MINUTES + 5), reminderCount: 1 });
    const tooFar = cand(120);
    const tooOld = cand(-120);
    const justNudged = cand(10, { reminderSentAt: NOW, reminderCount: 1 });
    const notPlanned = cand(10, { status: "taken" });
    const capped = cand(-40, {
      reminderSentAt: ago(REMINDER_RENUDGE_MINUTES + 5),
      reminderCount: REMINDER_MAX_NUDGES,
    });

    const result = dueReminders(
      [due1, tooFar, due2, tooOld, justNudged, notPlanned, dueRenudge, capped],
      NOW,
      LOOKAHEAD,
    );
    expect(result).toEqual([due1, due2, dueRenudge]);
  });

  it("preserves caller-supplied extra fields on returned objects (generic)", () => {
    type Rich = ReminderCandidate & { id: string; peptide: string };
    const rich: Rich = { ...cand(10), id: "pd-1", peptide: "Retatrutide" };
    const [out] = dueReminders([rich], NOW, LOOKAHEAD);
    expect(out.id).toBe("pd-1");
    expect(out.peptide).toBe("Retatrutide");
  });
});
