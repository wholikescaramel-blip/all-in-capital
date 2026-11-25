import type { DB, Extraction, Message } from "./schemas";
import { audit, claimThread, loadDB, nowISO, releaseThread, saveThread, transition, uid } from "./store";
import { PROCESS } from "../config/process";
import { getOut, pickContact } from "./emailflow";
import { flushMail, queueMail, recipientOf } from "./mail";
import { cleanReply, parseReply, type Parsed } from "./parse";
import { bookingProblem, freeSlots, REOFFER_RULE, slotLabel, stillFree } from "./slots";
import { eventIdFor } from "./google";
import { googleProviders, googleReady, mailProviderName, type Providers } from "./providers";

// The automatic scheduler. It uses no model, so it keeps working when the model quota is gone, and a founder's email can never
// instruct it to do anything. It may send exactly two kinds of message on its own, both in the invite's own thread:
//   1. a booking confirmation, for a time that was free on the calendar;
//   2. two new free times, when the time the founder gave clashed or was out of hours.
// Anything it cannot read waits for a person. Nothing is advanced or rejected automatically.
const SLOT = PROCESS.slots.minutes * 60000;
const MAX_REOFFERS = 3;

export type Outcome = "booked" | "offered_new_times" | "needs_person" | "nothing_new" | "no_thread" | "not_open";
export type ThreadResult = { appId: string; outcome: Outcome; detail?: string };

const addr = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
const firstName = (name?: string) => (name ?? "").replace(/^dr\.?\s+/i, "").split(/\s+/)[0] || "there";
const reply = (db: DB, appId: string, kind: Message["kind"], body: string) => {
  const o = getOut(db, appId);
  return queueMail(db, appId, kind, `Re: ${o.draft?.subject ?? ""}`, body);
};
const sign = `${PROCESS.signer}\n${PROCESS.fund_name}`;

function flagPerson(db: DB, appId: string, why: string, actor = "scheduler") {
  const o = getOut(db, appId);
  o.needs_human = why; o.state = "FLAGGED_PARTNER";
  if (db.states[appId] !== "FLAGGED") transition(db, appId, "FLAGGED", actor, why);
}

const toExtraction = (p: Parsed): Extraction => {
  if (p.kind === "pick") return { intent: "yes", windows: [{ start: p.slot, end: new Date(Date.parse(p.slot) + SLOT).toISOString() }], phone: p.phone, summary: p.why };
  if (p.kind === "propose") return { intent: "reschedule", windows: p.windows, phone: p.phone, summary: p.why };
  if (p.kind === "decline") return { intent: "no", windows: [], phone: p.phone, summary: p.why };
  return { intent: "unclear", windows: [], phone: p.phone, summary: p.why };
};

// Every 30 minute start inside the founder's windows, earliest first.
export function candidateStarts(windows: { start: string; end: string }[]): string[] {
  const out: string[] = [];
  for (const w of windows) for (let t = Date.parse(w.start); t + SLOT <= Date.parse(w.end); t += SLOT) out.push(new Date(t).toISOString());
  return [...new Set(out)].sort();
}

async function book(db: DB, appId: string, startISO: string, prov: Providers, persist?: () => Promise<void>) {
  const o = getOut(db, appId), app = db.applications[appId];
  const contact = o.contact ?? pickContact(app);
  const endISO = new Date(Date.parse(startISO) + SLOT).toISOString();
  const guest = recipientOf(db, appId); // in test mode the invite goes to the test inbox, never a real founder
  const aditya = o.attendees.includes("deeptech_partner") ? process.env.DEEPTECH_PARTNER_EMAIL : undefined;
  const ev = await prov.calendar.create({
    id: eventIdFor(appId, startISO), startISO, endISO,
    title: `${app.company} x ${PROCESS.fund_name}: intro call`,
    description: `30 minute intro call with ${contact.name} (${app.company}).${o.phone ? ` Phone: ${o.phone}.` : ""}\nBooked automatically from the founder's reply.`,
    attendees: [guest, ...(aditya ? [aditya] : [])],
  });
  // The event is on the calendar. Record it, and save it, before the confirmation goes out.
  o.meeting = { start: startISO, end: endISO, provider: "google", uid: ev.id, url: ev.meetUrl, calendar_url: ev.htmlLink, attendees: o.attendees };
  o.slot = startISO; o.state = "MEETING_SCHEDULED"; o.needs_human = undefined; o.prepared_followup = undefined;
  if (db.states[appId] === "AWAITING_REPLY") transition(db, appId, "SCHEDULING", "scheduler");
  if (db.states[appId] === "SCHEDULING") transition(db, appId, "SCHEDULED", "scheduler", `booked ${slotLabel(startISO)}${ev.duplicate ? " (event already existed)" : ""}`);
  if (persist) await persist();
  reply(db, appId, "confirmation", `Hi ${firstName(contact.name)},\n\nBooked for ${slotLabel(startISO)}. The calendar invite with the Meet link is on its way.\n\n${sign}`);
}

async function offerNewTimes(db: DB, appId: string, now: Date, prov: Providers, reason: string) {
  const o = getOut(db, appId), contact = o.contact ?? pickContact(db.applications[appId]);
  const already = (o.thread as Message[]).filter((m) => m.dir === "out" && m.kind === "slots").length;
  if (already >= MAX_REOFFERS) { flagPerson(db, appId, `The founder's times kept clashing (${already} offers sent). A person should pick a time.`); return "needs_person" as const; }
  const slots = await freeSlots(prov.calendar, now, REOFFER_RULE, 2, o.proposed_slots);
  if (slots.length < 2) { flagPerson(db, appId, "No two free weekday afternoon times in the next two weeks."); return "needs_person" as const; }
  o.proposed_slots = slots;
  if (db.states[appId] === "AWAITING_REPLY") transition(db, appId, "SCHEDULING", "scheduler", reason);
  o.state = "SCHEDULING";
  reply(db, appId, "slots", `Hi ${firstName(contact.name)},\n\nThat time doesn't work on our side. Would ${slotLabel(slots[0])} or ${slotLabel(slots[1])} suit you instead? If neither suits you, reply with a time that does.\n\n${sign}`);
  return "offered_new_times" as const;
}

