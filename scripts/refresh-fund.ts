import { loadDB, saveDB } from "../src/lib/store";
import { researchFund } from "../src/lib/research";

// Re-read the fund's thesis and portfolio and store them: npm run refresh-fund
const db = await loadDB();
await researchFund(db);
await saveDB(db);
console.log("Thesis:", db.fund.thesis_text);
console.log("Source:", db.fund.thesis_source);
console.log(`Portfolio: ${db.fund.portfolio.length} companies`);
console.log("Notes:\n  " + (db.fund.gaps.join("\n  ") || "none"));
