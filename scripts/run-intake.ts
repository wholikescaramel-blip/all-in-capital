import { ingestDirectory } from "../src/lib/ingest";
import { loadDB, saveDB } from "../src/lib/store";
import { processApplication } from "../src/lib/pipeline";
import { hasLLM } from "../src/lib/llm";

// Runs the whole week's pile through ingest -> research -> conflict -> score -> recommendation and parks each at AWAITING_REVIEW.
// One application failing (e.g. Gemini overloaded) must not stop the rest. Nothing partial is saved; a rerun resumes.
const db = await loadDB();
if (!hasLLM()) console.warn("OFFLINE MODE (no GEMINI_API_KEY): heuristic scores only, no web research. Set the key for real runs.\n");
const apps = await ingestDirectory();
const failed: string[] = [];
for (const app of apps) {
  if (db.states[app.id]) { console.log(`skip ${app.id} (already ${db.states[app.id]})`); continue; }
  try {
    const a = await processApplication(db, app);
    await saveDB(db);
    console.log(`${app.company.padEnd(14)} ${app.sector.padEnd(15)} total ${a.total_score} (F ${a.founder_group_score} / P ${a.path_to_market_score}) -> ${a.recommendation}${a.conflict_flags.some((f) => f.severity === "overlap") ? "  [CONFLICT]" : ""}`);
  } catch (e) {
    failed.push(app.company);
    console.error(`FAILED ${app.company}: ${String(e).slice(0, 200)}`);
    delete db.applications[app.id];
    delete db.states[app.id];
    db.audit = db.audit.filter((x) => x.app_id !== app.id);
    db.evidence = db.evidence.filter((x) => x.app_id !== app.id);
    db.gaps = db.gaps.filter((x) => x.app_id !== app.id);
  }
}
console.log(failed.length ? `\n${failed.length} failed (${failed.join(", ")}). Rerun npm run ingest: finished applications are skipped.` : "\nAll applications processed.");
