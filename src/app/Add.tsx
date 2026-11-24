"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { addByNameAction, advanceAction, uploadAction, type AddState } from "./actions";

type Row = { id: string; company: string; label: string; stage: number; state: "run" | "ok" | "err"; error?: string };
const TOTAL = 4;

export function AddPanel({ pending }: { pending: { id: string; company: string; stage: number; error?: string }[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<"files" | "name">("files");
  const [rows, setRows] = useState<Row[]>([]);
  const busy = useRef(false);
  const [names, setNames] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [upRes, upAct, upPending] = useActionState<AddState, FormData>(uploadAction, null);
  const [nmRes, nmAct, nmPending] = useActionState<AddState, FormData>(addByNameAction, null);

  // Processing runs one step per request, one company at a time, so nothing hits a time limit or overwrites another save.
  async function runQueue(items: { id: string; company: string; stage?: number }[]) {
    if (busy.current) return;
    busy.current = true;
    setRows(items.map((i) => ({ id: i.id, company: i.company, label: "Waiting", stage: i.stage ?? 0, state: "run" })));
    for (const it of items) {
      for (let guard = 0; guard < 8; guard++) {
        const r = await advanceAction(it.id);
        if (r.error) { setRows((p) => p.map((x) => (x.id === it.id ? { ...x, state: "err", error: r.error, label: "Stopped" } : x))); break; }
        setRows((p) => p.map((x) => (x.id === it.id ? { ...x, stage: r.stage ?? x.stage, label: r.done ? "Done" : r.label ?? "Working", state: r.done ? "ok" : "run" } : x)));
        if (r.done) break;
      }
    }
    busy.current = false;
    router.refresh();
  }

  // When a submit creates applications, start processing them.
  const lastKey = useRef("");
  useEffect(() => {
    for (const res of [upRes, nmRes]) {
      const created = res?.created ?? [];
      const k = created.map((c) => c.id).join(",");
      if (created.length && k !== lastKey.current) { lastKey.current = k; void runQueue(created); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upRes, nmRes]);

  const err = mode === "files" ? upRes?.error : nmRes?.error;
  const skipped = [...(upRes?.skipped ?? []), ...(nmRes?.skipped ?? [])];

  return (
    <>
      <div className="seg" role="tablist" aria-label="How to add">
        <button role="tab" aria-selected={mode === "files"} className={mode === "files" ? "on" : ""} onClick={() => setMode("files")}>Upload files</button>
        <button role="tab" aria-selected={mode === "name"} className={mode === "name" ? "on" : ""} onClick={() => setMode("name")}>Name or website</button>
      </div>

      {mode === "files" && (
        <form action={upAct} className="card">
          <label className={`drop ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); if (fileRef.current) { fileRef.current.files = e.dataTransfer.files; setNames([...e.dataTransfer.files].map((f) => f.name)); } }}>
            <b>Drop decks and forms here</b>
            <span className="muted">or click to choose. PDF or text, up to 4 MB in total.</span>
            <span className="muted">Name them like <code>Acme_Deck.pdf</code> and <code>Acme_Form.pdf</code> so they pair up.</span>
            <input ref={fileRef} type="file" name="files" multiple accept=".pdf,.txt,.md,text/plain,application/pdf" hidden onChange={(e) => setNames([...(e.target.files ?? [])].map((f) => f.name))} />
          </label>
          {names.length > 0 && <ul className="files">{names.map((n) => <li key={n}>{n}</li>)}</ul>}
          <p className="row" style={{ marginTop: 14 }}><button disabled={upPending || names.length === 0}>{upPending ? "Reading files..." : `Add ${names.length || ""} file${names.length === 1 ? "" : "s"}`}</button></p>
        </form>
      )}

      {mode === "name" && (
        <form action={nmAct} className="card">
          <div className="field"><label htmlFor="nm">Company name or website</label><input id="nm" name="name" placeholder="acme.com or Acme Foods" autoComplete="off" required /></div>
          <div className="field"><label htmlFor="em">Founder email (optional)</label><input id="em" name="email" type="email" placeholder="Leave empty if you don't have one" autoComplete="off" /></div>
          <p className="muted" style={{ margin: "4px 0 0" }}>With a website we read its public pages. With only a name there is little to score, so most points will show as missing info.</p>
          <p className="row" style={{ marginTop: 14 }}><button disabled={nmPending}>{nmPending ? "Reading the site..." : "Add"}</button></p>
        </form>
      )}

      {err && <p className="bad">{err}</p>}
      {skipped.map((s) => <p key={s} className="muted">Skipped: {s}</p>)}

      {pending.length > 0 && rows.length === 0 && (
        <div className="card">
          <b>{pending.length} waiting to finish</b>
          <p className="muted" style={{ margin: "4px 0 10px" }}>{pending.map((p) => p.company).join(", ")}{pending.some((p) => p.error) ? ". An earlier step stopped, try again." : ""}</p>
          <button onClick={() => void runQueue(pending.map((p) => ({ id: p.id, company: p.company, stage: p.stage })))}>Finish scoring</button>
        </div>
      )}

      {rows.length > 0 && (
        <div className="card">
          <h3>Progress</h3>
          {rows.map((r) => (
            <div key={r.id} className="prog">
              <b>{r.company}</b>
              <span className={`state ${r.state === "ok" ? "ok" : r.state === "err" ? "err" : ""}`}>{r.state === "err" ? r.error : r.label}</span>
              <span className={`bar ${r.state === "err" ? "low" : ""}`}><i style={{ width: `${r.state === "ok" ? 100 : (r.stage / TOTAL) * 100}%` }} /></span>
            </div>
          ))}
          {!busy.current && rows.every((r) => r.state !== "run") && <p style={{ marginTop: 14 }}><a href="/" className="inline">See them on the dashboard</a></p>}
        </div>
      )}
    </>
  );
}
