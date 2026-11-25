import { z } from "zod";

export const Sector = z.enum(["fintech", "deeptech", "consumer_tech", "consumer_brand", "commerce_infrastructure", "other"]);
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
  website: z.string().optional(),
  contact_email: z.string().optional(), // only when the applicant gave one; never guessed
  conflict_exclude: z.array(z.string()).optional(), // backtest only: portfolio names not to compare against
  kind: z.enum(["pair", "domain", "manual"]).default("pair"), // pair = deck+form, domain = name/website entry, manual = pasted text
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
  scored_by: z.string().optional(), // model that produced the scores (shown quietly, not in the reasoning text)
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
// Fact-check of an email draft: every factual claim must trace to the application; nothing internal may leak.
export const DraftCheck = z.object({
  pass: z.boolean(),
  claims: z.array(z.object({ text: z.string(), fact_id: z.string().nullable(), quote: z.string().optional(), supported: z.boolean(), note: z.string().optional() })),
  issues: z.array(z.string()), // unsupported claims and rule breaks, in plain words
  rounds: z.number(),
});
export type DraftCheck = z.infer<typeof DraftCheck>;
export type Extraction = { intent: "yes" | "no" | "reschedule" | "question" | "unclear"; windows: { start: string; end: string }[]; phone?: string; question?: string; summary: string };
export type Message = {
  id: string; at: string; dir: "out" | "in";
  kind: "invite" | "followup" | "slots" | "confirmation" | "reply" | "other";
  from: string; to: string; subject: string; body: string;
  via: "mock" | "resend" | "gmail" | "simulated" | "pasted" | "inbound";
  thread_id?: string; message_id_header?: string;
  status: "recorded" | "queued" | "sent" | "failed" | "received";
  provider_id?: string; error?: string; extracted?: Extraction;
};

// What reviewers have asked for in earlier drafts, kept so future drafts start closer to what they want.
export type DraftNote = { id: string; rule: string; raw: string[]; count: number; standing: boolean; created_at: string; last_seen: string };
export type DraftVersion = { n: number; at: string; by: "ai" | "human"; instruction?: string; subject: string; body: string; check?: DraftCheck };

export const Outreach = z.object({
  app_id: z.string(),
  state: OutreachState,
  draft: z.object({ subject: z.string(), body: z.string() }).optional(),
  contact: z.object({ name: z.string(), role: z.string().optional(), email: z.string(), email_source: z.enum(["form", "placeholder"]) }).optional(),
  versions: z.array(z.any()).default([]), // DraftVersion[]
  chat: z.array(z.object({ at: z.string(), who: z.enum(["human", "ai"]), text: z.string() })).default([]),
  thread: z.array(z.any()).default([]), // Message[]: every email in and out, in order
  phone: z.string().optional(), // taken from the founder's reply, in international format
  meeting: z.object({ start: z.string(), end: z.string(), provider: z.enum(["cal", "mock", "google"]), uid: z.string().optional(), url: z.string().optional(), calendar_url: z.string().optional(), attendees: z.array(z.string()) }).optional(),
  ai_slots: z.array(z.string()).optional(), // the two times the draft step wrote, so the reviewer's own edited times can be told apart
  thread_id: z.string().optional(), // Gmail thread the invite went out in
  claim: z.object({ at: z.string(), by: z.string() }).optional(), // set while one scheduler run owns this thread
  prepared_followup: z.object({ at: z.string(), subject: z.string(), body: z.string(), slots: z.array(z.string()) }).optional(), // written, never sent on its own
  last_read_at: z.string().optional(),
  needs_human: z.string().optional(), // why a person has to look (a question, a decline)
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
  pending: Record<string, { stage: number; flags?: { portfolio_company: string; reason: string; severity: "overlap" | "warning" }[]; error?: string }>; // applications mid-processing
  draft_notes: DraftNote[];
  style_examples?: { id: string; sector: string; subject: string; body: string; at: string }[]; // emails the reviewer edited and sent
  google?: { email: string; refresh_token: string; connected_at: string }; // the one connected Gmail and Calendar account
  outbox: { at: string; to: string; subject: string; body: string; app_id: string; mock: true }[];
  fund: { thesis_text: string; thesis_source: string; portfolio: { name: string; description: string; source: string }[]; gaps: string[]; researched_at?: string; sources?: { url: string; fetched_at: string; note: string }[] };
  backtest_runs: unknown[];
};
