import { loadDB } from "@/lib/store";
import { hasLLM } from "@/lib/llm";
import { nice, REC_LABEL, SECTOR_LABEL } from "@/lib/plain";
import { TickButton } from "./Forms";
import { Bar, Pill, ScoreRing } from "./ui";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // server actions on this page (draft, reply handling) call the LLM

export default async function Home() {
  const db = await loadDB();
  const rows = Object.values(db.applications).map((a) => {
    const asm = db.assessments[a.id];
    const overlap = asm?.conflict_flags.filter((f) => f.severity === "overlap").map((f) => f.portfolio_company) ?? [];
    // Order by what needs action, not by raw score: calls to take first, then holds, then holds that need a conversation, then passes.
    const tier = db.pending[a.id] || !asm ? 9 : asm.recommendation === "take_call" ? 0 : asm.recommendation === "hold" ? (overlap.length ? 2 : 1) : 3;
    return { a, s: db.states[a.id], asm, pending: db.pending[a.id], overlap, tier };
  }).sort((x, y) => x.tier - y.tier || (y.asm?.total_score ?? -1) - (x.asm?.total_score ?? -1));

  const waiting = rows.filter((r) => r.s === "AWAITING_REVIEW").length;
  const worthCall = rows.filter((r) => r.asm?.recommendation === "take_call").length;
  const held = rows.filter((r) => r.overlap.length).length;
  const inProgress = rows.filter((r) => r.pending).length;

  return (<>
    {!hasLLM() && <div className="card"><b className="bad">Offline mode.</b> <span className="muted">No GEMINI_API_KEY, so scores are simple keyword matches with no research. Good for a demo only.</span></div>}

    <h1 className="display"><span className="shimmer">This week&apos;s applications</span></h1>
    <div className="status" aria-live="polite">
      <span><b>{rows.length}</b>in</span>
      <span className="sep">&middot;</span>
      <span className="hl"><b>{waiting}</b>waiting for you</span>
      <span className="sep">&middot;</span>
      <span className={worthCall ? "good" : ""}><b>{worthCall}</b>worth a call</span>
      {held > 0 && <><span className="sep">&middot;</span><span className="warn"><b>{held}</b>held for overlap</span></>}
    </div>
    <p className="muted" style={{ marginTop: 12 }}>Scores come with sources. Nothing moves until you decide.</p>

    {inProgress > 0 && <div className="card"><b>{inProgress} still being scored.</b> <span className="muted">Open <a href="/add" className="inline">Add applications</a> to let them finish.</span></div>}
    {rows.length === 0 && <div className="card">No applications yet. <a href="/add" className="inline">Add some</a>.</div>}

    <div className="apps">
      {rows.map(({ a, s, asm, pending, overlap }, i) => (
        <a key={a.id} href={pending || !asm ? "/add" : `/apps/${a.id}`} className="app" style={{ animationDelay: `${120 + i * 50}ms` }}>
          <div className="head">
            {asm ? <ScoreRing value={asm.total_score} rec={asm.recommendation} /> : <div className="ring" style={{ ["--v" as string]: 0 }}><b>-</b></div>}
            <div style={{ minWidth: 0 }}>
              <h4>{a.company}</h4>
              <span className={`sector sec-${a.sector}`}>{SECTOR_LABEL[a.sector] ?? a.sector}</span>
              <span className="muted"> &middot; {a.stage}</span>
            </div>
            <div style={{ marginLeft: "auto" }}>{asm && <Pill kind={asm.recommendation}>{REC_LABEL[asm.recommendation]}</Pill>}</div>
          </div>
          <p>{a.one_liner.slice(0, 110)}</p>
          {asm && <div className="mini">
            <span>Founders</span><Bar value={asm.founder_group_score} /><b>{asm.founder_group_score}</b>
            <span>Business</span><Bar value={asm.path_to_market_score} /><b>{asm.path_to_market_score}</b>
          </div>}
          <div className="foot">
            <Pill>{pending ? "scoring" : nice(s)}</Pill>
            {overlap.length > 0 && <Pill kind="alert">held: overlaps {overlap.slice(0, 2).join(", ")}{overlap.length > 2 ? ` +${overlap.length - 2}` : ""}</Pill>}
          </div>
        </a>
      ))}
    </div>

    <details className="fold" style={{ marginTop: 40 }}>
      <summary>Test tools</summary>
      <TickButton />
    </details>
  </>);
}
