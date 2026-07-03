# Web Push — dose reminder notifications

Peptide Pitstop sends dose reminders as **native Web Push notifications** from
the installed PWA — no Home Assistant, no Companion app, no third-party
notification account. The payload is encrypted end to end (RFC 8291): the
browser vendor's push service relays it but cannot read it.

The nudge is **privacy-safe by design**: a generic "Time to review — tap to
open." with no peptide name, dose, or time — nothing sensitive ever lands on
your lock screen. Tapping it opens the app's `/today` review screen; from an
installed PWA it opens **fullscreen** in the app itself.

> This replaced the earlier Home Assistant webhook relay
> (`HA_WEBHOOK_URL` + a HA automation). That path is gone — if you had the
> automation installed, delete it and drop `HA_WEBHOOK_URL` from your `.env`.

## How it works

- A 15-minute tick in the app (`src/instrumentation.ts` → `runReminders`) finds
  `PlannedDose` rows that are `status:"planned"`, not yet reminded, on an
  **active** protocol, and scheduled within `[now - 30 min, now + 30 min]`.
- Each due dose is **claimed atomically** (`reminderSentAt` stamp — never
  reminded twice), then one push fans out to **every device you enrolled**
  (each browser / installed PWA is its own subscription).
- A fixed notification `tag` means a repeat nudge **replaces** the previous one
  — you never see a stack.
- If you have **no enrolled devices**, doses are left unclaimed, so enabling
  notifications mid-window still gets you the nudge.
- If VAPID keys are unset the feature is dormant (logged once, no crash).

## Requirements

1. **HTTPS.** Browsers only expose the Push API in a secure context. Serve the
   app over https — a Cloudflare Tunnel domain, a reverse proxy with a real
   cert, or `tailscale serve` (free, tailnet-only, valid certs) all work.
   Plain `http://<lan-ip>` will never show the enable button.
2. **iPhone: install to Home Screen.** iOS (16.4+) only grants push to web
   apps opened from a Home Screen icon: Safari → Share → **Add to Home
   Screen**, open the icon, then enable notifications in Settings.
3. **VAPID keys** on the server (below).

## 1. Generate VAPID keys (once)

```bash
npx web-push generate-vapid-keys
```

Put the pair in the compose `.env`:

```bash
VAPID_PUBLIC_KEY="BM…"
VAPID_PRIVATE_KEY="…"
# optional contact push services may use to reach you:
VAPID_SUBJECT="mailto:you@example.com"
```

> Treat the private key like a secret, and **don't rotate it casually** — new
> keys orphan every existing subscription and each device must re-enable.

## 2. Enrol a device

In the app: **Settings → Notifications → Enable on this device**, then
**Send test**. The card explains itself when something's missing (no HTTPS,
not installed to Home Screen, notifications blocked, server keys unset).

## Troubleshooting

- **No Enable button, hint about HTTPS** — you're on `http://`. Fix the origin
  first; the Push API genuinely does not exist in insecure contexts.
- **iPhone shows "install first"** — you're in a Safari tab. Add to Home
  Screen and open from the icon; iOS hides push from plain tabs.
- **Test says "No device received it"** — this browser isn't enrolled (enable
  first), or the subscription was pruned after the push service returned
  404/410 (re-enable).
- **Changed domains?** A subscription is bound to its origin. After moving
  hosts (e.g. LAN IP → tunnel domain), re-install the PWA on the new origin
  and re-enable notifications; old-origin rows get pruned automatically on the
  first failed push.
