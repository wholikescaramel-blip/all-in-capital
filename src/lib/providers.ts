import type { DB } from "./schemas";
import { calFreeBusy, calInsertEvent, gmailSend, gmailThread, googleConfigured, type Busy, type GmailMessage } from "./google";

// The scheduler talks to these two interfaces, never to Google directly, so it can be tested with the mock versions
// and a different mail or calendar service can be swapped in later without touching the booking rules.
export type SentMail = { id: string; threadId: string };
export interface MailProvider {
  name: string;
  mailbox: string;
  send(m: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string }): Promise<SentMail>;
  thread(threadId: string): Promise<GmailMessage[]>;
}
export type NewEvent = { id: string; startISO: string; endISO: string; title: string; description: string; attendees: string[] };
export type CreatedEvent = { id: string; meetUrl?: string; htmlLink?: string; duplicate: boolean };
export interface CalendarProvider {
  name: string;
  busy(startISO: string, endISO: string): Promise<Busy[]>;
  create(e: NewEvent): Promise<CreatedEvent>;
}
export type Providers = { mail: MailProvider; calendar: CalendarProvider };

export const overlaps = (busy: Busy[], startISO: string, endISO: string) => busy.some((b) => Date.parse(b.start) < Date.parse(endISO) && Date.parse(b.end) > Date.parse(startISO));

// ---------- Google ----------
export function googleProviders(db: DB): Providers {
  const g = db.google;
  if (!googleConfigured()) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.");
  if (!g?.refresh_token) throw new Error("Gmail is not connected yet. Open /api/auth/google once, signed in as the fund mailbox.");
  const rt = g.refresh_token;
  return {
    mail: {
      name: "gmail", mailbox: g.email,
      send: (m) => gmailSend(rt, { from: g.email, ...m }),
      thread: (id) => gmailThread(rt, id),
    },
    calendar: {
      name: "google-calendar",
      busy: (a, b) => calFreeBusy(rt, a, b),
      create: (e) => calInsertEvent(rt, e),
    },
  };
}
export const googleReady = (db: DB) => googleConfigured() && !!db.google?.refresh_token;
export const mailProviderName = () => (process.env.MAIL_PROVIDER ?? "resend").toLowerCase();

// ---------- in-memory versions for tests and offline runs ----------
export function mockProviders(opts: { mailbox?: string; busy?: Busy[] } = {}) {
  const mailbox = opts.mailbox ?? "riya@fund.test";
  const busy: Busy[] = [...(opts.busy ?? [])];
  const events = new Map<string, NewEvent & { meetUrl: string; htmlLink: string }>();
  const threads = new Map<string, GmailMessage[]>();
  const sent: { to: string; subject: string; body: string; threadId?: string; id: string }[] = [];
  let n = 0;
  const p: Providers & { busyList: Busy[]; events: typeof events; sent: typeof sent; receive: (threadId: string, from: string, body: string, subject?: string) => GmailMessage } = {
    busyList: busy, events, sent,
    mail: {
      name: "mock-mail", mailbox,
      async send(m) { const id = `m${++n}`, threadId = m.threadId ?? `t${n}`; sent.push({ ...m, threadId, id }); const list = threads.get(threadId) ?? []; list.push({ id, threadId, from: mailbox, subject: m.subject, body: m.body, at: new Date().toISOString(), sent: true }); threads.set(threadId, list); return { id, threadId }; },
      async thread(id) { return [...(threads.get(id) ?? [])]; },
    },
    calendar: {
      name: "mock-calendar",
      async busy(a, b) { return busy.filter((x) => Date.parse(x.start) < Date.parse(b) && Date.parse(x.end) > Date.parse(a)); },
      async create(e) {
        const dup = events.get(e.id);
        if (dup) return { id: dup.id, meetUrl: dup.meetUrl, htmlLink: dup.htmlLink, duplicate: true };
        const ev = { ...e, meetUrl: `https://meet.test/${e.id.slice(0, 10)}`, htmlLink: `https://calendar.test/event/${e.id}` };
        events.set(e.id, ev); busy.push({ start: e.startISO, end: e.endISO });
        return { id: e.id, meetUrl: ev.meetUrl, htmlLink: ev.htmlLink, duplicate: false };
      },
    },
    receive(threadId, from, body, subject = "Re: invite") {
      const list = threads.get(threadId) ?? [];
      const m: GmailMessage = { id: `in${++n}`, threadId, from, subject, body, messageIdHeader: `<in${n}@mock>`, at: new Date().toISOString(), sent: false };
      list.push(m); threads.set(threadId, list); return m;
    },
  };
  return p;
}

// The calendar the app uses right now: the connected Google one when Gmail is the mail provider, otherwise a stand-in
// that treats the meetings already booked in the app as busy (so no one is double-booked in offline runs).
export function calendarFor(db: DB): CalendarProvider {
  if (mailProviderName() === "google" && googleReady(db)) return googleProviders(db).calendar;
  const busy: Busy[] = Object.values(db.outreach).filter((o) => o.meeting).map((o) => ({ start: o.meeting!.start, end: o.meeting!.end }));
  return mockProviders({ busy }).calendar;
}
