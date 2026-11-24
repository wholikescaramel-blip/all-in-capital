import { loadDB } from "../src/lib/store";
import { processApplication } from "../src/lib/pipeline";

// Same application, scored several times on a copy of the stored data (nothing is saved): npm run stability -- grainkind 3
const id = process.argv[2] ?? "grainkind";
const runs = Number(process.argv[3] ?? 3);
const db = await loadDB();
const totals: number[] = [];
for (let i = 1; i <= runs; i++) {
  const a = await processApplication(db, db.applications[id], { keepState: true });
  totals.push(a.total_score);
  const line = a.scores.map((s) => `${s.criterion.slice(0, 6)} ${s.raw_score}->${s.score}`).join(" | ");
  console.log(`run ${i}: total ${a.total_score} (F ${a.founder_group_score} / P ${a.path_to_market_score}) -> ${a.recommendation} | ${a.scored_by}\n   ${line}`);
}
const spread = Math.max(...totals) - Math.min(...totals);
console.log(`\n${id}: totals ${totals.join(", ")} | spread ${spread.toFixed(1)}`);
