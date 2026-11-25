import type { DB } from "./schemas";
import { audit, transition } from "./store";
import { PROCESS } from "../config/process";
import { completeJSON, hasLLM } from "./llm";
import { z } from "zod";
import { addStyleExample, draftWithChecks, getOut, pickContact } from "./emailflow";
import { mailMode, queueMail, recipientOf } from "./mail";
import { calendarFor, type CalendarProvider } from "./providers";
import { fillSlots, freeSlots, INVITE_RULE, slotLabel, slotsFromText, slotsInBody, stillFree } from "./slots";

export { getOut };

// ---------- Step 9: draft (take_call only): write, fact-check, auto-fix ----------
export async function draftEmail(db: DB, appId: string, opts: { now?: Date; calendar?: CalendarProvider } = {}) {
  const app = db.applications[appId];
  if (db.states[appId] !== "APPROVED") throw new Error("Drafts are only made for applications a human approved as take_call");
  const o = getOut(db, appId);
  o.contact = pickContact(app);
  o.attendees = PROCESS.routing[app.sector] ?? PROCESS.routing.default;
  await draftWithChecks(db, appId, { now: opts.now, calendar: opts.calendar });
  o.state = "DRAFTED";
  transition(db, appId, "DRAFTED", "email-drafter");
  return o;
}

// ---------- the first letter: re-check the times, then queue it ----------
// Both times still free: keep them. One taken since the draft: swap in a fresh free one. Placeholders left: fill them now.
// The reviewer typed her own times: send her text exactly as written.
async function refreshSlots(db: DB, appId: string, now: Date, cal: CalendarProvider) {
  const o = getOut(db, appId), body = o.draft!.body, offered = [...o.proposed_slots];
  const reserved = Object.values(db.outreach).filter((x) => x.app_id !== appId && ["AWAITING_REPLY", "SCHEDULING"].includes(db.states[x.app_id] ?? "")).flatMap((x) => x.proposed_slots ?? []);
  if (body.includes("{slot_1}") || body.includes("{slot_2}")) {
    const fresh = await freeSlots(cal, now, INVITE_RULE, 2, [], reserved);
    if (fresh.length < 2) throw new Error("Could not find two free times on the calendar. Add times to the letter by hand, or try again.");
    o.draft!.body = fillSlots(body, fresh); o.proposed_slots = fresh; return;
  }
  const ours = o.ai_slots ?? offered; // only the times the draft step wrote are re-checked; times she typed are hers
  if (ours.length === 2 && slotsInBody(body, ours).length === 2) {
    let next = body; const cur = [...ours];
    for (let i = 0; i < cur.length; i++) {
      if (await stillFree(cal, cur[i])) continue;
      const repl = (await freeSlots(cal, now, INVITE_RULE, 1, [...cur, ...offered], reserved))[0];
      if (!repl) throw new Error("One of the offered times was taken and no other free time was found.");
      next = next.replaceAll(slotLabel(cur[i]), slotLabel(repl)); cur[i] = repl;
    }
    o.draft!.body = next; o.proposed_slots = cur; o.ai_slots = cur; return;
  }
  const own = slotsFromText(body, now);
  if (own.length) o.proposed_slots = own; // her own words: recognised in the reply, sent untouched
}

