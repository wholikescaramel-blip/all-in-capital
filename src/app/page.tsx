import { loadDB } from "@/lib/store";
import { hasLLM } from "@/lib/llm";
import { nice, REC_LABEL, SECTOR_LABEL } from "@/lib/plain";
import { TickButton } from "./Forms";
import { Bar, Pill, ScoreRing } from "./ui";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // server actions on this page (draft, reply handling) call the LLM

export default async function Home() {
  const db = await loadDB();
  const rows = Object.values(db.applications).map((a) => ({ a, s: db.states[a.id], asm: db.assessments[a.id], pending: db.pending[a.id] }))
    .sort((x, y) => (y.asm?.total_score ?? -1) - (x.asm?.total_score ?? -1));
  const count = (r: string) => rows.filter((x) => x.asm?.recommendation === r).length;
  const waiting = rows.filter((r) => r.s === "AWAITING_REVIEW").length;
  const conflicts = rows.filter((r) => r.asm?.conflict_flags.some((f) => f.severity === "overlap")).length;
  const inProgress = rows.filter((r) => r.pending).length;
  return (<>
    {!hasLLM() && <div className="card"><b className="bad">Offline mode.</b> <span className="muted">No GEMINI_API_KEY, so scores are simple keyword matches with no research. Good for a demo only.</span></div>}

    <p className="eyebrow">This week&apos;s applications</p>
    <h1 className="display"><span className="shimmer">Make the case.</span><br />Let a human decide.</h1>
    <p className="muted" style={{ maxWidth: 560, marginTop: 14, fontSize: 15 }}>
      Each application is scored on nine points, with a source for every claim and a list of what we couldn&apos;t find. Nothing moves forward until a reviewer says so.
    </p>

    <div className="stats">
      {[
        { k: "", n: rows.length, l: "applications" },
        { k: "", n: waiting, l: "waiting for you" },
        { k: "take_call", n: count("take_call"), l: "worth a call" },
        { k: "hold", n: count("hold"), l: "on hold" },
        { k: "", n: count("pass"), l: "suggested pass" },
        { k: "alert", n: conflicts, l: "overlap with portfolio" },
      ].map((s, i) => <div key={s.l} className={`stat ${s.k}`} style={{ animationDelay: `${i * 60}ms` }}><b>{s.n}</b><span>{s.l}</span></div>)}
    </div>

    {inProgress > 0 && <div className="card"><b>{inProgress} still being scored.</b> <span className="muted">Open <a href="/add" className="inline">Add applications</a> to let them finish.</span></div>}
    {rows.length === 0 && <div className="card">No applications yet. <a href="/add" className="inline">Add some</a>.</div>}

    <div className="apps">
      {rows.map(({ a, s, asm, pending }, i) => {
        const overlap = asm?.conflict_flags.filter((f) => f.severity === "overlap") ?? [];
        return (
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
              {overlap.map((f) => <Pill key={f.portfolio_company} kind="alert">overlaps {f.portfolio_company}</Pill>)}
            </div>
          </a>
        );
      })}
    </div>

    <details className="fold" style={{ marginTop: 40 }}>
      <summary>Test tools</summary>
      <TickButton />
    </details>
  </>);
}
