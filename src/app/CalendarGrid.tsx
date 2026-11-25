import type { DB } from "@/lib/schemas";

// A week view of the calls. Booked calls are solid blocks, times we have offered and are waiting on are dashed. Everything is in
// India time. It shows only what this app knows, never the contents of the real calendar.
const IST = 330 * 60000, DAY = 86400000, FROM = 10, TO = 19, ROW = 54; // hours shown, pixels per hour
const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hh = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;
const clock = (iso: string) => { const d = new Date(Date.parse(iso) + IST); const h = d.getUTCHours(), m = d.getUTCMinutes(); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`; };

type Block = { id: string; appId: string; app: string; start: string; kind: "booked" | "offered"; url?: string; sector: string; with?: string; mock?: boolean };

export function CalendarGrid({ db, week, now = new Date() }: { db: DB; week: number; now?: Date }) {
  const today = new Date(Math.floor((now.getTime() + IST) / DAY) * DAY); // IST midnight, held as a UTC time
  const dow = today.getUTCDay();
  const monday = today.getTime() - ((dow + 6) % 7) * DAY + week * 7 * DAY;
  const days = Array.from({ length: 5 }, (_, i) => monday + i * DAY);

  const blocks: Block[] = [];
  for (const o of Object.values(db.outreach)) {
    const app = db.applications[o.app_id]; if (!app) continue;
    const st = db.states[o.app_id];
    if (o.meeting && st === "SCHEDULED") blocks.push({ id: o.app_id, appId: o.app_id, app: app.company, start: o.meeting.start, kind: "booked", url: o.meeting.url, sector: app.sector, with: o.attendees.includes("deeptech_partner") ? "with the deeptech partner" : undefined, mock: o.meeting.provider === "mock" });
    else if (["AWAITING_REPLY", "SCHEDULING"].includes(st ?? "")) for (const s of o.proposed_slots ?? []) blocks.push({ id: o.app_id + s, appId: o.app_id, app: app.company, start: s, kind: "offered", sector: app.sector });
  }
  const inDay = (b: Block, d: number) => { const t = Date.parse(b.start) + IST; return t >= d && t < d + DAY; };
  const booked = blocks.filter((b) => b.kind === "booked").length;
  const d0 = new Date(days[0]), d4 = new Date(days[4]);
  const label = `${d0.getUTCDate()} ${MON[d0.getUTCMonth()]} to ${d4.getUTCDate()} ${MON[d4.getUTCMonth()]}`;
  const nowTop = ((now.getTime() + IST - today.getTime()) / 3600000 - FROM) * ROW;

  return (
    <section aria-label="Calendar">
      <div className="calhead">
        <div><b>{label}</b> <span className="muted">India time &middot; {booked} booked in total</span></div>
        <div className="row" style={{ gap: 8 }}>
          <a className="chip" href={`/dashboard?w=${week - 1}`} aria-label="Previous week">&larr;</a>
          <a className={`chip ${week === 0 ? "on" : ""}`} href="/dashboard">This week</a>
          <a className="chip" href={`/dashboard?w=${week + 1}`} aria-label="Next week">&rarr;</a>
        </div>
      </div>
      <div className="calwrap">
        <div className="cal" style={{ ["--row" as string]: `${ROW}px` }}>
          <div className="calcorner" />
          {days.map((d) => { const dt = new Date(d); return <div key={d} className={`calday ${d === today.getTime() ? "today" : ""}`}>{NAMES[dt.getUTCDay()]} <b>{dt.getUTCDate()}</b></div>; })}
          <div className="calhours">{Array.from({ length: TO - FROM }, (_, i) => <span key={i} style={{ height: ROW }}>{hh(FROM + i)}</span>)}</div>
          {days.map((d) => {
            const dt = new Date(d).getUTCDay(), invite = dt === 2 || dt === 4; // Tuesday and Thursday afternoons are the invite windows
            return (
              <div key={d} className="calcol" style={{ height: (TO - FROM) * ROW }}>
                {invite && <div className="calwin" style={{ top: (14 - FROM) * ROW, height: 4 * ROW }} title="Invite window: 2 to 6 pm" />}
                {d === today.getTime() && nowTop > 0 && nowTop < (TO - FROM) * ROW && <div className="calnow" style={{ top: nowTop }} />}
                {blocks.filter((b) => inDay(b, d)).map((b) => {
                  const t = new Date(Date.parse(b.start) + IST), top = (t.getUTCHours() + t.getUTCMinutes() / 60 - FROM) * ROW;
                  return (
                    <div key={b.id} className={`calblock ${b.kind} sec-${b.sector}`} style={{ top, height: ROW / 2 - 2 }} title={`${b.app}, ${clock(b.start)}${b.with ? ", " + b.with : ""}${b.mock ? " (recorded in the app only)" : ""}`}>
                      <a href={`/apps/${b.appId}`}><b>{b.app}</b></a>
                      <span>{b.kind === "booked" ? clock(b.start) : `offered ${clock(b.start)}`}</span>
                      {b.url && <a href={b.url} target="_blank" rel="noreferrer" className="meet">Meet</a>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <p className="muted" style={{ marginTop: 10 }}><span className="key booked" /> booked <span className="key offered" /> offered, waiting for the founder <span className="key win" /> Tuesday and Thursday invite window</p>
    </section>
  );
}
