import { z } from "zod";
import type { Application, DB, Evidence, Gap } from "./schemas";
import { completeJSON, hasLLM, webResearch } from "./llm";
import { nowISO, uid } from "./store";
import { PROCESS } from "../config/process";
import { scrapeFundSite, nameKey } from "./fundsite";
import { QuotaError } from "./llm";

// Seed portfolio from the memos and partner notes. This is PARTIAL by construction: the case says the full public list
// is not given. The research step tries to fetch the real one; if it can't, a gap is logged and conflict checks warn.
export const SEED_PORTFOLIO = [
  { name: "MeetRecord", description: "Meeting notes and call summary / recording software", source: "partner notes (meeting 4)" },
  { name: "The ePlane Company", description: "Electric vertical take-off and landing aircraft and UAVs for intracity travel", source: "deal memo 1" },
  { name: "Unbox Robotics", description: "AI-assisted robotic package sorting for warehouses and fulfilment centres", source: "deal memo 3" },
  { name: "Wint Wealth", description: "Retail access to bonds and fixed income products in India", source: "deal memo 5" },
  { name: "Giva", description: "Online-first silver and fine jewellery D2C brand", source: "deal memo 7" },
  { name: "SuperK", description: "Tech-enabled grocery retail network rebranding small-town neighbourhood stores", source: "deal memo 9" },
  { name: "Jai Kisan", description: "Rural and agri credit fintech for farmers and rural households", source: "deal memo 11" },
];
export const WRITTEN_THESIS = "Public line (per partner notes): fintech, deeptech, consumer tech, consumer brands. Pre-seed cheques; the founder is treated as a primary variable. Recent backing also leans to commerce infrastructure (small-town retail, distribution) and businesses with real repeat.";

const FundResearch = z.object({
  thesis_text: z.string(),
  portfolio: z.array(z.object({ name: z.string(), description: z.string() })),
});

export async function researchFund(db: DB) {
  const gaps: string[] = [];
  db.fund.researched_at = nowISO();
  // Start from what is already stored, so a refresh that can't read descriptions this time does not wipe the ones we have.
  const byName = new Map<string, { name: string; description: string; source: string }>();
  for (const p of [...SEED_PORTFOLIO, ...(db.fund.portfolio ?? [])]) {
    const k = nameKey(p.name), prev = byName.get(k);
    byName.set(k, { ...p, name: prev?.name ?? p.name, description: p.description || prev?.description || "" });
  }
  let thesis = "", thesisSource = "";

  // 1. Read the fund's own site directly (polite scraper). Primary source for thesis and portfolio.
  if (process.env.SKIP_FUND_SCRAPE) {
    gaps.push("Fund site scrape skipped (SKIP_FUND_SCRAPE set).");
  } else {
    const site = await scrapeFundSite();
    db.fund.sources = site.sources;
    gaps.push(...site.gaps);
    for (const p of site.portfolio) byName.set(nameKey(p.name), { name: byName.get(nameKey(p.name))?.name ?? p.name, description: p.description || byName.get(nameKey(p.name))?.description || "", source: `fund website: ${p.source}` });
    if (site.thesis_text) { thesis = site.thesis_text; thesisSource = `fund website: ${site.thesis_url}`; }
  }

  // 2. Grounded web search as a complement (finds companies the site omits, and fills the thesis if the site had none).
  if (hasLLM()) {
    try {
      const w = await webResearch(
        `Find ${PROCESS.fund_name}'s (India pre-seed venture fund) stated investment thesis and its public portfolio companies with one-line descriptions. Quote the thesis. Be explicit about anything you could not find.`, 6);
      const r = await completeJSON({
        system: "Extract only what the research text states. Do not add companies from memory.",
        user: `${w.text}

Return {"thesis_text": string, "portfolio":[{"name","description"}]}`,
        schema: FundResearch, model: "fast",
      });
      for (const p of r.portfolio) if (!byName.has(nameKey(p.name))) byName.set(nameKey(p.name), { name: p.name, description: p.description, source: "web search (unverified against fund site)" });
      if (!thesis && r.thesis_text) { thesis = r.thesis_text; thesisSource = w.sources.map((s) => s.url).join(", ") || "web search"; }
      if (!w.sources.length) gaps.push("Web search returned no sources for the fund's thesis or portfolio.");
    } catch (e) { if (!(e instanceof QuotaError)) gaps.push("Web search could not be used this run."); } // the site read above is the main source; search only adds to it
  } else gaps.push("No web search in this run.");

  if (!thesis) { thesis = WRITTEN_THESIS; thesisSource = "the partner notes"; gaps.push("The fund's public thesis couldn't be confirmed, so this uses the line in the partner notes."); }
  else if (!/fintech|deeptech|consumer/i.test(thesis)) { thesis += " Sectors, per the partner notes: fintech, deeptech, consumer tech and consumer brands, and lately commerce infrastructure."; thesisSource = "the fund's website and the partner notes"; }
  db.fund.thesis_text = thesis; db.fund.thesis_source = thesisSource;
  db.fund.portfolio = [...byName.values()];
  const fromSource = db.fund.portfolio.filter((p) => p.source.startsWith("fund website")).length;
  if (!fromSource) gaps.push("Couldn't read the portfolio from the fund's site. Only the companies named in the memos are checked for overlap.");
  db.fund.gaps = gaps;
}

