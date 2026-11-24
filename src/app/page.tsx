import { loadDB, storeKind } from "@/lib/store";
import { hasLLM } from "@/lib/llm";
import { TickButton } from "./Forms";
import { Bar, Pill, ScoreRing } from "./ui";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // server actions on this page (draft, reply handling) call the LLM

const nice = (s: string) => s.replace(/_/g, " ").toLowerCase();

export default async function Home() {
  const db = await loadDB();
  const rows = Object.values(db.applications).map((a) => ({ a, s: db.states[a.id], asm: db.assessments[a.id] }))
    .sort((x, y) => (y.asm?.total_score ?? 0) - (x.asm?.total_score ?? 0));
  const count = (r: string) => rows.filter((x) => x.asm?.recommendation === r).length;
  const waiting = rows.filter((r) => r.s === "AWAITING_REVIEW").length;
  const conflicts = rows.filter((r) => r.asm?.conflict_flags.some((f) => f.severity === "overlap")).length;
  const gapTotal = db.gaps.length;
  return (<>
    {!hasLLM() && <div className="card"><b className="bad">Offline mode.</b> <span className="muted">No GEMINI_API_KEY: scores are keyword heuristics with no web research. A demo of the workflow, not judgement.</span></div>}

    <p className="eyebrow">This week&apos;s intake</p>
    <h1 className="display"><span className="shimmer">Make the case.</span><br />Let a human decide.</h1>
    <p className="muted" style={{ maxWidth: 560, marginTop: 14, fontSize: 15 }}>
      Every application is scored criterion by criterion, with a source behind each claim and a ledger of what could not be found. Nothing is rejected or advanced without a reviewer.
    </p>

    <div className="stats">
      {[
        { k: "", n: rows.length, l: "applications" },
        { k: "", n: waiting, l: "awaiting review" },
        { k: "take_call", n: count("take_call"), l: "suggest a call" },
        { k: "hold", n: count("hold"), l: "suggest hold" },
        { k: "", n: count("pass"), l: "suggest pass" },
        { k: "alert", n: conflicts, l: "portfolio conflicts" },
        { k: "", n: gapTotal, l: "open gaps logged" },
      ].map((s, i) => <div key={s.l} className={`stat ${s.k}`} style={{ animationDelay: `${i * 60}ms` }}><b>{s.n}</b><span>{s.l}</span></div>)}
    </div>

    {rows.length === 0 && <div className="card">No applications yet. Run <code>npm run ingest</code>.</div>}

    <div className="apps">
      {rows.map(({ a, s, asm }, i) => {
        const overlap = asm?.conflict_flags.filter((f) => f.severity === "overlap") ?? [];
        return (
          <a key={a.id} href={`/apps/${a.id}`} className="app" style={{ animationDelay: `${120 + i * 50}ms` }}>
            <div className="head">
              {asm ? <ScoreRing value={asm.total_score} rec={asm.recommendation} /> : <div className="ring" style={{ ["--v" as string]: 0 }}><b>-</b></div>}
              <div style={{ minWidth: 0 }}>
                <h4>{a.company}</h4>
                <div className="muted">{nice(a.sector)} &middot; {a.stage}</div>
              </div>
              <div style={{ marginLeft: "auto" }}>{asm && <Pill kind={asm.recommendation}>{nice(asm.recommendation)}</Pill>}</div>
            </div>
            <p>{a.one_liner.slice(0, 110)}</p>
            {asm && <div className="mini">
              <span>Founder</span><Bar value={asm.founder_group_score} /><b>{asm.founder_group_score}</b>
              <span>Path</span><Bar value={asm.path_to_market_score} /><b>{asm.path_to_market_score}</b>
            </div>}
            <div className="foot">
              <Pill>{nice(s)}</Pill>
              {overlap.map((f) => <Pill key={f.portfolio_company} kind="alert">conflict: {f.portfolio_company}</Pill>)}
              {asm && /fallback model/.test(asm.basis_reason) && <Pill>lite model</Pill>}
            </div>
          </a>
        );
      })}
    </div>

    <details className="fund">
      <summary>Fund context</summary>
      <div className="card">
        <span className="lab" style={{ marginTop: 0 }}>Thesis ({db.fund.thesis_source || "none"})</span>
        <p className="muted" style={{ marginTop: 6 }}>{db.fund.thesis_text}</p>
        <span className="lab">Portfolio on file ({db.fund.portfolio.length})</span>
        <p className="row" style={{ marginTop: 8 }}>{db.fund.portfolio.map((p) => <Pill key={p.name}>{p.name}</Pill>)}</p>
        {db.fund.gaps.map((g, i) => <blockquote key={i} className="bad">{g}</blockquote>)}
      </div>
    </details>
    <p className="muted" style={{ marginTop: 28 }}>Storage: {storeKind()}</p>
    <TickButton />
  </>);
}
