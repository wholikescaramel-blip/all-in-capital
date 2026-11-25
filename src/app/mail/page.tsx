import { loadDB } from "@/lib/store";
import { mailMode } from "@/lib/mail";
import type { Message } from "@/lib/schemas";
import { Pill } from "../ui";

export const dynamic = "force-dynamic";

const ist = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
const MODE = { mock: "Mock: nothing is really sent.", test: "Test: mail goes through Resend, but only to the test inbox.", live: "Live: mail goes to the founders' own addresses." };

export default async function MailPage() {
  const db = await loadDB();
  const mode = mailMode();
  const rows = Object.values(db.outreach).filter((o) => (o.thread ?? []).length > 0 && db.applications[o.app_id]).map((o) => {
    const t = [...(o.thread as Message[])].sort((a, b) => a.at.localeCompare(b.at));
    return { o, app: db.applications[o.app_id], last: t[t.length - 1], sent: t.filter((m) => m.dir === "out").length, got: t.filter((m) => m.dir === "in").length, failed: t.filter((m) => m.status === "failed").length };
  }).sort((a, b) => b.last.at.localeCompare(a.last.at));

  return (<>
    <h1 className="display">Mail</h1>
    <p className="muted" style={{ marginTop: 10 }}>{MODE[mode]}</p>
    {rows.length === 0 && <div className="card">No mail yet. Approve a call on an application and send the email to start a thread.</div>}
    {rows.map(({ o, app, last, sent, got, failed }) => (
      <a key={o.app_id} href={`/apps/${o.app_id}`} className="mailrow">
        <div><b>{app.company}</b><div className="muted">{o.contact?.name}</div></div>
        <div className="muted">{last.dir === "out" ? "We sent" : "Founder replied"}: {last.body.replace(/\s+/g, " ").slice(0, 110)}<div style={{ fontSize: 12 }}>{ist(last.at)}</div></div>
        <div className="row" style={{ gap: 6 }}>
          <Pill>{sent} sent</Pill><Pill>{got} received</Pill>
          {failed > 0 && <Pill kind="alert">{failed} failed</Pill>}
          {o.meeting && <Pill kind="take_call">meeting booked</Pill>}
          {o.needs_human && !o.meeting && <Pill kind="hold">needs a person</Pill>}
        </div>
      </a>
    ))}
  </>);
}
