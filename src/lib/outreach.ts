import type { DB } from "./schemas";
import { audit, transition } from "./store";
import { PROCESS } from "../config/process";
import { completeJSON, hasLLM } from "./llm";
import { z } from "zod";
import { draftWithChecks, getOut, pickContact } from "./emailflow";
import { mailMode, queueMail } from "./mail";

export { getOut };

// ---------- Step 9: draft (take_call only): write, fact-check, auto-fix ----------
export async function draftEmail(db: DB, appId: string) {
  const app = db.applications[appId];
  if (db.states[appId] !== "APPROVED") throw new Error("Drafts are only made for applications a human approved as take_call");
  const o = getOut(db, appId);
  o.contact = pickContact(app);
  o.attendees = PROCESS.routing[app.sector] ?? PROCESS.routing.default;
  await draftWithChecks(db, appId);
  o.state = "DRAFTED";
  transition(db, appId, "DRAFTED", "email-drafter");
  return o;
}

// ---------- Step 8-9: human approves, then the mail is queued (mock: recorded; test/live: sent by flushMail) ----------
export function approveAndSend(db: DB, appId: string, approver: string, now = new Date()) {
  const o = getOut(db, appId);
  if (db.states[appId] !== "DRAFTED" || !o.draft) throw new Error("Nothing drafted to approve");
  o.approved_by = approver; o.state = "APPROVED_TO_SEND";
  transition(db, appId, "APPROVED_TO_SEND", approver);
  queueMail(db, appId, "invite", o.draft.subject, o.draft.body);
  o.state = "SENT"; o.last_sent_at = now.toISOString();
  transition(db, appId, "SENT", "mailer", mailMode() === "mock" ? "recorded only, nothing was sent" : "queued to send");
  o.state = "AWAITING_REPLY";
  transition(db, appId, "AWAITING_REPLY", "system");
  return o;
}

// ---------- reply classification (used when no richer reading is possible) ----------
export async function classifyReply(text: string): Promise<"yes" | "no" | "other"> {
  const t = text.toLowerCase();
  if (hasLLM()) {
    try {
      const r = await completeJSON({ system: "Classify a founder's reply to a call invitation.", user: `Reply:\n${text}\nReturn {"c":"yes"|"no"|"other"} ("other" = asks a question or proposes a different time).`, schema: z.object({ c: z.enum(["yes", "no", "other"]) }), model: "fast" });
      return r.c;
    } catch { /* regex fallback */ }
  }
  if (/\b(not interested|no thanks|decline|pass|can't|cannot|won't)\b/.test(t)) return "no";
  if (/\b(yes|sure|happy to|sounds good|works|confirm|let's|lets|great)\b/.test(t)) return "yes";
  return "other";
}

// Advance simulated time: queues follow-ups at the configured interval, flags to a partner after the max. Never auto-rejects.
export function tick(db: DB, now: Date) {
  const events: string[] = [];
  for (const [id, st] of Object.entries(db.states)) {
    if (st !== "AWAITING_REPLY") continue;
    const o = getOut(db, id);
    if (!o.last_sent_at) continue;
    const due = Date.parse(o.last_sent_at) + PROCESS.followups.interval_days * 86400000;
    if (now.getTime() < due) continue;
    if (o.followups_sent >= PROCESS.followups.max) {
      transition(db, id, "FLAGGED", "follow-up-handler", `no reply after ${o.followups_sent} follow-ups; flagged to partner, not rejected`);
      o.state = "FLAGGED_PARTNER";
      events.push(`${id}: flagged to partner`);
    } else {
      o.followups_sent += 1; o.last_sent_at = now.toISOString();
      queueMail(db, id, "followup", `Re: ${o.draft?.subject}`, `Hi, a quick nudge on the call invitation (follow-up ${o.followups_sent} of ${PROCESS.followups.max}).`);
      audit(db, id, "follow-up-handler", `follow-up ${o.followups_sent} queued`);
      events.push(`${id}: follow-up ${o.followups_sent}`);
    }
  }
  return events;
}

// ---------- calendar helpers: Tuesday/Thursday afternoons, India time ----------
const IST_OFFSET_MIN = 330;
export const fmt = (d: Date) => new Date(d.getTime() + IST_OFFSET_MIN * 60000).toISOString().replace("T", " ").slice(0, 16) + " IST";

// A time is allowed when it is a Tuesday or Thursday, starts at or after the window opens and ends by the time it closes (India time).
export function inAllowedWindow(iso: string) {
  const s = PROCESS.slots;
  const ist = new Date(new Date(iso).getTime() + IST_OFFSET_MIN * 60000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return s.weekdays.includes(ist.getUTCDay()) && minutes >= s.start_hour * 60 && minutes + s.minutes <= s.end_hour * 60;
}

// Mock calendar: deterministic busy blocks so conflicts and re-proposals are exercised.
export function isBusy(who: string[], start: Date, busy: Set<string>) {
  return who.some((p) => busy.has(`${p}|${start.toISOString()}`));
}

export function candidateSlots(now: Date, who: string[], busy = new Set<string>(), n = PROCESS.slots.propose, exclude: string[] = []) {
  const s = PROCESS.slots, out: string[] = [];
  for (let d = 1; d <= s.horizon_days && out.length < n; d++) {
    const day = new Date(now.getTime() + d * 86400000);
    const ist = new Date(day.getTime() + IST_OFFSET_MIN * 60000);
    if (!s.weekdays.includes(ist.getUTCDay())) continue; // Tuesday (2) or Thursday (4) only
    // One slot per eligible day (first free half-hour in the afternoon window) keeps the options spread out.
    outer: for (let h = s.start_hour; h < s.end_hour; h++) {
      for (const m of [0, 30]) {
        const start = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, m) - IST_OFFSET_MIN * 60000);
        const iso = start.toISOString();
        if (exclude.includes(iso) || isBusy(who, start, busy)) continue;
        out.push(iso);
        break outer;
      }
    }
  }
  return out;
}

export const busyFor = (db: DB, selfId: string) => new Set(Object.values(db.outreach).filter((o) => o.app_id !== selfId && (o.slot || o.meeting)).flatMap((o) => o.attendees.map((p) => `${p}|${o.meeting?.start ?? o.slot}`)));

export function proposeSlots(db: DB, appId: string, now: Date, exclude: string[] = []) {
  const o = getOut(db, appId);
  return candidateSlots(now, o.attendees, busyFor(db, appId), PROCESS.slots.propose, exclude);
}

export function sendSlots(db: DB, appId: string) {
  const o = getOut(db, appId);
  const list = o.proposed_slots.map((s, i) => `${i + 1}. ${fmt(new Date(s))}`).join("\n");
  queueMail(db, appId, "slots", `Re: ${o.draft?.subject}`, `Great. Here are 30-minute options (Tuesday or Thursday afternoons, India time):\n${list}\n\nReply with a number, or tell us what works. And please add the best phone number to reach you on.`);
  audit(db, appId, "booking", `proposed ${o.proposed_slots.length} slots`);
}
