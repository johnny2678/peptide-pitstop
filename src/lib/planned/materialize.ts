/**
 * Pure planned-dose materializer. No I/O — takes protocol data and existing
 * PlannedDose rows; returns the desired upsert set and any status transitions.
 *
 * Call site for schedule expansion:
 *   slotsInRange / slotsOn / parseSchedule (src/lib/schedule/entries.ts) — the
 *   custom-schedules engine. Parses both JSON scheduleRule (starts with "[") and
 *   legacy RRULE strings, so JSON custom schedules expand correctly rather than
 *   falling back to DAILY.
 */

import { startOfDay, addDays, daysBetween } from "../schedule/schedule";
import { parseSchedule, slotsOn, slotsInRange } from "../schedule/entries";
import { shiftSchedule } from "../schedule/shift";
import { resolveTitration } from "../titration/resolve";
import { buildResolveInput, type DeliveredLogInput } from "../titration/from-protocol";

// ─── input types ──────────────────────────────────────────────────────────

export interface ProtocolInput {
  id: string;
  userId: string;
  status: string;           // "active" | "paused" | "completed"
  scheduleRule: string | null;
  targetDose: string | null;
  doseInputUnit: string;
  /** per_injection | per_week — drives the basis-aware per-injection conversion. */
  doseBasis: string | null;
  /** fixed_anchor | rolling — needed for the resolver's within-week rebase. */
  rebaseMode: string | null;
  adherenceWindowMin: number | null;
  startDate: Date | null;
  endDate: Date | null;
  steps: ProtocolStepInput[];
  scheduleType: string;
  /** This protocol's FULL delivered DoseLog history — drives the titration phase cursor. */
  deliveredLogs: DeliveredLogInput[];
  /** none | rollover | rollover_shift — what missed-dose reconciliation does. Optional: absent = "none". */
  missedDosePolicy?: string | null;
}

export interface ProtocolStepInput {
  stepIndex: number;
  dose: string;
  doseInputUnit: string;
  durationDays: number | null;
}

export interface PlannedDoseInput {
  id: string;
  protocolId: string;
  scheduledAt: Date;
  status: string;           // "planned" | "taken" | "missed" | "skipped"
  hasDoseLog: boolean;
  /** Set when this row is a missed-dose make-up. Optional: absent = null. */
  rolledFromId?: string | null;
}

// ─── output types ─────────────────────────────────────────────────────────

export interface PlannedDoseUpsert {
  protocolId: string;
  userId: string;
  scheduledAt: Date;
  targetDose: string | null;
  doseInputUnit: string;
  status: "planned";
}

export interface StatusUpdate {
  id: string;
  status: "missed";
}

/** A missed-dose make-up row to create (missedDosePolicy rollover / rollover_shift). */
export interface RolloverUpsert {
  protocolId: string;
  userId: string;
  scheduledAt: Date; // the make-up date (local midnight)
  targetDose: string | null;
  doseInputUnit: string;
  /** The missed PlannedDose row this makes up for. */
  rolledFromId: string;
}

/** A schedule re-anchor to apply (missedDosePolicy rollover_shift). */
export interface ScheduleShift {
  protocolId: string;
  /** Re-serialised scheduleRule, or null when only the anchor moves. */
  newScheduleRule: string | null;
  /** Days to add to Protocol.startDate (interval/cycle anchor); 0 = leave it. */
  startDateDeltaDays: number;
}

export interface MaterializeResult {
  /** Rows to upsert (keyed on protocolId + scheduledAt by the runner). */
  upserts: PlannedDoseUpsert[];
  /** Existing rows whose status should be updated to "missed". */
  statusUpdates: StatusUpdate[];
  /** Make-up rows to create for missed doses (per policy). */
  rollovers: RolloverUpsert[];
  /** Schedule re-anchors to apply (rollover_shift only). */
  scheduleShifts: ScheduleShift[];
}

// ─── local helpers ────────────────────────────────────────────────────────

const KEY = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Monday (local) of the week containing `date` — mirrors weekStartOf in doses-timeline.ts */
function weekStartOf(date: Date): Date {
  const s = startOfDay(date);
  return addDays(s, -((s.getDay() + 6) % 7));
}

// ─── main export ──────────────────────────────────────────────────────────

/**
 * Compute the desired PlannedDose state for all active protocols across the
 * given horizon. Pure — no database access.
 *
 * @param protocols   Active (and paused/completed — filtered here) protocols.
 * @param horizonStart  Start of the generation window (inclusive, local midnight).
 * @param horizonEnd    End of the generation window (inclusive, local midnight).
 * @param existing    All PlannedDose rows for these protocols (any status) within
 *                    or before the horizon, used for override detection +
 *                    missed-dose reconciliation.
 * @param today       Local midnight of "today" — the reconciliation boundary.
 */
