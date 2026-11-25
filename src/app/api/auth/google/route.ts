import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { authUrl, googleConfigured, signState } from "@/lib/google";

export const dynamic = "force-dynamic";

const redirectUri = (req: Request) => `${process.env.APP_URL ?? new URL(req.url).origin}/api/auth/google/callback`;

// Visit this once, signed in as the fund mailbox, to connect Gmail and Calendar.
export async function GET(req: Request) {
  if (!googleConfigured()) return Response.json({ error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set." }, { status: 503 });
  const nonce = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authUrl(redirectUri(req), signState(nonce)));
  res.cookies.set("aic_oauth", nonce, { httpOnly: true, secure: new URL(req.url).protocol === "https:", sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
