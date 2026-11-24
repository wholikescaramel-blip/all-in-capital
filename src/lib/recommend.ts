import type { Assessment, Gap } from "./schemas";
import { CRITERIA } from "../config/rubric";
import { PROCESS } from "../config/process";

// Advisory only. Nothing is auto-rejected or auto-advanced: a human review sits between every recommendation and every action.
export function recommend(a: Assessment, gaps: Gap[]): Assessment {
  const { take_call_min_total, take_call_min_group, pass_max_total } = PROCESS.rec;
  const overlap = a.conflict_flags.some((f) => f.severity === "overlap");
  let rec: Assessment["recommendation"] = "hold";
  if (overlap) rec = "hold"; // default is hold on any portfolio overlap
  else if (a.total_score >= take_call_min_total && a.founder_group_score >= take_call_min_group && a.path_to_market_score >= take_call_min_group) rec = "take_call";
  else if (a.total_score <= pass_max_total) rec = "pass";

  const label = (k: string) => CRITERIA.find((c) => c.key === k)?.label ?? k;
  const sorted = [...a.scores].sort((x, y) => y.score - x.score);
  const caseFor = [...a.case_for];
  const caseAgainst = [...a.case_against];
  if (!caseFor.length) for (const s of sorted.slice(0, 2)) caseFor.push(`${label(s.criterion)}: ${s.score}/10. ${s.rationale}`);
  if (!caseAgainst.length) for (const s of sorted.slice(-2)) caseAgainst.push(`${label(s.criterion)}: ${s.score}/10. ${s.rationale}`);
  if (overlap) caseAgainst.unshift(`Overlaps with ${a.conflict_flags.filter((f) => f.severity === "overlap").map((f) => f.portfolio_company).join(", ")}, already in the portfolio. On hold until someone speaks to that founder.`);
  const mine = gaps.filter((g) => g.app_id === a.app_id);
  if (mine.some((g) => g.criterion === "research")) caseAgainst.push("Web search wasn't available, so these scores rest on the application alone.");
  const gapCrits = [...new Set(mine.filter((g) => g.criterion !== "research").map((g) => label(g.criterion)))];
  if (gapCrits.length) caseAgainst.push(`Missing info (each gap lowers the score): ${gapCrits.join(", ")}.`);
  return { ...a, recommendation: rec, case_for: caseFor, case_against: caseAgainst };
}
