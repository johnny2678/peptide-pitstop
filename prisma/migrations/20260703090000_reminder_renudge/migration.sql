-- Repeat-until-logged reminders: reminderSentAt now records the LAST nudge
-- (not the only one) and reminderCount caps total nudges per dose. Existing
-- once-nudged rows keep count 0 — the sender treats them as re-nudge
-- candidates with full remaining capacity, which is the desired behaviour.
ALTER TABLE "PlannedDose" ADD COLUMN "reminderCount" INTEGER NOT NULL DEFAULT 0;
