import { PROCESS } from "../config/process";
import { overlaps, type CalendarProvider } from "./providers";
import { parseReply } from "./parse";
import { DAYTIME_RE } from "./lint";

const IST = 330 * 60000;
const SLOT = PROCESS.slots.minutes * 60000;
const DAYMS = 86400000;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Thursday, 26 Nov, 2:00 pm IST": the form that goes into the email, and the form the linter and the reply reader both understand.
export function slotLabel(iso: string): string {
  const d = new Date(Date.parse(iso) + IST), h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"} IST`;
}

const istParts = (ms: number) => { const d = new Date(ms + IST); return { dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; };

// Why a time cannot be booked, or null if it can: weekday, 10:00 to 19:00 India time, not past, within 30 days.
export function bookingProblem(startISO: string, now: Date): string | null {
  const b = PROCESS.booking, t = Date.parse(startISO), p = istParts(t);
  if (!Number.isFinite(t)) return "not a valid time";
  if (t < now.getTime() + b.min_notice_hours * 3600000) return "too soon or already past";
  if (t > now.getTime() + b.horizon_days * DAYMS) return `more than ${b.horizon_days} days away`;
  if (!b.weekdays.includes(p.dow)) return "not a weekday";
  if (p.min < b.start_hour * 60 || p.min + b.minutes > b.end_hour * 60) return `outside ${b.start_hour}:00 to ${b.end_hour}:00 India time`;
  return null;
}

export type SlotRule = { weekdays: number[]; startHour: number; endHour: number; horizonDays: number };
export const INVITE_RULE: SlotRule = { weekdays: PROCESS.slots.weekdays, startHour: PROCESS.slots.start_hour, endHour: PROCESS.slots.end_hour, horizonDays: PROCESS.slots.horizon_days };
export const REOFFER_RULE: SlotRule = { weekdays: PROCESS.booking.weekdays, startHour: PROCESS.booking.reoffer_start_hour, endHour: PROCESS.booking.reoffer_end_hour, horizonDays: PROCESS.booking.reoffer_horizon_days };

// The first free half hour on each of the next qualifying days, never one already offered. Reads the calendar once.
export async function freeSlots(cal: CalendarProvider, now: Date, rule: SlotRule, n = 2, exclude: string[] = [], reserved: string[] = []): Promise<string[]> {
  const from = new Date(now.getTime() + PROCESS.booking.min_notice_hours * 3600000);
  const to = new Date(now.getTime() + (rule.horizonDays + 1) * DAYMS);
  const busy = await cal.busy(from.toISOString(), to.toISOString());
  const out: string[] = [];
  for (let d = 0; d <= rule.horizonDays + 1 && out.length < n; d++) {
    const day = istParts(now.getTime() + d * DAYMS);
    if (!rule.weekdays.includes(day.dow)) continue;
    for (let mins = rule.startHour * 60; mins + PROCESS.slots.minutes <= rule.endHour * 60; mins += PROCESS.slots.minutes) {
      const start = Date.UTC(day.y, day.m, day.d, 0, mins) - IST, iso = new Date(start).toISOString();
      if (start < from.getTime() || exclude.includes(iso) || reserved.includes(iso) || overlaps(busy, iso, new Date(start + SLOT).toISOString())) continue;
      out.push(iso); break; // one per day keeps the options apart
    }
  }
  return out;
}

export async function stillFree(cal: CalendarProvider, startISO: string): Promise<boolean> {
  const end = new Date(Date.parse(startISO) + SLOT).toISOString();
  return !overlaps(await cal.busy(startISO, end), startISO, end);
}

// Offered slots are written into the email as labels. Find them again in a body so edits can be told apart from our own text.
export const slotsInBody = (body: string, slots: string[]) => slots.filter((s) => body.includes(slotLabel(s)));
export function fillSlots(body: string, slots: string[]): string {
  return body.replace("{slot_1}", slots[0] ? slotLabel(slots[0]) : "{slot_1}").replace("{slot_2}", slots[1] ? slotLabel(slots[1]) : "{slot_2}");
}

export function unfillSlots(body: string, slots: string[]): string {
  return slots.reduce((b, s, i) => b.replaceAll(slotLabel(s), `{slot_${i + 1}}`), body);
}

// Times the reviewer typed into the email by hand ("Thursday 3 Dec 2:30 pm"), read back as exact start times.
export function slotsFromText(text: string, now: Date): string[] {
  const out: string[] = [];
  for (const m of text.match(DAYTIME_RE) ?? []) {
    const p = parseReply(m, { now, offered: [] });
    if (p.kind === "propose") { const w = p.windows.find((x) => Date.parse(x.end) - Date.parse(x.start) === SLOT); if (w && !out.includes(w.start)) out.push(w.start); }
  }
  return out.slice(0, 2);
}
