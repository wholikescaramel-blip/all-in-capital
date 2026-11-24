import type { DB, Outreach } from "./schemas";
import { audit, nowISO, transition } from "./store";
import { PROCESS } from "../config/process";
import { completeJSON, hasLLM } from "./llm";
import { z } from "zod";

// ---------- Mock email: appended to db.outbox. No real message is ever sent. ----------
export function mockSend(db: DB, to: string, subject: string, body: string, appId: string) {
  db.outbox.push({ at: nowISO(), to, subject, body, app_id: appId, mock: true });
}

const getOut = (db: DB, id: string): Outreach => (db.outreach[id] ??= { app_id: id, state: "NONE", followups_sent: 0, replies: [], proposed_slots: [], attendees: [] });
const founderEmail = (db: DB, id: string) => `${db.applications[id].founders[0]?.name.toLowerCase().replace(/[^a-z]+/g, ".") ?? "founder"}@${PROCESS.founder_domain_placeholder}`;

// ---------- Step 9: draft (take_call only) ----------
export async function draftEmail(db: DB, appId: string) {
  const app = db.applications[appId];
  if (db.states[appId] !== "APPROVED") throw new Error("Drafts are only made for applications a human approved as take_call");
  const who = PROCESS.routing[app.sector] ?? PROCESS.routing.default;
  const first = app.founders[0]?.name.split(" ")[0] ?? "there";
  let body = `Hi ${first},\n\nThanks for applying to ${PROCESS.fund_name}. We read the ${app.company} deck and application and would like to talk. It would be a 30-minute call${who.includes("deeptech_partner") ? " with our associate and our deeptech partner" : " with our associate"}.\n\nWe can do Tuesday or Thursday afternoons. Reply "yes" and we will send a few slots, or tell us if this isn't the right time.\n\nBest,\nThe team\n${PROCESS.fund_name}`;
  if (hasLLM()) {
    try {
      const r = await completeJSON({
        system: "Draft a warm, short, specific invitation email from an investor associate to a founder. No flattery, no promises about outcome, mention 30 minutes and Tuesday/Thursday afternoons. Do not include scores or internal assessment.",
        user: `Company: ${app.company}\nOne-liner: ${app.one_liner}\nFounder first name: ${first}\nAttendees: ${who.join(", ")}\nReturn {"body": string}`,
        schema: z.object({ body: z.string() }), model: "fast",
      });
      body = r.body;
    } catch { /* keep template */ }
  }
  const o = getOut(db, appId);
  o.draft = { subject: `${PROCESS.fund_name} x ${app.company}: a call?`, body };
  o.state = "DRAFTED"; o.attendees = who;
  transition(db, appId, "DRAFTED", "email-drafter");
  return o;
}

export function editDraft(db: DB, appId: string, body: string) {
  const o = getOut(db, appId);
  if (!o.draft || db.states[appId] !== "DRAFTED") throw new Error("No editable draft");
  o.draft.body = body;
}

// ---------- Step 8-9: human approves, then mock send ----------
export function approveAndSend(db: DB, appId: string, approver: string, now = new Date()) {
  const o = getOut(db, appId);
  if (db.states[appId] !== "DRAFTED" || !o.draft) throw new Error("Nothing drafted to approve");
  o.approved_by = approver; o.state = "APPROVED_TO_SEND";
  transition(db, appId, "APPROVED_TO_SEND", approver);
  mockSend(db, founderEmail(db, appId), o.draft.subject, o.draft.body, appId);
  o.state = "SENT"; o.last_sent_at = now.toISOString();
  transition(db, appId, "SENT", "mock-mailer", "mock send, nothing left this machine");
  o.state = "AWAITING_REPLY";
  transition(db, appId, "AWAITING_REPLY", "system");
  return o;
}

// ---------- Step 10: reply classification + follow-ups ----------
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

