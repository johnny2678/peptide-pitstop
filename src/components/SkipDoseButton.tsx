"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, X } from "lucide-react";
import { skipPlannedDose } from "@/app/actions/doses";

/**
 * Two-tap "Skip dose" (mirrors DeleteLogButton's confirm pattern). Skip is a
 * deliberate cancel: reminders stop and the missed-dose policy does NOT fire —
 * only doses that go missed overnight roll over / shift the schedule.
 */
export function SkipDoseButton({ protocolId, dateKey, label }: { protocolId: string; dateKey: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function skip() {
    setBusy(true);
    setError(null);
    const res = await skipPlannedDose({ protocolId, dateKey });
    setBusy(false);
    if (res.ok) {
      router.refresh();
    } else {
      setError(res.error ?? "Could not skip.");
    }
  }

  if (!confirming) {
    return (
      <span className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={`Skip ${label}`}
          title="Mark as skipped — stops reminders; no make-up dose"
          className="inline-flex items-center gap-1 font-medium text-muted hover:text-danger"
        >
          <Ban className="h-3.5 w-3.5" aria-hidden /> Skip this dose
        </button>
        {error && <span className="text-danger">{error}</span>}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs">
      <button type="button" onClick={skip} disabled={busy} className="inline-flex items-center gap-1 font-medium text-danger disabled:opacity-40">
        <Check className="h-3.5 w-3.5" aria-hidden /> {busy ? "…" : "Confirm skip"}
      </button>
      <button type="button" onClick={() => setConfirming(false)} className="inline-flex items-center gap-1 text-muted">
        <X className="h-3.5 w-3.5" aria-hidden /> Cancel
      </button>
      {error && <span className="text-danger">{error}</span>}
    </span>
  );
}
