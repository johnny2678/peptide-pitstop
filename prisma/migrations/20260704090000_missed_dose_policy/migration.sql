-- Per-protocol missed-dose handling. `missedDosePolicy` tells the overnight
-- pass what to do when a dose is marked missed (none | rollover |
-- rollover_shift). `rolledFromId` marks a PlannedDose as a make-up row
-- (pointing at the missed row) so the planner's off-grid override suppression
-- ignores it. Additive — existing rows keep today's behaviour ("none").
ALTER TABLE "Protocol" ADD COLUMN "missedDosePolicy" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "PlannedDose" ADD COLUMN "rolledFromId" TEXT;