export async function handleReply(db: DB, appId: string, text: string, now = new Date()) {
  const o = getOut(db, appId);
  const cls = await classifyReply(text);
  o.replies.push({ at: now.toISOString(), text, classification: cls });
  const st = db.states[appId];
  if (st === "AWAITING_REPLY") {
    if (cls === "no") {
      // Founder declined: still goes to a human, never silently closed.
      transition(db, appId, "FLAGGED", "reply-handler", "founder declined; partner to confirm closure");
      o.state = "FLAGGED_PARTNER";
    } else {
      o.proposed_slots = proposeSlots(db, appId, now);
      transition(db, appId, "SCHEDULING", "reply-handler");
      o.state = "SCHEDULING";
      sendSlots(db, appId);
    }
  } else if (st === "SCHEDULING") {
    await handleSchedulingReply(db, appId, text, cls, now);
  }
  return o;
}

// Advance simulated time: sends follow-ups at the configured interval, flags to a partner after the max. Never auto-rejects.
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
      mockSend(db, founderEmail(db, id), `Re: ${o.draft?.subject}`, `Hi, a quick nudge on the call invitation (follow-up ${o.followups_sent} of ${PROCESS.followups.max}).`, id);
      audit(db, id, "follow-up-handler", `follow-up ${o.followups_sent} sent (mock)`);
      events.push(`${id}: follow-up ${o.followups_sent}`);
    }
  }
  return events;
}

// ---------- Step 11: mocked calendar + booking ----------
const IST_OFFSET_MIN = 330;
const fmt = (d: Date) => new Date(d.getTime() + IST_OFFSET_MIN * 60000).toISOString().replace("T", " ").slice(0, 16) + " IST";

// Mock calendar: deterministic busy blocks so conflicts and re-proposals are exercised.
function isBusy(who: string[], start: Date, busy: Set<string>) {
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

const busyFor = (db: DB, selfId: string) => new Set(Object.values(db.outreach).filter((o) => o.app_id !== selfId && o.slot).flatMap((o) => o.attendees.map((p) => `${p}|${o.slot}`)));

export function proposeSlots(db: DB, appId: string, now: Date, exclude: string[] = []) {
  const o = getOut(db, appId);
  return candidateSlots(now, o.attendees, busyFor(db, appId), PROCESS.slots.propose, exclude);
}

function sendSlots(db: DB, appId: string) {
  const o = getOut(db, appId);
  const list = o.proposed_slots.map((s, i) => `${i + 1}. ${fmt(new Date(s))}`).join("\n");
  mockSend(db, founderEmail(db, appId), `Re: ${o.draft?.subject}`, `Great. Here are 30-minute options (Tuesday/Thursday afternoons):\n${list}\n\nReply with a number, or tell us what works.`, appId);
  audit(db, appId, "booking", `proposed ${o.proposed_slots.length} slots`);
}

async function handleSchedulingReply(db: DB, appId: string, text: string, cls: string, now: Date) {
  const o = getOut(db, appId);
  const pick = text.match(/\b([1-9])\b/);
  const idx = pick ? parseInt(pick[1], 10) - 1 : -1;
  if (cls !== "no" && o.proposed_slots[idx]) {
    // Re-check at confirm time: the slot may have been taken since it was proposed.
    if (isBusy(o.attendees, new Date(o.proposed_slots[idx]), busyFor(db, appId))) {
      o.proposed_slots = proposeSlots(db, appId, now, o.proposed_slots);
      sendSlots(db, appId);
      return;
    }
    o.slot = o.proposed_slots[idx];
    o.state = "MEETING_SCHEDULED";
    transition(db, appId, "SCHEDULED", "booking", `MEETING_SCHEDULED ${fmt(new Date(o.slot))} with ${o.attendees.join(", ")}`);
    mockSend(db, founderEmail(db, appId), "Confirmed", `Confirmed for ${fmt(new Date(o.slot))}. Calendar invite sent to ${o.attendees.join(", ")} (mock).`, appId);
  } else if (cls === "no") {
    transition(db, appId, "FLAGGED", "booking", "founder withdrew during scheduling; partner to confirm");
    o.state = "FLAGGED_PARTNER";
  } else {
    // Founder proposed something else or was unclear: keep looping with fresh Tue/Thu options until they agree.
    o.proposed_slots = proposeSlots(db, appId, now, o.proposed_slots);
    sendSlots(db, appId);
  }
}