const ClaimOut = z.object({ claims: z.array(z.object({ claim: z.string(), source_type: z.enum(["deck", "form"]), quote: z.string() })) });

// Deterministic base evidence: every form field and every substantive deck paragraph becomes an Evidence row.
export function baseEvidence(app: Application): Evidence[] {
  const t = nowISO();
  const ev: Evidence[] = [];
  for (const [k, v] of Object.entries(app.form_fields)) {
    if (!v) continue;
    ev.push({ id: uid("ev"), app_id: app.id, claim: `${k}: ${v}`.slice(0, 400), source_type: "form", url_or_ref: `form:${k}`, retrieved_at: t, quote_or_snippet: v.slice(0, 600) });
  }
  let chunks = app.deck_text.split(/\r?\n\s*\r?\n/);
  if (chunks.length < 4) chunks = app.deck_text.split(/\r?\n+/); // PDF text may use single line breaks only
  const paras = chunks.map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.length >= 20);
  paras.forEach((p, i) => ev.push({ id: uid("ev"), app_id: app.id, claim: p.slice(0, 300), source_type: app.kind === "domain" ? "scrape" : "deck", url_or_ref: app.kind === "domain" ? `${app.website ?? "website"}#p${i + 1}` : `deck:p${i + 1}`, retrieved_at: t, quote_or_snippet: p.slice(0, 600) }));
  return ev;
}

const OUTCOME_RE = /(raised|series [a-d]|seed round|acquired|shut down|all in capital|funding round|valuation of)/i;

