import type { DB, Message } from "./schemas";
import { nowISO, uid } from "./store";
import { PROCESS } from "../config/process";
import { getOut, pickContact } from "./emailflow";

// Three modes, set by MAIL_MODE:
//   mock : nothing leaves the app. Mail is only recorded in the thread. (default)
//   test : mail goes out through Resend but ONLY to MAIL_TEST_RECIPIENT, never to a founder. Replies can come back.
//   live : mail goes to the contact's real address.
// "test" without a recipient falls back to mock, so a half-set config can never email a stranger.
export type MailMode = "mock" | "test" | "live";
export function mailMode(): MailMode {
  const m = (process.env.MAIL_MODE ?? "mock").toLowerCase();
  if (m === "live") return "live";
  if (m === "test" && process.env.MAIL_TEST_RECIPIENT) return "test";
  return "mock";
}

const FROM = () => process.env.RESEND_FROM || "onboarding@resend.dev";
const REF = /\[ref:([a-z0-9-]+)\]/i;
export const refTag = (appId: string) => `[ref:${appId}]`;
export const parseRef = (subject: string) => subject.match(REF)?.[1]?.toLowerCase();

// Record an outgoing email in the application's thread. In mock mode it is final; otherwise flushMail() sends it.
export function queueMail(db: DB, appId: string, kind: Message["kind"], subject: string, body: string): Message {
  const o = getOut(db, appId);
  const contact = o.contact ?? pickContact(db.applications[appId]);
  const mode = mailMode();
  const to = mode === "test" ? process.env.MAIL_TEST_RECIPIENT! : contact.email;
  const msg: Message = {
    id: uid("msg"), at: nowISO(), dir: "out", kind,
    from: `${PROCESS.fund_name} <${FROM()}>`, to,
    subject: mode === "mock" ? subject : `${subject.replace(REF, "").trim()} ${refTag(appId)}`, // the tag lets a reply find its application
    body, via: mode === "mock" ? "mock" : "resend", status: mode === "mock" ? "recorded" : "queued",
  };
  o.thread.push(msg);
  db.outbox.push({ at: msg.at, to, subject: msg.subject, body, app_id: appId, mock: true });
  return msg;
}

// Send everything queued. A failure is written onto the message (and shown in the thread), never thrown.
export async function flushMail(db: DB): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0;
  const key = process.env.RESEND_API_KEY;
  for (const o of Object.values(db.outreach)) {
    for (const m of (o.thread ?? []) as Message[]) {
      if (m.status !== "queued") continue;
      if (!key) { m.status = "failed"; m.error = "No RESEND_API_KEY is set."; failed++; continue; }
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.body, ...(process.env.RESEND_INBOUND_ADDRESS ? { reply_to: process.env.RESEND_INBOUND_ADDRESS } : {}) }),
          signal: AbortSignal.timeout(20000),
        });
        const j = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
        if (res.ok && j.id) { m.status = "sent"; m.provider_id = j.id; sent++; }
        else { m.status = "failed"; m.error = (j.message ?? `Resend answered ${res.status}`).slice(0, 200); failed++; }
      } catch (e) { m.status = "failed"; m.error = String(e).slice(0, 160); failed++; }
    }
  }
  return { sent, failed };
}
