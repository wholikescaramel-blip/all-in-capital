import { z } from "zod";
import type { Application, DB, DraftCheck, DraftVersion, Outreach } from "./schemas";
import { completeJSON, hasLLM } from "./llm";
import { PROCESS } from "../config/process";
import { nowISO } from "./store";

const S = z.coerce.string();

// ---------- who the email goes to ----------
// The contact is the founder named on the application (CEO first). We never guess a real address: if the applicant gave
// none, a placeholder on a reserved .example domain stands in, so the flow can be shown end to end without a real person.
export function pickContact(app: Application): NonNullable<Outreach["contact"]> {
  const f = app.founders.find((x) => /ceo|chief exec|founder/i.test(x.role ?? "")) ?? app.founders[0];
  const name = f?.name ?? "the founder";
  const given = app.contact_email || app.form_fields["Email"] || app.form_fields["Contact email"];
  if (given && /@/.test(given)) return { name, role: f?.role, email: given.trim(), email_source: "form" };
  const first = name.replace(/^dr\.?\s+/i, "").split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "") || "founder";
  return { name, role: f?.role, email: `${first}@${app.id.replace(/[^a-z0-9]/g, "")}.example`, email_source: "placeholder" };
}

// ---------- facts the draft may use ----------
type Fact = { id: string; text: string };
const NOT_FOR_EMAIL = /^(Valuation expectation|Equity split|Amount raising|Existing investors|Other investors|How did you hear|Use of funds|Time commitment)/i;

export function factsFor(db: DB, app: Application): Fact[] {
  return db.evidence
    .filter((e) => e.app_id === app.id && ["form", "deck", "scrape"].includes(e.source_type) && !NOT_FOR_EMAIL.test(e.claim))
    .slice(0, 45)
    .map((e) => ({ id: e.id, text: e.claim.replace(/\s+/g, " ").slice(0, 230) }));
}
const askTopics = (db: DB, app: Application) =>
  db.gaps.filter((g) => g.app_id === app.id && !["candour", "research"].includes(g.criterion)).slice(0, 3).map((g) => g.what_missing.replace(/\s+/g, " ").slice(0, 160));

const attendeesText = (who: string[]) => (who.includes("deeptech_partner") ? "our associate and our deeptech partner" : "our associate");

// ---------- checks that do not need a model ----------
const FORBIDDEN = /\b(scores?|scored|rating|rubric|recommend(ation|ed)?|conflicts?|portfolio|valuation|cheque|check size|term sheet)\b/i;
const ALLOWED_NUMBERS = new Set(["30", "3"]);
const digits = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));

function hardChecks(body: string, facts: Fact[]): string[] {
  const issues: string[] = [];
  const factNums = new Set(facts.flatMap((f) => digits(f.text)));
  for (const n of new Set(digits(body))) if (!ALLOWED_NUMBERS.has(n) && !factNums.has(n)) issues.push(`The number ${n} does not appear in the application.`);
  const bad = body.match(FORBIDDEN);
  if (bad) issues.push(`Mentions "${bad[0]}". Internal or deal terms must stay out of the email.`);
  const words = body.trim().split(/\s+/).length;
  if (words > 170) issues.push(`Too long (${words} words). Keep it under 150.`);
  return issues;
}

const RULES = `You write a short first-contact email from an early-stage investment firm to a founder who applied, inviting them to a call.
CONTENT:
- Greet the founder by first name.
- One line on why we are writing, quoting one specific fact from their application (use the exact figures).
- Ask for 30 minutes, on a Tuesday or Thursday afternoon (India time), say who joins, and say we will send three slots or they can reply with a preference.
- Include one or two things we want to go through on the call. Use the QUESTION TOPICS, phrased as curiosity ("we'd like to hear how repeat orders look"), never as criticism.
- Optional: one line on what to have ready (for example cohort or repeat data) if a topic calls for it.
STYLE: write like a person, not a template. Open with the point. Short sentences, contractions are fine, under 120 words, 3 short paragraphs at most. No flattery, no hype, no promises about outcome.
Never use: "I hope this finds you well", "we are writing", "reaching out", "noting that", "touch base", "delve", "leverage", "exciting", "impressive", "journey".
Good example of the voice: "Hi Asha, we read the Acme application and the 90-day repeat rate of 35% stood out. Could we get 30 minutes with you on a Tuesday or Thursday afternoon (India time)? Our associate would join. We'd like to hear how that repeat number splits by channel. Reply with a time or say 'yes' and we'll send three slots."
Sign off "The team, ${PROCESS.fund_name}".
HARD RULES:
- Every fact about the company must come from FACTS below, with the same numbers. Do not invent or round anything.
- Never mention scores, ratings, our recommendation, weaknesses, portfolio companies, conflicts, valuation, cheque size, other investors, or other applicants.
- List the ids of the facts you used in facts_used.`;

