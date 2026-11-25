import { loadDB, saveDB } from "@/lib/store";
import { emailAllowed, exchangeCode, googleConfigured, stateOk } from "@/lib/google";

export const dynamic = "force-dynamic";

const page = (msg: string, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><title>Gmail connection</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><p>${msg}</p></body>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export async function GET(req: Request) {
  if (!googleConfigured()) return page("Google sign-in is not set up on this server.", 503);
  const url = new URL(req.url), code = url.searchParams.get("code"), state = url.searchParams.get("state") ?? "";
  if (url.searchParams.get("error")) return page(`Google said: ${url.searchParams.get("error")}. Nothing was connected.`, 400);
  const cookie = req.headers.get("cookie")?.match(/aic_oauth=([a-f0-9]+)/)?.[1];
  if (!code || !stateOk(state) || !cookie || !state.startsWith(cookie + ".")) return page("This sign-in link has expired or did not start here. Open /api/auth/google again.", 400);
  try {
    const redirect = `${process.env.APP_URL ?? url.origin}/api/auth/google/callback`;
    const t = await exchangeCode(code, redirect);
    if (!t.email || !emailAllowed(t.email)) return page(`${t.email || "That account"} is not on the allowed list, so nothing was connected.`, 403);
    if (!t.refresh_token) return page("Google did not return a long-lived token. Remove this app from your Google account's connected apps and try again.", 400);
    const db = await loadDB();
    db.google = { email: t.email, refresh_token: t.refresh_token, connected_at: new Date().toISOString() };
    await saveDB(db);
    return page(`Connected as ${t.email}. Gmail and Calendar are ready. You can close this tab.`);
  } catch (e) { return page(`Could not finish the connection: ${String((e as Error).message).slice(0, 160)}`, 502); }
}
