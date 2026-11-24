"use client";
import { useActionState, useState } from "react";
import { draftAction, replyAction, reviewAction, saveDraftAction, sendAction, tickAction } from "./actions";

type Crit = { key: string; label: string; score: number };
type Res = { error?: string; ok?: boolean } | null;

export function ReviewForm({ id, systemRec, crits }: { id: string; systemRec: string; crits: Crit[] }) {
  const [res, act, pending] = useActionState(reviewAction, null as Res);
  const [dec, setDec] = useState(systemRec);
  return (
    <form action={act} className="card beam">
      <h3>Your decision</h3>
      <p className="muted" style={{ marginTop: 0 }}>The system only suggests. Nothing moves until you record a decision here.</p>
      <input type="hidden" name="id" value={id} />
      <div className="row">
        <label>Reviewing as <select name="reviewer"><option value="associate">associate</option><option value="partner">partner</option></select></label>
        <label>Decision <select name="decision" value={dec} onChange={(e) => setDec(e.target.value)}><option>take_call</option><option>pass</option><option>hold</option></select></label>
        <span className="muted">System recommended <b>{systemRec}</b>{dec !== systemRec && " : a one-line reason is required"}</span>
      </div>
      <p><input name="reason" placeholder="One-line reason (required if you differ)" style={{ width: "100%" }} /></p>
      <details><summary>Correct individual criterion scores (reused on similar companies)</summary>
        <table><tbody>{crits.map((c) => (
          <tr key={c.key}><td>{c.label} <span className="muted">now {c.score}</span></td>
            <td><input name={`fix_${c.key}`} type="number" min="0" max="10" step="0.5" placeholder="new" style={{ width: 70 }} /></td>
            <td><input name={`why_${c.key}`} placeholder="why (one line, required if changed)" style={{ width: "100%" }} /></td></tr>))}
        </tbody></table>
      </details>
      <p><button disabled={pending}>Record decision</button> {res?.error && <span className="bad">{res.error}</span>}</p>
    </form>
  );
}

export function OutreachPanel({ id, state, draft, followups, slot, slots }: { id: string; state: string; draft?: string; followups: number; slot?: string; slots: string[] }) {
  const [body, setBody] = useState(draft ?? "");
  const [msg, setMsg] = useState("");
  const [res, act, pending] = useActionState(replyAction, null as Res);
  const call = async (p: Promise<Res | void>) => { const r = await p; setMsg(r && "error" in r && r.error ? r.error : ""); };
  return (
    <div className="card">
      <h3>Outreach <span className="pill">{state}</span></h3>
      {state === "APPROVED" && <button onClick={() => call(draftAction(id))}>Draft invitation</button>}
      {state === "DRAFTED" && <>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row"><button className="ghost" onClick={() => call(saveDraftAction(id, body))}>Save edits</button>
          <button onClick={() => call(sendAction(id, "associate"))}>Approve and send (mock)</button></div></>}
      {["AWAITING_REPLY", "SCHEDULING"].includes(state) && <>
        <p className="muted">Mock send only. Follow-ups sent: {followups}. {state === "SCHEDULING" && `Proposed: ${slots.join(" | ")}`}</p>
        <form action={act} className="row"><input type="hidden" name="id" value={id} /><input name="text" placeholder="Simulate founder reply (e.g. yes / 2 works)" style={{ flex: 1 }} /><button disabled={pending}>Deliver reply</button></form></>}
      {state === "SCHEDULED" && <p><b>MEETING_SCHEDULED</b> {slot}</p>}
      {state === "FLAGGED" && <p className="bad">Flagged to a partner. Not rejected. A human decides next.</p>}
      {(msg || res?.error) && <p className="bad">{msg || res?.error}</p>}
    </div>
  );
}

export function TickButton() {
  return <div className="row"><span className="muted">Simulate time:</span>{[3, 9, 12].map((d) => <button key={d} className="ghost" onClick={() => tickAction(d)}>+{d} days</button>)}</div>;
}
