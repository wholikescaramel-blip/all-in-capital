import { loadDB, saveDB } from "../src/lib/store";
import { enrichPortfolio } from "../src/lib/portfolio";

// Read each portfolio company's own site and store a profile: npm run refresh-portfolio   (or: -- "Giva" "Wint Wealth")
const db = await loadDB();
const only = process.argv.slice(2);
const out = await enrichPortfolio(db, { only, log: (s) => console.log(s) });
await saveDB(db);
for (const p of out) console.log(`${p.name.padEnd(18)} ${p.category.padEnd(14)} ${p.customer.padEnd(8)} ${p.website ?? "(no website)"}\n   ${p.description.slice(0, 110)} [${p.description_source}]${p.hq ? ` | ${p.hq}` : ""}${p.gaps.length ? `\n   gaps: ${p.gaps.join(" ")}` : ""}`);
