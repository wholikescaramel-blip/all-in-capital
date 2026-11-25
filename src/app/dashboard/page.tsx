import { loadDB } from "@/lib/store";
import { REC_LABEL, SECTOR_LABEL } from "@/lib/plain";
import { slotLabel } from "@/lib/slots";
import { gmailThreadUrl } from "@/lib/links";
import type { Message } from "@/lib/schemas";
import { Pill } from "../ui";

export const dynamic = "force-dynamic";

// Where every application is, what type it is, the calls that are booked, and the portfolio we already hold.
const STAGES: { key: string; label: string; hint: string; states: string[] }[] = [
  { key: "reading", label: "Being read", hint: "research and scoring", states: ["SCORING", "INGESTED", "RESEARCHED", "SCORED"] },
  { key: "review", label: "Waiting for you", hint: "scored, needs a decision", states: ["AWAITING_REVIEW"] },
  { key: "approved", label: "Approved", hint: "no email yet", states: ["APPROVED"] },
  { key: "drafted", label: "Email drafted", hint: "not sent", states: ["DRAFTED", "APPROVED_TO_SEND"] },
  { key: "waiting", label: "Waiting for a reply", hint: "invite sent", states: ["SENT", "AWAITING_REPLY"] },
  { key: "offered", label: "Times offered", hint: "agreeing a slot", states: ["SCHEDULING"] },
  { key: "booked", label: "Call booked", hint: "on the calendar", states: ["SCHEDULED"] },
  { key: "person", label: "Needs a person", hint: "unclear reply or flag", states: ["FLAGGED"] },
  { key: "hold", label: "On hold", hint: "", states: ["ON_HOLD"] },
  { key: "passed", label: "Passed", hint: "", states: ["DECIDED_PASS"] },
];
const ist = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default async function Dashboard() {
  const db = await loadDB();
  const apps = Object.values(db.applications).filter((a) => !a.is_backtest).map((a) => ({ a, st: db.pending[a.id] ? "SCORING" : db.states[a.id] ?? "INGESTED", asm: db.assessments[a.id] }));
  const stages = STAGES.map((s) => ({ ...s, items: apps.filter((x) => s.states.includes(x.st)) }));
  const sectors = [...new Set(apps.map((x) => x.a.sector))].map((k) => {
    const list = apps.filter((x) => x.a.sector === k), scored = list.filter((x) => x.asm);
    return { k, n: list.length, avg: scored.length ? scored.reduce((t, x) => t + x.asm.total_score, 0) / scored.length : 0, calls: list.filter((x) => x.asm?.recommendation === "take_call").length };
  }).sort((x, y) => y.n - x.n);
  const lanes = (["take_call", "hold", "pass"] as const).map((r) => ({ r, n: apps.filter((x) => x.asm?.recommendation === r).length }));
  const booked = Object.values(db.outreach).filter((o) => o.meeting && db.states[o.app_id] === "SCHEDULED").sort((x, y) => x.meeting!.start.localeCompare(y.meeting!.start));
  const waiting = Object.values(db.outreach).filter((o) => ["AWAITING_REPLY", "SCHEDULING"].includes(db.states[o.app_id] ?? ""));
  const needYou = Object.values(db.outreach).filter((o) => o.needs_human && db.states[o.app_id] === "FLAGGED");
  const mailbox = db.google?.email ?? process.env.MAILBOX_EMAIL;
  const threads = Object.values(db.outreach).filter((o) => (o.thread ?? []).length > 0 && db.applications[o.app_id]).map((o) => {
    const t = [...(o.thread as Message[])].sort((a, b) => a.at.localeCompare(b.at));
    return { o, last: t[t.length - 1], sent: t.filter((m) => m.dir === "out").length, got: t.filter((m) => m.dir === "in").length, failed: t.filter((m) => m.status === "failed").length };
  }).sort((a, b) => b.last.at.localeCompare(a.last.at));
  const profiles = db.fund.profiles ?? [];
  const cats = [...profiles.reduce((m, p) => m.set(p.category, (m.get(p.category) ?? 0) + 1), new Map<string, number>())].sort((x, y) => y[1] - x[1]);
  const overlaps = apps.flatMap((x) => (x.asm?.conflict_flags ?? []).filter((f) => f.severity === "overlap").map((f) => ({ company: x.a.company, id: x.a.id, with: f.portfolio_company })));
  const maxS = Math.max(1, ...sectors.map((s) => s.n)), maxC = Math.max(1, ...cats.map((c) => c[1]));

  return (<>
    <h1 className="display"><span className="shimmer">Pipeline</span></h1>
    <div className="status">
      <span><b>{apps.length}</b>in the pipeline</span><span className="sep">&middot;</span>
      <span className="hl"><b>{stages.find((s) => s.key === "review")!.items.length}</b>waiting for you</span><span className="sep">&middot;</span>
      <span className="good"><b>{booked.length}</b>calls booked</span>
      {needYou.length > 0 && <><span className="sep">&middot;</span><span className="warn"><b>{needYou.length}</b>need a person</span></>}
    </div>

    <h3 className="section">Where each one is</h3>
    <div className="flow">
      {stages.map((s) => (
        <div key={s.key} className={`stage ${s.items.length ? "has" : ""}`}>
          <div className="stagehead"><b>{s.items.length}</b><span>{s.label}</span></div>
          {s.hint && <small className="muted">{s.hint}</small>}
          <div className="chips">
            {s.items.map((x) => <a key={x.a.id} href={`/apps/${x.a.id}`} className={`chip sec-${x.a.sector}`} title={`${SECTOR_LABEL[x.a.sector] ?? x.a.sector}, ${x.a.stage}`}>{x.a.company}</a>)}
            {!s.items.length && <span className="muted">none</span>}
          </div>
        </div>
      ))}
    </div>

    <div className="grid2" style={{ marginTop: 28 }}>
      <div className="card">
        <h3>What type they are</h3>
        {sectors.map((s) => (
          <div key={s.k} className="distrow">
            <span className={`sector sec-${s.k}`}>{SECTOR_LABEL[s.k] ?? s.k}</span>
            <span className="distbar"><i style={{ width: `${(s.n / maxS) * 100}%` }} /></span>
            <b>{s.n}</b><span className="muted">avg {s.avg ? s.avg.toFixed(1) : "-"} &middot; {s.calls} worth a call</span>
          </div>
        ))}
        <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: "wrap" }}>
          {lanes.map((l) => <Pill key={l.r} kind={l.r}>{REC_LABEL[l.r]}: {l.n}</Pill>)}
        </div>
      </div>

      <div className="card">
        <h3>Calls</h3>
        {booked.length === 0 && <p className="muted">No calls booked yet.</p>}
        {booked.map((o) => (
          <div key={o.app_id} className="callrow">
            <a href={`/apps/${o.app_id}`} className="inline">{db.applications[o.app_id].company}</a>
            <span>{ist(o.meeting!.start)} IST{o.attendees.includes("deeptech_partner") ? ", with the deeptech partner" : ""}</span>
            <span className="links">{o.meeting!.url && <a className="inline" href={o.meeting!.url} target="_blank" rel="noreferrer">Join Meet</a>}{o.meeting!.calendar_url && <a className="inline" href={o.meeting!.calendar_url} target="_blank" rel="noreferrer">Calendar</a>}{o.thread_id && <a className="inline" href={gmailThreadUrl(o.thread_id, mailbox)} target="_blank" rel="noreferrer">Gmail</a>}</span>
          </div>
        ))}
        <p className="muted" style={{ marginTop: 12 }}>{waiting.length} waiting for a reply &middot; {needYou.length} need a person</p>
        {waiting.slice(0, 5).map((o) => <div key={o.app_id} className="muted">{db.applications[o.app_id].company}: {o.proposed_slots.length ? `offered ${o.proposed_slots.map(slotLabel).join(" or ")}` : "invite sent"}</div>)}
        {needYou.map((o) => <div key={o.app_id} className="warn">{db.applications[o.app_id].company}: {o.needs_human}</div>)}
      </div>
    </div>

    <h3 className="section">Mail and meetings</h3>
    {threads.length === 0 && <div className="card">No mail yet. Approve a call on an application and send the email to start a thread.</div>}
    <div className="mailrows">
      {threads.map(({ o, last, sent, got, failed }) => (
        <div key={o.app_id} className="mailrow">
          <div><a href={`/apps/${o.app_id}`} className="inline"><b>{db.applications[o.app_id].company}</b></a><div className="muted">{o.contact?.name}</div></div>
          <div className="muted">{last.dir === "out" ? "We sent" : "Founder replied"}: {last.body.replace(/\s+/g, " ").slice(0, 110)}<div style={{ fontSize: 12 }}>{ist(last.at)} IST</div></div>
          <div className="mailside">
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <Pill>{sent} sent</Pill><Pill>{got} received</Pill>
              {failed > 0 && <Pill kind="alert">{failed} failed</Pill>}
              {o.meeting ? <Pill kind="take_call">booked {ist(o.meeting.start)}</Pill> : o.needs_human ? <Pill kind="hold">needs a person</Pill> : <Pill>no meeting yet</Pill>}
            </div>
            <div className="links">
              <a className="inline" href={`/apps/${o.app_id}`}>Thread</a>
              {o.thread_id && <a className="inline" href={gmailThreadUrl(o.thread_id, mailbox)} target="_blank" rel="noreferrer">Open in Gmail</a>}
              {o.meeting?.url && <a className="inline" href={o.meeting.url} target="_blank" rel="noreferrer">Join Meet</a>}
              {o.meeting?.calendar_url && <a className="inline" href={o.meeting.calendar_url} target="_blank" rel="noreferrer">Open in Calendar</a>}
            </div>
          </div>
        </div>
      ))}
    </div>

    <h3 className="section">Portfolio at a glance <a href="/portfolio" className="inline" style={{ fontFamily: "var(--sans)", fontSize: 13 }}>See all {db.fund.portfolio.length} companies</a></h3>
    <div className="grid2">
      <div className="card">
        {cats.length === 0 && <p className="muted">Profiles not loaded yet. Run <code>npm run refresh-portfolio</code>.</p>}
        {cats.map(([c, n]) => <div key={c} className="distrow"><span>{c}</span><span className="distbar"><i style={{ width: `${(n / maxC) * 100}%` }} /></span><b>{n}</b></div>)}
        {profiles.length > 0 && <p className="muted" style={{ marginTop: 12 }}>{profiles.filter((p) => p.website).length} of {profiles.length} have a website we could read.</p>}
      </div>
      <div className="card">
        <h4>Overlap watch</h4>
        {overlaps.length === 0 && <p className="muted">No application overlaps a portfolio company.</p>}
        {overlaps.map((o, i) => <div key={i}><a className="inline" href={`/apps/${o.id}`}>{o.company}</a> <span className="muted">overlaps</span> {o.with}</div>)}
      </div>
    </div>
  </>);
}
