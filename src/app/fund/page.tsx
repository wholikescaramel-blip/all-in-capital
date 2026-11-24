import { loadDB } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Fund() {
  const db = await loadDB();
  const f = db.fund;
  return (<>
    <p className="eyebrow">The fund</p>
    <h1 className="display">What we score against</h1>

    <h3 className="section">Thesis</h3>
    <p className="quote">{f.thesis_text || "Not loaded yet. Run the intake once to read it from the fund's site."}</p>
    <p className="muted" style={{ marginTop: 8 }}>Source: {f.thesis_source || "none"}</p>

    <h3 className="section">Portfolio <span className="muted" style={{ fontFamily: "var(--sans)", fontSize: 13 }}>{f.portfolio.length} companies. New applications are checked against all of them.</span></h3>
    <ul className="plainlist">{f.portfolio.map((p) => <li key={p.name}>{p.name}</li>)}</ul>

    {f.gaps.length > 0 && <>
      <h3 className="section">Worth knowing</h3>
      <ul className="notes">{f.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
    </>}
  </>);
}
