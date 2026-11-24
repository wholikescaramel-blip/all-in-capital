"use client";
import { useActionState, useEffect, useState, useTransition } from "react";
import { draftAction, removeNoteAction, replyAction, restoreAction, reviewAction, reviseAction, saveDraftAction, sendAction, tickAction } from "./actions";

type Crit = { key: string; label: string; score: number };
type Res = { error?: string; ok?: boolean } | null;
type Claim = { text: string; fact_id: string | null; quote?: string; supported: boolean; note?: string };
type Check = { pass: boolean; claims: Claim[]; issues: string[]; rounds: number };
type Version = { n: number; by: "ai" | "human"; instruction?: string; subject: string; body: string; check?: Check };
type Chat = { at: string; who: "human" | "ai"; text: string };
type Contact = { name: string; role?: string; email: string; email_source: "form" | "placeholder" };

export function ReviewForm({ id, systemRec, crits }: { id: string; systemRec: string; crits: Crit[] }) {
  const [res, act, pending] = useActionState(reviewAction, null as Res);
  const [dec, setDec] = useState(systemRec);
  return (
    <form action={act} className="card beam">
      <h3>Your decision</h3>
      <input type="hidden" name="id" value={id} />
      <div className="row">
        <label>Deciding as <select name="reviewer"><option value="associate">associate</option><option value="partner">partner</option></select></label>
        <label>Decision <select name="decision" value={dec} onChange={(e) => setDec(e.target.value)}><option value="take_call">Take the call</option><option value="hold">Hold</option><option value="pass">Pass</option></select></label>
        {dec !== systemRec && <span className="muted">You differ from the suggestion, so add a one-line reason.</span>}
      </div>
      <p><input name="reason" placeholder="One-line reason (needed if you differ)" style={{ width: "100%" }} /></p>
      <details className="fold">
        <summary>Change a score (saved, and used on similar companies later)</summary>
        <table><tbody>{crits.map((c) => (
          <tr key={c.key}><td>{c.label} <span className="muted">now {c.score}</span></td>
            <td><input name={`fix_${c.key}`} type="number" min="0" max="10" step="0.5" placeholder="new" style={{ width: 70 }} /></td>
            <td><input name={`why_${c.key}`} placeholder="Why (one line)" style={{ width: "100%" }} /></td></tr>))}
        </tbody></table>
      </details>
      <p><button disabled={pending}>Save decision</button> {res?.error && <span className="bad">{res.error}</span>}</p>
    </form>
  );
}

