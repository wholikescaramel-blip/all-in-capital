import type { DB, Message } from "./schemas";
import { mailMode, parseRef } from "./mail";
import { getOut } from "./emailflow";
import { processReply } from "./replies";

export type InboundResult = { ok: boolean; application?: string; duplicate?: boolean; reason?: string };

// Matches an email that arrived to the application it answers, checks it came from the person we wrote to, and processes it.
export async function handleInboundEmail(db: DB, m: { emailId: string; from: string; subject: string; body: string }): Promise<InboundResult> {
  const appId = parseRef(m.subject);
  if (!appId || !db.applications[appId]) return { ok: false, reason: "no application tag in the subject" };
  const o = getOut(db, appId);
  if ((o.thread as Message[]).some((x) => x.provider_id === m.emailId)) return { ok: true, duplicate: true, application: appId };

  // Only the person we wrote to may answer: the test inbox in test mode, the founder's address otherwise.
  const expected = (mailMode() === "test" ? process.env.MAIL_TEST_RECIPIENT : o.contact?.email)?.toLowerCase();
  if (!expected || !m.from.toLowerCase().includes(expected)) return { ok: false, reason: "sender is not the person we wrote to", application: appId };

  await processReply(db, appId, m.body, { via: "inbound", from: m.from, provider_id: m.emailId });
  return { ok: true, application: appId };
}
