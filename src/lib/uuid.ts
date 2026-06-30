/**
 * UUID v4 that also works in a NON-secure context.
 *
 * `crypto.randomUUID()` is only defined in a secure context — HTTPS or
 * http://localhost. A self-hosted instance reached over plain HTTP on a LAN
 * (e.g. http://tower-ip:3000 — the documented COOKIE_SECURE=false setup) is NOT
 * a secure context, so there `crypto.randomUUID` is `undefined` and calling it
 * THROWS. That throw, fired before the dose-log submit's try/catch, leaves the
 * form's spinner stuck forever (the request never even leaves the browser).
 *
 * `crypto.getRandomValues()` carries no secure-context restriction, so we derive
 * a v4 UUID from it whenever randomUUID is unavailable. Used for the dose-log
 * client UUID (idempotency + offline-outbox dedup): it must be unique + stable,
 * which this guarantees.
 */
export function safeUUID(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();

  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(b);
  } else {
    // No Web Crypto at all (very old/exotic runtime): fall back to Math.random.
    // Not cryptographic, but a dedup key only needs to be collision-free.
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx

  const hex: string[] = [];
  for (let i = 0; i < 256; i++) hex.push((i + 0x100).toString(16).slice(1));
  return (
    hex[b[0]] + hex[b[1]] + hex[b[2]] + hex[b[3]] + "-" +
    hex[b[4]] + hex[b[5]] + "-" +
    hex[b[6]] + hex[b[7]] + "-" +
    hex[b[8]] + hex[b[9]] + "-" +
    hex[b[10]] + hex[b[11]] + hex[b[12]] + hex[b[13]] + hex[b[14]] + hex[b[15]]
  );
}
