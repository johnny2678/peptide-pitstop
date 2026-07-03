"use server";

import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/owner";
import { isPushConfigured, sendPushToUser } from "@/lib/push";

/** `PushSubscription.toJSON()` from the browser — endpoint + encryption keys. */
interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Register (or refresh) this browser's push subscription. Upserts on the
 * endpoint URL: re-enabling on the same device updates keys in place instead
 * of accumulating dead rows.
 */
export async function subscribePush(input: SubscriptionInput) {
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const endpoint = typeof input?.endpoint === "string" ? input.endpoint.trim() : "";
  const p256dh = typeof input?.keys?.p256dh === "string" ? input.keys.p256dh : "";
  const auth = typeof input?.keys?.auth === "string" ? input.keys.auth : "";
  // Push endpoints are always https URLs to the browser vendor's push service.
  if (!endpoint.startsWith("https://") || !p256dh || !auth) {
    return { ok: false as const, error: "Invalid subscription." };
  }

  // Best-effort device label so a future device list is legible.
  const userAgent = headers().get("user-agent")?.slice(0, 255) ?? null;

  try {
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId: user.id, endpoint, p256dh, auth, userAgent },
      update: { userId: user.id, p256dh, auth, userAgent },
    });
  } catch (e) {
    console.error("subscribePush failed", e);
    return { ok: false as const, error: "Could not save subscription." };
  }
  return { ok: true as const };
}

/** Remove this browser's subscription (called after `pushManager.unsubscribe()`). */
export async function unsubscribePush(endpoint: string) {
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, error: "Not signed in." };
  try {
    await prisma.pushSubscription.deleteMany({
      where: { endpoint: typeof endpoint === "string" ? endpoint : "", userId: user.id },
    });
  } catch (e) {
    console.error("unsubscribePush failed", e);
    return { ok: false as const, error: "Could not remove subscription." };
  }
  return { ok: true as const };
}

/**
 * Fire a test notification to every device the user has enabled — the
 * "did I wire this up right?" button in Settings.
 */
export async function sendTestPush() {
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, error: "Not signed in." };
  if (!isPushConfigured()) {
    return { ok: false as const, error: "Server has no VAPID keys — see docs/web-push-notifications.md." };
  }
  try {
    const sent = await sendPushToUser(user.id, {
      title: "Pitstop",
      body: "Test notification — pushes are working.",
      url: "/today",
      tag: "peptide-pitstop-test",
    });
    if (sent === 0) return { ok: false as const, error: "No device received it — enable notifications first." };
    return { ok: true as const, sent };
  } catch (e) {
    console.error("sendTestPush failed", e);
    return { ok: false as const, error: "Send failed — check server logs." };
  }
}
