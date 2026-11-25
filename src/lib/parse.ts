import { PROCESS } from "../config/process";
import { findPhone } from "./phone";

// Reads a founder's reply with plain rules. No model is involved, so it runs even when the model quota is gone,
// it gives the same answer every time, and nothing in a reply can talk it into doing anything.
// All times are India time. A reply it cannot read confidently is "unclear" and waits for a person.
const IST = 330 * 60000;
const SLOT = PROCESS.slots.minutes * 60000;
const DAYMS = 86400000;

export type Win = { start: string; end: string };
export type Parsed =
  | { kind: "pick"; slot: string; why: string; phone?: string }
  | { kind: "propose"; windows: Win[]; why: string; phone?: string }
  | { kind: "decline"; why: string; phone?: string }
  | { kind: "unclear"; why: string; phone?: string };

const WEEKDAYS: [RegExp, number][] = [[/^sun/, 0], [/^mon/, 1], [/^tue/, 2], [/^wed/, 3], [/^thu/, 4], [/^fri/, 5], [/^sat/, 6]];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_WORD = "(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday|s)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const MONTH_WORD = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const toIST = (ms: number) => new Date(ms + IST);
const wall = (y: number, m: number, d: number, hh: number, mm: number) => Date.UTC(y, m, d, hh, mm) - IST; // India wall time to a UTC instant
const dayOf = (iso: string) => toIST(Date.parse(iso)).getUTCDay();
const ymd = (ms: number) => { const t = toIST(ms); return [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()] as const; };
const sameDate = (a: string, b: string) => ymd(Date.parse(a)).join() === ymd(Date.parse(b)).join();