type Draft = { subject: string; body: string };

function templateDraft(app: Application, contact: NonNullable<Outreach["contact"]>, who: string[], facts: Fact[]): Draft {
  const first = contact.name.replace(/^dr\.?\s+/i, "").split(/\s+/)[0];
  const line = app.one_liner ? ` We read about ${app.company}: ${app.one_liner.replace(/\.$/, "")}.` : ` We read the ${app.company} application.`;
  void facts;
  return {
    subject: `${PROCESS.fund_name} x ${app.company}: a 30-minute call?`,
    body: `Hi ${first},\n\nThanks for applying to ${PROCESS.fund_name}.${line} We'd like to talk it through on a 30-minute call with ${attendeesText(who)}, on a Tuesday or Thursday afternoon (India time).\n\nReply "yes" and we'll send three slots, or tell us what suits you.\n\nBest,\nThe team, ${PROCESS.fund_name}`,
  };
}

async function writeDraft(app: Application, contact: NonNullable<Outreach["contact"]>, who: string[], facts: Fact[], topics: string[], extra: { base?: string; instruction?: string; issues?: string[] }): Promise<Draft> {
  const user = [
    `FOUNDER: ${contact.name}${contact.role ? ` (${contact.role})` : ""}`,
    `COMPANY: ${app.company}`,
    `WHO JOINS: ${attendeesText(who)}`,
    `FACTS:\n${facts.map((f) => `[${f.id}] ${f.text}`).join("\n")}`,
    `QUESTION TOPICS:\n${topics.length ? topics.map((t) => `- ${t}`).join("\n") : "- (none; just ask for the call)"}`,
    extra.base ? `CURRENT DRAFT:\n${extra.base}` : "",
    extra.instruction ? `REVIEWER'S INSTRUCTION (follow it, keep all rules): ${extra.instruction}` : "",
    extra.issues?.length ? `PROBLEMS FOUND IN THE LAST VERSION (fix all of them):\n${extra.issues.map((i) => `- ${i}`).join("\n")}` : "",
    `Return {"subject": string, "body": string, "facts_used": string[]}`,
  ].filter(Boolean).join("\n\n");
  const r = await completeJSON({ system: RULES, user, schema: z.object({ subject: S, body: S, facts_used: z.array(S).optional() }), model: "smart", max_tokens: 2500 });
  return { subject: r.subject.trim(), body: r.body.trim() };
}

const CheckOut = z.object({
  claims: z.array(z.object({ text: S, fact_id: S.nullable().optional(), quote: S.optional(), supported: z.coerce.boolean(), note: S.optional() })).default([]),
  issues: z.array(S).default([]),
});

export async function checkDraft(body: string, facts: Fact[], rounds: number): Promise<DraftCheck> {
  const hard = hardChecks(body, facts);
  if (!hasLLM()) return { pass: hard.length === 0, claims: [], issues: [...hard, ...(hard.length ? [] : ["No model available: only number and wording checks were run."])].slice(0, 6), rounds };
  try {
    const r = await completeJSON({
      system: `You are a strict fact-checker for an investor's outreach email. List EVERY factual statement the email makes about the founder or company (numbers, customers, product, background, places, dates). For each, give the id of the fact that supports it and a short exact quote from that fact. supported=false if no fact supports it or any figure differs. Also list rule breaks in "issues", in plain words: mentions of scores, ratings or a recommendation; criticism of the company; portfolio companies or conflicts; valuation, cheque size or other investors; promises about outcome; no clear ask for a call.`,
      user: `EMAIL:\n${body}\n\nFACTS:\n${facts.map((f) => `[${f.id}] ${f.text}`).join("\n")}\n\nReturn {"claims":[{"text","fact_id","quote","supported","note"}],"issues":[string]}`,
      schema: CheckOut, model: "fast", max_tokens: 3000,
    });
    const ids = new Set(facts.map((f) => f.id));
    const claims = r.claims.map((c) => ({ ...c, fact_id: c.fact_id && ids.has(c.fact_id) ? c.fact_id : null, supported: c.supported && !!c.fact_id && ids.has(c.fact_id) }));
    const issues = [...claims.filter((c) => !c.supported).map((c) => `Not backed by the application: "${c.text}"`), ...r.issues, ...hard];
    return { pass: issues.length === 0, claims, issues: [...new Set(issues)].slice(0, 8), rounds };
  } catch (e) {
    return { pass: false, claims: [], issues: [...hard, "The fact-check could not run. Check the facts by hand before sending."], rounds };
  }
}

