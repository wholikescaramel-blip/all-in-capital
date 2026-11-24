import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Locks the pass/fail thresholds AND the scoring config (rubric, weights, recommendation thresholds) by hash,
// so neither can be tuned after seeing backtest results without an explicit, logged re-registration.
const root = process.cwd();
const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, p))).digest("hex");
const files = ["data/backtest/preregistration.json", "src/config/rubric.ts", "src/config/process.ts", "data/backtest/memos.json"];
const lockPath = path.join(root, "data/backtest/preregistration.lock.json");
const prev = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : { history: [] };
const entry = { registered_at: new Date().toISOString(), hashes: Object.fromEntries(files.map((f) => [f, sha(f)])) };
fs.writeFileSync(lockPath, JSON.stringify({ current: entry, history: [...prev.history, ...(prev.current ? [prev.current] : [])] }, null, 2));
console.log("Registered:", entry.registered_at);
for (const [f, h] of Object.entries(entry.hashes)) console.log(`  ${h.slice(0, 12)}  ${f}`);
console.log(prev.current ? "NOTE: this replaced an earlier registration (kept in history)." : "First registration. Run `npm run backtest` next.");
