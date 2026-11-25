// Tests the mail loop end to end with the network stubbed: reading replies, mail modes, Resend sending, Cal.com booking,
// the inbound webhook logic and its signature check. Nothing real is sent or booked.
process.env.GEMINI_API_KEY = ""; process.env.MAIL_MODE = "mock"; process.env.SKIP_FUND_SCRAPE = "1";
for (const k of ["MAIL_TEST_RECIPIENT", "RESEND_API_KEY", "CAL_API_KEY", "CAL_EVENT_TYPE_ID", "DEEPTECH_PARTNER_EMAIL", "RESEND_INBOUND_ADDRESS"]) delete process.env[k];
import assert from "node:assert/strict";
import { emptyDB } from "../src/lib/store";
import { createFromFiles, advance } from "../src/lib/addflow";
import { submitReview } from "../src/lib/pipeline";
import { approveAndSend, draftEmail, inAllowedWindow } from "../src/lib/outreach";
import { calendarLines, excludedDays, extractReply, findPhone, normalisePhone, pickedNumber, processReply, stripQuoted } from "../src/lib/replies";
import { flushMail, mailMode, parseRef, queueMail } from "../src/lib/mail";
import { signSvix, verifySvix } from "../src/lib/svix";
import { handleInboundEmail } from "../src/lib/inbound";
import { calCancel } from "../src/lib/cal";
import { getOut } from "../src/lib/emailflow";
import type { DB, Message } from "../src/lib/schemas";