// ---------- tidy the text ----------
export function cleanReply(raw: string): string {
  const out: string[] = [];
  for (const l of raw.split(/\r?\n/)) {
    if (/^\s*>/.test(l) || /^\s*On .{5,160} wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^_{5,}$/.test(l) || /^\s*From:\s.+/i.test(l) && out.length) break;
    if (/^--\s*$/.test(l) || /^(sent from my|get outlook for|sent via)/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n").replace(/[ \t]+/g, " ").trim();
}

// ---------- pieces ----------
const NEG = /\b(can'?t|cannot|can not|won'?t|unable|not available|unavailable|not free|busy|doesn'?t work|does not work|don'?t work|do not work|isn'?t (?:possible|good|great|ideal)|not (?:possible|good|great|ideal|on|this)|except|excluding|other than|clash\w*|conflict\w*|already (?:have|booked|got)|out of (?:office|town)|travell?ing|on leave|no\b(?!\s+(?:problem|worries|issue)))|\bnot\b/i;
const DECLINE = /\b(not interested|no thanks|no,? thank you|decline|not a fit|pass on this|not (?:looking|raising)|withdraw|remove me|unsubscribe|not the right time|not right now)\b/i;
const OTHER_TZ = /\b(pst|pdt|est|edt|cst|cdt|mst|gmt|utc|bst|cet|cest|sgt|sast|aest|singapore|london|new york|dubai|pacific time|eastern time|uk time|us time)\b/i;

function splitClauses(text: string): string[] {
  const parts = text.split(/(?:[.!?;\n]+|\b(?:but|however|instead|though|although)\b)/i).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (NEG.test(p) && p.includes(",")) out.push(...p.split(/,\s*(?!\d)/).map((s) => s.trim()).filter(Boolean)); // "can't do Thursday, Friday 3pm works"
    else out.push(p);
  }
  return out;
}

type Clock = { h: number; m: number };
const to24 = (h: number, m: number, ap?: string): Clock | null => {
  if (m > 59 || h > 23) return null;
  if (ap) { const pm = ap.toLowerCase().startsWith("p"); if (h < 1 || h > 12) return null; h = (h % 12) + (pm ? 12 : 0); }
  return { h, m };
};
// A bare hour with no am/pm: business hours decide. 1-7 is the afternoon, 12 is noon, 8 to 11 is the morning.
const bare = (h: number, m: number): Clock | null => (h < 1 || h > 12 ? (h >= 13 && h <= 23 ? { h, m } : null) : { h: h <= 7 ? h + 12 : h, m });

type Span = { from: Clock; to?: Clock; kind: "exact" | "range" | "after" | "before" | "part" };
const part = (name: string): Span => ({ kind: "part", from: name === "morning" ? { h: 10, m: 0 } : name === "evening" ? { h: 17, m: 0 } : { h: 13, m: 0 }, to: name === "morning" ? { h: 13, m: 0 } : name === "evening" ? { h: 19, m: 0 } : { h: 18, m: 0 } });

function findTimes(src: string): { spans: Span[]; rest: string } {
  const spans: Span[] = []; let s = " " + src.toLowerCase() + " ";
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => Span | null) => { s = s.replace(re, (...a) => { const m = a as unknown as RegExpMatchArray; const sp = fn(m); if (sp) { spans.push(sp); return " "; } return a[0]; }); };

  // 3-5pm, between 3 and 5 pm, 2 to 4pm, from 2:30 till 4
  take(new RegExp(`(?:between|from)?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?\\s*(?:-|–|to|and|till|until)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)`, "g"), (m) => {
    const ap2 = m[6], ap1 = m[3] ?? ap2;
    const a = to24(+m[1], +(m[2] ?? 0), ap1), b = to24(+m[4], +(m[5] ?? 0), ap2);
    return a && b && (b.h * 60 + b.m) > (a.h * 60 + a.m) ? { kind: "range", from: a, to: b } : null;
  });
  // after 4, after 4pm
  take(/\b(?:after|post|from)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/g, (m) => { const c = m[3] ? to24(+m[1], +(m[2] ?? 0), m[3]) : bare(+m[1], +(m[2] ?? 0)); return c ? { kind: "after", from: c } : null; });
  take(/\b(?:before|by|until|till)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/g, (m) => { const c = m[3] ? to24(+m[1], +(m[2] ?? 0), m[3]) : bare(+m[1], +(m[2] ?? 0)); return c ? { kind: "before", from: c } : null; });
  // 3pm, 3:30 pm, 11.30am
  take(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/g, (m) => { const c = to24(+m[1], +(m[2] ?? 0), m[3]); return c ? { kind: "exact", from: c } : null; });
  // 15:00, 9:30
  take(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (m) => ({ kind: "exact", from: { h: +m[1], m: +m[2] } }));
  take(/\b(noon|midday|12 noon)\b/g, () => ({ kind: "exact", from: { h: 12, m: 0 } }));
  // at 4, @ 3
  take(/(?:\bat|@|\baround)\s+(\d{1,2})(?![\d:]|\s*(?:st|nd|rd|th|\/|-)|\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/g, (m) => { const c = bare(+m[1], 0); return c ? { kind: "exact", from: c } : null; });
  if (!spans.length) for (const w of ["morning", "afternoon", "evening"]) if (new RegExp(`\\b${w}\\b`).test(s)) { spans.push(part(w)); break; }
  return { spans, rest: s };
}

type DayRef = { ms: number; explicit: "weekday" | "date" | "relative" };
function findDays(rest: string, now: Date): DayRef[] {
  const out: DayRef[] = [], s = " " + rest + " ";
  const [ny, nm, nd] = ymd(now.getTime());
  const today = Date.UTC(ny, nm, nd);
  const at = (ms: number) => ({ y: toIST(ms).getUTCFullYear(), m: toIST(ms).getUTCMonth(), d: toIST(ms).getUTCDate() });
  void at;
  if (/\bday after tomorrow\b/.test(s)) out.push({ ms: today + 2 * DAYMS, explicit: "relative" });
  else if (/\btomorrow\b/.test(s)) out.push({ ms: today + DAYMS, explicit: "relative" });
  else if (/\btoday\b/.test(s)) out.push({ ms: today, explicit: "relative" });

  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_WORD})\\b(?:\\s*,?\\s*(\\d{4}))?`, "g"))) out.push(dateRef(+m[1], m[2], m[3] ? +m[3] : undefined, today));
  for (const m of s.matchAll(new RegExp(`\\b(${MONTH_WORD})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?::|am|pm))(?:\\s*,?\\s*(\\d{4}))?`, "g"))) out.push(dateRef(+m[2], m[1], m[3] ? +m[3] : undefined, today));
  for (const m of s.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g)) { // day first, as in India
    const d = +m[1], mo = +m[2]; if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    out.push(dateRef(d, MONTHS[mo - 1], m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : undefined, today));
  }
  for (const m of s.matchAll(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/g)) { // "the 10th": this month, or next if passed
    const d = +m[1]; if (d < 1 || d > 31) continue;
    let ms = Date.UTC(ny, nm, d); if (ms < today) ms = Date.UTC(ny, nm + 1, d);
    out.push({ ms, explicit: "date" });
  }
  for (const m of s.matchAll(new RegExp(`\\b(next|this|coming)?\\s*(${DAY_WORD})\\b`, "g"))) {
    const dow = WEEKDAYS.find(([re]) => re.test(m[2]))![1];
    const todayDow = new Date(today).getUTCDay();
    let ahead = (dow - todayDow + 7) % 7; if (ahead === 0) ahead = 7;
    if (m[1] === "next") { const toNextMonday = ((1 - todayDow + 7) % 7) || 7; if (ahead < toNextMonday) ahead += 7; }
    out.push({ ms: today + ahead * DAYMS, explicit: "weekday" });
  }
  return out.filter((d) => Number.isFinite(d.ms));
}
function dateRef(d: number, month: string, year: number | undefined, today: number): DayRef {
  const mo = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  const ty = new Date(today).getUTCFullYear();
  let ms = Date.UTC(year ?? ty, mo, d);
  if (!year && ms < today) ms = Date.UTC(ty + 1, mo, d);
  return { ms, explicit: "date" };
}

function toWindows(day: DayRef, sp: Span): Win | null {
  const [y, m, d] = [new Date(day.ms).getUTCFullYear(), new Date(day.ms).getUTCMonth(), new Date(day.ms).getUTCDate()];
  const mk = (c: Clock) => wall(y, m, d, c.h, c.m);
  const end = PROCESS.booking.end_hour, start = PROCESS.booking.start_hour;
  let a: number, b: number;
  if (sp.kind === "exact") { a = mk(sp.from); b = a + SLOT; }
  else if (sp.kind === "after") { a = mk(sp.from); b = mk({ h: end, m: 0 }); }
  else if (sp.kind === "before") { a = mk({ h: start, m: 0 }); b = mk(sp.from); }
  else { a = mk(sp.from); b = mk(sp.to!); }
  return b > a ? { start: new Date(a).toISOString(), end: new Date(b).toISOString() } : null;
}

// ---------- the reader ----------
export function parseReply(rawText: string, ctx: { now: Date; offered: string[] }): Parsed {
  const text = cleanReply(rawText), low = text.toLowerCase();
  const phone = findPhone(text);
  const U = (why: string): Parsed => ({ kind: "unclear", why, phone });
  const offered = ctx.offered;
  if (!text) return U("The reply was empty.");

  const clauses = splitClauses(text);
  const pos: string[] = [], neg: string[] = [];
  for (const c of clauses) (NEG.test(c) ? neg : pos).push(c);
  const posText = pos.join(" . ");

  if (OTHER_TZ.test(low) && !/\bist\b|india/.test(low)) return U("They gave a time in another time zone. Check it before booking.");

  // 1. a pick from the times we offered
  const namesDay = new RegExp(`\\b${DAY_WORD}\\b|\\btomorrow\\b|\\b${MONTH_WORD}\\b`).test(low);
  if (offered.length && pos.length) {
    if (!namesDay) {
      const num = posText.trim().match(/^\W*(?:option|slot|number|no\.?)?\s*([1-9])\b\W*(?:works|please|is fine|is good|for me)?\W*$/i) ?? posText.match(/\b(?:option|slot|number)\s*([1-9])\b/i) ?? posText.match(/\b([1-9])\s+(?:works|is fine|is good|is better|for me)\b/i);
      if (num && +num[1] <= offered.length) return { kind: "pick", slot: offered[+num[1] - 1], why: `Chose option ${num[1]}.`, phone };
      const ord = posText.match(/\b(?:the\s+)?(first|1st|second|2nd|third|3rd|later|latter|earlier|former)\s+(?:one|option|slot|time|choice)\b/i) ?? posText.match(/^\W*(?:the\s+)?(first|second|later|earlier)\W*(?:works|is (?:fine|good|better)|please|for me)?\W*$/i);
      if (ord) {
        const w = ord[1].toLowerCase(); const idx = /^(first|1st|earlier|former)$/.test(w) ? 0 : /^(second|2nd|later|latter)$/.test(w) ? (w === "second" || w === "2nd" ? 1 : offered.length - 1) : 2;
        if (offered[idx]) return { kind: "pick", slot: offered[idx], why: `Chose the ${w} one.`, phone };
      }
      if (/\b(?:either|both|whichever|any one)\b[^.?!]{0,24}\b(?:works?|fine|good|ok|okay|suits?)\b/i.test(posText) || /\bany of (?:them|those)\b/i.test(posText)) return { kind: "pick", slot: offered[0], why: "Said either time works; took the first.", phone };
    }
  }

  // 2. a decline with nothing positive to book
  const times = findTimes(posText), days = findDays(times.rest, ctx.now);
  const hasTimeRef = times.spans.length > 0 && days.length > 0;
  if (DECLINE.test(low) && !hasTimeRef) return { kind: "decline", why: "They said they are not interested.", phone };

  // 3. their own time
  const wins: Win[] = [];
  // pair clauses: a time and a day in one clause, or a day-only clause followed by a time-only clause
  const perClause = pos.map((c) => { const t = findTimes(c); return { spans: t.spans, days: findDays(t.rest, ctx.now) }; });
  for (let i = 0; i < perClause.length; i++) {
    const c = perClause[i];
    if (c.spans.length && c.days.length) { for (const d of c.days) for (const sp of c.spans) { const w = toWindows(d, sp); if (w) wins.push(w); } continue; }
    if (c.days.length && !c.spans.length && perClause[i + 1]?.spans.length && !perClause[i + 1].days.length) { for (const d of c.days) for (const sp of perClause[i + 1].spans) { const w = toWindows(d, sp); if (w) wins.push(w); } }
    if (c.spans.length && !c.days.length && perClause[i - 1]?.days.length && !perClause[i - 1].spans.length) { for (const d of perClause[i - 1].days) for (const sp of c.spans) { const w = toWindows(d, sp); if (w) wins.push(w); } }
  }
  const future = wins.filter((w) => Date.parse(w.end) > ctx.now.getTime());

  // 3a. a day (and maybe a loose time of day) that matches what we offered counts as a pick
  if (offered.length && days.length) {
    const hit = (win?: Win) => offered.filter((o) => days.some((d) => sameDate(new Date(d.ms).toISOString(), o) || (d.explicit === "weekday" && dayOf(o) === new Date(d.ms).getUTCDay() && Math.abs(Date.parse(o) - d.ms) < 8 * DAYMS)) && (!win || (Date.parse(o) >= Date.parse(win.start) && Date.parse(o) + SLOT <= Date.parse(win.end))));
    if (!future.length || times.spans.every((s) => s.kind === "part")) { const h = hit(); if (h.length) return { kind: "pick", slot: h.sort()[0], why: "Named a day that matches one of the times offered.", phone }; }
    const exact = future.filter((w) => Date.parse(w.end) - Date.parse(w.start) === SLOT).map((w) => offered.find((o) => o === w.start)).find(Boolean);
    if (exact) return { kind: "pick", slot: exact, why: "Gave the exact time we offered.", phone };
  }

  if (future.length) return { kind: "propose", windows: future, why: `Suggested ${future.length === 1 ? "a time" : "times"} of their own.`, phone };
  if (wins.length) return U("The time they gave is already in the past.");
  if (DECLINE.test(low)) return { kind: "decline", why: "They said they are not interested.", phone };
  if (neg.length && !pos.length) return U("They ruled times out but did not suggest one.");
  if (days.length && !times.spans.length) return U("They named a day but no time.");
  if (/\?/.test(text)) return U("They asked a question.");
  return U("No clear time or answer in the reply.");
}
