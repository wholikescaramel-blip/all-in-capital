import type { Application, Correction, DB } from "./schemas";
import { nowISO, uid } from "./store";
import { PROCESS } from "../config/process";

// Correction memory. Retrieval uses token-vector cosine over a features string (no embedding service needed for seed scope;
// swap `similarity` for an embedding call later without changing callers).
const tok = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
function vec(s: string) { const m = new Map<string, number>(); for (const w of tok(s)) m.set(w, (m.get(w) ?? 0) + 1); return m; }
export function similarity(a: string, b: string) {
  const va = vec(a), vb = vec(b); let dot = 0, na = 0, nb = 0;
  for (const [k, x] of va) { na += x * x; const y = vb.get(k); if (y) dot += x * y; }
  for (const y of vb.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const featuresOf = (app: Application) =>
  `${app.sector} ${app.one_liner} ${app.form_fields["What have you built?"] ?? ""} ${app.form_fields["Revenue / GMV"] ?? ""}`.slice(0, 800);

export function addCorrection(db: DB, c: Omit<Correction, "id" | "created_at">): Correction {
  if (!c.reason || c.reason.trim().length < 5) throw new Error("A one-line reason is required for every correction");
  const full: Correction = { ...c, id: uid("corr"), created_at: nowISO() };
  db.corrections.push(full);
  return full;
}

export type Retrieved = Correction & { sim: number };
export function retrieveCorrections(db: DB, criterion: string, app: Application, k = PROCESS.top_k_corrections): Retrieved[] {
  const f = featuresOf(app);
  return db.corrections
    .filter((c) => c.criterion === criterion && c.app_id !== app.id)
    .map((c) => ({ ...c, sim: 0.7 * similarity(f, c.features) + (c.sector === app.sector ? 0.3 : 0) }))
    .filter((c) => c.sim > 0.25)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k);
}
