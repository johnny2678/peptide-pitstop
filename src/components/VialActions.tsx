"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Pencil, FlaskConical, Archive, Trash2, Copy, Check, X } from "lucide-react";
import { retireVial, deleteVial, cloneVial } from "@/app/actions/vials";
import { OverflowMenu } from "@/components/OverflowMenu";

const CLONE_CHIPS = [1, 2, 3, 5, 10];

export function VialActions({ id, hasPrep = false, doseCount = 0 }: { id: string; hasPrep?: boolean; doseCount?: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function clone(n: number) {
    setBusy(true);
    setError(null);
    const res = await cloneVial(id, n);
    setBusy(false);
    if (res.ok) {
      setCloning(false);
      setCustom("");
      router.refresh();
    } else {
      setError(res.error ?? "Could not clone.");
    }
  }

  async function retire() {
    setBusy(true);
    setError(null);
    const res = await retireVial(id, "finished");
    setBusy(false);
    if (res.ok) {
      router.refresh();
    } else {
      setError(res.error ?? "Could not retire.");
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await deleteVial(id);
    setBusy(false);
    if (res.ok) {
      router.refresh();
    } else {
      setError(res.error ?? "Could not delete.");
    }
  }

  const deletePrompt = doseCount > 0
    ? `Permanently delete this vial and its ${doseCount} logged dose${doseCount === 1 ? "" : "s"}? This can't be undone.`
    : "Permanently delete this vial? This can't be undone.";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      {confirming ? (
        <>
          <button type="button" disabled={busy} onClick={retire} className="inline-flex items-center gap-1 font-medium text-danger disabled:opacity-40"><Check className="h-3.5 w-3.5" aria-hidden /> {busy ? "…" : "Confirm retire"}</button>
          <button type="button" onClick={() => setConfirming(false)} className="inline-flex items-center gap-1 text-muted"><X className="h-3.5 w-3.5" aria-hidden /> Cancel</button>
        </>
      ) : deleting ? (
        <>
          <span className="text-danger">{deletePrompt}</span>
          <button type="button" disabled={busy} onClick={remove} className="inline-flex items-center gap-1 font-medium text-danger disabled:opacity-40"><Check className="h-3.5 w-3.5" aria-hidden /> {busy ? "…" : "Confirm delete"}</button>
          <button type="button" onClick={() => setDeleting(false)} className="inline-flex items-center gap-1 text-muted"><X className="h-3.5 w-3.5" aria-hidden /> Cancel</button>
        </>
      ) : cloning ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="text-muted">Clone ×</span>
          {CLONE_CHIPS.map((n) => (
            <button key={n} type="button" disabled={busy} onClick={() => clone(n)} className="rounded-control bg-bg px-2 py-1 font-medium text-accentStrong ring-1 ring-line/15 hover:bg-accent/10 disabled:opacity-40">{n}</button>
          ))}
          <form
            onSubmit={(e) => { e.preventDefault(); const n = Number(custom); if (n >= 1) clone(n); }}
            className="flex items-center gap-1"
          >
            <input type="number" min={1} max={24} inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="#" aria-label="Custom clone count" className="w-12 rounded-control bg-bg px-2 py-1 text-center tabular-nums ring-1 ring-line/15" />
            <button type="submit" disabled={busy || !custom} className="inline-flex items-center gap-1 font-medium text-accentStrong disabled:opacity-40"><Check className="h-3.5 w-3.5" aria-hidden /></button>
          </form>
          <button type="button" onClick={() => { setCloning(false); setCustom(""); }} className="inline-flex items-center gap-1 text-muted"><X className="h-3.5 w-3.5" aria-hidden /> Cancel</button>
          {busy && <span className="text-muted">…</span>}
        </div>
      ) : (
        <>
          {/* Desktop (sm+): inline action row — unchanged from before */}
          <div className="hidden sm:flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Link href={`/inventory/${id}/edit`} className="inline-flex items-center gap-1 font-medium text-accentStrong"><Pencil className="h-3.5 w-3.5" aria-hidden /> Edit</Link>
            {hasPrep && <Link href={`/inventory/${id}/recon/edit`} className="inline-flex items-center gap-1 font-medium text-accentStrong"><FlaskConical className="h-3.5 w-3.5" aria-hidden /> Edit recon</Link>}
            <button type="button" onClick={() => setCloning(true)} className="inline-flex items-center gap-1 font-medium text-accentStrong"><Copy className="h-3.5 w-3.5" aria-hidden /> Clone</button>
            <button type="button" onClick={() => setConfirming(true)} className="inline-flex items-center gap-1 font-medium text-muted hover:text-danger"><Archive className="h-3.5 w-3.5" aria-hidden /> Retire</button>
            <button type="button" onClick={() => setDeleting(true)} className="inline-flex items-center gap-1 font-medium text-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete</button>
          </div>
          {/* Mobile (<sm): same four actions collapsed into an overflow menu */}
          <div className="sm:hidden">
            <OverflowMenu>
              <Link href={`/inventory/${id}/edit`} className="flex items-center gap-2 rounded-control px-3 py-2 font-medium text-accentStrong hover:bg-bg"><Pencil className="h-3.5 w-3.5" aria-hidden /> Edit</Link>
              {hasPrep && <Link href={`/inventory/${id}/recon/edit`} className="flex items-center gap-2 rounded-control px-3 py-2 font-medium text-accentStrong hover:bg-bg"><FlaskConical className="h-3.5 w-3.5" aria-hidden /> Edit recon</Link>}
              <button type="button" onClick={() => setCloning(true)} className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-left font-medium text-accentStrong hover:bg-bg"><Copy className="h-3.5 w-3.5" aria-hidden /> Clone</button>
              <button type="button" onClick={() => setConfirming(true)} className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-left font-medium text-muted hover:bg-bg hover:text-danger"><Archive className="h-3.5 w-3.5" aria-hidden /> Retire</button>
              <button type="button" onClick={() => setDeleting(true)} className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-left font-medium text-danger hover:bg-bg"><Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete</button>
            </OverflowMenu>
          </div>
        </>
      )}
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}
