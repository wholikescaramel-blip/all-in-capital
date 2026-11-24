import { z } from "zod";
import type { Application, Assessment, CriterionScore, DB, Evidence, Gap } from "./schemas";
import { CriterionScore as CriterionScoreSchema } from "./schemas";
import { CRITERIA, GAP_PENALTY, GROUP_WEIGHTS, NO_EVIDENCE_CAP, type Criterion } from "../config/rubric";
import { completeJSON, hasLLM, lastModelUsed } from "./llm";
import { PROCESS } from "../config/process";
import { retrieveCorrections, type Retrieved } from "./corrections";
import { nowISO, uid } from "./store";
import { recommend } from "./recommend";

const clamp = (n: number, lo = 0, hi = 10) => Math.max(lo, Math.min(hi, n));

// Models drift on types (numbers for strings, bare strings for objects, "High" for "high"). Accept the sensible variants and
// normalise them, so one stray type does not discard a whole scoring call. Content rules (ids must exist, etc.) are enforced later.
const S = z.coerce.string();
const NOTE = "Not stated by the scorer.";
const Missing = z.union([
  z.string().transform((what) => ({ what, cost_to_score: NOTE })),
  z.object({ what: S, cost_to_score: S.optional() }).transform((m) => ({ what: m.what, cost_to_score: m.cost_to_score ?? NOTE })),
]);
const LLMScore = z.object({
  criteria: z.array(z.object({
    criterion: S,
    raw_score: z.coerce.number(),
    evidence_ids: z.array(S).default([]),
    missing: z.array(Missing).default([]),
    confidence: z.string().transform((c) => c.toLowerCase()).pipe(z.enum(["low", "medium", "high"])),
    rationale: S,
    corrections_applied: z.array(S).optional(),
  })),
  thesis_basis: z.string().transform((c) => c.toLowerCase()).pipe(z.enum(["written", "observed"])),
  basis_reason: S,
  case_for: z.array(S).default([]),
  case_against: z.array(S).default([]),
});

// ---- Offline heuristic (clearly labelled; used only when no API key). Evidence-only, keyword based. ----
const SIGNALS: Record<string, { pos: RegExp; neg?: RegExp }> = {
  risk_ownership: { pos: /first[- ]loss|we (own|bear|take)|credit (hire|lead|head)|compliance|licen[sc]e|risk (team|model)|underwrit/i, neg: /partner (handles|takes)|nbfc.{0,20}problem|bank handles|solved once/i },
  numeric_fluency: { pos: /repeat|\bcac\b|margin|retention|cohort|payback|ltv|\d+%/i },
  field_first: { pos: /field (agent|team|visit)|visited|store visit|door[- ]to[- ]door|onboard(ed)? (them )?(in person)|interview(ed)?|spent (weeks|months)|manual/i },
  customer_traction: { pos: /customers?|retailers|clients?|pilot|revenue|gmv|paying|workers enabled/i, neg: /no (signed )?customer|prototype only|waitlist/i },
  unit_economics: { pos: /contribution|repeat|margin|payback|ltv/i, neg: /negative|burn|loss[- ]making|discount/i },
  structure_capital: { pos: /asset[- ]light|software|marketplace/i, neg: /dark store|inventory|fleet|manufactur|capex|working capital|credit book|hardware/i },
  regulatory_dependence: { pos: /licen[sc]e (held|obtained)|registered|approved/i, neg: /not registered|awaiting|pending|rbi|sebi|nbfc|dgca|regulat/i },
  candour: { pos: /weakness|challenge|we (failed|learned|struggle)|lesson|honest|risk we/i },
  sector_thesis_fit: { pos: /./ },
};

function offlineScore(app: Application, c: Criterion, ev: Evidence[]): { raw: number; ids: string[]; rationale: string; missing: string[] } {
  if (c.key === "sector_thesis_fit") {
    const fits = app.sector !== "other";
    return { raw: fits ? 6.5 : 3, ids: ev.filter((e) => e.url_or_ref.startsWith("form:Sector") || e.url_or_ref.startsWith("form:One-line")).map((e) => e.id), rationale: `Offline heuristic: applicant selected "${app.sector_selected}", normalised to ${app.sector}.`, missing: [] };
  }
  const s = SIGNALS[c.key];
  const pos = ev.filter((e) => s.pos.test(e.quote_or_snippet));
  const neg = s.neg ? ev.filter((e) => s.neg!.test(e.quote_or_snippet)) : [];
  const ids = [...new Set([...pos.slice(0, 3), ...neg.slice(0, 2)].map((e) => e.id))];
  const raw = clamp(3.5 + Math.min(pos.length, 4) * 1.0 - neg.length * 1.5);
  return { raw, ids, rationale: `Offline heuristic: ${pos.length} supporting and ${neg.length} adverse keyword matches in applicant materials. Not a judgement; run with an API key for evidence-based scoring.`, missing: pos.length === 0 ? [`No applicant material addresses "${c.label}".`] : [] };
}

