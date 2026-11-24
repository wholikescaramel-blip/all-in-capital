import { z } from "zod";

export const Sector = z.enum(["fintech", "deeptech", "consumer_tech", "consumer_brand", "other"]);
export type Sector = z.infer<typeof Sector>;

export const Application = z.object({
  id: z.string(),
  company: z.string(),
  sector_selected: z.string(),
  sector: Sector, // normalised bucket used for routing (the deeptech partner joins deeptech calls)
  stage: z.string(),
  source: z.enum(["form", "warm_intro"]),
  founders: z.array(z.object({ name: z.string(), role: z.string().optional(), background: z.string().optional() })),
  one_liner: z.string().default(""),
  deck_text: z.string(),
  form_fields: z.record(z.string(), z.string()),
  applied_at: z.string(),
  is_backtest: z.boolean().default(false),
  research_cutoff: z.string().optional(), // ISO date; evidence after this is blocked in backtests
});
export type Application = z.infer<typeof Application>;

export const SourceType = z.enum(["deck", "form", "web", "scrape", "memo"]);
export const Evidence = z.object({
  id: z.string(),
  app_id: z.string(),
  claim: z.string(),
  source_type: SourceType,
  url_or_ref: z.string(),
  retrieved_at: z.string(),
  quote_or_snippet: z.string(),
  post_cutoff_suspected: z.boolean().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Gap = z.object({
  id: z.string(),
  app_id: z.string(),
  criterion: z.string(),
  what_missing: z.string(),
  tried: z.array(z.string()),
  cost_to_score: z.string(), // what not knowing this costs the assessment
});
export type Gap = z.infer<typeof Gap>;

export const CriterionScore = z
  .object({
    criterion: z.string(),
    score: z.number().min(0).max(10),
    raw_score: z.number().min(0).max(10).optional(), // before gap penalty
    weight: z.number(),
    evidence_ids: z.array(z.string()),
    gap_ids: z.array(z.string()),
    confidence: z.enum(["low", "medium", "high"]),
    rationale: z.string(),
    corrections_applied: z.array(z.string()).default([]),
  })
  // Hard rule: no unexplained scores. Every score points at evidence or at a gap.
  .refine((c) => c.evidence_ids.length > 0 || c.gap_ids.length > 0, {
    message: "CriterionScore needs at least one evidence_id or gap_id",
  });
export type CriterionScore = z.infer<typeof CriterionScore>;

export const Recommendation = z.enum(["take_call", "pass", "hold"]);
export type Recommendation = z.infer<typeof Recommendation>;

export const Assessment = z.object({
  app_id: z.string(),
  created_at: z.string(),
  scores: z.array(CriterionScore),
  founder_group_score: z.number(),
  path_to_market_score: z.number(),
  total_score: z.number(),
  thesis_basis: z.enum(["written", "observed"]),
  basis_reason: z.string(),
  conflict_flags: z.array(z.object({ portfolio_company: z.string(), reason: z.string(), severity: z.enum(["overlap", "warning"]) })),
  recommendation: Recommendation,
  case_for: z.array(z.string()),
  case_against: z.array(z.string()),
  advisory_only: z.literal(true).default(true),
});
export type Assessment = z.infer<typeof Assessment>;

export const Review = z.object({
  app_id: z.string(),
  reviewer: z.string(),
  system_rec: Recommendation,
  human_decision: Recommendation,
  reason_line: z.string().optional(),
  reviewed_at: z.string(),
}).refine((r) => r.system_rec === r.human_decision || (r.reason_line && r.reason_line.trim().length >= 5), {
  message: "reason_line is required when the human decision differs from the system recommendation",
});
export type Review = z.infer<typeof Review>;

export const Correction = z.object({
  id: z.string(),
  app_id: z.string().optional(),
  criterion: z.string(),
  sector: z.string(),
  features: z.string(), // text used for similarity retrieval (no external embedding dependency)
  old_score: z.number(),
  new_score: z.number(),
  reason: z.string(),
  author: z.string(),
  created_at: z.string(),
});
export type Correction = z.infer<typeof Correction>;

export const OutreachState = z.enum([
  "NONE", "DRAFTED", "APPROVED_TO_SEND", "SENT", "AWAITING_REPLY", "SCHEDULING", "MEETING_SCHEDULED", "FLAGGED_PARTNER",
]);
export const Outreach = z.object({
  app_id: z.string(),
  state: OutreachState,
  draft: z.object({ subject: z.string(), body: z.string() }).optional(),
  approved_by: z.string().optional(),
  followups_sent: z.number().default(0),
  last_sent_at: z.string().optional(),
  replies: z.array(z.object({ at: z.string(), text: z.string(), classification: z.enum(["yes", "no", "none", "other"]) })).default([]),
  proposed_slots: z.array(z.string()).default([]),
  slot: z.string().optional(),
  attendees: z.array(z.string()).default([]),
});
export type Outreach = z.infer<typeof Outreach>;

export const AppState = z.enum([
  "INGESTED", "RESEARCHED", "SCORED", "AWAITING_REVIEW", "APPROVED", "DRAFTED", "APPROVED_TO_SEND",
  "SENT", "AWAITING_REPLY", "SCHEDULING", "SCHEDULED", "FLAGGED", "DECIDED_PASS", "ON_HOLD",
]);
export type AppState = z.infer<typeof AppState>;

export type AuditEntry = { at: string; app_id: string; from: AppState | null; to: AppState; actor: string; note?: string };

export type DB = {
  applications: Record<string, Application>;
  states: Record<string, AppState>;
  evidence: Evidence[];
  gaps: Gap[];
  assessments: Record<string, Assessment>;
  reviews: Review[];
  corrections: Correction[];
  outreach: Record<string, Outreach>;
  audit: AuditEntry[];
  outbox: { at: string; to: string; subject: string; body: string; app_id: string; mock: true }[];
  fund: { thesis_text: string; thesis_source: string; portfolio: { name: string; description: string; source: string }[]; gaps: string[]; researched_at?: string; sources?: { url: string; fetched_at: string; note: string }[] };
  backtest_runs: unknown[];
};
