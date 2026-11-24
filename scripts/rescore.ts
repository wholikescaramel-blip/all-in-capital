import { loadDB, saveDB, audit } from "../src/lib/store";
import { processApplication } from "../src/lib/pipeline";

// Score the stored applications again with the current prompts: npm run rescore [-- company-id ...]
// States, reviews and email drafts are left alone; only evidence, gaps and the assessment are replaced.
const only = process.argv.slice(2);
const db = await loadDB();
const ids = Object.keys(db.assessments).filter((id) => !db.pending[id] && (!only.length || only.includes(id)));
console.log(`Rescoring ${ids.length} application(s)`);
for (const id of ids) {
  const app = db.applications[id];
  const before = db.assessments[id];
  try {
    const a = await processApplication(db, app, { keepState: true });
    audit(db, id, "rescore", `rescored: ${before.total_score} -> ${a.total_score}, suggestion ${before.recommendation} -> ${a.recommendation}`);
    await saveDB(db);
    console.log(`${app.company.padEnd(14)} ${before.total_score} -> ${a.total_score}  ${before.recommendation} -> ${a.recommendation}`);
  } catch (e) {
    console.error(`FAILED ${app.company}: ${String(e).slice(0, 160)}`);
  }
}
