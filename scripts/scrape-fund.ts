import { scrapeFundSite } from "../src/lib/fundsite";
import { PROCESS } from "../src/config/process";

// Try the fund-page scraper on its own: npm run scrape:fund   (FUND_URL=https://... to override)
console.log("Fund URL(s):", PROCESS.fund_public_urls.join(", "));
const s = await scrapeFundSite();
console.log("\nPages read:", s.sources.map((x) => `${x.note} ${x.url}`).join("\n  ") || "none");
console.log(`\nPortfolio (${s.portfolio.length}):`, s.portfolio.map((p) => p.name).join(", ") || "none");
console.log("\nThesis:", s.thesis_text || "none", s.thesis_url ? `\n(from ${s.thesis_url})` : "");
console.log("\nGaps:\n  " + (s.gaps.join("\n  ") || "none"));
console.log(`\nFetched ${s.report.fetched} page(s) in ${s.report.elapsedMs}ms`);