export async function researchApplication(db: DB, app: Application): Promise<{ evidence: Evidence[]; gaps: Gap[] }> {
  const evidence = baseEvidence(app);
  const gaps: Gap[] = [];
  const t = nowISO();
  const cutoff = app.research_cutoff ? Date.parse(app.research_cutoff) : null;

  if (!hasLLM()) {
    gaps.push({
      id: uid("gap"), app_id: app.id, criterion: "research",
      what_missing: "Public research (founder backgrounds, website, news, competitors, regulatory status) was not run: no web access in this run.",
      tried: ["offline mode"], cost_to_score: "Founder claims and traction are unverified; every score rests on the applicant's own words. Confidence capped at low.",
    });
    return { evidence, gaps };
  }

  const founderNames = app.founders.map((f) => f.name).join(", ") || "the founders";
  const cutoffNote = cutoff ? ` IMPORTANT: ignore anything published after ${app.research_cutoff}; do not use funding outcomes or later news.` : "";
  const queries: { label: string; criterion: string; q: string }[] = [
    { label: "founders", criterion: "risk_ownership", q: `Verify the professional background of ${founderNames} (${app.company}, ${app.one_liner}). Cite sources. Say clearly what you could NOT confirm.${cutoffNote}` },
    { label: "company", criterion: "customer_traction", q: `Find ${app.company}'s website, product, customers and any press or news. Cite sources; state what could not be found.${cutoffNote}` },
    { label: "competitors", criterion: "structure_capital", q: `Who are the main competitors of ${app.company} (${app.one_liner}) in India and how well funded are they?${cutoffNote}` },
    { label: "regulation", criterion: "regulatory_dependence", q: `What is the regulatory status/exposure for a business like ${app.company} (${app.one_liner}) in India (licences, RBI/SEBI/DGCA etc. as relevant)? Pending rule changes?${cutoffNote}` },
  ];
  let searchDown = false;
  for (const q of queries) {
    try {
      const r = await webResearch(q.q, 4);
      const sources = r.sources.filter((s) => !/allincapital/i.test(s.url));
      if (!sources.length) {
        gaps.push({ id: uid("gap"), app_id: app.id, criterion: q.criterion, what_missing: `No public sources found for ${q.label}.`, tried: [q.q], cost_to_score: "Claim stays unverified; criterion scored on applicant's own words only." });
        continue;
      }
      const summaryTxt = r.text.slice(0, 700);
      const suspicious = !!cutoff && OUTCOME_RE.test(r.text);
      evidence.push({ id: uid("ev"), app_id: app.id, claim: `[${q.label}] ${summaryTxt}`, source_type: "web", url_or_ref: sources.map((s) => s.url).join(" | "), retrieved_at: t, quote_or_snippet: sources.map((s) => s.snippet).filter(Boolean).join(" … ").slice(0, 600) || summaryTxt, post_cutoff_suspected: suspicious || undefined });
      if (/could not|couldn't|unable to (find|confirm)|no (public )?(information|record)/i.test(r.text)) {
        gaps.push({ id: uid("gap"), app_id: app.id, criterion: q.criterion, what_missing: `Partial: research on ${q.label} reported items it could not confirm.`, tried: [q.q], cost_to_score: "Some claims in this area remain unverified." });
      }
    } catch (e) {
      if (e instanceof QuotaError) { searchDown = true; break; } // our search tool is down: that is not the company's fault, so no criterion is marked down for it
      gaps.push({ id: uid("gap"), app_id: app.id, criterion: q.criterion, what_missing: `Web research failed for ${q.label}: ${String(e).slice(0, 120)}`, tried: [q.q], cost_to_score: "Area unverified." });
    }
  }

  if (searchDown) gaps.push({ id: uid("gap"), app_id: app.id, criterion: "research", what_missing: "Web search was not available, so founders, competitors and regulation were not looked up.", tried: ["Google search"], cost_to_score: "These scores rest on the application alone. Treat them as lower confidence." });

  // Extract verified claims from the deck+form. A quote must literally appear in the source text or the claim is dropped.
  try {
    const r = await completeJSON({
      system: "Extract atomic factual claims (numbers, customers, regulatory status, founder behaviour) from a startup application. Each claim needs an exact verbatim quote from the text.",
      user: `DECK:\n${app.deck_text}\n\nFORM:\n${JSON.stringify(app.form_fields)}\n\nReturn {"claims":[{"claim","source_type":"deck"|"form","quote"}]}, max 25.`,
      schema: ClaimOut, model: "fast",
    });
    const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
    const hayDeck = norm(app.deck_text);
    const hayForm = norm(JSON.stringify(app.form_fields));
    for (const c of r.claims) {
      const q = norm(c.quote);
      if (q.length < 8 || !(hayDeck.includes(q) || hayForm.includes(q))) continue;
      evidence.push({ id: uid("ev"), app_id: app.id, claim: c.claim, source_type: c.source_type, url_or_ref: c.source_type === "deck" ? "deck" : "form", retrieved_at: t, quote_or_snippet: c.quote });
    }
  } catch { /* base evidence already covers the text */ }

  return { evidence, gaps };
}
