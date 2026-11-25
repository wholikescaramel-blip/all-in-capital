import { loadDB } from "@/lib/store";
import type { CSSProperties } from "react";
import { inkOn } from "@/lib/brand";

export const dynamic = "force-dynamic";

const brandVars = (c?: string) => (c ? { "--brand": c, "--on": inkOn(c) } : {}) as CSSProperties;
const dom = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

export default async function Portfolio({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  const db = await loadDB();
  const all = db.fund.profiles ?? [];
  const cats = [...all.reduce((m, p) => m.set(p.category, (m.get(p.category) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const list = c ? all.filter((p) => p.category === c) : all;
  const withSite = all.filter((p) => p.website).length;
  return (<>
    <h1 className="display"><span className="shimmer">Portfolio</span></h1>
    <div className="status">
      <span><b>{db.fund.portfolio.length}</b>companies</span><span className="sep">&middot;</span>
      <span className="good"><b>{withSite}</b>sites read</span>
      {cats[0] && <><span className="sep">&middot;</span><span><b>{cats[0][1]}</b>{cats[0][0]}</span></>}
    </div>
    <p className="muted" style={{ marginTop: 12 }}>Read from the fund&apos;s portfolio page and each company&apos;s own site. New applications are checked against all of them.</p>

    {all.length === 0 && <div className="card" style={{ marginTop: 20 }}>No profiles yet. Run <code>npm run refresh-portfolio</code> to read each company&apos;s site.</div>}
    {all.length > 0 && <div className="wall" aria-label="Portfolio companies">
      {all.map((p) => <a key={p.key} href={`#${p.key}`} className={`tile ${p.color ? "" : "plain"}`} style={brandVars(p.color)} title={p.name}>{p.name.replace(/^the\s+/i, "").slice(0, 2)}</a>)}
    </div>}
    {all.length > 0 && <div className="chips" style={{ marginTop: 18 }}>
      <a href="/portfolio" className={`chip ${!c ? "on" : ""}`}>All {all.length}</a>
      {cats.map(([k, n]) => <a key={k} href={`/portfolio?c=${encodeURIComponent(k)}`} className={`chip ${c === k ? "on" : ""}`}>{k} {n}</a>)}
    </div>}

    <div className="pcards">
      {list.map((p) => (
        <article key={p.key} id={p.key} className={`card pcard ${p.color ? "branded" : ""}`} style={brandVars(p.color)}>
          <div className="phead">
            <span className="logo">{p.name.replace(/^the\s+/i, "").slice(0, 1)}</span>
            <div><h4>{p.name}</h4><span className="cat">{p.category}</span></div>
          </div>
          <p>{p.description || <span className="muted">No description could be read.</span>}</p>
          {p.what && <p className="muted">{p.what}</p>}
          <div className="facts">
            {p.customer !== "unclear" && <span>{p.customer}</span>}
            {p.hq && <span>{p.hq}</span>}
            {p.founders.length > 0 && <span>{p.founders.join(", ")}</span>}
            {p.tags.map((t) => <span key={t}>{t}</span>)}
          </div>
          <div className="foot">
            {p.website ? <a className="inline" href={p.website} target="_blank" rel="noreferrer">{dom(p.website)}</a> : <span className="muted">no website read</span>}
            <span className="muted"> &middot; <a className="inline" href={p.fund_page_url} target="_blank" rel="noreferrer">fund page</a>{p.description_source === "fund page" ? ", description from the fund page" : ""}{p.website_source === "name match" ? ", site found by name, check it" : ""}</span>
          </div>
        </article>
      ))}
    </div>
  </>);
}
