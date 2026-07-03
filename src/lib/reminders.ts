/**
 * Dose reminders over Web Push — repeat until logged.
 *
 * When a scheduled dose is due soon, push a notification to every device the
 * user enabled notifications on (installed PWA / browser). While the dose
 * STAYS `planned`, keep re-nudging on an interval, up to a cap — logging or
 * skipping the dose is what stops the loop. (iOS web push has no snooze/action
 * buttons — WebKit ignores them — so persistence lives server-side instead.)
 * This replaced the Home Assistant webhook relay — the transport is
 * `src/lib/push.ts` and no HA automation is involved.
 *
 * Split into:
 *   - `dueReminders` — a PURE, unit-tested predicate over candidate doses.
 *   - `sendDueReminders` / `runReminders` — impure: load candidates, send the
 *     push, and stamp `reminderSentAt`/`reminderCount` idempotently.
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
// First nudge: a dose is eligible from `GRACE` minutes before to `LOOKAHEAD`
// minutes after the current tick. The grace window MUST be ≥ the tick interval
// (15 min, see instrumentation.ts) so a dose can never slip *between* two ticks
// unnoticed; it also lets the startup catch-up tick pick up a dose that just
// became due. 30 min each gives ~1 h of combined coverage — robust even if a
// single tick is skipped.
export const REMINDER_GRACE_MINUTES = 30;
export const REMINDER_LOOKAHEAD_MINUTES = 30;

// Re-nudges: while the dose is still `planned`, nudge again every
// `RENUDGE_MINUTES` (≥ the last nudge), up to `MAX_NUDGES` total. The EXPIRY
// bound stops re-nudges for doses whose scheduled time is long past — after a
// server outage the tick must not buzz the phone about hours-stale doses (the
// app's Today screen still shows them as overdue; the daily generation pass
// marks them missed).
export const REMINDER_RENUDGE_MINUTES = 30;
export const REMINDER_MAX_NUDGES = 3;
export const REMINDER_RENUDGE_EXPIRY_MINUTES = 120;

// Generic on purpose — see the privacy note above. Same fixed tag on both, so
// a re-nudge REPLACES whatever is still sitting in the notification tray.
const FIRST_NUDGE: PushMessage = {
  title: "Pitstop",
  body: "Time to review — tap to open.",
  url: "/today",
  tag: "peptide-pitstop-nudge",
};
const RE_NUDGE: PushMessage = {
  title: "Pitstop",
  body: "Still pending — tap to review.",
  url: "/today",
  tag: "peptide-pitstop-nudge",
};

/** Minimal shape the pure finder needs — richer objects pass through unchanged. */
export interface ReminderCandidate {
  scheduledAt: Date;
  status: string;
  /** Last nudge time; null = never nudged. */
  reminderSentAt: Date | null;
  /** Nudges sent so far. */
  reminderCount: number;
}

