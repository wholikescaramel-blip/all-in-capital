import crypto from "node:crypto";

// Resend signs webhooks with Svix. The signed text is "<id>.<timestamp>.<raw body>", HMAC-SHA256 with the base64 part of the
// secret ("whsec_..."), and the header holds one or more "v1,<base64>" signatures. Requests older than five minutes are refused.
export function verifySvix(body: string, h: { id?: string | null; timestamp?: string | null; signature?: string | null }, secret: string, toleranceSec = 300, nowMs = Date.now()): boolean {
  if (!h.id || !h.timestamp || !h.signature || !secret) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${body}`).digest();
  return h.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

export function signSvix(body: string, id: string, timestamp: string, secret: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return "v1," + crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}
