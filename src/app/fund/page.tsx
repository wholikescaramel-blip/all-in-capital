import { loadDB } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Fund() {
  const db = await loadDB();
  const f = db.fund;
  const fromSite = /website/i.test(f.thesis_source);
  // The "no thesis page" note is folded into the source line below; anything else we couldn't read stays visible, without a heading.
  const other = f.gaps.filter((g) => !/no thesis page/i.test(g));
  return (<>
    <h1 className="display">What we score against</h1>

    <h3 className="section">Thesis</h3>
    <p className="quote">{f.thesis_text || "Not loaded yet. Run the intake once to read it from the fund's site."}</p>
    <p className="muted" style={{ marginTop: 8 }}>{fromSite ? "Source: the fund's homepage. Sectors from the partner notes." : `Source: ${f.thesis_source || "none"}.`}</p>

    <h3 className="section">Portfolio <span className="muted" style={{ fontFamily: "var(--sans)", fontSize: 13 }}>{f.portfolio.length} companies. New applications are checked against all of them.</span></h3>
    <ul className="plainlist">{f.portfolio.map((p) => <li key={p.name}>{p.name}</li>)}</ul>

    {other.length > 0 && <ul className="notes" style={{ marginTop: 28 }}>{other.map((g, i) => <li key={i}>{g}</li>)}</ul>}
  </>);
}
