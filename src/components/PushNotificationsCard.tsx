"use client";

import { Bell, BellOff, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { subscribePush, unsubscribePush, sendTestPush } from "@/app/actions/push";

/**
 * Dose-reminder notifications via Web Push — enable/disable THIS device and
 * fire a test push. Replaces the old Home Assistant relay.
 *
 * Platform gotchas this component narrates instead of failing silently:
 *   - Push needs a secure context: over plain http the API simply isn't there.
 *   - iOS only exposes push to web apps INSTALLED to the Home Screen (16.4+),
 *     so in-browser Safari gets an "install first" hint, not a broken button.
 *   - `Notification.requestPermission()` must run from a user gesture — it is
 *     only ever called from the Enable button's click handler.
 */

type Availability =
  | "detecting"
  | "no-vapid" // server has no VAPID keys configured
  | "insecure" // plain-http origin — Push API unavailable
  | "needs-install" // iOS Safari tab: must Add to Home Screen first
  | "unsupported" // browser has no Push API at all
  | "denied" // user blocked notifications for this origin
  | "off" // available, not subscribed on this device
  | "on"; // subscribed on this device

/** VAPID public key (base64url) → the BufferSource `subscribe()` requires. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  // Explicit ArrayBuffer (not ArrayBufferLike) so the result satisfies BufferSource.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function PushNotificationsCard({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [state, setState] = useState<Availability>("detecting");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function detect() {
      if (!vapidPublicKey) return setState("no-vapid");
      if (!window.isSecureContext) return setState("insecure");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        // iOS hides the Push API from plain Safari tabs; it appears once the
        // app is installed to the Home Screen and opened from its icon.
        const standalone =
          window.matchMedia("(display-mode: standalone)").matches ||
          (navigator as { standalone?: boolean }).standalone === true;
        return setState(isIos() && !standalone ? "needs-install" : "unsupported");
      }
      if (Notification.permission === "denied") return setState("denied");
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (!cancelled) setState(sub ? "on" : "off");
    }
    detect().catch(() => setState("unsupported"));
    return () => {
      cancelled = true;
    };
  }, [vapidPublicKey]);

  async function enable() {
    if (!vapidPublicKey) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        await sub.unsubscribe();
        setError("Browser returned an incomplete subscription.");
        return;
      }
      const res = await subscribePush({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
      if (!res.ok) {
        await sub.unsubscribe(); // don't leave a sub the server doesn't know about
        setError(res.error);
        return;
      }
      setState("on");
      setNote("Notifications on — dose reminders arrive on this device.");
    } catch (e) {
      console.warn("[push] enable failed", e);
      setError("Could not enable notifications on this device.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await unsubscribePush(endpoint);
      }
      setState("off");
      setNote("Notifications off for this device.");
    } catch (e) {
      console.warn("[push] disable failed", e);
      setError("Could not disable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await sendTestPush();
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setNote(`Test sent to ${res.sent} device${res.sent === 1 ? "" : "s"} ✓`);
  }

  const hint: Partial<Record<Availability, string>> = {
    "no-vapid": "Server isn't configured for push — set VAPID keys (docs/web-push-notifications.md).",
    insecure: "Push needs HTTPS. Serve the app over https (e.g. Tailscale Serve or a tunnel), then enable here.",
    "needs-install": "On iPhone: open in Safari, Share → Add to Home Screen, then enable from the installed app.",
    unsupported: "This browser doesn't support web push.",
    denied: "Notifications are blocked for this site — allow them in browser/site settings, then retry.",
  };

  return (
    <section className="mt-8">
      <h2 className="mb-1 text-sm font-medium text-muted">Notifications</h2>
      <p className="mb-3 text-sm text-muted">
        Dose reminders as push notifications, per device. The nudge is generic — no peptide names on your lock screen.
      </p>
      <div className="rounded-card bg-surface p-4 shadow-sm ring-1 ring-line/10">
        {state === "detecting" && <p className="text-sm text-muted">Checking this device…</p>}
        {hint[state] && <p className="text-sm text-muted">{hint[state]}</p>}
        {(state === "off" || state === "on") && (
          <div className="flex flex-wrap items-center gap-2">
            {state === "off" ? (
              <button
                type="button"
                onClick={enable}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-control bg-accent px-4 py-2 text-sm font-medium text-onAccent disabled:opacity-40"
              >
                <Bell className="h-4 w-4" aria-hidden /> {busy ? "Enabling…" : "Enable on this device"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={disable}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-control border border-line/15 bg-bg px-4 py-2 text-sm font-medium text-ink disabled:opacity-40"
                >
                  <BellOff className="h-4 w-4" aria-hidden /> Disable
                </button>
                <button
                  type="button"
                  onClick={test}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-control bg-accent px-4 py-2 text-sm font-medium text-onAccent disabled:opacity-40"
                >
                  <Send className="h-4 w-4" aria-hidden /> Send test
                </button>
              </>
            )}
          </div>
        )}
        {note && <p className="mt-2 text-xs text-ok">{note}</p>}
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </section>
  );
}
