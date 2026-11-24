import { loadDB } from "@/lib/store";
import { AddPanel } from "../Add";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // each processing step runs as its own request

export default async function Add() {
  const db = await loadDB();
  const pending = Object.entries(db.pending).filter(([id]) => db.applications[id]).map(([id, p]) => ({ id, company: db.applications[id].company, stage: p.stage, error: p.error }));
  return (<>
    <p className="eyebrow">Add applications</p>
    <h1 className="display">Bring in new companies</h1>
    <p className="muted" style={{ maxWidth: 560, marginTop: 14 }}>
      Upload a deck and form, or just type a company name or website. Each one is read, researched, checked against the portfolio and scored. That takes a minute or two.
    </p>
    <AddPanel pending={pending} />
  </>);
}
