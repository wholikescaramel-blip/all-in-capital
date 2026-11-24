import { loadDB } from "../src/lib/store";
import { draftWithChecks, reviseDraft } from "../src/lib/emailflow";

// Dry run of the email loop on a copy of the stored data (nothing is saved): npm run try-email -- grainkind
const id = process.argv[2] ?? "grainkind";
const db = await loadDB();
if (!db.applications[id]) throw new Error(`No application ${id}`);
db.outreach[id] = { app_id: id, state: "NONE", followups_sent: 0, replies: [], proposed_slots: [], attendees: [], versions: [], chat: [] };
const t0 = Date.now();
const v = await draftWithChecks(db, id);
const show = (label: string, x: typeof v) => {
  console.log(`\n=== ${label} (${Math.round((Date.now() - t0) / 1000)}s) ===\nSubject: ${x.subject}\n\n${x.body}\n`);
  const c = x.check!;
  console.log(`Fact-check: ${c.pass ? "PASS" : "NEEDS A LOOK"} after ${c.rounds} round(s); ${c.claims.length} claims`);
  for (const k of c.claims) console.log(`  ${k.supported ? "ok " : "!! "} ${k.text}${k.quote ? `  <- "${k.quote.slice(0, 70)}"` : ""}`);
  for (const i of c.issues) console.log(`  issue: ${i}`);
};
show("First draft", v);
const r = await reviseDraft(db, id, "Shorter, and ask about their repeat purchase rate");
show("After revision", r);
console.log("\nChat:", db.outreach[id].chat.map((c) => `${c.who}: ${c.text}`).join("\n      "));
