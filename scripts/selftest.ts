process.env.SKIP_FUND_SCRAPE = "1"; // no network in the offline self-test
import assert from "node:assert/strict";
import { ingestDirectory } from "../src/lib/ingest";
import { emptyDB, transition } from "../src/lib/store";
import { processApplication, submitReview } from "../src/lib/pipeline";
import { approveAndSend, draftEmail, handleReply, tick } from "../src/lib/outreach";
import { CriterionScore } from "../src/lib/schemas";

const db = emptyDB();
const apps = await ingestDirectory();
assert.equal(apps.length, 10, "10 applications ingested");
for (const a of apps) await processApplication(db, a);

// Every application parked at AWAITING_REVIEW; nothing auto-decided.
for (const a of apps) assert.equal(db.states[a.id], "AWAITING_REVIEW");
// Hard rule: every score has evidence or a gap; the candour criterion always carries an 'unavailable' gap.
for (const asm of Object.values(db.assessments)) {
  for (const s of asm.scores) { CriterionScore.parse(s); assert.ok(s.evidence_ids.length + s.gap_ids.length > 0); }
  const cand = asm.scores.find((s) => s.criterion === "candour")!;
  assert.ok(cand.gap_ids.length > 0 && cand.confidence === "low");
}
assert.throws(() => CriterionScore.parse({ criterion: "x", score: 5, weight: 1, evidence_ids: [], gap_ids: [], confidence: "low", rationale: "" }));

// Review: differing decision requires a reason.
const [a1, a2, a3] = apps;
const sys1 = db.assessments[a1.id].recommendation;
const other = sys1 === "pass" ? "take_call" : "pass";
assert.throws(() => submitReview(db, a1.id, "associate", other as any, undefined), /reason_line/);
// Correction persists and is reused on a later, similar application.
db.applications[a2.id] = { ...db.applications[a2.id], sector: a1.sector, one_liner: a1.one_liner };
submitReview(db, a1.id, "partner", other as any, "Founder owns credit risk personally", [{ criterion: "risk_ownership", new_score: 9, reason: "Founder owns credit risk personally" }]);
assert.ok(db.corrections.length >= 1);
transition(db, a2.id, "FLAGGED", "test"); transition(db, a2.id, "AWAITING_REVIEW", "test");
await processApplication(db, db.applications[a2.id], { keepState: true });
const applied = db.assessments[a2.id].scores.find((s) => s.criterion === "risk_ownership")!.corrections_applied;
assert.ok(applied.length >= 1, "similar company sees the earlier correction");

// Outreach A (deeptech, no reply): follow-ups at the interval, then flagged to a partner.
const a4 = apps[3], a5 = apps[4];
db.applications[a3.id].sector = "deeptech";
submitReview(db, a3.id, "partner", "take_call", "Testing outreach path");
await assert.rejects(() => draftEmail(db, a4.id)); // only human-approved take_call gets a draft
await draftEmail(db, a3.id);
assert.deepEqual(db.outreach[a3.id].attendees, ["associate", "deeptech_partner"], "deeptech: the partner joins");
const t0 = new Date("2026-12-01T05:00:00Z");
approveAndSend(db, a3.id, "associate", t0);
assert.equal(db.states[a3.id], "AWAITING_REPLY");
let now = t0;
for (let i = 1; i <= 3; i++) { now = new Date(now.getTime() + 3 * 86400000); tick(db, now); assert.equal(db.outreach[a3.id].followups_sent, i); }
now = new Date(now.getTime() + 3 * 86400000); tick(db, now);
assert.equal(db.states[a3.id], "FLAGGED", "flagged after 3 follow-ups, not auto-rejected");

// Outreach B (consumer, replies yes): Tue/Thu afternoon slots, loop until agreed, then SCHEDULED.
db.applications[a5.id].sector = "consumer_tech";
submitReview(db, a5.id, "partner", "take_call", "Testing booking path");
await draftEmail(db, a5.id);
assert.deepEqual(db.outreach[a5.id].attendees, ["associate"]);
approveAndSend(db, a5.id, "associate", t0);
await handleReply(db, a5.id, "Yes, happy to talk!", t0);
assert.equal(db.states[a5.id], "SCHEDULING");
for (const s of db.outreach[a5.id].proposed_slots) {
  const ist = new Date(new Date(s).getTime() + 330 * 60000);
  assert.ok([2, 4].includes(ist.getUTCDay()), "Tuesday or Thursday");
  assert.ok(ist.getUTCHours() >= 14 && ist.getUTCHours() < 18, "afternoon");
}
await handleReply(db, a5.id, "Can we do Monday morning instead?", t0); // counter -> re-propose, still scheduling
assert.equal(db.states[a5.id], "SCHEDULING");
await handleReply(db, a5.id, "2 works", t0);
assert.equal(db.states[a5.id], "SCHEDULED");
assert.ok(db.audit.length > 30);
console.log("selftest OK:", db.audit.length, "audit entries,", db.corrections.length, "correction(s)");