/**
 * PURE — the subset of `candidates` that should be nudged at `now`.
 *
 * First nudge (`reminderSentAt == null`):
 *   - `status === "planned"`,
 *   - `scheduledAt` within `[now - GRACE, now + lookaheadMinutes]` (inclusive).
 *
 * Re-nudge (`reminderSentAt != null`) — the dose was nudged but never logged:
 *   - `status === "planned"` still,
 *   - `reminderCount < MAX_NUDGES`,
 *   - at least `RENUDGE_MINUTES` since the last nudge,
 *   - `scheduledAt` no older than `RENUDGE_EXPIRY` (stale doses stay quiet).
 *
 * (Pre-migration rows have `reminderSentAt` set with `reminderCount` 0 — they
 * fall into the re-nudge branch with full remaining capacity, by design.)
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
  const renudgeCutoff = now.getTime() - REMINDER_RENUDGE_MINUTES * 60_000;
  const expiry = now.getTime() - REMINDER_RENUDGE_EXPIRY_MINUTES * 60_000;
  return candidates.filter((c) => {
    if (c.status !== "planned") return false;
    const t = c.scheduledAt.getTime();
    if (c.reminderSentAt == null) {
      return t >= lower && t <= upper; // first nudge — original window
    }
    if (c.reminderCount >= REMINDER_MAX_NUDGES) return false; // out of nudges
    if (c.reminderSentAt.getTime() > renudgeCutoff) return false; // too soon
    return t >= expiry && t <= upper; // not stale
  });
}

// ── Impure side ──────────────────────────────────────────────────────────────

/**
 * Send nudges for one user's due planned doses. Returns the number of doses
 * nudged this tick (not the number of devices reached — one dose fans out to
 * all of the user's subscriptions).
 *
 * If the user has NO push subscriptions yet, doses are left unstamped: they stay
 * eligible, so enabling notifications mid-window still produces the nudge.
 *
 * No-double-send guarantee: each nudge is *claimed* atomically using
 * `reminderCount` as an optimistic-concurrency token — the updateMany only
 * matches while the row still has the count this tick read, so two concurrent
 * ticks (15-min interval + the manual cron route) can never both send the same
 * nudge. We claim BEFORE sending: if the push then fails the nudge is spent and
 * not retried — a deliberate trade favouring "never double-send" over
 * re-delivery (a later re-nudge covers the loss anyway, until the cap).
 */
export async function sendDueReminders(
  userId: string,
  now: Date = new Date(),
  lookaheadMinutes: number = REMINDER_LOOKAHEAD_MINUTES,
): Promise<number> {
  if (!isPushConfigured()) return 0;

  const { prisma } = await import("@/lib/db");

  // No devices to notify → don't burn nudges on nobody.
  const subCount = await prisma.pushSubscription.count({ where: { userId } });
  if (subCount === 0) return 0;

  const lowerBound = new Date(now.getTime() - REMINDER_GRACE_MINUTES * 60_000);
  const upperBound = new Date(now.getTime() + lookaheadMinutes * 60_000);
  const expiryBound = new Date(now.getTime() - REMINDER_RENUDGE_EXPIRY_MINUTES * 60_000);

  // Narrow at the DB layer (first-nudge window OR re-nudge candidates with
  // capacity); the pure finder is then the source of truth — it also applies
  // the since-last-nudge interval, which is deliberately NOT filtered here.
  const candidates = await prisma.plannedDose.findMany({
    where: {
      userId,
      status: "planned",
      protocol: { status: "active" },
      OR: [
        { reminderSentAt: null, scheduledAt: { gte: lowerBound, lte: upperBound } },
        {
          reminderSentAt: { not: null },
          reminderCount: { lt: REMINDER_MAX_NUDGES },
          scheduledAt: { gte: expiryBound, lte: upperBound },
        },
      ],
    },
    select: {
      id: true,
      scheduledAt: true,
      status: true,
      reminderSentAt: true,
      reminderCount: true,
    },
  });

  const due = dueReminders(candidates, now, lookaheadMinutes);

  let reminded = 0;
  for (const dose of due) {
    // Atomic claim — `reminderCount` is the optimistic token: only the tick
    // that still sees the count it read wins; a concurrent claimer bumped it.
    const claim = await prisma.plannedDose.updateMany({
      where: { id: dose.id, status: "planned", reminderCount: dose.reminderCount },
      data: { reminderSentAt: now, reminderCount: { increment: 1 } },
    });
    if (claim.count !== 1) continue; // already claimed by another tick

    try {
      const delivered = await sendPushToUser(
        userId,
        dose.reminderSentAt == null ? FIRST_NUDGE : RE_NUDGE,
      );
      if (delivered > 0) reminded++;
    } catch (err) {
      // Fail-safe: a push failure must never crash the tick. The nudge stays
      // spent (no immediate retry) — a later re-nudge covers it, until the cap.
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
