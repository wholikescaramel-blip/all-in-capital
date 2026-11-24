import { loadDB, saveDB } from "../src/lib/store";
import { tick } from "../src/lib/outreach";

// Simulate time passing: npm run tick -- 3   (advance 3 days; sends due follow-ups, flags after the max)
const days = Number(process.argv[2] ?? 3);
const db = await loadDB();
const events = tick(db, new Date(Date.now() + days * 86400000));
await saveDB(db);
console.log(events.length ? events.join("\n") : "nothing due");