const t0 = new Date("2026-12-01T05:00:00Z"); // a Tuesday
const real = globalThis.fetch;
const calls: { url: string; init?: RequestInit }[] = [];
function stub(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  calls.length = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const unstub = () => { globalThis.fetch = real; };

// ---- readers ----
assert.equal(normalisePhone("98765 43210"), "+919876543210");
assert.equal(normalisePhone("+91 98765-43210"), "+919876543210");
assert.equal(normalisePhone("09876543210"), "+919876543210");
assert.equal(normalisePhone("+1 415 555 0100"), "+14155550100");
assert.equal(normalisePhone("12345"), undefined);
assert.equal(findPhone("Thursday works, call me on 98765 43210 after 4"), "+919876543210");
assert.equal(findPhone("See you on 2026-12-03"), undefined, "a date is not a phone number");
assert.equal(stripQuoted("Yes please.\n\nOn Tue, 1 Dec 2026 at 10:00, Team <t@x.com> wrote:\n> Hi there\n> options"), "Yes please.");
assert.equal(pickedNumber("2 works", 3), 2); assert.equal(pickedNumber("option 3 please", 3), 3); assert.equal(pickedNumber("2 works", 1), null); assert.equal(pickedNumber("Thursday at 4", 3), null);
assert.equal(parseRef("Re: All In Capital x Acme [ref:acme-foods]"), "acme-foods");
assert.equal(inAllowedWindow("2026-12-03T09:30:00Z"), true, "Thursday 15:00 IST");
assert.equal(inAllowedWindow("2026-12-07T09:30:00Z"), false, "Monday");
assert.equal(inAllowedWindow("2026-12-03T05:30:00Z"), false, "Thursday 11:00 IST is before the window");
assert.equal(inAllowedWindow("2026-12-03T12:15:00Z"), false, "ends after 18:00 IST");

// ---- days the founder rules out are never booked, whatever the model says ----
assert.deepEqual([...excludedDays("Any weekday after lunch except Wednesday")], [3]);
assert.deepEqual([...excludedDays("Tuesday works, not Thursday")], [4]);
assert.deepEqual([...excludedDays("I can't do Fridays")], [5]);
assert.equal(excludedDays("Not for now, thanks").size, 0); assert.equal(excludedDays("Monday works").size, 0);
assert.equal(calendarLines(t0, 3), "Tue 2026-12-01\nWed 2026-12-02\nThu 2026-12-03", "the model is handed a printed calendar");
{
  const ex = await extractReply("Tuesday or Thursday works, but not Thursday. Tuesday afternoon then.", { now: t0, offered: [] });
  assert.ok(ex.windows.length > 0 && ex.windows.every((w) => new Date(Date.parse(w.start) + 330 * 60000).getUTCDay() === 2), "only Tuesdays survive");
}

// ---- webhook signature ----
const secret = "whsec_" + Buffer.from("test-secret-bytes").toString("base64");
const body = JSON.stringify({ type: "email.received" });
const ts = String(Math.floor(Date.now() / 1000));
const sig = signSvix(body, "msg_1", ts, secret);
assert.equal(verifySvix(body, { id: "msg_1", timestamp: ts, signature: sig }, secret), true);
assert.equal(verifySvix(body + " ", { id: "msg_1", timestamp: ts, signature: sig }, secret), false, "a changed body fails");
assert.equal(verifySvix(body, { id: "msg_1", timestamp: ts, signature: "v1,AAAA" }, secret), false);
assert.equal(verifySvix(body, { id: "msg_1", timestamp: String(Number(ts) - 3600), signature: signSvix(body, "msg_1", String(Number(ts) - 3600), secret) }, secret), false, "an old request fails");
assert.equal(verifySvix(body, { id: "msg_1", timestamp: ts, signature: `v1,bad ${sig}` }, secret), true, "any listed signature may match");

// ---- modes ----
assert.equal(mailMode(), "mock");
process.env.MAIL_MODE = "test"; assert.equal(mailMode(), "mock", "test without a recipient falls back to mock");
process.env.MAIL_TEST_RECIPIENT = "owner@example.org"; assert.equal(mailMode(), "test");
process.env.MAIL_MODE = "live"; assert.equal(mailMode(), "live");
process.env.MAIL_MODE = "mock"; delete process.env.MAIL_TEST_RECIPIENT;

// ---- helper: an application that has been sent the invitation ----
async function sentApp(db: DB, company: string, sector = "Consumer brands", founder = "Asha Rao") {
  const form = `Company name ${company}\n\nSector (as selected) ${sector}\n\nStage (as selected) Pre-seed\n\nOne-line description Snacks for kids.\n\nFounder 1 ${founder}, CEO. 5 years in FMCG.\n\nWebsite www.${company.toLowerCase()}.example`;
  const made = await createFromFiles(db, [{ name: `${company}_Deck.pdf`, text: `${company}\n\nSnacks for kids\n\nRepeat rate 35% over 90 days` }, { name: `${company}_Form.pdf`, text: form }]);
  const id = made.created[0].id;
  let n = 0; while (!(await advance(db, id)).done && n++ < 10);
  submitReview(db, id, "partner", "take_call", "Testing the mail loop");
  await draftEmail(db, id);
  await approveAndSend(db, id, "associate", t0);
  return id;
}

// ---- mock mode: the whole loop, with a phone number and a free-text window ----
{
  const db = emptyDB();
  const id = await sentApp(db, "Acme");
  const o = getOut(db, id);
  assert.equal(db.states[id], "AWAITING_REPLY");
  assert.equal(o.thread.length, 1); assert.equal((o.thread[0] as Message).via, "mock"); assert.equal((o.thread[0] as Message).status, "recorded");
  assert.match((o.thread[0] as Message).to, /@acme\.example$/, "placeholder contact");
  await processReply(db, id, "Yes! Thursday afternoon works for me. My number is 98765 43210.", { via: "simulated", now: t0 });
  assert.equal(db.states[id], "SCHEDULED");
  assert.equal(o.phone, "+919876543210");
  assert.equal(o.meeting?.provider, "mock"); assert.ok(inAllowedWindow(o.meeting!.start), "booked inside Tuesday or Thursday afternoon");
  const kinds = (o.thread as Message[]).map((m) => `${m.dir}:${m.kind}`);
  assert.deepEqual(kinds, ["out:invite", "in:reply", "out:confirmation"]);
  const reply = (o.thread as Message[])[1];
  assert.equal(reply.extracted?.intent, "yes"); assert.equal(reply.extracted?.phone, "+919876543210");
  assert.match((o.thread[2] as Message).body, /\+919876543210/, "the confirmation repeats the number we have");
}

// ---- a time we don't offer gets new options; a pick books; a question and a decline go to a person ----
{
  const db = emptyDB();
  const id = await sentApp(db, "Brewco");
  const o = getOut(db, id);
  await processReply(db, id, "Can we do Monday morning instead?", { via: "simulated", now: t0 });
  assert.equal(db.states[id], "SCHEDULING"); assert.equal(o.proposed_slots.length, 3); assert.ok(o.proposed_slots.every(inAllowedWindow));
  assert.equal((o.thread as Message[]).filter((m) => m.kind === "slots").length, 1);
  await processReply(db, id, "2 works", { via: "simulated", now: t0 });
  assert.equal(db.states[id], "SCHEDULED");

  const q = emptyDB(); const qid = await sentApp(q, "Quizco");
  await processReply(q, qid, "Before we set a time, what size of cheque do you usually write?", { via: "simulated", now: t0 });
  assert.equal(q.states[qid], "FLAGGED"); assert.match(getOut(q, qid).needs_human ?? "", /asked/);

  const d = emptyDB(); const did = await sentApp(d, "Declco");
  await processReply(d, did, "Thanks, but we are not interested right now.", { via: "simulated", now: t0 });
  assert.equal(d.states[did], "FLAGGED");

  const v = emptyDB(); const vid = await sentApp(v, "Vagueco");
  await processReply(v, vid, "Thanks, I'll have a think.", { via: "simulated", now: t0 });
  assert.equal(v.states[vid], "AWAITING_REPLY", "a vague reply keeps waiting; nothing is sent");
  assert.equal(getOut(v, vid).thread.length, 2);
}

// ---- test mode: mail goes to the test inbox only, through Resend ----
{
  process.env.MAIL_MODE = "test"; process.env.MAIL_TEST_RECIPIENT = "owner@example.org"; process.env.RESEND_API_KEY = "re_test_key";
  const db = emptyDB();
  const id = await sentApp(db, "Testco");
  const o = getOut(db, id);
  const m = o.thread[0] as Message;
  assert.equal(m.to, "owner@example.org", "never the founder in test mode"); assert.equal(m.via, "resend"); assert.equal(m.status, "queued");
  assert.match(m.subject, /\[ref:testco\]/, "a reply can find its application");
  stub(() => ({ body: { id: "em_123" } }));
  const r = await flushMail(db);
  assert.deepEqual(r, { sent: 1, failed: 0 });
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  const sentBody = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(sentBody.to, ["owner@example.org"]); assert.equal(sentBody.text, m.body);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer re_test_key");
  assert.equal(m.status, "sent"); assert.equal(m.provider_id, "em_123");
  assert.deepEqual(await flushMail(db), { sent: 0, failed: 0 }, "nothing is sent twice");

  queueMail(db, id, "followup", "Re: x", "nudge");
  stub(() => ({ status: 422, body: { message: "The domain is not verified" } }));
  const f = await flushMail(db);
  assert.equal(f.failed, 1); assert.equal((o.thread[o.thread.length - 1] as Message).status, "failed"); assert.match((o.thread[o.thread.length - 1] as Message).error ?? "", /not verified/);
  unstub();
}

// ---- Cal.com booking (test mode): real slots, phone, guest for deeptech, test inbox as attendee ----
{
  process.env.MAIL_MODE = "test"; process.env.MAIL_TEST_RECIPIENT = "owner@example.org"; process.env.RESEND_API_KEY = "re_test_key";
  process.env.CAL_API_KEY = "cal_test_key"; process.env.CAL_EVENT_TYPE_ID = "123"; process.env.DEEPTECH_PARTNER_EMAIL = "partner@example.org";
  const db = emptyDB();
  const id = await sentApp(db, "Deepco", "Deeptech", "Ravi Nair");
  const o = getOut(db, id);
  assert.ok(o.attendees.includes("deeptech_partner"));
  stub((url) => {
    if (url.includes("/v2/slots")) return { body: { status: "success", data: { "2026-12-03": [{ start: "2026-12-03T15:00:00.000+05:30" }], "2026-12-07": [{ start: "2026-12-07T15:00:00.000+05:30" }], "2026-12-08": [{ start: "2026-12-08T11:00:00.000+05:30" }] } } };
    if (url.endsWith("/v2/bookings")) return { body: { status: "success", data: { uid: "bk_1", start: "2026-12-03T09:30:00.000Z", end: "2026-12-03T10:00:00.000Z", meetingUrl: "https://cal.example/m/bk_1" } } };
    return { status: 404, body: {} };
  });
  await processReply(db, id, "Thursday afternoon is good. Call me on +91 98765 43210.", { via: "simulated", now: t0 });
  const slotsCall = calls.find((c) => c.url.includes("/v2/slots"))!;
  assert.match(slotsCall.url, /eventTypeId=123/); assert.equal((slotsCall.init?.headers as Record<string, string>)["cal-api-version"], "2024-09-04");
  const bookCall = calls.find((c) => c.url.endsWith("/v2/bookings"))!;
  const b = JSON.parse(String(bookCall.init?.body));
  assert.equal((bookCall.init?.headers as Record<string, string>)["cal-api-version"], "2024-08-13");
  assert.equal(b.eventTypeId, 123); assert.equal(b.start, "2026-12-03T09:30:00.000Z");
  assert.equal(b.attendee.email, "owner@example.org", "the test inbox is the attendee, not the founder");
  assert.equal(b.attendee.phoneNumber, "+919876543210"); assert.deepEqual(b.guests, ["partner@example.org"]); assert.equal(b.metadata.application, id);
  assert.equal(db.states[id], "SCHEDULED"); assert.equal(o.meeting?.provider, "cal"); assert.equal(o.meeting?.uid, "bk_1"); assert.equal(o.meeting?.url, "https://cal.example/m/bk_1");
  assert.match((o.thread[o.thread.length - 1] as Message).body, /cal\.example/);

  stub(() => ({ body: {} })); await calCancel("bk_1");
  assert.match(calls[0].url, /\/v2\/bookings\/bk_1\/cancel$/); assert.equal(calls[0].init?.method, "POST");

  // a booking that fails must reach a person, not vanish
  const db2 = emptyDB();
  const id2 = await sentApp(db2, "Failco");
  stub((url) => url.includes("/v2/slots") ? { body: { data: { "2026-12-03": [{ start: "2026-12-03T15:00:00.000+05:30" }] } } } : { status: 400, body: { error: { message: "That time was just taken" } } });
  await processReply(db2, id2, "Thursday afternoon works.", { via: "simulated", now: t0 });
  assert.equal(db2.states[id2], "FLAGGED"); assert.match(getOut(db2, id2).needs_human ?? "", /just taken/);
  unstub();
}

// ---- inbound mail: found by its tag, from the right sender, once ----
{
  process.env.MAIL_MODE = "test"; process.env.MAIL_TEST_RECIPIENT = "owner@example.org"; delete process.env.CAL_API_KEY; delete process.env.CAL_EVENT_TYPE_ID;
  const db = emptyDB();
  const id = await sentApp(db, "Inbo");
  const o = getOut(db, id);
  const subject = (o.thread[0] as Message).subject;
  assert.deepEqual(await handleInboundEmail(db, { emailId: "r1", from: "stranger@evil.test", subject, body: "yes" }), { ok: false, reason: "sender is not the person we wrote to", application: id });
  assert.equal(o.thread.length, 1, "a stranger's mail is not added");
  assert.equal((await handleInboundEmail(db, { emailId: "r2", from: "Owner <owner@example.org>", subject: "Re: hello", body: "yes" })).ok, false, "no tag, no match");
  const ok = await handleInboundEmail(db, { emailId: "r3", from: "Owner <Owner@Example.org>", subject: "Re: " + subject, body: "Yes, happy to talk. Tuesday afternoon, 98765 43210" });
  assert.equal(ok.ok, true); assert.equal(db.states[id], "SCHEDULED");
  assert.equal((await handleInboundEmail(db, { emailId: "r3", from: "owner@example.org", subject, body: "again" })).duplicate, true, "a repeated delivery is ignored");
  assert.equal((o.thread as Message[]).filter((m) => m.dir === "in").length, 1);
}

console.log("mail tests OK");