export async function approveAndSend(db: DB, appId: string, approver: string, now = new Date(), opts: { expectTo?: string; calendar?: CalendarProvider } = {}) {
  const o = getOut(db, appId);
  if (db.states[appId] !== "DRAFTED" || !o.draft) throw new Error("Nothing drafted to approve");
  const to = recipientOf(db, appId);
  if (opts.expectTo && opts.expectTo.trim().toLowerCase() !== to.toLowerCase()) throw new Error(`The confirmation names ${opts.expectTo}, but this letter goes to ${to}. Nothing was sent.`);
  await refreshSlots(db, appId, now, opts.calendar ?? calendarFor(db));
  if (o.versions.some((v) => (v as { by?: string }).by === "human") || o.chat.some((c) => c.who === "human")) addStyleExample(db, appId);
  o.approved_by = approver; o.state = "APPROVED_TO_SEND";
  transition(db, appId, "APPROVED_TO_SEND", approver);
  queueMail(db, appId, "invite", o.draft.subject, o.draft.body);
  o.state = "SENT"; o.last_sent_at = now.toISOString();
  transition(db, appId, "SENT", "mailer", mailMode() === "mock" ? "recorded only, nothing was sent" : `queued to send to ${to}`);
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

// Three working days after a letter with no reply, a follow-up is PREPARED with two fresh free times. It is never sent on its own:
// the reviewer sends it with one click (sendFollowup). After the maximum, the thread is flagged to a person, never rejected.
export function addWorkingDays(from: Date, n: number): Date {
  let d = new Date(from.getTime()), left = n;
  while (left > 0) { d = new Date(d.getTime() + 86400000); const dow = new Date(d.getTime() + 330 * 60000).getUTCDay(); if (dow !== 0 && dow !== 6) left--; }
  return d;
}

export async function tick(db: DB, now: Date, calendar?: CalendarProvider) {
  const events: string[] = [];
  for (const [id, st] of Object.entries(db.states)) {
    if (st !== "AWAITING_REPLY") continue;
    const o = getOut(db, id);
    if (!o.last_sent_at || o.prepared_followup) continue;
    if (now.getTime() < addWorkingDays(new Date(o.last_sent_at), PROCESS.followups.interval_days).getTime()) continue;
    if (o.followups_sent >= PROCESS.followups.max) {
      transition(db, id, "FLAGGED", "follow-up-handler", `no reply after ${o.followups_sent} follow-ups; flagged to partner, not rejected`);
      o.state = "FLAGGED_PARTNER";
      events.push(`${id}: flagged to partner`);
      continue;
    }
    const slots = await freeSlots(calendar ?? calendarFor(db), now, INVITE_RULE, 2, o.proposed_slots);
    if (slots.length < 2) { audit(db, id, "follow-up-handler", "no two free times found; follow-up not prepared yet"); continue; }
    const first = (o.contact?.name ?? "").replace(/^dr\.?\s+/i, "").split(/\s+/)[0] || "there";
    const body = `Hi ${first},\n\nA short nudge on the 30 minute call: would ${slotLabel(slots[0])} or ${slotLabel(slots[1])} work? If neither suits you, reply with a time that does.\n\n${PROCESS.signer}\n${PROCESS.fund_name}`;
    o.prepared_followup = { at: now.toISOString(), subject: `Re: ${o.draft?.subject ?? ""}`, body, slots };
    audit(db, id, "follow-up-handler", `follow-up ${o.followups_sent + 1} prepared, waiting for a person to send it`);
    events.push(`${id}: follow-up prepared`);
  }
  return events;
}

// The reviewer's click. Re-checks that the two prepared times are still free before sending.
export async function sendFollowup(db: DB, appId: string, now = new Date(), calendar?: CalendarProvider) {
  const o = getOut(db, appId), f = o.prepared_followup;
  if (!f) throw new Error("There is no follow-up waiting to be sent.");
  const cal = calendar ?? calendarFor(db);
  let body = f.body; const slots = [...f.slots];
  for (let i = 0; i < slots.length; i++) {
    if (await stillFree(cal, slots[i])) continue;
    const repl = (await freeSlots(cal, now, INVITE_RULE, 1, [...slots, ...o.proposed_slots]))[0];
    if (!repl) throw new Error("A time in the follow-up was taken and no other free time was found.");
    body = body.replaceAll(slotLabel(slots[i]), slotLabel(repl)); slots[i] = repl;
  }
  queueMail(db, appId, "followup", f.subject, body);
  o.followups_sent += 1; o.last_sent_at = now.toISOString(); o.proposed_slots = slots; o.prepared_followup = undefined;
  audit(db, appId, "reviewer", `follow-up ${o.followups_sent} sent`);
  return o;
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
