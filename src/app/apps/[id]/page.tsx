import { notFound } from "next/navigation";
import { loadDB } from "@/lib/store";
import { CRITERIA } from "@/config/rubric";
import { OutreachPanel, ReviewForm } from "../../Forms";
import { Bar, Pill, Pipeline, ScoreRing } from "../../ui";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const nice = (s: string) => s.replace(/_/g, " ").toLowerCase();

export default async function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await loadDB();
  const app = db.applications[id];
  const asm = db.assessments[id];
  if (!app || !asm) notFound();
  const state = db.states[id];
  const ev = new Map(db.evidence.filter((e) => e.app_id === id).map((e) => [e.id, e]));
  const gaps = new Map(db.gaps.filter((g) => g.app_id === id).map((g) => [g.id, g]));
  const out = db.outreach[id];
  const slotFmt = (s: string) => new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const overlaps = asm.conflict_flags.filter((f) => f.severity === "overlap");
  const warns = asm.conflict_flags.filter((f) => f.severity !== "overlap");

  const group = (g: "founder" | "path", title: string, blurb: string) => (
    <>
      <h3 className="section">{title} <span className="muted" style={{ fontFamily: "var(--sans)", fontSize: 13 }}>{blurb}</span></h3>
      {asm.scores.filter((s) => CRITERIA.find((c) => c.key === s.criterion)?.group === g).map((s) => {
        const c = CRITERIA.find((x) => x.key === s.criterion)!;
        return (
          <details key={s.criterion} className="card crit" open={s.gap_ids.length > 0 && s.evidence_ids.length === 0}>
            <summary>
              <span><b>{c.label}</b><br /><span className="muted">weight {c.weight} &middot; raw {s.raw_score}</span></span>
              <span className="num">{s.score}</span>
              <Bar value={s.score} />
              <span className="meta row" style={{ gap: 6 }}>
                <Pill>{s.confidence} confidence</Pill>
                {s.gap_ids.length > 0 && <Pill kind="hold">{s.gap_ids.length} gap{s.gap_ids.length > 1 ? "s" : ""}</Pill>}
                {s.corrections_applied.length > 0 && <Pill kind="take_call">{s.corrections_applied.length} correction{s.corrections_applied.length > 1 ? "s" : ""} reused</Pill>}
              </span>
            </summary>
            <div className="body">
              <p style={{ margin: "0 0 4px" }}>{s.rationale}</p>
              {s.corrections_applied.map((cid) => { const k = db.corrections.find((x) => x.id === cid); return k && <blockquote key={cid}>Past correction by {k.author}: {k.old_score} &rarr; {k.new_score}. {k.reason}</blockquote>; })}
              <span className="lab">Evidence</span>
              {s.evidence_ids.map((eid) => { const e = ev.get(eid); return e && <blockquote key={eid}>{e.claim}<br /><span style={{ opacity: .75 }}>{e.source_type} &middot; {e.url_or_ref.slice(0, 120)} &middot; &ldquo;{e.quote_or_snippet.slice(0, 160)}&rdquo;</span></blockquote>; })}
              {s.evidence_ids.length === 0 && <p className="muted">None found.</p>}
              <span className="lab">What we couldn&apos;t find</span>
              {s.gap_ids.map((gid) => { const g = gaps.get(gid); return g && <blockquote key={gid} className="bad">{g.what_missing}<br /><span style={{ opacity: .8 }}>Tried: {g.tried.join(", ")}. Cost: {g.cost_to_score}</span></blockquote>; })}
              {s.gap_ids.length === 0 && <p className="muted">Nothing missing.</p>}
            </div>
          </details>
        );
      })}
    </>
  );

  return (<>
    <a href="/" className="back">&larr; All applications</a>

    <div className="card beam" style={{ padding: 26 }}>
      <div className="hero">
        <ScoreRing value={asm.total_score} rec={asm.recommendation} size={112} />
        <div style={{ flex: 1, minWidth: 240 }}>
          <p className="eyebrow">{nice(app.sector)} &middot; {app.stage} &middot; {app.source === "warm_intro" ? "warm intro" : "public form"}</p>
          <h1 className="display" style={{ fontSize: "clamp(2rem,4vw,3rem)" }}>{app.company}</h1>
          <p className="muted" style={{ margin: "8px 0 0" }}>{app.one_liner}</p>
          <p className="row" style={{ marginTop: 12 }}>
            <Pill kind={asm.recommendation}>system suggests: {nice(asm.recommendation)}</Pill>
            <Pill>{nice(state)}</Pill>
            <Pill>thesis basis: {asm.thesis_basis}</Pill>
            {app.founders.slice(0, 3).map((f) => <Pill key={f.name}>{f.name}</Pill>)}
          </p>
        </div>
        <div style={{ minWidth: 190 }}>
          <div className="mini" style={{ marginTop: 0 }}><span>Founder</span><Bar value={asm.founder_group_score} /><b>{asm.founder_group_score}</b><span>Path to market</span><Bar value={asm.path_to_market_score} /><b>{asm.path_to_market_score}</b></div>
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>Scored separately, never blended into one number.</p>
        </div>
      </div>
      <Pipeline state={state} />
    </div>

    {overlaps.map((f) => <div key={f.portfolio_company} className="card" style={{ borderColor: "color-mix(in srgb, var(--red) 55%, transparent)" }}><b className="bad">Portfolio conflict: {f.portfolio_company}.</b> <span className="muted">{f.reason} Held by default.</span></div>)}
    {warns.map((f) => <div key={f.portfolio_company} className="card"><b>Warning.</b> <span className="muted">{f.reason}</span></div>)}
    <p className="muted" style={{ margin: "14px 4px" }}><b>Why this thesis basis:</b> {asm.basis_reason}</p>

    <div className="grid2" style={{ marginTop: 14 }}>
      <div className="card"><h4>Case for</h4><ul className="clean">{asm.case_for.map((c, i) => <li key={i}>{c}</li>)}</ul></div>
      <div className="card"><h4>Case against and gaps</h4><ul className="clean">{asm.case_against.map((c, i) => <li key={i}>{c}</li>)}</ul></div>
    </div>

    {group("founder", "The founders", "risk ownership, numbers, field work, candour")}
    {group("path", "Path and structure", "traction, economics, capital fit, regulation, thesis")}

    <div style={{ marginTop: 30 }}>
      {state === "AWAITING_REVIEW" && <ReviewForm id={id} systemRec={asm.recommendation} crits={asm.scores.map((s) => ({ key: s.criterion, label: CRITERIA.find((c) => c.key === s.criterion)!.label, score: s.score }))} />}
      {["APPROVED", "DRAFTED", "AWAITING_REPLY", "SCHEDULING", "SCHEDULED", "FLAGGED"].includes(state) && (
        <OutreachPanel id={id} state={state} draft={out?.draft?.body} followups={out?.followups_sent ?? 0} slot={out?.slot ? slotFmt(out.slot) : undefined} slots={(out?.proposed_slots ?? []).map(slotFmt)} />)}
    </div>

    <h3 className="section">Audit log</h3>
    <ol className="tl">
      {db.audit.filter((a) => a.app_id === id).map((a, i) => <li key={i}><span className="t">{a.at.slice(0, 16).replace("T", " ")}</span>{a.from ?? "start"} &rarr; <b>{nice(a.to)}</b> <span className="muted">by {a.actor}{a.note ? `: ${a.note}` : ""}</span></li>)}
    </ol>
  </>);
}
