import type { Application, DB } from "./schemas";
import { Review } from "./schemas";
import { audit, transition } from "./store";
import { researchApplication, researchFund } from "./research";
import { conflictCheck } from "./conflict";
import { finalise, scoreApplication } from "./scorer";
import { addCorrection, featuresOf } from "./corrections";
import { CRITERIA } from "../config/rubric";
import { PROCESS } from "../config/process";

export async function ensureFund(db: DB) {
  if (!db.fund.researched_at) await researchFund(db);
}

// Steps 1-5: INGESTED -> RESEARCHED -> SCORED -> AWAITING_REVIEW. Stops there: a human decides.
export async function processApplication(db: DB, app: Application, opts: { keepState?: boolean } = {}) {
  const stage = (m: string) => { if (!app.is_backtest || process.env.VERBOSE) console.log(`[${app.company}] ${m}`); };
  if (!opts.keepState) {
    db.applications[app.id] = app;
    transition(db, app.id, "INGESTED", "system", "ingested deck+form");
  }
  stage("fund research");
  await ensureFund(db);
  stage("application research");

  // drop prior evidence/gaps for a clean re-run, keep audit
  db.evidence = db.evidence.filter((e) => e.app_id !== app.id);
  db.gaps = db.gaps.filter((g) => g.app_id !== app.id);

  const r = await researchApplication(db, app);
  db.evidence.push(...r.evidence);
  db.gaps.push(...r.gaps);
  if (!opts.keepState) transition(db, app.id, "RESEARCHED", "research-agent", `${r.evidence.length} evidence, ${r.gaps.length} research gaps`);

  stage(`conflict check (${r.evidence.length} evidence, ${r.gaps.length} gaps)`);
  const flags = await conflictCheck(db, app);
  stage("scoring");
  const { assessment, gaps } = await scoreApplication(db, app, r.evidence, r.gaps);
  db.gaps.push(...gaps);
  assessment.conflict_flags = flags;
  const allGaps = db.gaps.filter((g) => g.app_id === app.id);
  db.assessments[app.id] = finalise(assessment, allGaps);
  if (!opts.keepState) {
    transition(db, app.id, "SCORED", "scorer", `total ${assessment.total_score}, rec ${db.assessments[app.id].recommendation}`);
    transition(db, app.id, "AWAITING_REVIEW", "system", flags.some((f) => f.severity === "overlap") ? "portfolio overlap flagged" : undefined);
  }
  return db.assessments[app.id];
}

export type ScoreFix = { criterion: string; new_score: number; reason: string };

// Step 7: human review. A differing decision needs a one-line reason; any score fix is stored as a reusable Correction.
export function submitReview(db: DB, appId: string, reviewer: string, decision: "take_call" | "pass" | "hold", reasonLine: string | undefined, fixes: ScoreFix[] = []) {
  const a = db.assessments[appId];
  const app = db.applications[appId];
  if (!a || !app) throw new Error("Unknown application");
  if (db.states[appId] !== "AWAITING_REVIEW") throw new Error(`Application is ${db.states[appId]}, not AWAITING_REVIEW`);
  const review = Review.parse({ app_id: appId, reviewer, system_rec: a.recommendation, human_decision: decision, reason_line: reasonLine, reviewed_at: new Date().toISOString() });
  db.reviews.push(review);

  for (const f of fixes) {
    const s = a.scores.find((x) => x.criterion === f.criterion);
    if (!s) throw new Error(`Unknown criterion ${f.criterion}`);
    if (!f.reason || f.reason.trim().length < 5) throw new Error(`A one-line reason is required to correct ${f.criterion}`);
    addCorrection(db, { app_id: appId, criterion: f.criterion, sector: app.sector, features: featuresOf(app), old_score: s.score, new_score: f.new_score, reason: f.reason, author: reviewer });
    audit(db, appId, reviewer, `score correction ${f.criterion}: ${s.score} -> ${f.new_score} (${f.reason})`);
  }
  if (decision !== a.recommendation && !fixes.length) {
    // Decision-level disagreement with no criterion named: keep it as an 'overall' correction so it's still searchable.
    addCorrection(db, { app_id: appId, criterion: "overall", sector: app.sector, features: featuresOf(app), old_score: a.total_score, new_score: decision === "take_call" ? Math.max(a.total_score, PROCESS.rec.take_call_min_total) : decision === "pass" ? Math.min(a.total_score, PROCESS.rec.pass_max_total) : (PROCESS.rec.take_call_min_total + PROCESS.rec.pass_max_total) / 2, reason: reasonLine!, author: reviewer });
  }
  if (decision === "take_call") transition(db, appId, "APPROVED", reviewer, reasonLine);
  else if (decision === "pass") transition(db, appId, "DECIDED_PASS", reviewer, reasonLine ?? "agreed with system");
  else transition(db, appId, "ON_HOLD", reviewer, reasonLine ?? "agreed with system");
  return review;
}

export const CRITERION_KEYS = CRITERIA.map((c) => c.key);
