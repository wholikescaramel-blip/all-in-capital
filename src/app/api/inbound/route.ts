import { loadDB, saveDB } from "@/lib/store";
import { verifySvix } from "@/lib/svix";
import { flushMail } from "@/lib/mail";
import { handleInboundEmail } from "@/lib/inbound";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const plain = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").trim();

// Resend calls this when an email arrives on our inbound address. The call carries metadata only, so we fetch the body.
export async function POST(req: Request) {
  const raw = await req.text();
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "RESEND_WEBHOOK_SECRET is not set" }, { status: 503 }); // never accept unsigned mail
  const ok = verifySvix(raw, { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") }, secret);
  if (!ok) return Response.json({ error: "bad signature" }, { status: 401 });

  const evt = JSON.parse(raw) as { type?: string; data?: { email_id?: string; from?: string; subject?: string } };
  if (evt.type !== "email.received" || !evt.data?.email_id) return Response.json({ ok: true, ignored: evt.type ?? "unknown" });

  const key = process.env.RESEND_RECEIVING_KEY || process.env.RESEND_API_KEY;
  const r = await fetch(`https://api.resend.com/emails/receiving/${evt.data.email_id}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return Response.json({ error: `could not fetch the email (${r.status}). The key may be send-only.` }, { status: 502 }); // Resend retries
  const mail = (await r.json()) as { text?: string; html?: string; subject?: string; from?: string };

  const db = await loadDB();
  const result = await handleInboundEmail(db, {
    emailId: evt.data.email_id,
    from: mail.from ?? evt.data.from ?? "",
    subject: mail.subject ?? evt.data.subject ?? "",
    body: (mail.text && mail.text.trim()) || plain(mail.html ?? ""),
  });
  if (result.ok && !result.duplicate) { await flushMail(db); await saveDB(db); }
  return Response.json(result);
}
