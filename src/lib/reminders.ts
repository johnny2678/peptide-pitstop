/**
 * Dose reminders over Web Push.
 *
 * When a scheduled dose is due soon, push a notification to every device the
 * user enabled notifications on (installed PWA / browser), exactly once per
 * dose. This replaced the Home Assistant webhook relay — the transport is now
 * `src/lib/push.ts` and no HA automation is involved.
 *
 * Split into:
 *   - `dueReminders` — a PURE, unit-tested predicate over candidate doses.
 *   - `sendDueReminders` / `runReminders` — impure: load candidates, send the
 *     push, and stamp `reminderSentAt` idempotently.
 *
 * PRIVACY: the notification is a generic "time to review" nudge — peptide,
 * dose and time never appear in it (lock-screen rule; see push.ts).
 *
 * TZ: the container runs Australia/Brisbane, so the stored `Date`s and `now`
 * compare correctly in local time — no offset maths needed (just `Date` vs `now`).
 */

import { isPushConfigured, sendPushToUser, type PushMessage } from "@/lib/push";

// ── Tuning ───────────────────────────────────────────────────────────────────
//
// A dose is eligible from `GRACE` minutes before to `LOOKAHEAD` minutes after the
// current tick. The grace window MUST be ≥ the tick interval (15 min, see
// instrumentation.ts) so a dose can never slip *between* two ticks unnoticed; it
// also lets the startup catch-up tick pick up a dose that just became due. 30 min
// each gives ~1 h of combined coverage — robust even if a single tick is skipped.
export const REMINDER_GRACE_MINUTES = 30;
export const REMINDER_LOOKAHEAD_MINUTES = 30;

/** The one nudge we ever send. Generic on purpose — see the privacy note above. */
const REMINDER_MESSAGE: PushMessage = {
  title: "Pitstop",
  body: "Time to review — tap to open.",
  url: "/today",
  tag: "peptide-pitstop-nudge", // fixed tag → a repeat replaces, never stacks
};

/** Minimal shape the pure finder needs — richer objects pass through unchanged. */
export interface ReminderCandidate {
  scheduledAt: Date;
  status: string;
  reminderSentAt: Date | null;
}

/**
 * PURE — the subset of `candidates` that should be reminded at `now`:
 *   - `status === "planned"`,
 *   - `reminderSentAt == null`,
 *   - `scheduledAt` within `[now - GRACE, now + lookaheadMinutes]` (inclusive).
 *
 * Generic so the impure caller gets its own richer rows back, typed.
 */
export function dueReminders<T extends ReminderCandidate>(
  candidates: readonly T[],
  now: Date,
  lookaheadMinutes: number,
): T[] {
  const lower = now.getTime() - REMINDER_GRACE_MINUTES * 60_000;
  const upper = now.getTime() + lookaheadMinutes * 60_000;
  return candidates.filter((c) => {
    if (c.status !== "planned") return false;
    if (c.reminderSentAt != null) return false;
    const t = c.scheduledAt.getTime();
    return t >= lower && t <= upper;
  });
}

// ── Impure side ──────────────────────────────────────────────────────────────

/**
 * Send reminders for one user's due planned doses. Returns the number of doses
 * reminded (not the number of devices reached — one dose fans out to all of the
 * user's subscriptions).
 *
 * If the user has NO push subscriptions yet, doses are left unstamped: they stay
 * eligible, so enabling notifications mid-window still produces the nudge.
 *
 * No-double-send guarantee: each dose is *claimed* with an atomic
 * `updateMany({ where: { reminderSentAt: null, ... }, data: { reminderSentAt } })`.
 * Only the caller whose update flips the row from null wins (`count === 1`), so two
 * concurrent ticks (15-min interval + the manual cron route) can never both push.
 * We claim BEFORE sending: if the push then fails the dose stays stamped and is
 * not retried — a deliberate trade favouring "never double-send" over re-delivery.
 */
export async function sendDueReminders(
  userId: string,
  now: Date = new Date(),
  lookaheadMinutes: number = REMINDER_LOOKAHEAD_MINUTES,
): Promise<number> {
  if (!isPushConfigured()) return 0;

  const { prisma } = await import("@/lib/db");

  // No devices to notify → don't burn the doses' one reminder on nobody.
  const subCount = await prisma.pushSubscription.count({ where: { userId } });
  if (subCount === 0) return 0;

  const lowerBound = new Date(now.getTime() - REMINDER_GRACE_MINUTES * 60_000);
  const upperBound = new Date(now.getTime() + lookaheadMinutes * 60_000);

  // Narrow at the DB layer; the pure finder is then the source of truth.
  const candidates = await prisma.plannedDose.findMany({
    where: {
      userId,
      status: "planned",
      reminderSentAt: null,
      scheduledAt: { gte: lowerBound, lte: upperBound },
      protocol: { status: "active" },
    },
    select: {
      id: true,
      scheduledAt: true,
      status: true,
      reminderSentAt: true,
    },
  });

  const due = dueReminders(candidates, now, lookaheadMinutes);

  let reminded = 0;
  for (const dose of due) {
    // Atomic claim — concurrent ticks can't both win this row.
    const claim = await prisma.plannedDose.updateMany({
      where: { id: dose.id, reminderSentAt: null, status: "planned" },
      data: { reminderSentAt: now },
    });
    if (claim.count !== 1) continue; // already claimed by another tick

    try {
      const delivered = await sendPushToUser(userId, REMINDER_MESSAGE);
      if (delivered > 0) reminded++;
    } catch (err) {
      // Fail-safe: a push failure must never crash the tick. Row stays stamped
      // (no retry) — and the fixed tag means the user lost nothing they'd see.
      console.error(`[reminders] failed to push reminder for dose ${dose.id}:`, err);
    }
  }
  return reminded;
}

/**
 * Run reminders for every user with an active protocol. Used by both the cron
 * route and the instrumentation interval. No-op (logged once) if VAPID keys
 * are unset.
 */
export async function runReminders(
  now: Date = new Date(),
  lookaheadMinutes: number = REMINDER_LOOKAHEAD_MINUTES,
): Promise<{ sent: number }> {
  if (!isPushConfigured()) return { sent: 0 };

  const { prisma } = await import("@/lib/db");
  const users = await prisma.user.findMany({
    where: { protocols: { some: { status: "active" } } },
    select: { id: true },
  });

  let sent = 0;
  for (const user of users) {
    sent += await sendDueReminders(user.id, now, lookaheadMinutes);
  }
  return { sent };
}
