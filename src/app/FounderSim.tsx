"use client";
import { useState, useTransition } from "react";
import { cancelMeetingAction, deliverReplyAction, founderDraftAction } from "./actions";

const SCENARIOS: [string, string][] = [
  ["eager", "Eager: gives times and a number"],
  ["offtime", "Wants a time we don't offer"],
  ["question", "Asks a question first"],
  ["vague", "Vague: no times, no number"],
  ["decline", "Declines"],
];

// Testing tool. Drafts a reply as the founder (or takes one you paste) and delivers it through the same path a real reply takes.
export function FounderSim({ id, open }: { id: string; open: boolean }) {
  const [scenario, setScenario] = useState("eager");
  const [text, setText] = useState("");
  const [paste, setPaste] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, start] = useTransition();

  if (!open) return null;
  return (
    <div className="card">
      <h3>Play the founder</h3>
      <p className="muted" style={{ marginTop: 0 }}>For testing. Write a reply as the founder, or paste a real one, and deliver it. It goes through the same steps as an email that arrives for real.</p>
      <div className="seg" role="tablist" aria-label="Reply source" style={{ marginTop: 6 }}>
        <button type="button" role="tab" aria-selected={!paste} className={!paste ? "on" : ""} onClick={() => setPaste(false)}>Draft one for me</button>
        <button type="button" role="tab" aria-selected={paste} className={paste ? "on" : ""} onClick={() => setPaste(true)}>Paste a reply</button>
      </div>
      {!paste && (
        <div className="row" style={{ margin: "10px 0" }}>
          <select value={scenario} onChange={(e) => setScenario(e.target.value)} aria-label="How the founder replies">{SCENARIOS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <button type="button" className="ghost" disabled={busy} onClick={() => start(async () => { setMsg(""); const r = await founderDraftAction(id, scenario); if (r.error) setMsg(r.error); else setText(r.text ?? ""); })}>{busy ? "Writing..." : "Draft the reply"}</button>
        </div>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={paste ? "Paste the founder's email here" : "The founder's reply appears here. Edit it if you like."} aria-label="Founder's reply" />
      <p className="row" style={{ marginTop: 8 }}>
        <button type="button" disabled={busy || !text.trim()} onClick={() => start(async () => { setMsg(""); const r = await deliverReplyAction(id, text, paste ? "pasted" : "simulated"); if (r && "error" in r && r.error) setMsg(r.error); else setText(""); })}>{busy ? "Delivering..." : "Deliver reply"}</button>
        {msg && <span className="bad">{msg}</span>}
      </p>
    </div>
  );
}

export function CancelMeeting({ id }: { id: string }) {
  const [msg, setMsg] = useState("");
  const [busy, start] = useTransition();
  return (
    <span className="row" style={{ display: "inline-flex", gap: 8 }}>
      <button type="button" className="ghost" disabled={busy} onClick={() => start(async () => { const r = await cancelMeetingAction(id); setMsg(r && "error" in r && r.error ? r.error : ""); })}>{busy ? "Cancelling..." : "Cancel the meeting"}</button>
      {msg && <span className="bad">{msg}</span>}
    </span>
  );
}
