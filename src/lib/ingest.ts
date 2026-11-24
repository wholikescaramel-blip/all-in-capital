import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Application, Sector } from "./schemas";
import { SECTOR_KEYWORDS } from "../config/rubric";
import { completeJSON, hasLLM } from "./llm";
import { DATA_DIR, nowISO } from "./store";

// Labels the public application form uses. Anything not matching is treated as a continuation of the previous field,
// and the raw text is always kept so nothing is lost if a label is unfamiliar.
const LABELS = [
  "Company name", "Website", "Location", "Incorporated", "One-line description", "Sector (as selected)", "Stage (as selected)",
  "Team size", "Founder 1", "Founder 2", "Founder 3", "Time commitment", "Prior startup experience", "Equity split",
  "What have you built?", "Active customers", "Revenue / GMV", "Growth", "Repeat behaviour", "Customer acquisition", "Unit economics",
  "How is credit funded?", "Credit book size", "Defaults to date", "Regulatory status", "Who else is doing this?", "Why will you win?",
  "Amount raising", "Valuation expectation", "Existing investors", "Use of funds", "Other investors in conversation",
  "How did you hear about us?", "Anything else we should know?",
];

export function parseForm(rawText: string): Record<string, string> {
  // PDF text often has no blank line between fields: start a new paragraph at every known label.
  const escapeRe = (l: string) => l.replace(/[.*+?^$(){}|[\]\\\/]/g, "\\$&");
  const labelRe = new RegExp("(^|\\n)[ \\t]*(" + LABELS.map(escapeRe).join("|") + ")(?=[ \\t?:]|$)", "g");
  const text = rawText.replace(labelRe, "\n\n$2");
  const paras = text.split(/\r?\n\s*\r?\n/).map((p) => p.replace(/\s*\r?\n\s*/g, " ").trim()).filter(Boolean);
  const out: Record<string, string> = {};
  let cur: string | null = null;
  for (const p of paras) {
    const label = LABELS.find((l) => p === l || p.startsWith(l + " ") || p.startsWith(l + "?"));
    if (label) {
      cur = label;
      out[cur] = p.slice(label.length).trim();
    } else if (cur) {
      out[cur] = (out[cur] + " " + p).trim();
    }
  }
  return out;
}

export function normaliseSector(selected: string, oneLiner: string, deck: string): z.infer<typeof Sector> {
  const s = selected.toLowerCase();
  if (/deep/.test(s)) return "deeptech";
  if (/fintech/.test(s)) return "fintech";
  if (/brand/.test(s)) return "consumer_brand";
  if (/consumer/.test(s)) return "consumer_tech";
  const hay = (oneLiner + " " + deck).toLowerCase();
  for (const [k, words] of Object.entries(SECTOR_KEYWORDS)) if (words.some((w) => hay.includes(w))) return k as z.infer<typeof Sector>;
  return "other";
}

const FounderLLM = z.object({ founders: z.array(z.object({ name: z.string(), role: z.string().optional(), background: z.string().optional() })) });

export async function ingestPair(company: string, deckText: string, formText: string): Promise<Application> {
  const form = parseForm(formText);
  const name = (form["Company name"] || company).replace(/\s*\(.*\)\s*$/, "").trim();
  const oneLiner = form["One-line description"] ?? "";
  const heard = (form["How did you hear about us?"] ?? "").toLowerCase();
  const source = /introduc|referr|warm|portfolio|friend/.test(heard) ? "warm_intro" : "form";

  let founders: Application["founders"] = [];
  for (const k of ["Founder 1", "Founder 2", "Founder 3"]) {
    const v = form[k];
    if (!v) continue;
    const m = v.match(/^([A-Z][\w.'-]+(?:\s[A-Z][\w.'-]+){0,3}),\s*([^.]+)\.?\s*(.*)$/);
    founders.push(m ? { name: m[1], role: m[2], background: m[3] } : { name: v.split(",")[0], background: v });
  }
  // Deck-only founders (deck may name people the form omits, or vice versa): let the model reconcile when available.
  if (hasLLM() && founders.length === 0) { // only when the form parser found none: saves a call per application on the free tier
    try {
      const r = await completeJSON({
        system: "Extract founders from a startup deck and application form. Only include people actually named. Do not invent backgrounds.",
        user: `DECK:\n${deckText}\n\nFORM:\n${formText}\n\nReturn {"founders":[{"name","role","background"}]}`,
        schema: FounderLLM, model: "fast",
      });
      if (r.founders.length) founders = r.founders;
    } catch { /* keep regex founders */ }
  }

  return Application.parse({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    company: name,
    sector_selected: form["Sector (as selected)"] ?? "",
    sector: normaliseSector(form["Sector (as selected)"] ?? "", oneLiner, deckText),
    stage: form["Stage (as selected)"] ?? "Pre-seed",
    source,
    founders,
    one_liner: oneLiner,
    deck_text: deckText,
    form_fields: form,
    applied_at: nowISO(),
  });
}

export async function ingestDirectory(dir = path.join(DATA_DIR, "applications")): Promise<Application[]> {
  const files = fs.readdirSync(dir);
  const companies = [...new Set(files.map((f) => f.split("_")[0]))];
  const apps: Application[] = [];
  for (const c of companies) {
    const deck = files.find((f) => f.startsWith(c + "_deck"));
    const form = files.find((f) => f.startsWith(c + "_form"));
    if (!deck || !form) { console.warn(`Skipping ${c}: needs both deck and form`); continue; }
    apps.push(await ingestPair(c, fs.readFileSync(path.join(dir, deck), "utf8"), fs.readFileSync(path.join(dir, form), "utf8")));
  }
  return apps;
}
