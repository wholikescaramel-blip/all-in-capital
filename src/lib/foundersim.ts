import { z } from "zod";
import type { DB, Message } from "./schemas";
import { completeJSON, hasLLM } from "./llm";
import { fmt, getOut } from "./outreach";
import { pickContact } from "./emailflow";

export const SCENARIOS = {
  eager: "Eager. Say yes, offer two windows (use the options we listed if there are any, otherwise a Tuesday or Thursday afternoon next week), and include your mobile number.",
  offtime: "Keen, but you can only do Monday morning or Friday after 6pm, which we did not offer. Include your mobile number.",
  question: "Interested but not ready to agree. Ask one practical question about how the process works or what size of cheque the fund writes.",
  vague: "Positive but non-committal: thanks them, says you'll check your calendar, and gives no times and no number.",
  decline: "Politely decline: you are not raising right now.",
} as const;
export type Scenario = keyof typeof SCENARIOS;

const OFFLINE: Record<Scenario, (name: string, offered: string[]) => string> = {
  eager: (n, o) => `Hi, thanks for reaching out. Yes, happy to talk. ${o.length ? `Options ${Math.min(2, o.length)} or 1 both work for me.` : "I'm free Tuesday or Thursday afternoons next week."} My number is +91 98765 43210.\n\n${n}`,
  offtime: (n) => `Hi, thanks. I'd love to talk, but I can only do Monday morning or Friday after 6pm. Could we do one of those? Call me on +91 98765 43210.\n\n${n}`,
  question: (n) => `Hi, thanks for the note. Before we set a time, could you tell me what size of cheque you usually write at this stage?\n\n${n}`,
  vague: (n) => `Hi, thanks for reaching out. Sounds interesting, I'll check my calendar and get back to you.\n\n${n}`,
  decline: (n) => `Hi, thank you for the interest. We aren't raising right now, so I'll pass for the moment. Happy to stay in touch.\n\n${n}`,
};

// Writes a believable reply as the founder, for testing the reply flow. The reviewer can edit it before it is delivered.
export async function draftFounderReply(db: DB, appId: string, scenario: Scenario, now = new Date()): Promise<string> {
  const app = db.applications[appId], o = getOut(db, appId), c = o.contact ?? pickContact(app);
  const first = c.name.replace(/^dr\.?\s+/i, "").split(/\s+/)[0];
  const offered = o.proposed_slots.map((s, i) => `${i + 1}. ${fmt(new Date(s))}`);
  const lastOut = [...(o.thread as Message[])].reverse().find((m) => m.dir === "out");
  if (hasLLM()) {
    try {
      const r = await completeJSON({
        system: "You write the email a startup founder would send back to an investor who invited them to a call. Write only the email body, first person, natural and brief (under 90 words), no subject line, no placeholders, no brackets. Sign with the first name.",
        user: `You are ${c.name}${c.role ? `, ${c.role}` : ""} of ${app.company} (${app.one_liner}). ${app.founders[0]?.background ? `Your background: ${app.founders[0].background}` : ""}\n\nThe investor's last email to you:\n${lastOut?.body ?? o.draft?.body ?? "(an invitation to a 30-minute call)"}\n\n${offered.length ? `Times they offered:\n${offered.join("\n")}\n\n` : ""}Today is ${new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10)} (India).\nHow you reply: ${SCENARIOS[scenario]}\nIf you give a phone number, use a clearly fake one like +91 98765 43210.\n\nReturn {"body": string}`,
        schema: z.object({ body: z.coerce.string() }), model: "fast", temperature: 0.8, max_tokens: 800,
      });
      if (r.body.trim()) return r.body.trim();
    } catch { /* use the template */ }
  }
  return OFFLINE[scenario](first, o.proposed_slots);
}
