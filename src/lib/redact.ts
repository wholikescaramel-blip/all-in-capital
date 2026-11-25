import { findPhone } from "./phone";

// What may leave the building. Names become [F1], [F2]; emails, phone numbers and LinkedIn links never go to a model.
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LINKEDIN = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s)>\]]*/gi;
const PHONE = /\+?\d[\d\s().-]{8,16}\d/g;

const tokens = (names: string[]) => [...new Set(names.flatMap((n) => n.split(/\s+/)).map((t) => t.replace(/[^\p{L}'-]/gu, "")).filter((t) => t.length >= 3 && !/^(dr|mr|mrs|ms|prof)$/i.test(t)))];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redact(text: string, founderNames: string[]): string {
  let t = text.replace(EMAIL, "[email]").replace(LINKEDIN, "[linkedin]").replace(PHONE, (m) => (findPhone(m) ? "[phone]" : m));
  founderNames.forEach((full, i) => {
    const parts = [full, ...tokens([full])].sort((a, b) => b.length - a.length);
    for (const p of parts) t = t.replace(new RegExp(`\\b${esc(p)}\\b`, "gi"), `[F${i + 1}]`);
  });
  return t;
}

// Put the first names back into the finished email.
export function restoreNames(text: string, founderNames: string[]): string {
  return founderNames.reduce((t, full, i) => t.replaceAll(`[F${i + 1}]`, full.replace(/^dr\.?\s+/i, "").split(/\s+/)[0]), text);
}

// Throws if a prompt still holds anything that must not leave. Run on every prompt that goes to a model for an email.
export function assertNoPII(prompt: string, founderNames: string[]): void {
  const bad: string[] = [];
  if (new RegExp(EMAIL.source, "i").test(prompt)) bad.push("an email address");
  if (new RegExp(LINKEDIN.source, "i").test(prompt)) bad.push("a LinkedIn link");
  for (const m of prompt.match(PHONE) ?? []) if (findPhone(m)) { bad.push("a phone number"); break; }
  for (const t of tokens(founderNames)) if (new RegExp(`\\b${esc(t)}\\b`, "i").test(prompt)) { bad.push("a founder's name"); break; }
  if (bad.length) throw new Error(`PII guard: the prompt still contains ${bad.join(" and ")}. Nothing was sent to the model.`);
}
