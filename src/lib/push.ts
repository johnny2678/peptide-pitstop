/**
 * Web Push transport — sends dose-reminder notifications straight to the
 * installed PWA (iOS 16.4+ Home Screen web apps, Android, desktop). Replaces
 * the earlier Home Assistant webhook relay: no HA automation, no Companion
 * app — the push service delivers to the browser and `sw.js` shows it.
 *
 * Config (all-or-nothing pair; unset → feature dormant, logged once, no crash):
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — generate ONCE per deployment with
 *     `npx web-push generate-vapid-keys`. Rotating them orphans every existing
 *     subscription (devices must re-enable notifications), so treat like a key.
 *   VAPID_SUBJECT — optional mailto:/https: contact URL push services may use
 *     to reach the operator; defaults to mailto:owner@example.com.
 *
 * PRIVACY: title/body land on the phone's lock screen. Keep peptide names,
 * doses and times OUT of them — callers send a generic "time to review" nudge
 * only (same rule the HA notification had; see docs/web-push-notifications.md).
 *
 * Requires HTTPS end to end: browsers only expose the Push API in a secure
 * context, so the app must be served over https for subscribe to work at all.
 */

/** What the service worker shows. Serialized as the (encrypted) push payload. */
export interface PushMessage {
  title: string;
  body: string;
  /** App-relative URL to open on tap (e.g. "/today"). */
  url: string;
  /** Notification tag — a repeat with the same tag REPLACES, never stacks. */
  tag: string;
}

let warnedNoVapid = false;

/** VAPID key pair from env, or null (logged once) when push is unconfigured. */
function getVapidConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = (process.env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY ?? "").trim();
  if (!publicKey || !privateKey) {
    if (!warnedNoVapid) {
      console.log("[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — web push dormant");
      warnedNoVapid = true;
    }
    return null;
  }
  const subject = (process.env.VAPID_SUBJECT ?? "").trim() || "mailto:owner@example.com";
  return { publicKey, privateKey, subject };
}

/** True when VAPID keys are configured (reminder tick gates on this). */
export function isPushConfigured(): boolean {
  return getVapidConfig() !== null;
}

/**
 * Send one message to every subscription the user has (each browser / installed
 * PWA is its own row). Returns the number of successful deliveries.
 *
 * Dead endpoints (push service answers 404/410 — the user uninstalled the PWA
 * or revoked notifications) are deleted so we stop paying for them. Other
 * failures are logged and skipped: one flaky push service must never take the
 * reminder tick down.
 */
export async function sendPushToUser(userId: string, message: PushMessage): Promise<number> {
  const vapid = getVapidConfig();
  if (!vapid) return 0;

  const { prisma } = await import("@/lib/db");
  const subs = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subs.length === 0) return 0;

  const { default: webpush } = await import("web-push");
  const payload = JSON.stringify(message);

  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        {
          vapidDetails: vapid,
          // A reminder an hour late is noise — let the push service drop it.
          TTL: 3600,
          urgency: "high",
          timeout: 10_000,
        },
      );
      sent++;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Subscription is gone on the push-service side — prune our row.
        await prisma.pushSubscription
          .delete({ where: { id: sub.id } })
          .catch(() => undefined); // already pruned by a concurrent tick — fine
        console.log(`[push] pruned dead subscription ${sub.id} (${statusCode})`);
      } else {
        console.error(`[push] send failed for subscription ${sub.id}:`, err);
      }
    }
  }
  return sent;
}
