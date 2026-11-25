import crypto from "node:crypto";

// Google sign-in, Gmail and Calendar over plain REST, so there is nothing to install.
// One connected account (the fund mailbox) sends the letters, reads the replies, and owns the calendar that is checked and booked.
export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
];

export const googleConfigured = () => !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
const allowed = () => (process.env.ALLOWED_EMAILS ?? process.env.MAILBOX_EMAIL ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
export const emailAllowed = (email: string) => allowed().includes(email.toLowerCase());

export function authUrl(redirectUri: string, state: string) {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", state, login_hint: process.env.MAILBOX_EMAIL ?? "",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

// The state is signed so a callback can only be finished by the browser that started it.
export const signState = (nonce: string) => nonce + "." + crypto.createHmac("sha256", process.env.GOOGLE_CLIENT_SECRET ?? "").update(nonce).digest("hex").slice(0, 32);
export const stateOk = (s: string) => { const [n] = s.split("."); return !!n && signState(n) === s; };

type Tok = { access_token: string; expires_in: number; refresh_token?: string; id_token?: string };
async function tokenCall(body: Record<string, string>): Promise<Tok> {
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...body }), signal: AbortSignal.timeout(20000) });
  const j = (await res.json().catch(() => ({}))) as Tok & { error?: string; error_description?: string };
  if (!res.ok) throw new Error(`Google sign-in: ${j.error_description ?? j.error ?? res.status}`);
  return j;
}

export async function exchangeCode(code: string, redirectUri: string) {
  const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  const me = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(20000) }).then((r) => r.json()) as { email?: string };
  return { email: me.email ?? "", refresh_token: t.refresh_token, access_token: t.access_token };
}

const cache = new Map<string, { token: string; until: number }>();
export async function accessToken(refresh: string): Promise<string> {
  const hit = cache.get(refresh);
  if (hit && hit.until > Date.now() + 60000) return hit.token;
  const t = await tokenCall({ grant_type: "refresh_token", refresh_token: refresh });
  cache.set(refresh, { token: t.access_token, until: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}

async function api<T>(refresh: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, { method: init.method ?? "GET", headers: { Authorization: `Bearer ${await accessToken(refresh)}`, "content-type": "application/json" }, body: init.body ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(25000) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok) { const e = new Error(`Google: ${j.error?.message ?? res.status}`) as Error & { status?: number }; e.status = res.status; throw e; }
  return j;
}

// ---------- Gmail ----------
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const header = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);

export function buildRaw(m: { from: string; to: string; subject: string; body: string; inReplyTo?: string; references?: string }) {
  const lines = [
    `From: ${m.from}`, `To: ${m.to}`, `Subject: ${header(m.subject)}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64",
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.references ?? m.inReplyTo}`] : []),
    "", Buffer.from(m.body).toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ];
  return b64url(lines.join("\r\n"));
}

export type GmailMessage = { id: string; threadId: string; from: string; subject: string; body: string; messageIdHeader?: string; at: string; sent: boolean };

export async function gmailSend(refresh: string, m: { from: string; to: string; subject: string; body: string; threadId?: string; inReplyTo?: string; references?: string }) {
  const j = await api<{ id: string; threadId: string }>(refresh, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", body: { raw: buildRaw(m), ...(m.threadId ? { threadId: m.threadId } : {}) } });
  return { id: j.id, threadId: j.threadId };
}

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };
const textOf = (p: Part): string => {
  if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const c of p.parts ?? []) { const t = textOf(c); if (t) return t; }
  if (p.mimeType === "text/html" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").trim();
  return "";
};

export async function gmailThread(refresh: string, threadId: string): Promise<GmailMessage[]> {
  const j = await api<{ messages?: { id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload: Part }[] }>(refresh, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`);
  return (j.messages ?? []).map((m) => {
    const h = (n: string) => m.payload.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    return { id: m.id, threadId: m.threadId, from: h("from"), subject: h("subject"), body: textOf(m.payload), messageIdHeader: h("message-id") || undefined, at: new Date(Number(m.internalDate ?? Date.now())).toISOString(), sent: !!m.labelIds?.includes("SENT") };
  });
}

// ---------- Calendar ----------
export type Busy = { start: string; end: string };
export async function calFreeBusy(refresh: string, startISO: string, endISO: string): Promise<Busy[]> {
  const j = await api<{ calendars?: Record<string, { busy?: Busy[]; errors?: unknown[] }> }>(refresh, "https://www.googleapis.com/calendar/v3/freeBusy", { method: "POST", body: { timeMin: startISO, timeMax: endISO, items: [{ id: "primary" }] } });
  const c = j.calendars?.primary;
  if (!c || c.errors?.length) throw new Error("Google Calendar did not return free/busy for the primary calendar.");
  return c.busy ?? [];
}

// A fixed event id makes the insert safe to repeat: a second run gets "already exists" instead of a second meeting.
export const eventIdFor = (appId: string, startISO: string) => crypto.createHash("sha256").update(`aic:${appId}:${startISO}`).digest("hex").slice(0, 40); // hex digits are inside Google's allowed id alphabet (0-9, a-v)

export async function calInsertEvent(refresh: string, e: { id: string; startISO: string; endISO: string; title: string; description: string; attendees: string[] }) {
  const url = "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all";
  try {
    const j = await api<{ id: string; hangoutLink?: string; htmlLink?: string }>(refresh, url, { method: "POST", body: {
      id: e.id, summary: e.title, description: e.description, start: { dateTime: e.startISO }, end: { dateTime: e.endISO },
      attendees: e.attendees.map((email) => ({ email })),
      conferenceData: { createRequest: { requestId: e.id, conferenceSolutionKey: { type: "hangoutsMeet" } } },
    } });
    return { id: j.id, meetUrl: j.hangoutLink, htmlLink: j.htmlLink, duplicate: false };
  } catch (err) {
    if ((err as { status?: number }).status === 409) { // already created by an earlier run
      const j = await api<{ id: string; hangoutLink?: string; htmlLink?: string }>(refresh, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${e.id}`);
      return { id: j.id, meetUrl: j.hangoutLink, htmlLink: j.htmlLink, duplicate: true };
    }
    throw err;
  }
}
