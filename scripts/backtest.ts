import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { emptyDB } from "../src/lib/store";
import { processApplication } from "../src/lib/pipeline";
import { hasLLM } from "../src/lib/llm";
import { Application } from "../src/lib/schemas";
import { CRITERIA } from "../src/config/rubric";

const root = process.cwd();
const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, p))).digest("hex");
const lockPath = path.join(root, "data/backtest/preregistration.lock.json");

// Gate: thresholds must be registered first, and unchanged since.
if (!fs.existsSync(lockPath)) { console.error("Not pre-registered. Run `npm run preregister` first."); process.exit(1); }
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")).current;
for (const [f, h] of Object.entries<string>(lock.hashes)) {
  if (sha(f) !== h) { console.error(`${f} changed since registration (${lock.registered_at}). Re-register explicitly to proceed.`); process.exit(1); }
}
const prereg = JSON.parse(fs.readFileSync(path.join(root, "data/backtest/preregistration.json"), "utf8"));
const T = prereg.thresholds;
const memos = JSON.parse(fs.readFileSync(path.join(root, "data/backtest/memos.json"), "utf8"));

const live = hasLLM();
if (!live) console.warn("\n*** OFFLINE MODE: no GEMINI_API_KEY. Results below test the harness only and say NOTHING about the system's judgement. ***\n");

const db = emptyDB(); // isolated: no corrections carried in, nothing written to the live DB
const rows: any[] = [];
for (const m of memos) {
  const app = Application.parse({
    id: m.id, company: m.company, sector_selected: m.sector_selected, sector: m.sector, stage: m.stage, source: m.source,
    founders: m.founders.map((n: string) => ({ name: n })), one_liner: m.what_it_does.split(". ")[0],
    deck_text: `${m.what_it_does}\n\n${m.facts.join("\n\n")}`, // decision, why-text and founder assessment are NOT included
    form_fields: { "Company name": m.company, "Sector (as selected)": m.sector_selected, "Stage (as selected)": m.stage, "One-line description": m.what_it_does.split(". ")[0] },
    applied_at: new Date().toISOString(), is_backtest: true, research_cutoff: m.cutoff ?? undefined, conflict_exclude: memos.map((x: { company: string }) => x.company),
  });
  const a = await processApplication(db, app);
  const agree = (a.recommendation === "take_call" && m.outcome === "invested") || (a.recommendation === "pass" && m.outcome === "passed");
  const hits = Object.entries<string>(m.expected).map(([c, dir]) => {
    const s = a.scores.find((x) => x.criterion === c)!.score;
    const hit = dir === "high" ? s >= 6 : dir === "low" ? s <= 5 : s >= 4 && s <= 7;
    return { criterion: c, expected: dir, score: s, hit };
  });
  rows.push({ id: m.id, company: m.company, fund: m.outcome, system: a.recommendation, total: a.total_score, founder: a.founder_group_score, path: a.path_to_market_score, agree, hits, flags: a.conflict_flags.map((f) => f.portfolio_company), case_for: a.case_for, case_against: a.case_against, basis: a.thesis_basis });
  console.log(`${agree ? "AGREE   " : "DISAGREE"}  ${m.company.padEnd(20)} fund=${m.outcome.padEnd(8)} system=${a.recommendation.padEnd(9)} total=${a.total_score}`);
}

const agreeN = rows.filter((r) => r.agree).length;
const funded = rows.filter((r) => r.fund === "invested");
const crit: Record<string, { n: number; hit: number }> = {};
for (const r of rows) for (const h of r.hits) { (crit[h.criterion] ??= { n: 0, hit: 0 }).n++; if (h.hit) crit[h.criterion].hit++; }
const checks = [
  { name: `agreement >= ${T.agreement_min_of_12}/12`, pass: agreeN >= T.agreement_min_of_12, value: `${agreeN}/12` },
  { name: `no funded company below total ${T.funded_min_total_score}`, pass: funded.every((r) => r.total >= T.funded_min_total_score), value: funded.filter((r) => r.total < T.funded_min_total_score).map((r) => r.company).join(", ") || "none" },
  { name: `funded recommended pass <= ${T.max_funded_recommended_pass}`, pass: funded.filter((r) => r.system === "pass").length <= T.max_funded_recommended_pass, value: String(funded.filter((r) => r.system === "pass").length) },
  { name: `passed recommended take_call <= ${T.max_passed_recommended_take_call}`, pass: rows.filter((r) => r.fund === "passed" && r.system === "take_call").length <= T.max_passed_recommended_take_call, value: String(rows.filter((r) => r.fund === "passed" && r.system === "take_call").length) },
  ...Object.entries(crit).map(([c, v]) => ({ name: `criterion hit rate ${c} >= ${T.per_criterion_hit_rate_min}`, pass: v.hit / v.n >= T.per_criterion_hit_rate_min, value: `${v.hit}/${v.n}` })),
];
const trust = checks.every((c) => c.pass);

const dis = rows.filter((r) => !r.agree);
const md = [
  `# Backtest report`,
  `Run: ${new Date().toISOString()} | mode: ${live ? "LIVE (model + web search)" : "OFFLINE HARNESS TEST (not evidence of judgement)"} | registration: ${lock.registered_at}`,
  ``, `**Verdict under the pre-registered rule: ${trust ? "TRUST (advisory use only)" : "NOT YET"}**`, ``,
  `| Check | Result | Value |`, `|---|---|---|`, ...checks.map((c) => `| ${c.name} | ${c.pass ? "pass" : "FAIL"} | ${c.value} |`), ``,
  `## Per application`, `| Company | Fund | System | Total | Founder | Path | Agree |`, `|---|---|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.company} | ${r.fund} | ${r.system} | ${r.total} | ${r.founder} | ${r.path} | ${r.agree ? "yes" : "NO"} |`), ``,
  `## Disagreements (to be labelled system_wrong | fund_wrong | ambiguous by a human, citing the memo)`,
  ...dis.map((r) => `### ${r.company}: fund ${r.fund}, system ${r.system} (${r.total})\n- Case for: ${r.case_for.join(" / ")}\n- Case against: ${r.case_against.join(" / ")}\n- Conflict flags: ${r.flags.join(", ") || "none"}\n- **Judgement:** _TODO (human)_`), ``,
  `## Caveats`, ...prereg.caveats_to_state.map((c: string) => `- ${c}`),
].join("\n");
fs.mkdirSync(path.join(root, "reports"), { recursive: true });
const out = path.join(root, "reports", `backtest-${live ? "live" : "offline"}-${Date.now()}.md`);
fs.writeFileSync(out, md);
console.log(`\nAgreement ${agreeN}/12. Verdict: ${trust ? "TRUST" : "NOT YET"}. Report: ${out}`);
