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
// ---- email workspace: placeholder contact, versions, fact-check, revision chat ----
const o5 = db.outreach[a5.id];
assert.equal(o5.contact?.email_source, "placeholder");
assert.match(o5.contact!.email, /^[a-z]+@[a-z0-9]+\.example$/, "placeholder address on a reserved .example domain");
assert.equal(o5.versions.length, 1, "first draft recorded as a version");
assert.ok((o5.versions[0] as any).check, "every draft is fact-checked");
const { checkDraft, reviseDraft, saveEdits, pickContact } = await import("../src/lib/emailflow");
const bad = await checkDraft("Hi, we scored you 7 and your valuation of 99 is fine.", [{ id: "x", text: "30 customers" }], 0);
assert.equal(bad.pass, false, "forbidden words and unsourced numbers fail the check");
assert.ok(bad.issues.some((i) => /99/.test(i)) && bad.issues.some((i) => /scored|valuation/i.test(i)));
db.states[a5.id] = "DRAFTED";
await reviseDraft(db, a5.id, "make it shorter");
assert.equal(o5.versions.length, 2); assert.equal(o5.chat.length, 2, "revision adds a human and an AI chat line");
await saveEdits(db, a5.id, o5.draft!.body + "\nP.S. see you soon");
assert.equal(o5.versions.length, 3); assert.equal((o5.versions[2] as any).by, "human");
assert.equal(pickContact({ ...db.applications[a5.id], contact_email: "real@acme.com" }).email_source, "form", "a given email is used, never guessed");

// ---- add flow: pair files, then staged processing to AWAITING_REVIEW ----
const { createFromFiles, createFromName, advance, safeHost } = await import("../src/lib/addflow");
assert.equal(safeHost("localhost"), null); assert.equal(safeHost("http://169.254.169.254/x"), null); assert.equal(safeHost("10.0.0.5"), null);
assert.equal(safeHost("internal.corp"), null); assert.equal(safeHost("example.com"), "example.com");
const form = "Company name Acme Foods\n\nSector (as selected) Consumer brands\n\nStage (as selected) Pre-seed\n\nOne-line description Snacks for kids.\n\nFounder 1 Asha Rao, CEO. 5 years in FMCG.\n\nWebsite www.acmefoods.example";
const made = await createFromFiles(db, [{ name: "Acme_Deck.pdf", text: "Acme Foods\n\nSnacks for kids\n\nRepeat rate 35% over 90 days\n\nCAC INR 400 on Instagram" }, { name: "Acme_Form.pdf", text: form }]);
assert.equal(made.created.length, 1, "deck and form pair into one company"); assert.equal(made.created[0].company, "Acme Foods");
const acme = made.created[0].id;
assert.equal(db.states[acme], "INGESTED");
let steps = 0; while (!(await advance(db, acme)).done && steps++ < 10);
assert.equal(db.states[acme], "AWAITING_REVIEW"); assert.ok(db.assessments[acme]); assert.equal(db.pending[acme], undefined);
assert.equal((await createFromFiles(db, [{ name: "Acme_Form.pdf", text: form }])).skipped.length, 1, "adding the same company twice is skipped");
await assert.rejects(() => createFromName(db, "http://127.0.0.1/admin"), /public website/);

// ---- sectors: commerce infrastructure is its own bucket ----
{
  const { normaliseSector } = await import("../src/lib/ingest");
  assert.equal(normaliseSector("Commerce infrastructure", "", ""), "commerce_infrastructure");
  assert.equal(normaliseSector("", "Platform for small-town kirana stores", ""), "commerce_infrastructure");
  assert.equal(normaliseSector("Consumer brands", "", ""), "consumer_brand");
}

// ---- backtest overlap check: never against itself (any alias) or the other memo companies ----
{
  const { conflictCheck } = await import("../src/lib/conflict");
  const { nameKey } = await import("../src/lib/fundsite");
  assert.equal(nameKey("The ePlane Company"), nameKey("ePlane"), "one company under two names is one key");
  const d = emptyDB();
  d.fund.portfolio = [{ name: "ePlane", description: "electric aircraft for short flights", source: "x" }, { name: "Unbox Robotics", description: "warehouse sorting robots", source: "x" }, { name: "Fleetx", description: "fleet management software", source: "x" }];
  const t = { ...db.applications[acme], id: "eplane", company: "The ePlane Company", one_liner: "electric aircraft for short flights", deck_text: "electric aircraft and warehouse sorting robots for fleet management", is_backtest: true, conflict_exclude: ["The ePlane Company", "Unbox Robotics"] };
  const flags = await conflictCheck(d, t as any);
  assert.ok(!flags.some((f) => /eplane|unbox/i.test(f.portfolio_company)), "no self or peer overlap in a backtest");
  assert.ok(flags.some((f) => /fleetx/i.test(f.portfolio_company)), "a real portfolio overlap is still flagged");
}

// ---- PDF text extraction (uses the case PDF if present) ----
import fs from "node:fs";
if (fs.existsSync("Case.pdf")) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync("Case.pdf")));
  const { text } = await extractText(pdf, { mergePages: true });
  assert.ok(text.length > 1000, "PDF text extracted");
}
// ---- old-shaped records (made before versions/chat/contact existed) must not crash the email code ----
const { learnFromFeedback, standingNotes, removeNote } = await import("../src/lib/emailflow");
const old = db.applications[acme];
db.states[acme] = "DRAFTED";
db.outreach[acme] = { app_id: acme, state: "DRAFTED", draft: { subject: "s", body: "Hi Asha,\n\nCan we talk for 30 minutes?\n\nThe team, All In Capital" }, followups_sent: 0 } as any; // no versions, chat, attendees
await reviseDraft(db, acme, "shorter please");
assert.equal(db.outreach[acme].versions.length, 1); assert.ok(old);
await saveEdits(db, acme, db.outreach[acme].draft!.body + "\nThanks");
assert.equal(db.outreach[acme].versions.length, 2);

// ---- feedback memory: a reason, or a repeat, makes a note stand; a one-off does not ----
db.draft_notes = [];
const m1 = await learnFromFeedback(db, "Mention their pilot customers");
assert.equal(db.draft_notes[0].standing, false, "a one-off request is not saved as a standing rule"); assert.match(m1, /ask again/);
const m2 = await learnFromFeedback(db, "Please mention their pilot customers again");
assert.equal(db.draft_notes.length, 1, "a similar request updates the same note"); assert.equal(db.draft_notes[0].count, 2); assert.equal(db.draft_notes[0].standing, true);
await learnFromFeedback(db, "Keep it under 100 words because founders read these on their phones");
assert.equal(db.draft_notes.length, 2); assert.ok(db.draft_notes[0].standing, "an instruction with a reason is saved straight away");
assert.equal(standingNotes(db).length, 2); assert.match(standingNotes(db).join(" "), /asked 2 times/);
removeNote(db, db.draft_notes[0].id); assert.equal(db.draft_notes.length, 1);
void m2;
console.log("selftest OK:", db.audit.length, "audit entries,", db.corrections.length, "correction(s)");
