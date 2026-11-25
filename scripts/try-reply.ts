import { emptyDB } from "../src/lib/store";
import { extractReply, firstFit, mockOpenSlots } from "../src/lib/replies";
import { fmt } from "../src/lib/outreach";
import { hasLLM } from "../src/lib/llm";

// Shows how the app reads a founder's English reply and what it would book. Saves nothing: npm run try-reply
const now = new Date("2026-12-01T05:00:00Z"); // Tuesday 10:30 India time
const db = emptyDB();
db.outreach.x = { app_id: "x", state: "AWAITING_REPLY", followups_sent: 0, replies: [], proposed_slots: [], attendees: ["associate"], versions: [], chat: [], thread: [] };
const open = mockOpenSlots(db, "x", now); // every free half hour, Tuesday and Thursday 14:00 to 18:00 India time
const ist = (iso: string) => new Date(Date.parse(iso) + 330 * 60000).toISOString().replace("T", " ").slice(5, 16);

const cases = [
  "Thursday after 4 works for me. My number is 98765 43210.",
  "I'm free next Tuesday between 3 and 5pm. +91 98765 43210",
  "How about the 10th of December, late afternoon?",
  "Any weekday after lunch except Wednesday would be fine. Mobile: 9876543210",
  "Can we do Friday morning instead?",
  "Tuesday 2 pm Singapore time works",
  "Thursday 4:30 pm please, call me on 98765 43210",
  "Thursday 5:45pm?",
  "Before we pick a time, who else from your team would join?",
  "Not for now, thanks.",
];
console.log(`Reader: ${hasLLM() ? "Gemini" : "offline fallback (no key)"}. Open times: Tue/Thu 14:00-18:00 IST. "Now" is Tue 1 Dec 2026, 10:30 IST.\n`);
for (const text of cases) {
  const ex = await extractReply(text, { now, offered: [] });
  const hit = ex.intent === "yes" || ex.intent === "reschedule" ? firstFit(open, ex.windows) : undefined;
  console.log(`"${text}"`);
  console.log(`   read: ${ex.intent}${ex.phone ? ` | phone ${ex.phone}` : ""} | windows: ${ex.windows.slice(0, 3).map((w) => `${ist(w.start)}-${ist(w.end).slice(6)}`).join(", ") || "none"}`);
  console.log(`   would: ${ex.intent === "no" ? "flag to a person (declined)" : ex.intent === "question" ? "flag to a person (a question)" : ex.intent === "unclear" ? "keep waiting" : hit ? `BOOK ${fmt(new Date(hit))}` : "offer three new times"}\n`);
}
