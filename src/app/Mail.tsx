import type { Message, Outreach } from "@/lib/schemas";
import { Pill } from "./ui";
import { CancelMeeting } from "./FounderSim";

const ist = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
const VIA: Record<Message["via"], string> = { mock: "recorded only", resend: "via Resend", simulated: "simulated", pasted: "pasted", inbound: "received by Resend" };
const INTENT: Record<string, string> = { yes: "wants the call", no: "declined", reschedule: "wants another time", question: "asked a question", unclear: "no clear answer" };

// Every email in and out for one application, in order, with what we read from each reply.
export function MailThread({ o }: { o: Outreach }) {
  const thread = [...((o.thread ?? []) as Message[])].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <div className="card">
      <h3>Mail</h3>
      {thread.length === 0 && <p className="muted">Nothing sent yet.</p>}
      {thread.map((m) => (
        <div key={m.id} className={`msg ${m.dir}`}>
          <div className="meta">
            <b>{m.dir === "out" ? "We sent" : "Founder replied"}</b>
            <span>{m.dir === "out" ? `to ${m.to}` : `from ${m.from}`}</span>
            <span>{ist(m.at)}</span>
            <Pill kind={m.status === "failed" ? "alert" : undefined}>{m.status === "failed" ? "failed to send" : VIA[m.via]}</Pill>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>{m.subject}</div>
          <pre>{m.body}</pre>
          {m.error && <p className="bad" style={{ margin: "6px 0 0" }}>{m.error}</p>}
          {m.extracted && (
            <div className="chips">
              <Pill kind={m.extracted.intent === "yes" ? "take_call" : m.extracted.intent === "no" ? "alert" : "hold"}>{INTENT[m.extracted.intent]}</Pill>
              {m.extracted.phone && <Pill>phone {m.extracted.phone}</Pill>}
              {m.extracted.windows.slice(0, 3).map((w, i) => <Pill key={i}>{ist(w.start)} to {new Date(w.end).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", timeStyle: "short" })}</Pill>)}
              {m.extracted.summary && <span className="muted">{m.extracted.summary}</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function MeetingCard({ id, o }: { id: string; o: Outreach }) {
  if (!o.meeting && !o.needs_human) return null;
  return (
    <>
      {o.meeting && (
        <div className="card beam">
          <h3>Meeting booked</h3>
          <p style={{ margin: "0 0 6px" }}><b>{ist(o.meeting.start)}</b> India time, 30 minutes</p>
          <p className="muted" style={{ margin: "0 0 10px" }}>
            With {o.meeting.attendees.join(" and ").replace(/_/g, " ")}. {o.phone ? `Founder's number: ${o.phone}. ` : "No phone number yet. "}
            {o.meeting.provider === "cal" ? "Booked in Cal.com." : "Recorded in the app's own calendar."}
            {o.meeting.url && <> <a href={o.meeting.url} className="inline">Meeting link</a></>}
          </p>
          <CancelMeeting id={id} />
        </div>
      )}
      {o.needs_human && !o.meeting && <div className="card" style={{ borderColor: "color-mix(in srgb, var(--amber) 55%, transparent)" }}><b>Needs a person.</b> <span className="muted">{o.needs_human}</span></div>}
    </>
  );
}
