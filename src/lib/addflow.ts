import { z } from "zod";
import type { Application, DB } from "./schemas";
import { Application as ApplicationSchema } from "./schemas";
import { ingestPair, normaliseSector } from "./ingest";
import { Fetcher, scrapeSite, type Target } from "./scraper";
import { completeJSON, hasLLM } from "./llm";
import { researchApplication } from "./research";
import { conflictCheck } from "./conflict";
import { finalise, scoreApplication } from "./scorer";
import { ensureFund } from "./pipeline";
import { nowISO, transition } from "./store";

const S = z.coerce.string();
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export type UploadedFile = { name: string; text: string };
export type AddResult = { created: { id: string; company: string }[]; skipped: string[] };

// ---------- 1. Uploaded files: pair "<Company>_Deck" with "<Company>_Form" ----------
const companyOf = (file: string) => file.replace(/\.[a-z0-9]+$/i, "").replace(/[_\- ]*(deck|form response|form|application)$/i, "").replace(/[_]+/g, " ").trim();
const roleOf = (file: string, text: string): "deck" | "form" => /deck|slides|pitch/i.test(file) ? "deck" : /form|response|application/i.test(file) || /Company name|Sector \(as selected\)/.test(text) ? "form" : "deck";

export async function createFromFiles(db: DB, files: UploadedFile[]): Promise<AddResult> {
  const groups = new Map<string, { company: string; deck: string; form: string }>();
  for (const f of files) {
    const company = companyOf(f.name), k = key(company);
    if (!k) continue;
    const g = groups.get(k) ?? { company, deck: "", form: "" };
    if (roleOf(f.name, f.text) === "form") g.form += (g.form ? "\n\n" : "") + f.text; else g.deck += (g.deck ? "\n\n" : "") + f.text;
    groups.set(k, g);
  }
  const out: AddResult = { created: [], skipped: [] };
  for (const g of groups.values()) {
    const app = await ingestPair(g.company, g.deck, g.form);
    if (db.applications[app.id]) { out.skipped.push(`${app.company} (already added)`); continue; }
    register(db, app, "uploaded files");
    out.created.push({ id: app.id, company: app.company });
  }
  return out;
}

function register(db: DB, app: Application, how: string) {
  db.applications[app.id] = app;
  transition(db, app.id, "INGESTED", "intake", how);
  db.pending[app.id] = { stage: 0 };
}

// ---------- 2. A company name or website ----------
// Server-side fetches of user-typed addresses must never reach private networks.
export function safeHost(input: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    const h = u.hostname.toLowerCase();
    if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || /(^|\.)(localhost|local|internal|lan|home|corp)$/.test(h)) return null;
    return h;
  } catch { return null; }
}

// Anything with a scheme, an IP, or a dotted host counts as an address (and goes through safeHost); otherwise it's a plain name.
const looksLikeSite = (s: string) => /^https?:\/\//i.test(s) || /^[\d.:]+(\/.*)?$/.test(s) || (!/\s/.test(s) && /\.[a-z0-9-]{2,}(\/|$)/i.test(s));
const ABOUT: Target[] = [
  { name: "about", paths: ["/about", "/about-us", "/company", "/team"], linkRegex: /about|team|company|who[- ]we/i },
  { name: "product", paths: ["/product", "/products", "/solutions"], linkRegex: /product|solution|platform|how[- ]it[- ]works/i },
];

