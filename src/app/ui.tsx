import type { CSSProperties } from "react";

// Small presentational pieces shared by the dashboard and the detail page. Server-safe, no client JS.
export function ScoreRing({ value, rec, size = 64 }: { value: number; rec: string; size?: number }) {
  return <div className={`ring ${rec}`} style={{ "--v": Math.max(0, Math.min(100, value * 10)), "--s": `${size}px` } as CSSProperties} aria-label={`Score ${value} out of 10`}><b>{value.toFixed(1)}</b></div>;
}

export const Pill = ({ kind, children }: { kind?: string; children: React.ReactNode }) => <span className={`pill ${kind ?? ""}`}>{children}</span>;

export function Bar({ value, label }: { value: number; label?: string }) {
  return <span className={`bar ${value < 4 ? "low" : ""}`} role="img" aria-label={label ?? `${value} out of 10`}><i style={{ width: `${value * 10}%` }} /></span>;
}

const STEPS = ["INGESTED", "RESEARCHED", "SCORED", "AWAITING_REVIEW", "APPROVED", "DRAFTED", "APPROVED_TO_SEND", "SENT", "AWAITING_REPLY", "SCHEDULING", "SCHEDULED"];
const LABEL: Record<string, string> = { AWAITING_REVIEW: "Review", APPROVED_TO_SEND: "Send ok", AWAITING_REPLY: "Reply", SCHEDULED: "Booked" };

export function Pipeline({ state }: { state: string }) {
  const idx = STEPS.indexOf(state);
  const off = idx < 0; // FLAGGED / DECIDED_PASS / ON_HOLD sit outside the happy path
  return (
    <ol className="pipe" aria-label="Pipeline progress">
      {STEPS.map((s, i) => <li key={s} className={off ? (i <= 3 ? "done" : "") : i < idx ? "done" : i === idx ? "now" : ""}>{LABEL[s] ?? s.replace(/_/g, " ").toLowerCase()}</li>)}
    </ol>
  );
}
