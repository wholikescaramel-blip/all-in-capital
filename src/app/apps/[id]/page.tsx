import { notFound } from "next/navigation";
import { loadDB } from "@/lib/store";
import { CRITERIA } from "@/config/rubric";
import { BASIS_LABEL, cleanBullet, cleanFit, keyFacts, nice, REC_LABEL, scoredBy } from "@/lib/plain";
import { pickContact } from "@/lib/emailflow";
import { OutreachPanel, ReviewForm } from "../../Forms";
import { Bar, Pill, Pipeline, ScoreRing } from "../../ui";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  const facts = keyFacts(app);
  const model = scoredBy(asm);

  const group = (g: "founder" | "path", title: string, blurb: string) => (
    <>
      <h3 className="section">{title} <span className="muted" style={{ fontFamily: "var(--sans)", fontSize: 13 }}>{blurb}</span></h3>
      {asm.scores.filter((s) => CRITERIA.find((c) => c.key === s.criterion)?.group === g).map((s) => {
        const c = CRITERIA.find((x) => x.key === s.criterion)!;
        const penalty = Math.max(0, (s.raw_score ?? s.score) - s.score);
        return (
          <details key={s.criterion} className="card crit" open={s.gap_ids.length > 0 && s.evidence_ids.length === 0}>
            <summary>
              <b>{c.label}</b>
              <span className="num">{s.score}</span>
              <Bar value={s.score} />
              <span className="meta row" style={{ gap: 6 }}>
                {s.gap_ids.length > 0 && <Pill kind="hold">{s.gap_ids.length} missing</Pill>}
                {s.corrections_applied.length > 0 && <Pill kind="take_call">uses {s.corrections_applied.length} past fix{s.corrections_applied.length > 1 ? "es" : ""}</Pill>}
                <i className="chev" />
              </span>
            </summary>
            <div className="body">
              <p style={{ margin: "0 0 4px" }}>{s.rationale}</p>
              {penalty > 0 && <p className="muted" style={{ margin: "4px 0" }}>{penalty.toFixed(1)} points taken off for missing info.</p>}
              {s.corrections_applied.map((cid) => { const k = db.corrections.find((x) => x.id === cid); return k && <blockquote key={cid}>Earlier fix by {k.author}: {k.old_score} to {k.new_score}. {k.reason}</blockquote>; })}
              <span className="lab">What we found</span>
              {s.evidence_ids.map((eid) => { const e = ev.get(eid); return e && <blockquote key={eid}>{e.claim}<br /><span style={{ opacity: .75 }}>{e.source_type === "form" ? "Application form" : e.source_type === "deck" ? "Deck" : e.source_type === "scrape" ? "Company website" : "Web"}</span></blockquote>; })}
              {s.evidence_ids.length === 0 && <p className="muted">Nothing.</p>}
              <span className="lab">What we couldn&apos;t find</span>
              {s.gap_ids.map((gid) => { const g = gaps.get(gid); return g && <blockquote key={gid} className="bad">{g.what_missing}<br /><span style={{ opacity: .8 }}>{g.cost_to_score}</span></blockquote>; })}
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
          <h1 className="display" style={{ fontSize: "clamp(2rem,4vw,3rem)" }}>{app.company}</h1>
          <p className="muted" style={{ margin: "8px 0 0" }}>{app.one_liner}</p>
          <p className="row" style={{ marginTop: 12 }}>
            <Pill kind={asm.recommendation}>Suggests: {REC_LABEL[asm.recommendation].toLowerCase()}</Pill>
            <Pill>{nice(state)}</Pill>
          </p>
        </div>
        <div style={{ minWidth: 190 }}>
          <div className="mini" style={{ marginTop: 0 }}><span>Founders</span><Bar value={asm.founder_group_score} /><b>{asm.founder_group_score}</b><span>Business</span><Bar value={asm.path_to_market_score} /><b>{asm.path_to_market_score}</b></div>
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>Scored separately on purpose.</p>
        </div>
      </div>

      <div className="kfs">
        {facts.map((f, i) => i === 0
          ? <div key={f.label} className={`kf lead sec-${app.sector}`}><small>{f.label}</small><b>{f.value}</b></div>
          : <div key={f.label} className="kf"><small>{f.label}</small><b>{f.value}</b></div>)}
        {app.founders.length > 0 && <div className="kf"><small>Founders</small><b>{app.founders.slice(0, 3).map((x) => x.name).join(", ")}</b></div>}
      </div>
      <Pipeline state={state} />
    </div>

    {overlaps.map((f) => <div key={f.portfolio_company} className="card" style={{ borderColor: "color-mix(in srgb, var(--red) 55%, transparent)" }}><b className="bad">Overlaps with {f.portfolio_company}.</b> <span className="muted">{f.reason} On hold until someone speaks to that founder.</span></div>)}

    <p className="muted" style={{ margin: "14px 4px" }}><b style={{ color: "var(--fg)" }}>Fit:</b> judged against {BASIS_LABEL[asm.thesis_basis]}. {cleanFit(asm.basis_reason)}</p>

    <div className="grid2" style={{ marginTop: 14 }}>
      <div className="card"><h4>What&apos;s good</h4><ul className="clean">{asm.case_for.map((c, i) => <li key={i}>{cleanBullet(c)}</li>)}</ul></div>
      <div className="card"><h4>What&apos;s holding it back</h4><ul className="clean">{asm.case_against.map((c, i) => <li key={i}>{cleanBullet(c)}</li>)}</ul></div>
    </div>

    {group("founder", "The founders", "what they've shown")}
    {group("path", "The business", "traction, money, structure")}

    <div style={{ marginTop: 30 }}>
      {state === "AWAITING_REVIEW" && <ReviewForm id={id} systemRec={asm.recommendation} crits={asm.scores.map((s) => ({ key: s.criterion, label: CRITERIA.find((c) => c.key === s.criterion)!.label, score: s.score }))} />}
      {["APPROVED", "DRAFTED", "AWAITING_REPLY", "SCHEDULING", "SCHEDULED", "FLAGGED"].includes(state) && (
        <OutreachPanel id={id} state={state} contact={out?.contact ?? pickContact(app)} draft={out?.draft} versions={(out?.versions ?? []) as never} chat={out?.chat ?? []} notes={db.draft_notes} followups={out?.followups_sent ?? 0}
          slot={out?.slot ? slotFmt(out.slot) : undefined} slots={(out?.proposed_slots ?? []).map(slotFmt)} />)}
    </div>

    <details className="fold" style={{ marginTop: 28 }}>
      <summary>History</summary>
      <ol className="tl">
        {db.audit.filter((a) => a.app_id === id).map((a, i) => <li key={i}><span className="t">{a.at.slice(0, 16).replace("T", " ")}</span>{a.from ? nice(a.from) : "start"} &rarr; <b>{nice(a.to)}</b> <span className="muted">by {a.actor}{a.note ? `: ${a.note}` : ""}</span></li>)}
      </ol>
    </details>
    {model && <p className="muted" style={{ fontSize: 12 }}>Scored with {model}.</p>}
  </>);
}