export async function createFromName(db: DB, input: string, email?: string): Promise<AddResult> {
  const raw = input.trim();
  if (!raw) throw new Error("Type a company name or website");
  const out: AddResult = { created: [], skipped: [] };
  const site = looksLikeSite(raw) ? raw : "";
  let host: string | null = null, text = "", title = "";
  if (site) {
    host = safeHost(site);
    if (!host) throw new Error("That address can't be fetched. Use a public website, like example.com.");
    const f = new Fetcher({ ...(await import("./scraper")).defaultScrapeConfig(), cachePath: undefined, maxFetches: 5, timeBudgetMs: 25000, delayMs: 1000 });
    const rep = await scrapeSite(host, f, ABOUT);
    text = Object.values(rep.pages).map((p) => p.text).join("\n\n").slice(0, 9000);
    title = rep.pages.home?.html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
  }

  let company = host ? (title.split(/[|\-–:]/)[0].trim() || host.replace(/^www\./, "").split(".")[0]) : raw;
  let one_liner = text.split("\n").find((l) => l.length > 40 && l.length < 220) ?? "";
  let sectorGuess = "other";
  let founders: Application["founders"] = [];
  if (text && hasLLM()) {
    try {
      const r = await completeJSON({
        system: "From a company's own website text, extract only what is stated. Never invent people or facts. Use an empty value when unknown.",
        user: `WEBSITE TEXT:\n${text}\n\nReturn {"company": string, "one_liner": string (what it does, under 25 words), "sector": "fintech"|"deeptech"|"consumer_tech"|"consumer_brand"|"other", "founders": [{"name": string, "role": string}]}`,
        schema: z.object({ company: S, one_liner: S, sector: S, founders: z.array(z.object({ name: S, role: S.optional() })).default([]) }), model: "fast",
      });
      company = r.company || company; one_liner = r.one_liner || one_liner; sectorGuess = r.sector; founders = r.founders.filter((x) => x.name);
    } catch { /* keep scraped basics */ }
  }
  const id = slug(company);
  if (!id) throw new Error("Could not work out a company name");
  if (db.applications[id]) { out.skipped.push(`${company} (already added)`); return out; }

  const app = ApplicationSchema.parse({
    id, company, sector_selected: "", sector: normaliseSector(sectorGuess, one_liner, text), stage: "Unknown", source: "form", founders, one_liner,
    deck_text: text, form_fields: { "Company name": company, ...(host ? { Website: host } : {}), ...(one_liner ? { "One-line description": one_liner } : {}) },
    applied_at: nowISO(), kind: "domain", website: host ?? undefined, contact_email: email?.trim() || undefined,
  });
  register(db, app, host ? `added from ${host}` : "added by name only");
  out.created.push({ id, company });
  return out;
}

// ---------- 3. Staged processing: each step stays inside a serverless time limit ----------
export const STAGES = ["Reading the fund's site", "Researching the company", "Checking the portfolio for overlap", "Scoring"];

export async function advance(db: DB, id: string): Promise<{ done: boolean; stage: number; label: string }> {
  const p = db.pending[id], app = db.applications[id];
  if (!p || !app) return { done: true, stage: STAGES.length, label: "Done" };
  p.error = undefined;
  if (p.stage === 0) {
    await ensureFund(db);
  } else if (p.stage === 1) {
    db.evidence = db.evidence.filter((e) => e.app_id !== id);
    db.gaps = db.gaps.filter((g) => g.app_id !== id);
    const r = await researchApplication(db, app);
    db.evidence.push(...r.evidence); db.gaps.push(...r.gaps);
    if (db.states[id] === "INGESTED") transition(db, id, "RESEARCHED", "research", `${r.evidence.length} evidence, ${r.gaps.length} gaps`);
  } else if (p.stage === 2) {
    p.flags = await conflictCheck(db, app);
  } else if (p.stage === 3) {
    const ev = db.evidence.filter((e) => e.app_id === id);
    const gaps = db.gaps.filter((g) => g.app_id === id);
    const { assessment, gaps: more } = await scoreApplication(db, app, ev, gaps);
    db.gaps.push(...more);
    assessment.conflict_flags = p.flags ?? [];
    db.assessments[id] = finalise(assessment, db.gaps.filter((g) => g.app_id === id));
    transition(db, id, "SCORED", "scorer", `total ${assessment.total_score}`);
    transition(db, id, "AWAITING_REVIEW", "system");
    delete db.pending[id];
    return { done: true, stage: STAGES.length, label: "Done" };
  }
  p.stage += 1;
  return { done: false, stage: p.stage, label: STAGES[p.stage] ?? "Scoring" };
}
