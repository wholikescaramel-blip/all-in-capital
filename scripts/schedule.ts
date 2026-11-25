import { runScheduler } from "../src/lib/scheduler";

// Check replies and book, once: npm run schedule   (or: npm run schedule -- <application id>)
const only = process.argv[2];
const r = await runScheduler({ only });
console.log(`Checked ${r.checked} thread(s), sent ${r.sent} message(s).`);
for (const t of r.results) console.log(` ${t.appId}: ${t.outcome}${t.detail ? ` (${t.detail})` : ""}`);
for (const s of r.skipped) console.log(` skipped ${s}`);
for (const e of r.errors) console.log(` ERROR ${e}`);