export function OutreachPanel(p: { id: string; state: string; contact?: Contact; draft?: { subject: string; body: string }; versions: Version[]; chat: Chat[]; notes: { id: string; rule: string; count: number; standing: boolean }[]; followups: number; slot?: string; slots: string[] }) {
  const { id, state } = p;
  const [body, setBody] = useState(p.draft?.body ?? "");
  const [ask, setAsk] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, start] = useTransition();
  const [res, act, pending] = useActionState(replyAction, null as Res);
  useEffect(() => setBody(p.draft?.body ?? ""), [p.draft?.body]);

  const current = [...p.versions].reverse().find((v) => v.body === p.draft?.body) ?? p.versions[p.versions.length - 1];
  const check = current?.check;
  const call = (fn: () => Promise<Res | void>, then?: () => void) => start(async () => { const r = await fn(); setMsg(r && "error" in r && r.error ? r.error : ""); if (!(r && "error" in r && r.error)) then?.(); });

  return (
    <div className="card">
      <h3>Email to the founder</h3>

      {state === "APPROVED" && <>
        <p className="muted">The AI writes it from the application, then a second pass checks every fact in it.</p>
        <button disabled={busy} onClick={() => call(() => draftAction(id))}>{busy ? "Writing and fact-checking, up to a minute..." : "Write the email"}</button>
      </>}

      {state === "DRAFTED" && p.contact && <>
        <div className="contact">
          <div className="avatar">{p.contact.name.replace(/^dr\.?\s+/i, "")[0]}</div>
          <div style={{ minWidth: 0 }}>
            <b>{p.contact.name}</b>{p.contact.role && <span className="muted"> &middot; {p.contact.role}</span>}
            <div className="mono" title={p.contact.email_source === "placeholder" ? "No email was given in the application, so this is a stand-in address." : "From the application"}>{p.contact.email}</div>
          </div>
        </div>

        {check && (
          <div className={`verdict ${check.pass ? "pass" : "fail"}`}>
            <b>{check.pass ? "Facts check out" : "Needs a look"}</b>
            <span className="muted">{check.pass ? (check.claims.length ? `${check.claims.length} claims, each matched to the application.` : "Number and wording checks passed.") : check.issues.join(" ")}</span>
          </div>
        )}
        {check && check.claims.length > 0 && (
          <details className="fold">
            <summary>How each fact was checked ({check.claims.length})</summary>
            <table className="claims"><tbody>{check.claims.map((c, i) => (
              <tr key={i}><td className={`tick ${c.supported ? "ok" : "no"}`}>{c.supported ? "✓" : "!"}</td><td>{c.text}{c.quote && <div className="muted">&ldquo;{c.quote}&rdquo;</div>}</td></tr>))}</tbody></table>
          </details>
        )}

        <p className="muted" style={{ marginBottom: 4 }}>Subject: <b style={{ color: "var(--fg)" }}>{p.draft?.subject}</b></p>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} aria-label="Email body" />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="ghost" disabled={busy || body === p.draft?.body} onClick={() => call(() => saveDraftAction(id, body))}>Save my edit and re-check</button>
        </div>

        {p.versions.length > 1 && <div className="vers" aria-label="Versions">{p.versions.map((v) => (
          <button key={v.n} className={current?.n === v.n ? "on" : ""} title={v.instruction ?? (v.by === "human" ? "Your edit" : "AI draft")} onClick={() => call(() => restoreAction(id, v.n))}>v{v.n}{v.by === "human" ? " (you)" : ""}</button>))}</div>}

        <h4 style={{ marginTop: 18 }}>Ask for changes</h4>
        {p.chat.length > 0 && <div className="chat">{p.chat.map((c, i) => <div key={i} className={`bub ${c.who}`}>{c.text}</div>)}</div>}
        <form className="chatbox" onSubmit={(e) => { e.preventDefault(); const t = ask; call(() => reviseAction(id, t), () => setAsk("")); }}>
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="e.g. shorter, and ask about repeat orders" aria-label="What should change" />
          <button disabled={busy || ask.trim().length < 3}>{busy ? "Rewriting..." : "Send"}</button>
        </form>

        {p.notes.length > 0 && (
          <details className="fold">
            <summary>What the AI has learned from your feedback ({p.notes.filter((n) => n.standing).length} saved)</summary>
            <ul className="notes">{p.notes.map((n) => (
              <li key={n.id}>{n.rule}{n.count > 1 && <span> (asked {n.count} times)</span>}{!n.standing && <span> (used once, not saved yet)</span>}{" "}
                <button className="ghost" style={{ padding: "1px 9px", fontSize: 12 }} disabled={busy} onClick={() => call(() => removeNoteAction(id, n.id))}>Remove</button></li>))}
            </ul>
          </details>
        )}

        <p className="row" style={{ marginTop: 18 }}>
          <button disabled={busy} onClick={() => call(() => sendAction(id, "associate"))}>Approve and send</button>
          <span className="muted">Nothing is really sent. It&apos;s recorded in the outbox.{check && !check.pass ? " The fact-check still has open points." : ""}</span>
        </p>
      </>}

      {["AWAITING_REPLY", "SCHEDULING"].includes(state) && <>
        <p className="muted">Sent to {p.contact?.name} at {p.contact?.email} (not really sent). Follow-ups so far: {p.followups}. {state === "SCHEDULING" && `Proposed times: ${p.slots.join(" | ")}`}</p>
        <form action={act} className="row"><input type="hidden" name="id" value={id} /><input name="text" placeholder="Type the founder's reply to test it (e.g. yes, or 2 works)" style={{ flex: 1 }} /><button disabled={pending}>Deliver reply</button></form></>}
      {state === "SCHEDULED" && <p><b>Meeting booked</b> &middot; {p.slot}</p>}
      {state === "FLAGGED" && <p className="bad">Flagged for a partner. Not rejected. A person decides next.</p>}
      {(msg || res?.error) && <p className="bad">{msg || res?.error}</p>}
    </div>
  );
}

export function TickButton() {
  return <div className="row"><span className="muted">Move time forward to test follow-ups:</span>{[3, 9, 12].map((d) => <button key={d} className="ghost" onClick={() => tickAction(d)}>+{d} days</button>)}</div>;
}