// Handle one founder message. Returns what happened.
export async function handleMessage(db: DB, appId: string, msg: Message, now: Date, prov: Providers, persist?: () => Promise<void>): Promise<Outcome> {
  const o = getOut(db, appId);
  const p = parseReply(msg.body, { now, offered: o.proposed_slots });
  msg.extracted = toExtraction(p);
  o.replies.push({ at: now.toISOString(), text: msg.body, classification: p.kind === "decline" ? "no" : p.kind === "unclear" ? "other" : "yes" });
  if (p.phone) o.phone = p.phone;

  if (p.kind === "decline") { flagPerson(db, appId, "The founder declined. A person confirms before anything is closed."); return "needs_person"; }
  if (p.kind === "unclear") { flagPerson(db, appId, `Founder replied: needs you. ${p.why}`); return "needs_person"; }

  const starts = p.kind === "pick" ? [p.slot] : candidateStarts(p.windows);
  const ok = starts.filter((s) => !bookingProblem(s, now));
  if (!ok.length) {
    const why = p.kind === "pick" ? "the offered time can no longer be booked" : `their time is ${bookingProblem(starts[0] ?? "", now) ?? "not usable"}`;
    return offerNewTimes(db, appId, now, prov, why);
  }
  for (const s of ok) {
    if (!(await stillFree(prov.calendar, s))) continue; // checked again right before booking
    await book(db, appId, s, prov, persist);
    return "booked";
  }
  return offerNewTimes(db, appId, now, prov, "their time clashes with the calendar");
}

// One thread: read the new founder messages, handle them in order, stop as soon as a meeting is booked or a person is needed.
export async function scheduleThread(db: DB, appId: string, now: Date, prov: Providers, persist?: () => Promise<void>): Promise<ThreadResult> {
  const o = getOut(db, appId), st = db.states[appId];
  if (st !== "AWAITING_REPLY" && st !== "SCHEDULING") return { appId, outcome: "not_open", detail: String(st) };
  if (!o.thread_id) return { appId, outcome: "no_thread" };
  const known = new Set((o.thread as Message[]).map((m) => m.provider_id).filter(Boolean));
  const expected = recipientOf(db, appId).toLowerCase(), mailbox = prov.mail.mailbox.toLowerCase();

  const incoming = (await prov.mail.thread(o.thread_id)).filter((m) => !m.sent && addr(m.from) !== mailbox && !known.has(m.id)).sort((a, b) => a.at.localeCompare(b.at));
  o.last_read_at = now.toISOString();
  if (!incoming.length) return { appId, outcome: "nothing_new" };

  let outcome: Outcome = "nothing_new", detail: string | undefined;
  for (const m of incoming) {
    const msg: Message = { id: uid("msg"), at: m.at || nowISO(), dir: "in", kind: "reply", from: m.from, to: prov.mail.mailbox, subject: m.subject, body: "", via: "gmail", status: "received", provider_id: m.id, thread_id: m.threadId, message_id_header: m.messageIdHeader };
    msg.body = cleanReply(m.body) || m.body.trim().slice(0, 2000);
    o.thread.push(msg);
    if (addr(m.from) !== expected) { audit(db, appId, "scheduler", `ignored a message from ${addr(m.from)}: not the person we wrote to`); continue; }
    if (outcome === "booked" || outcome === "needs_person") { audit(db, appId, "scheduler", "message recorded after the thread was already settled"); continue; }
    outcome = await handleMessage(db, appId, msg, now, prov, persist);
    detail = msg.extracted?.summary;
  }
  return { appId, outcome, detail };
}

export type SchedReport = { checked: number; results: ThreadResult[]; skipped: string[]; errors: string[]; sent: number };

// The one "check replies and book" function. Triggered by hand, by a script, or later by any outside timer calling /api/cron/schedule.
export async function runScheduler(opts: { now?: Date; providers?: Providers; only?: string } = {}): Promise<SchedReport> {
  const now = opts.now ?? new Date(), report: SchedReport = { checked: 0, results: [], skipped: [], errors: [], sent: 0 };
  const first = await loadDB();
  const prov = opts.providers ?? (googleReady(first) && mailProviderName() === "google" ? googleProviders(first) : null);
  if (!prov) { report.errors.push("Gmail is not connected, or MAIL_PROVIDER is not google. Nothing was checked."); return report; }
  const ids = Object.values(first.outreach).filter((o) => o.thread_id && ["AWAITING_REPLY", "SCHEDULING"].includes(first.states[o.app_id] ?? "") && (!opts.only || o.app_id === opts.only)).map((o) => o.app_id);
  const by = uid("run");
  for (const id of ids) {
    if (!(await claimThread(id, by))) { report.skipped.push(`${id}: another run has this thread`); continue; }
    try {
      const db = await loadDB(); // fresh, after the claim, so nothing a person did a moment ago is overwritten
      const from = db.audit.length;
      const persist = () => saveThread(db, id, from);
      const r = await scheduleThread(db, id, now, prov, persist);
      const f = await flushMail(db, { only: id, providers: prov });
      report.sent += f.sent; report.checked++; report.results.push(r);
      await saveThread(db, id, from);
    } catch (e) { report.errors.push(`${id}: ${String((e as Error).message).slice(0, 160)}`); }
    finally { await releaseThread(id, by); }
  }
  return report;
}
