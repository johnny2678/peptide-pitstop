"use client";

import { SprayCan } from "lucide-react";

import { useMemo, useState } from "react";
import Decimal from "decimal.js";
import { computeDraw } from "@/lib/dosing/engine";
import type { DoseUnit, GraduationType } from "@/lib/dosing/types";
import { logDose } from "@/app/actions/doses";
import { enqueue } from "@/lib/offline/outbox";
import { safeUUID } from "@/lib/uuid";
import { RebasePrompt } from "./RebasePrompt";

interface SprayerDTO {
  id: string;
  name: string;
  graduationType: GraduationType;
  unitsPerMl: number;
  capacityMl: string;
  capacityUnits: number;
  increment: string;
  mlPerSpray: string | null;
}

interface Props {
  protocolId?: string;
  peptideName: string;
  preparation: { id: string; concentrationMcgPerMl: string; remainingMl: string };
  sprayers: SprayerDTO[];
  defaultSprayerId?: string;
  /** Prefill the "time taken" — used when logging for a day other than today. */
  defaultTakenAtISO?: string;
  initialSprays?: string;
}

function toLocalInput(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/**
 * Log a NASAL dose: a whole number of sprays through a chosen sprayer. The sprayer's
 * mL/spray × the vial concentration convert sprays → mcg + a depletion volume via
 * the shared dosing engine (route "nasal" rides the injection branch of `logDose`,
 * minus the needle/site). No body-map, no reconstitution here — just count sprays.
 */
export function NasalLogForm({ protocolId, peptideName, preparation, sprayers, defaultSprayerId, defaultTakenAtISO, initialSprays }: Props) {
  const [sprays, setSprays] = useState(initialSprays ?? "1");
  const [sprayerId, setSprayerId] = useState(defaultSprayerId ?? sprayers[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [takenAt, setTakenAt] = useState(toLocalInput(defaultTakenAtISO ? new Date(defaultTakenAtISO) : new Date()));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rebase, setRebase] = useState<{ protocolId: string; plannedDateISO: string; actualDateISO: string; suggestedDays: string[] } | undefined>();

  const sprayer = sprayers.find((s) => s.id === sprayerId) ?? sprayers[0];

  const draw = useMemo(() => {
    if (!sprayer) return null;
    let n: Decimal;
    try { n = new Decimal(sprays || 0); } catch { return null; }
    if (n.lte(0)) return null;
    try {
      return computeDraw({
        dose: { value: sprays, unit: "sprays" },
        preparation: { prepType: "premixed", concentrationMcgPerMl: new Decimal(preparation.concentrationMcgPerMl) },
        syringe: { ...sprayer },
        remainingMl: preparation.remainingMl,
      });
    } catch {
      return null;
    }
  }, [sprays, preparation, sprayer]);

  const blocker = draw?.warnings.find((w) => w.severity === "block");
  const valid = sprayer != null && draw != null && !blocker;

  // Per-spray mcg = mL/spray × concentration — the "≈ 200 mcg/spray" readback.
  const mcgPerSpray = useMemo(() => {
    if (!sprayer?.mlPerSpray) return null;
    try {
      return new Decimal(sprayer.mlPerSpray).times(preparation.concentrationMcgPerMl);
    } catch {
      return null;
    }
  }, [sprayer, preparation.concentrationMcgPerMl]);

  async function onConfirm() {
    if (!sprayer) return;
    setBusy(true);
    setError(null);

    const uuid = safeUUID();
    const input = {
      protocolId,
      route: "nasal" as const,
      preparationId: preparation.id,
      syringeId: sprayer.id,
      doseValue: sprays,
      doseUnit: "sprays" as DoseUnit,
      notes: notes || undefined,
      takenAtISO: new Date(takenAt).toISOString(),
      clientUuid: uuid,
    };

    let res: Awaited<ReturnType<typeof logDose>>;
    try {
      res = await logDose(input);
    } catch {
      await enqueue({ ...input, clientUuid: uuid });
      setBusy(false);
      setDone(true); // optimistic — the outbox syncs on reconnect
      return;
    }

    setBusy(false);
    if (res.ok) { setDone(true); if (res.rebase) setRebase(res.rebase); }
    else setError(res.error ?? "Could not log dose");
  }

  if (done) {
    return (
      <div className="space-y-2">
        <p className="rounded-control bg-ok/10 px-3 py-2 text-sm font-medium text-ok">Logged ✓ {peptideName}</p>
        {rebase && <RebasePrompt rebase={rebase} />}
      </div>
    );
  }

  if (!sprayer) {
    return <p className="text-sm text-muted">No sprayer yet — add one in Settings.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          inputMode="numeric"
          value={sprays}
          onChange={(e) => setSprays(e.target.value)}
          className="w-20 rounded-control border border-line/15 bg-bg px-3 py-2 tabular-nums"
          aria-label="Number of sprays"
        />
        <span className="text-sm text-muted">spray{sprays === "1" ? "" : "s"}</span>
      </div>

      <label className="block text-sm text-muted">
        Sprayer
        <select value={sprayerId} onChange={(e) => setSprayerId(e.target.value)} className="mt-1 w-full rounded-control border border-line/15 bg-bg px-3 py-2 text-ink" aria-label="Sprayer">
          {sprayers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>

      <p className="text-xs text-muted">
        {sprayer.mlPerSpray} mL/spray
        {mcgPerSpray && ` · ≈ ${mcgPerSpray.toDecimalPlaces(0).toString()} mcg/spray`}
        {` · ${new Decimal(preparation.remainingMl).toDecimalPlaces(2).toString()} mL left in vial`}
      </p>

      {draw && (
        <p className="rounded-control bg-bg px-3 py-2 text-sm ring-1 ring-line/10 tabular-nums">
          = {draw.deliveredMassMcg.toDecimalPlaces(0).toString()} mcg · {draw.deliveredVolumeMl.toDecimalPlaces(3).toString()} mL
        </p>
      )}

      {blocker && <p className="text-sm text-danger">{blocker.message}</p>}

      <label className="block text-sm text-muted">
        Time taken
        <input type="datetime-local" value={takenAt} onChange={(e) => setTakenAt(e.target.value)} className="mt-1 w-full rounded-control border border-line/15 bg-bg px-3 py-2 text-ink" />
      </label>

      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional, encrypted)" className="w-full rounded-control border border-line/15 bg-bg px-3 py-2 text-sm" />

      {error && <p className="text-sm text-danger">{error}</p>}

      <button
        type="button"
        onClick={onConfirm}
        disabled={busy || !valid}
        className="w-full rounded-control bg-accent px-4 py-3 font-medium text-onAccent disabled:opacity-40"
      >
        <SprayCan className="mr-1.5 inline h-4 w-4 align-[-0.125em]" aria-hidden />{busy ? "Logging…" : `Confirm & log ${peptideName}`}
      </button>
    </div>
  );
}