export function materializePlannedDoses(args: {
  protocols: ProtocolInput[];
  horizonStart: Date;
  horizonEnd: Date;
  existing: PlannedDoseInput[];
  today: Date;
}): MaterializeResult {
  const { protocols, horizonStart, horizonEnd, existing, today } = args;
  const todayKey = KEY(today);

  // ── 1. Compute override-suppressed week set per protocol ─────────────────
  // A "rebase override" is an existing "planned" row whose scheduledAt falls
  // OFF the protocol's schedule grid (written by confirmRebase with a shifted
  // date). We detect these by checking whether the existing row's scheduledAt
  // is NOT a due-date for the protocol's rule. If an off-grid "planned" row
  // exists in a week, the generator skips grid expansion for that whole week.
  //
  // Existing "planned" rows that ARE on the grid (e.g. from a previous run of
  // this same generator) do NOT trigger suppression — this preserves idempotency.
  // Existing rows with status != "planned" (taken/missed/skipped) are history
  // and do not trigger suppression.

  // Build a lookup: protocolId → protocol (for rule + startDate/endDate lookup)
  const protocolMap = new Map(protocols.map((p) => [p.id, p]));

  type ProtocolWeekKey = string; // `${protocolId}:${weekKey}`
  const suppressedWeeks = new Set<ProtocolWeekKey>();

  // A genuine confirmRebase deletes the week's on-grid rows and writes ONLY
  // shifted off-grid ones. So suppress a (protocol, week) only when it has
  // off-grid "planned" rows AND NO on-grid one. A MIX (on-grid + off-grid) means
  // the off-grid rows are stale artefacts (edited schedule / old rebase) — those
  // must not suppress and lose the live grid for that week (which would drop a
  // genuinely-scheduled day from Today).
  const onGridWeeks = new Set<ProtocolWeekKey>();
  const offGridWeeks = new Set<ProtocolWeekKey>();
  for (const row of existing) {
    if (row.status !== "planned") continue;
    // Make-up rows (missed-dose rollovers) are EXPECTED off-grid — they are
    // not rebase overrides and must never suppress their week's grid.
    if (row.rolledFromId != null) continue;
    const p = protocolMap.get(row.protocolId);
    if (!p || !p.scheduleRule) continue;
    const onGrid =
      slotsOn(parseSchedule(p.scheduleRule), row.scheduledAt, p.startDate, p.endDate).length > 0;
    const key = `${row.protocolId}:${KEY(weekStartOf(row.scheduledAt))}`;
    (onGrid ? onGridWeeks : offGridWeeks).add(key);
  }
  for (const key of offGridWeeks) {
    if (!onGridWeeks.has(key)) suppressedWeeks.add(key);
  }

  // ── 2. Expand schedule grid → desired upsert set ─────────────────────────
  const upserts: PlannedDoseUpsert[] = [];

  // Per-protocol resolved per-injection doses, kept for the rollover rows in
  // step 3 (a make-up row wants the same day-level dose resolution the grid
  // rows get).
  type ResolvedSlot = { perInjectionValue: string; perInjectionUnit: string };
  const resolvedByProtocol = new Map<string, Map<string, ResolvedSlot>>();

  for (const p of protocols) {
    // Only materialize active protocols.
    if (p.status !== "active") continue;
    if (!p.scheduleRule) continue;

    const occurrences = [
      ...new Map(
        slotsInRange(parseSchedule(p.scheduleRule), horizonStart, horizonEnd, p.startDate, p.endDate)
          .map((s) => [KEY(s.date), startOfDay(s.date)] as const),
      ).values(),
    ];

    // Resolve the per-injection dose for every slot in the horizon ONCE per
    // protocol (single source of truth). A raw per_week weekly value must never
    // be persisted into PlannedDose.targetDose where it would later be read as a
    // per-injection dose (spec §6) — the resolver divides it exactly once.
    const resolved = resolveTitration(
      buildResolveInput({
        protocol: {
          doseBasis: p.doseBasis,
          targetDose: p.targetDose,
          doseInputUnit: p.doseInputUnit,
          scheduleRule: p.scheduleRule,
          rebaseMode: p.rebaseMode,
          startDate: p.startDate,
          endDate: p.endDate,
          adherenceWindowMin: p.adherenceWindowMin,
          steps: p.steps,
        },
        deliveredLogs: p.deliveredLogs,
        range: { start: horizonStart, end: horizonEnd },
        now: today,
      }),
    );
    // Index resolved slots by date (occurrences are untimed/per-day); first slot
    // for a date wins, matching the day-level dose used for planned rows.
    const resolvedByDate = new Map<string, (typeof resolved.slots)[number]>();
    for (const rs of resolved.slots) {
      const k = KEY(rs.date);
      if (!resolvedByDate.has(k)) resolvedByDate.set(k, rs);
    }
    resolvedByProtocol.set(p.id, resolvedByDate);

    for (const occ of occurrences) {
      // Suppress grid slots for weeks that already have override "planned" rows.
      const weekKey = KEY(weekStartOf(occ));
      if (suppressedWeeks.has(`${p.id}:${weekKey}`)) continue;

      // Per-injection dose for this occurrence's date. The resolver emits "" only
      // when a per_week dose can't be divided (frequency unresolved) — in that
      // case write null so the upsert PRESERVES any prior value rather than
      // overwriting it with an (undivided) weekly figure. per_injection always
      // resolves; non-titration falls through to the resolved fallback dose.
      const slot = resolvedByDate.get(KEY(occ));
      const resolvedValue = slot && slot.perInjectionValue !== "" ? slot.perInjectionValue : null;
      const targetDose =
        resolvedValue ?? (p.doseBasis === "per_week" ? null : p.targetDose);
      const doseInputUnit = slot ? slot.perInjectionUnit : p.doseInputUnit;

      upserts.push({
        protocolId: p.id,
        userId: p.userId,
        scheduledAt: occ,
        targetDose,
        doseInputUnit,
        status: "planned",
      });
    }
  }

  // ── 3. Missed-dose reconciliation ────────────────────────────────────────
  // An existing "planned" row whose scheduledAt is strictly before today and
  // has no linked DoseLog → mark it "missed".
  const statusUpdates: StatusUpdate[] = [];
  // Newly-missed non-make-up rows per protocol — candidates for rollover.
  const missedByProtocol = new Map<string, PlannedDoseInput[]>();

  for (const row of existing) {
    if (row.status !== "planned") continue;
    if (row.hasDoseLog) continue;
    const rowKey = KEY(row.scheduledAt);
    if (rowKey >= todayKey) continue; // today or future → not yet missed
    statusUpdates.push({ id: row.id, status: "missed" });
    // Make-up rows that themselves get missed do NOT chain another make-up —
    // one retry per missed dose, then the normal grid resumes.
    if (row.rolledFromId != null) continue;
    const list = missedByProtocol.get(row.protocolId) ?? [];
    list.push(row);
    missedByProtocol.set(row.protocolId, list);
  }

  // ── 4. Missed-dose policy: rollover / rollover_shift ────────────────────
  // At most ONE make-up per protocol per pass (the most recent miss) — after a
  // multi-day outage the user gets one catch-up dose, not a backlog of them.
  const rollovers: RolloverUpsert[] = [];
  const scheduleShifts: ScheduleShift[] = [];

  // Any existing row (any status) already occupying (protocol, day) blocks a
  // make-up on that day — you don't make up a dose on a day you already dose.
  const occupiedDays = new Set<string>();
  for (const row of existing) occupiedDays.add(`${row.protocolId}:${KEY(row.scheduledAt)}`);

  for (const [protocolId, missedRows] of missedByProtocol) {
    const p = protocolMap.get(protocolId);
    if (!p || p.status !== "active" || !p.scheduleRule) continue;
    const policy = p.missedDosePolicy ?? "none";
    if (policy !== "rollover" && policy !== "rollover_shift") continue;

    const latest = missedRows.reduce((a, b) => (a.scheduledAt > b.scheduledAt ? a : b));

    // Make-up lands the day after the miss; if the pass didn't run for days,
    // clamp to today — a make-up in the past would be marked missed right back.
    let makeupDate = startOfDay(addDays(latest.scheduledAt, 1));
    if (KEY(makeupDate) < todayKey) makeupDate = today;
    const delta = daysBetween(startOfDay(latest.scheduledAt), makeupDate);

    // Guards: protocol still running on the make-up day, and that day is free
    // (no existing row, no grid occurrence).
    if (p.endDate && makeupDate > startOfDay(p.endDate)) continue;
    if (occupiedDays.has(`${protocolId}:${KEY(makeupDate)}`)) continue;
    if (slotsOn(parseSchedule(p.scheduleRule), makeupDate, p.startDate, p.endDate).length > 0) continue;

    // Same day-level dose resolution the grid rows get; resolver misses fall
    // back exactly like step 2 (never persist an undivided per_week figure).
    const slot = resolvedByProtocol.get(protocolId)?.get(KEY(makeupDate));
    const resolvedValue = slot && slot.perInjectionValue !== "" ? slot.perInjectionValue : null;
    rollovers.push({
      protocolId,
      userId: p.userId,
      scheduledAt: makeupDate,
      targetDose: resolvedValue ?? (p.doseBasis === "per_week" ? null : p.targetDose),
      doseInputUnit: slot ? slot.perInjectionUnit : p.doseInputUnit,
      rolledFromId: latest.id,
    });

    if (policy === "rollover_shift") {
      const shift = shiftSchedule(p.scheduleRule, delta);
      if (shift.newRule !== null || shift.shiftStartDate) {
        scheduleShifts.push({
          protocolId,
          newScheduleRule: shift.newRule,
          startDateDeltaDays: shift.shiftStartDate ? delta : 0,
        });
      }
    }
  }

  return { upserts, statusUpdates, rollovers, scheduleShifts };
}
