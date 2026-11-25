import { PROCESS } from "../config/process";

// Cal.com v2 API. Used for real availability and real bookings; without CAL_API_KEY and CAL_EVENT_TYPE_ID the app uses the mock calendar.
const BASE = "https://api.cal.com";
export const calConfigured = () => !!process.env.CAL_API_KEY && !!process.env.CAL_EVENT_TYPE_ID;

async function cal<T>(path: string, version: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${process.env.CAL_API_KEY}`, "cal-api-version": version, "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const j = (await res.json().catch(() => ({}))) as { data?: T; error?: { message?: string }; message?: string };
  if (!res.ok) throw new Error(`Cal.com: ${(j.error?.message ?? j.message ?? `HTTP ${res.status}`).toString().slice(0, 200)}`);
  return j.data as T;
}

// Open start times (UTC ISO) for the event type over the next `days`, as Cal.com sees them (their calendar, their hours).
export async function calSlots(days = PROCESS.slots.horizon_days): Promise<string[]> {
  const from = new Date(), to = new Date(Date.now() + days * 86400000);
  const q = new URLSearchParams({ eventTypeId: process.env.CAL_EVENT_TYPE_ID!, start: from.toISOString().slice(0, 10), end: to.toISOString().slice(0, 10), timeZone: PROCESS.slots.tz });
  const data = await cal<Record<string, { start: string }[]>>(`/v2/slots?${q}`, "2024-09-04");
  return Object.values(data ?? {}).flat().map((s) => new Date(s.start).toISOString()).sort();
}

export type CalBooking = { uid: string; start: string; end: string; url?: string };

export async function calBook(a: { startISO: string; name: string; email: string; phone?: string; tz?: string; guests?: string[]; application: string }): Promise<CalBooking> {
  const d = await cal<{ uid: string; start: string; end: string; meetingUrl?: string; location?: string }>("/v2/bookings", "2024-08-13", {
    method: "POST",
    body: {
      start: new Date(a.startISO).toISOString(), // Cal.com wants UTC
      eventTypeId: Number(process.env.CAL_EVENT_TYPE_ID),
      attendee: { name: a.name, email: a.email, timeZone: a.tz ?? PROCESS.slots.tz, language: "en", ...(a.phone ? { phoneNumber: a.phone } : {}) },
      ...(a.guests?.length ? { guests: a.guests } : {}),
      metadata: { application: a.application },
    },
  });
  return { uid: d.uid, start: d.start, end: d.end, url: d.meetingUrl ?? d.location };
}

export async function calCancel(uid: string, reason = "Cancelled from the review app") {
  await cal(`/v2/bookings/${encodeURIComponent(uid)}/cancel`, "2024-08-13", { method: "POST", body: { cancellationReason: reason } });
}
