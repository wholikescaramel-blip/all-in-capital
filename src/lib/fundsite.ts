import { z } from "zod";
import { Fetcher, scrapeSite, snippetInText, type Report, type Target } from "./scraper";
import { completeJSON, hasLLM } from "./llm";
import { PROCESS } from "../config/process";

// Fund-page scraper: reads the fund's OWN site (thesis + portfolio) directly, so the conflict check does not rest on a
// search engine paraphrasing a list. Every company and the thesis must be quotable from the fetched page text.
const TARGETS: Target[] = [
  { name: "portfolio", paths: ["/portfolio", "/companies", "/investments", "/our-companies"], linkRegex: /portfolio|companies|investments|our[- ]companies/i },
  { name: "thesis", paths: ["/about", "/thesis", "/philosophy", "/what-we-do", "/approach"], linkRegex: /\/about|\babout\b|thesis|philosophy|what[- ]we[- ]do|approach/i },
];

export type FundSite = {
  thesis_text: string; thesis_url?: string;
  portfolio: { name: string; description: string; source: string }[];
  sources: { url: string; fetched_at: string; note: string }[];
  gaps: string[]; report: Report;
};

const NOT_NAMES = /^(home|about|about us|contact|contact us|portfolio|companies|team|blog|news|careers|jobs|apply|apply here|apply now|login|sign in|read more|learn more|view all|view website|visit website|website|menu|twitter|linkedin|instagram|facebook|medium|youtube|logo|image|arrow|allstars|all in|all in capital|founder stories|founders|privacy|terms)$/i;

// Same company written two ways ("Super K" / "SuperK", "Spiti" / "Spiti.xyz", "GIVA" / "Giva").
export const nameKey = (s: string) => s.toLowerCase().replace(/\.(xyz|ai|io|com|in|co)$/, "").replace(/^the /,"").replace(/[^a-z0-9]/g,"");

export async function scrapeFundSite(urls: string[] = PROCESS.fund_public_urls): Promise<FundSite> {
  const gaps: string[] = [];
  const sources: FundSite["sources"] = [];
  const now = new Date().toISOString();
  const fetcher = new Fetcher();
  let best: Report | null = null;
  for (const u of urls) {
    const r = await scrapeSite(u, fetcher, TARGETS);
    if (!best || Object.keys(r.pages).length > Object.keys(best.pages).length) best = r;
    if (r.pages.portfolio) break;
  }
  const report = best!;
  for (const [name, p] of Object.entries(report.pages)) sources.push({ url: p.url, fetched_at: now, note: `${name}${p.fromCache ? " (cache)" : ""}` });
  // 404s on guessed paths are expected (we try several); only report them if the target ends up unread (handled below).
  for (const f of report.failed.filter((f) => !/HTTP 404/.test(f.reason))) gaps.push(`Fund site fetch failed: ${f.url}: ${f.reason}`);
  for (const s of report.skipped.filter((s) => !/fetch cap|time budget/.test(s.reason))) gaps.push(`Fund site page not fetched: ${s.url}: ${s.reason}`);
  if (report.capHit || report.timeHit) gaps.push("Fund site scrape stopped early (fetch cap or time budget).");

  const pf = report.pages.portfolio;
  const thesisPage = report.pages.thesis ?? report.pages.home;
  let portfolio: FundSite["portfolio"] = [];

  if (!Object.keys(report.pages).length) {
    gaps.push(`Fund site unreachable or blocked (${urls.join(", ")}). Thesis and portfolio not read from the source; set FUND_URL to the right address.`);
  } else if (!pf) {
    gaps.push("Fund site reached, but no portfolio page was found or readable (it may be JavaScript-rendered). Portfolio not confirmed from the source.");
  } else {
    if (hasLLM()) {
      try {
        const r = await completeJSON({
          system: "Extract the investor's portfolio companies from the page text. Only companies literally present in the text. Descriptions must come from the text; use empty string if none.",
          user: `PAGE TEXT:\n${pf.text.slice(0, 14000)}\n\nCompany-like image alt texts: ${pf.images.join(" | ")}\nReturn {"companies":[{"name","description"}]}`,
          schema: z.object({ companies: z.array(z.object({ name: z.string(), description: z.string() })) }), model: "fast", max_tokens: 4000,
        });
        // Gate: the name must be quotable from the page text or alt text.
        const hay = pf.text + "\n" + pf.images.join("\n");
        portfolio = r.companies.filter((c) => snippetInText(c.name, hay)).map((c) => ({ name: c.name.trim(), description: c.description, source: pf.url }));
        const dropped = r.companies.length - portfolio.length;
        if (dropped) gaps.push(`${dropped} extracted portfolio name(s) dropped because they were not found in the page text.`);
      } catch (e) { gaps.push(`Portfolio extraction by model failed (${String(e).slice(0, 100)}); fell back to link/alt text.`); }
    }
    if (!portfolio.length) {
      // Offline / fallback: short capitalised link texts and logo alts on the portfolio page. Low confidence; flagged as such.
      const seen = new Map<string, string>();
      for (const t of [...pf.links.flatMap((l) => l.text.split(/\n|,/)), ...pf.images]) {
        const s = t.trim();
        if (s.length < 2 || s.length > 40 || !/^[A-Z0-9]/.test(s) || NOT_NAMES.test(s) || s.split(/\s+/).length > 3 || /stor(y|ies)|about|invest|apply|view |read |learn |jobs/i.test(s)) continue;
        const k = nameKey(s);
        if (k && !seen.has(k)) seen.set(k, s);
      }
      portfolio = [...seen.values()].map((name) => ({ name, description: "", source: pf.url }));
      if (portfolio.length) gaps.push("Portfolio names were read from links and logos, without descriptions, so product-overlap checks are weaker.");
    }
    if (!portfolio.length) gaps.push("The portfolio page loaded but no company names could be read from it.");
  }

  let thesis_text = "", thesis_url: string | undefined;
  if (thesisPage) {
    thesis_url = thesisPage.url;
    if (!report.pages.thesis) gaps.push("The fund's site has no thesis page, so the thesis comes from its homepage.");
    if (hasLLM()) {
      try {
        const r = await completeJSON({
          system: "Quote the investor's stated investment thesis (sectors, stage, what they look for) from the page text. Copy sentences verbatim; do not paraphrase. Empty string if the page states none.",
          user: `PAGE TEXT:\n${thesisPage.text.slice(0, 10000)}\nReturn {"thesis_quote": string}`,
          schema: z.object({ thesis_quote: z.string() }), model: "fast",
        });
        if (r.thesis_quote && snippetInText(r.thesis_quote.slice(0, 80), thesisPage.text)) thesis_text = r.thesis_quote;
        else if (r.thesis_quote) gaps.push("Thesis text from the model could not be matched to the page, so it was discarded.");
      } catch { /* leave empty */ }
    }
    if (!thesis_text) {
      thesis_text = thesisPage.text.split("\n").filter((l) => /invest|pre-seed|seed|founder|sector|fintech|deeptech|consumer/i.test(l)).slice(0, 6).join(" ").slice(0, 800);
      if (!thesis_text) gaps.push("No thesis wording found on the fund's pages.");
    }
  } else gaps.push("No fund page with thesis wording was readable.");

  return { thesis_text, thesis_url, portfolio, sources, gaps, report };
}