const getOut = (db: DB, id: string): Outreach => (db.outreach[id] ??= { app_id: id, state: "NONE", followups_sent: 0, replies: [], proposed_slots: [], attendees: [], versions: [], chat: [] });

// Draft -> fact-check -> fix, repeated until it passes or the round/time budget runs out. A failing draft is never hidden.
export async function draftWithChecks(db: DB, appId: string, opts: { instruction?: string; base?: string; maxRounds?: number; budgetMs?: number } = {}): Promise<DraftVersion> {
  const app = db.applications[appId];
  const o = getOut(db, appId);
  o.contact ??= pickContact(app);
  const who = o.attendees.length ? o.attendees : PROCESS.routing[app.sector] ?? PROCESS.routing.default;
  o.attendees = who;
  const facts = factsFor(db, app), topics = askTopics(db, app);
  const start = Date.now(), maxRounds = opts.maxRounds ?? 3, budget = opts.budgetMs ?? 40000;

  let draft: Draft = templateDraft(app, o.contact, who, facts);
  let check: DraftCheck = await checkDraft(draft.body, facts, 0);
  if (hasLLM()) {
    let issues: string[] = [];
    let base = opts.base;
    for (let round = 1; round <= maxRounds; round++) {
      try { draft = await writeDraft(app, o.contact, who, facts, topics, { base, instruction: opts.instruction, issues }); }
      catch { break; }
      check = await checkDraft(draft.body, facts, round);
      if (check.pass || Date.now() - start > budget) break;
      issues = check.issues; base = draft.body; // next round fixes what the checker found
    }
  }
  const v: DraftVersion = { n: o.versions.length + 1, at: nowISO(), by: "ai", instruction: opts.instruction, subject: draft.subject, body: draft.body, check };
  o.versions.push(v);
  o.draft = { subject: v.subject, body: v.body };
  return v;
}

// A reviewer's typed instruction becomes another draft + check cycle. The chat keeps the thread.
export async function reviseDraft(db: DB, appId: string, instruction: string) {
  const o = getOut(db, appId);
  if (!o.draft) throw new Error("No draft to revise");
  if (instruction.trim().length < 3) throw new Error("Type what you want changed");
  o.chat.push({ at: nowISO(), who: "human", text: instruction.trim() });
  const v = await draftWithChecks(db, appId, { instruction: instruction.trim(), base: o.draft.body });
  o.chat.push({ at: nowISO(), who: "ai", text: summary(v) });
  return v;
}

// A manual edit becomes its own version and gets the same fact-check.
export async function saveEdits(db: DB, appId: string, body: string) {
  const app = db.applications[appId], o = getOut(db, appId);
  if (!o.draft) throw new Error("No draft to edit");
  const check = await checkDraft(body, factsFor(db, app), 0);
  const v: DraftVersion = { n: o.versions.length + 1, at: nowISO(), by: "human", subject: o.draft.subject, body, check };
  o.versions.push(v);
  o.draft = { subject: v.subject, body };
  o.chat.push({ at: nowISO(), who: "ai", text: `Saved your edit. ${summary(v)}` });
  return v;
}

export function summary(v: DraftVersion) {
  const c = v.check;
  if (!c) return "Updated.";
  const n = c.claims.length;
  if (c.pass) return n ? `Updated. Fact-check passed: ${n} claim${n > 1 ? "s" : ""}, all matched to the application.` : "Updated. Number and wording checks passed.";
  return `Updated, but ${c.issues.length} thing${c.issues.length > 1 ? "s" : ""} still need a look: ${c.issues.slice(0, 2).join(" ")}`;
}

export function restoreVersion(db: DB, appId: string, n: number) {
  const o = getOut(db, appId);
  const v = (o.versions as DraftVersion[]).find((x) => x.n === n);
  if (!v) throw new Error("No such version");
  o.draft = { subject: v.subject, body: v.body };
  o.chat.push({ at: nowISO(), who: "ai", text: `Switched back to version ${n}.` });
}