export function applyGapPenalty(raw: number, nGaps: number, nEvidence: number) {
  let s = raw - Math.min(GAP_PENALTY.max_total, GAP_PENALTY.per_gap * nGaps);
  if (nEvidence === 0) s = Math.min(s, NO_EVIDENCE_CAP);
  return clamp(Math.round(s * 10) / 10);
}

export async function scoreApplication(db: DB, app: Application, evidence: Evidence[], researchGaps: Gap[]): Promise<{ assessment: Assessment; gaps: Gap[] }> {
  const usable = evidence.filter((e) => !e.post_cutoff_suspected);
  const evById = new Map(usable.map((e) => [e.id, e]));
  const retrievedByCrit: Record<string, Retrieved[]> = {};
  for (const c of CRITERIA) retrievedByCrit[c.key] = retrieveCorrections(db, c.key, app);

  let llm: z.infer<typeof LLMScore> | null = null;
  let scoredBy = "";
  if (hasLLM()) {
    const evText = usable.slice(0, 120).map((e) => `[${e.id}] (${e.source_type}) ${e.claim.slice(0, 260)}`).join("\n");
    const corrText = CRITERIA.map((c) => {
      const rs = retrievedByCrit[c.key];
      return rs.length ? `${c.key}:\n` + rs.map((r) => `  - [${r.id}] similar case scored ${r.old_score} -> corrected to ${r.new_score}. Reason: ${r.reason}`).join("\n") : "";
    }).filter(Boolean).join("\n");
    llm = await completeJSON({
      system: `You score a pre-seed startup application for ${"All In Capital"} against a rubric. Rules:
- Score ONLY from the evidence list. Every criterion must cite evidence_ids or list what is missing.
- Missing data LOWERS the score; never skip a criterion. List each missing item in "missing" with the cost of not knowing it.
- Score evidence, not pedigree: impressive credentials without business evidence do not raise the score.
- Founder quality and path to market are separate groups: do not let one leak into the other.
- Sector label matters less than whether founders own the risk.
- Candour/defensiveness cannot be seen from a deck: say so in "missing" and score neutral-to-low with low confidence.
- Do not turn the rubric into a pass/fail checklist; weigh the whole picture.
- thesis_basis: "written" if you judged fit against the stated thesis, "observed" if against how the fund actually behaves (memos/notes); say why.
- If prior corrections are provided and apply, adjust accordingly and list their ids in corrections_applied.
Scores 0-10 (raw, before any mechanical gap penalty).`,
      user: `FUND THESIS (${db.fund.thesis_source}): ${db.fund.thesis_text}\n\nRUBRIC:\n${CRITERIA.map((c) => `- ${c.key} [${c.group}]: ${c.question}${app.is_backtest ? "" : ` (seed evidence: ${c.seed_evidence})`}`).join("\n")}\n\nAPPLICATION: ${app.company} | ${app.sector_selected} | ${app.stage} | source=${app.source}\n\nEVIDENCE:\n${evText}\n\nPRIOR CORRECTIONS TO REUSE:\n${corrText || "(none)"}\n\nReturn {"criteria":[{criterion,raw_score,evidence_ids,missing:[{what,cost_to_score}],confidence,rationale,corrections_applied}], thesis_basis, basis_reason, case_for:[...], case_against:[...]} with one entry per rubric criterion.`,
      schema: LLMScore, model: "smart", max_tokens: 6000,
    });
    scoredBy = lastModelUsed;
  }

  const newGaps: Gap[] = [];
  const scores: CriterionScore[] = [];
  for (const c of CRITERIA) {
    const rel = researchGaps.filter((g) => g.criterion === c.key);
    const gapIds: string[] = rel.map((g) => g.id);
    let raw: number, ids: string[], rationale: string, confidence: "low" | "medium" | "high", applied: string[] = [];
    let missing: { what: string; cost: string }[] = [];

    if (llm) {
      const row = llm.criteria.find((x) => x.criterion === c.key);
      if (row) {
        raw = clamp(row.raw_score);
        ids = row.evidence_ids.filter((i) => evById.has(i)); // drop hallucinated ids
        rationale = row.rationale; confidence = row.confidence;
        missing = row.missing.map((m) => ({ what: m.what, cost: m.cost_to_score }));
        applied = (row.corrections_applied ?? []).filter((i) => retrievedByCrit[c.key].some((r) => r.id === i));
      } else {
        raw = 3; ids = []; rationale = "Model returned no entry for this criterion; treated as unscored evidence gap."; confidence = "low";
        missing = [{ what: "Criterion not assessed by the scorer.", cost: "Score is a placeholder floor." }];
      }
    } else {
      const o = offlineScore(app, c, usable);
      raw = o.raw; ids = o.ids; rationale = o.rationale; confidence = "low";
      missing = o.missing.map((m) => ({ what: m, cost: "Cannot score from applicant materials alone." }));
      // Offline: apply stored corrections as bounded deltas so reuse is visible and testable without an LLM.
      const rs = retrievedByCrit[c.key];
      if (rs.length) {
        const delta = rs.reduce((s, r) => s + (r.new_score - r.old_score) * r.sim, 0) / rs.reduce((s, r) => s + r.sim, 0);
        raw = clamp(raw + delta * 0.8); applied = rs.map((r) => r.id);
        rationale += ` Adjusted by ${delta.toFixed(1)} from ${rs.length} similar past correction(s).`;
      }
    }

    if (c.always_gap) {
      missing.push({ what: c.always_gap, cost: "Founder candour/defensiveness enters the score only after a live call." });
      confidence = "low";
    }
    if (rel.length && confidence === "high") confidence = "medium";
    for (const m of missing) {
      const g: Gap = { id: uid("gap"), app_id: app.id, criterion: c.key, what_missing: m.what, tried: ["deck", "form", ...(hasLLM() ? ["web search"] : [])], cost_to_score: m.cost };
      newGaps.push(g); gapIds.push(g.id);
    }
    const score = applyGapPenalty(raw, gapIds.length, ids.length);
    if (ids.length === 0 && gapIds.length === 0) { // hard rule backstop
      const g: Gap = { id: uid("gap"), app_id: app.id, criterion: c.key, what_missing: "No evidence cited for this criterion.", tried: ["deck", "form"], cost_to_score: "Score is a floor." };
      newGaps.push(g); gapIds.push(g.id);
    }
    scores.push(CriterionScoreSchema.parse({ criterion: c.key, score, raw_score: raw, weight: c.weight, evidence_ids: ids, gap_ids: gapIds, confidence, rationale, corrections_applied: applied }));
  }

  const group = (g: "founder" | "path") => {
    const rows = scores.filter((s) => CRITERIA.find((c) => c.key === s.criterion)!.group === g);
    const w = rows.reduce((a, r) => a + r.weight, 0);
    return Math.round((rows.reduce((a, r) => a + r.score * r.weight, 0) / w) * 10) / 10;
  };
  const founder = group("founder"), path = group("path");
  const total = Math.round((founder * GROUP_WEIGHTS.founder + path * GROUP_WEIGHTS.path) * 10) / 10;

  const base = {
    app_id: app.id, created_at: nowISO(), scores, founder_group_score: founder, path_to_market_score: path, total_score: total,
    thesis_basis: llm?.thesis_basis ?? ("written" as const),
    basis_reason: (llm?.basis_reason ?? "Offline run: judged only against the secondhand written line; observed fund behaviour not weighed.")
      + (llm && scoredBy && scoredBy !== PROCESS.models.smart ? ` [Scored by fallback model ${scoredBy}: primary ${PROCESS.models.smart} was overloaded. Treat as lower confidence.]` : ""),
    conflict_flags: [] as Assessment["conflict_flags"], case_for: llm?.case_for ?? [], case_against: llm?.case_against ?? [],
    recommendation: "hold" as const, advisory_only: true as const,
  };
  return { assessment: base, gaps: newGaps };
}

export function finalise(assessment: Assessment, allGaps: Gap[]): Assessment {
  return recommend(assessment, allGaps);
}
