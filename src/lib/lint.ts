import { PROCESS } from "../config/process";

// The linter decides whether an email meets the house standard. The model only drafts; this code accepts or rejects.
export type EmailKind = "invite" | "dig" | "pass" | "followup";
export type Lint = { pass: boolean; issues: string[]; words: number };

const PRAISE = /\b(impressive|amazing|exciting|excited|fantastic|incredible|brilliant|great|love|loved|thrilled|excellent|congrat\w*|stellar|remarkable|wonderful|awesome|stunning|outstanding)\b/i;
const BANNED = /\b(delve|leverage|utili[sz]e|robust|cutting-edge|game-changer|transformative|reach out|reaching out|touch base|circle back|synergy|hope this finds you)\b/i;
const NOT_BUT = /\bnot\s+(?:just\s+|only\s+|merely\s+)?[^.,;:!?\n]{1,40}?,?\s+but\b/i;
const THROAT = /^(i\s+(just\s+)?wanted\s+to|i\s+hope|i\s+am\s+writing|i'?m\s+writing|just\s+(a\s+quick|checking|following)|quick\s+(note|one)|hope\s+you|i\s+came\s+across|i'?d\s+like\s+to\s+take|trust\s+this|as\s+per)/i;
const SUMMARY = /\b(in\s+summary|to\s+summari[sz]e|to\s+sum\s+up|in\s+conclusion|looking\s+forward\s+to\s+(hearing|speaking|your|our)|i\s+look\s+forward)\b/i;
const ACCUSE = /\b(you\s+(lied|misled|inflated|faked|fabricated|exaggerated)|fraud\w*|dishonest|lying|misrepresent\w*|fake)\b/i;
export const DAYTIME_RE = /\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat|sun)[a-z]*\b[^.?\n]{0,28}?\d{1,2}(?::\d{2})?\s*(?:am|pm)/gi;

const LIMITS: Record<EmailKind, { words: number; min: number; max: number }> = {
  invite: { words: 80, min: 1, max: 2 }, dig: { words: 120, min: 1, max: 2 }, pass: { words: 120, min: 0, max: 1 }, followup: { words: 120, min: 0, max: 1 },
};

export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const stripSlots = (s: string) => s.replace(/\{slot_\d\}/g, " ");

export function firstSentence(body: string): string {
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const para = paras.find((p) => !/^(hi|hello|hey|dear)\b[^\n]{0,60}$/i.test(p)) ?? "";
  return (para.split(/(?<=[.?!])\s+/)[0] ?? "").trim();
}

export function lintEmail(kind: EmailKind, subject: string, body: string, opts: { deeptech?: boolean; signer?: string } = {}): Lint {
  const issues: string[] = [], L = LIMITS[kind], signer = opts.signer ?? PROCESS.signer;
  const words = wordCount(body);
  if (words > L.words) issues.push(`Too long: ${words} words, the limit for this email is ${L.words}.`);
  if (wordCount(subject) > 7) issues.push(`The subject has ${wordCount(subject)} words. Keep it to 7 or fewer.`);
  if (!/\d/.test(stripSlots(firstSentence(body)))) issues.push("The first sentence must cite a number from their application.");

  const q = (body.match(/\?/g) ?? []).length;
  if (q < L.min || q > L.max) issues.push(`It has ${q} question mark${q === 1 ? "" : "s"}; this email should have ${L.min === L.max ? L.min : `${L.min} to ${L.max}`}.`);

  if (kind === "invite") {
    const placeholders = body.includes("{slot_1}") && body.includes("{slot_2}");
    const real = new Set((body.match(DAYTIME_RE) ?? []).map((m) => m.toLowerCase())).size >= 2;
    if (!placeholders && !real) issues.push("The invite must offer two times: write {slot_1} and {slot_2}, or two real weekday-and-time phrases.");
    if (!/neither\s+suits\s+you,?\s+reply\s+with\s+a\s+time\s+that\s+does/i.test(body)) issues.push('Include the line "If neither suits you, reply with a time that does."');
    if (!/30\s+minutes/i.test(body)) issues.push("Say the call is 30 minutes.");
    if (PRAISE.test(body)) issues.push(`Praise word "${body.match(PRAISE)![0]}". Invites carry no praise.`);
    if (opts.deeptech && !/aditya/i.test(body)) issues.push('For deeptech and hardware, add: "Our partner Aditya will join us for the technical part."');
  }
  if (kind === "pass" && ACCUSE.test(body)) issues.push("A pass email must never accuse. Ask for the numbers instead.");

  const lines = body.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.at(-2) !== signer || lines.at(-1) !== PROCESS.fund_name) issues.push(`Sign off with "${signer}" on one line and "${PROCESS.fund_name}" on the next.`);

  const text = `${subject}\n${body}`;
  if (/[—–]/.test(text)) issues.push("No em dashes or en dashes.");
  const b = text.match(BANNED); if (b) issues.push(`Banned word or phrase: "${b[0]}".`);
  if (NOT_BUT.test(body)) issues.push('Avoid the "not X but Y" construction.');
  if (THROAT.test(firstSentence(body))) issues.push("Start with the point, not a throat-clearing opener.");
  if (SUMMARY.test(body)) issues.push("No summary sign-off.");
  return { pass: issues.length === 0, issues, words };
}
