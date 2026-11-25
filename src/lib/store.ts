import fs from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import type { DB, AppState, AuditEntry } from "./schemas";

// Storage: Neon Postgres when DATABASE_URL is set (required on Vercel, whose filesystem is read-only),
// otherwise a local JSON file for offline dev. The whole state is one JSON document: fine at seed scale
// and keeps the pipeline code independent of the backend.
export const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const useNeon = () => !!process.env.DATABASE_URL;
export const storeKind = () => (useNeon() ? "neon" : "local-file");

export function emptyDB(): DB {
  return {
    applications: {}, states: {}, evidence: [], gaps: [], assessments: {}, reviews: [], corrections: [],
    outreach: {}, audit: [], pending: {}, draft_notes: [], outbox: [], fund: { thesis_text: "", thesis_source: "", portfolio: [], gaps: [] }, backtest_runs: [],
  };
}

// Records written by earlier versions of the app can lack newer fields. Fill them in on every load so no code path trips on undefined.
function normalise(db: DB): DB {
  db.draft_notes ??= [];
  db.pending ??= {};
  for (const o of Object.values(db.outreach)) {
    o.thread ??= []; o.versions ??= []; o.chat ??= []; o.attendees ??= []; o.replies ??= []; o.proposed_slots ??= []; o.followups_sent ??= 0;
  }
  return db;
}

let ready = false;
async function ensureTable() {
  if (ready) return;
  const sql = neon(process.env.DATABASE_URL!);
  await sql`create table if not exists app_state (id int primary key, data jsonb not null, updated_at timestamptz default now())`;
  ready = true;
}

// Neon's HTTP driver can drop a request; retry a few times before giving up.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw last;
}

export async function loadDB(): Promise<DB> {
  if (useNeon()) {
    return withRetry(async () => {
      await ensureTable();
      const sql = neon(process.env.DATABASE_URL!);
      const rows = await sql`select data from app_state where id = 1`;
      return normalise({ ...emptyDB(), ...(rows[0]?.data ?? {}) });
    });
  }
  try { return normalise({ ...emptyDB(), ...JSON.parse(fs.readFileSync(DB_PATH, "utf8")) }); } catch { return emptyDB(); }
}

export async function saveDB(db: DB) {
  if (useNeon()) {
    await withRetry(async () => {
      await ensureTable();
      const sql = neon(process.env.DATABASE_URL!);
      await sql`insert into app_state (id, data) values (1, ${JSON.stringify(db)}::jsonb)
                on conflict (id) do update set data = excluded.data, updated_at = now()`;
    });
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

// ---- Thread-level writes. The scheduler runs on a timer while people use the site, so it never rewrites the whole document:
// it claims one thread, and saves only that thread. The claim is a single conditional update, so two runs cannot both win it.
const CLAIM_MINUTES = 10;
const localLock = new Set<string>();

export async function claimThread(appId: string, by: string, ttlMin = CLAIM_MINUTES): Promise<boolean> {
  const claim = JSON.stringify({ at: new Date().toISOString(), by });
  if (useNeon()) {
    return withRetry(async () => {
      await ensureTable();
      const sql = neon(process.env.DATABASE_URL!);
      const path = ["outreach", appId];
      const rows = await sql`update app_state set data = jsonb_set(data, ${[...path, "claim"]}::text[], ${claim}::jsonb, true)
        where id = 1 and (data #> ${path}::text[]) is not null
          and ((data #>> ${[...path, "claim", "at"]}::text[]) is null or (data #>> ${[...path, "claim", "at"]}::text[])::timestamptz < now() - (${ttlMin} * interval '1 minute'))
        returning 1 as ok`;
      return rows.length === 1;
    });
  }
  if (localLock.has(appId)) return false;
  localLock.add(appId);
  return true;
}

export async function releaseThread(appId: string, by: string) {
  if (useNeon()) {
    await withRetry(async () => {
      const sql = neon(process.env.DATABASE_URL!);
      const path = ["outreach", appId];
      await sql`update app_state set data = data #- ${[...path, "claim"]}::text[] where id = 1 and (data #>> ${[...path, "claim", "by"]}::text[]) = ${by}`;
    });
    return;
  }
  localLock.delete(appId);
}

// Save one application's outreach, its state, and any audit lines added since `auditFrom`. Nothing else in the document is touched.
export async function saveThread(db: DB, appId: string, auditFrom: number) {
  const o = { ...db.outreach[appId] }; // keeps the claim, so the thread stays owned until releaseThread
  const st = db.states[appId], added = db.audit.slice(auditFrom);
  if (useNeon()) {
    await withRetry(async () => {
      const sql = neon(process.env.DATABASE_URL!);
      await sql`update app_state set data = jsonb_set(jsonb_set(jsonb_set(data, ${["outreach", appId]}::text[], ${JSON.stringify(o)}::jsonb, true), ${["states", appId]}::text[], ${JSON.stringify(st)}::jsonb, true), '{audit}', coalesce(data->'audit', '[]'::jsonb) || ${JSON.stringify(added)}::jsonb) where id = 1`;
    });
    return;
  }
  const cur = await loadDB();
  cur.outreach[appId] = o; cur.states[appId] = st; cur.audit.push(...added);
  await saveDB(cur);
}

export const nowISO = () => new Date().toISOString();
let counter = 0;
export const uid = (p: string) => `${p}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// ---- Orchestrator state machine ----
const ALLOWED: Record<AppState, AppState[]> = {
  INGESTED: ["RESEARCHED", "FLAGGED"],
  RESEARCHED: ["SCORED", "FLAGGED"],
  SCORED: ["AWAITING_REVIEW", "FLAGGED"],
  AWAITING_REVIEW: ["APPROVED", "DECIDED_PASS", "ON_HOLD", "FLAGGED"],
  APPROVED: ["DRAFTED", "FLAGGED"],
  DRAFTED: ["APPROVED_TO_SEND", "FLAGGED"],
  APPROVED_TO_SEND: ["SENT", "FLAGGED"],
  SENT: ["AWAITING_REPLY", "FLAGGED"],
  AWAITING_REPLY: ["SCHEDULING", "FLAGGED", "DECIDED_PASS"],
  SCHEDULING: ["SCHEDULED", "FLAGGED"],
  SCHEDULED: ["FLAGGED"], // a cancelled meeting goes back to a person
  FLAGGED: ["AWAITING_REVIEW", "AWAITING_REPLY", "SCHEDULING", "DECIDED_PASS", "ON_HOLD"], // a reviewer resolves flags
  DECIDED_PASS: ["AWAITING_REVIEW"], // reopen is allowed
  ON_HOLD: ["AWAITING_REVIEW", "APPROVED", "DECIDED_PASS"],
};

export function transition(db: DB, appId: string, to: AppState, actor: string, note?: string) {
  const from = db.states[appId] ?? null;
  if (from !== null && !ALLOWED[from].includes(to)) throw new Error(`Illegal transition ${from} -> ${to} for ${appId}`);
  db.states[appId] = to;
  const entry: AuditEntry = { at: nowISO(), app_id: appId, from, to, actor, note };
  db.audit.push(entry);
}

export function audit(db: DB, appId: string, actor: string, note: string) {
  db.audit.push({ at: nowISO(), app_id: appId, from: db.states[appId] ?? null, to: db.states[appId] ?? "INGESTED", actor, note });
}
