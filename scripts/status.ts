import { loadDB, storeKind } from "../src/lib/store";

// Progress and results from the stored state: npm run status
const db = await loadDB();
const ids = Object.keys(db.states);
console.log(`store: ${storeKind()} | processed: ${ids.length}/10 | fund portfolio on file: ${db.fund.portfolio.length} | fund gaps: ${db.fund.gaps.length}`);
console.log("\nCompany".padEnd(14), "State".padEnd(17), "Total".padEnd(6), "F".padEnd(5), "P".padEnd(5), "System says".padEnd(10), "Conflicts / notes");
for (const id of ids) {
  const a = db.assessments[id];
  const app = db.applications[id];
  if (!a) { console.log(app.company.padEnd(13), db.states[id]); continue; }
  const overlaps = a.conflict_flags.filter((f) => f.severity === "overlap").map((f) => f.portfolio_company);
  const fb = /fallback model/.test(a.basis_reason) ? " [fallback model]" : "";
  console.log(app.company.padEnd(13), db.states[id].padEnd(17), String(a.total_score).padEnd(6), String(a.founder_group_score).padEnd(5), String(a.path_to_market_score).padEnd(5), a.recommendation.padEnd(10), (overlaps.length ? `CONFLICT: ${overlaps.join(", ")}` : "") + fb);
}
if (process.argv[2] === "detail") {
  for (const id of ids) {
    const a = db.assessments[id]; if (!a) continue;
    console.log(`\n=== ${db.applications[id].company} (${a.recommendation}, ${a.total_score}) | thesis basis: ${a.thesis_basis}: ${a.basis_reason}`);
    for (const s of a.scores) console.log(`  ${s.criterion.padEnd(22)} ${String(s.score).padEnd(4)} (raw ${s.raw_score}) conf ${s.confidence.padEnd(6)} ev ${s.evidence_ids.length} gaps ${s.gap_ids.length}`);
    console.log("  FOR:", a.case_for.join(" | ").slice(0, 400));
    console.log("  AGAINST:", a.case_against.join(" | ").slice(0, 400));
  }
}
