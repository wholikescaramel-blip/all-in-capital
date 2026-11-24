import { z } from "zod";
import { completeJSON, webResearch, hasLLM } from "../src/lib/llm";
import { loadDB, saveDB, storeKind } from "../src/lib/store";

// Smoke test for the two external services. Prints only pass/fail and short facts, never keys.
console.log("Gemini key set:", hasLLM(), "| store:", storeKind());

try {
  const r = await completeJSON({ system: "Reply with JSON.", user: 'Return {"ok": true, "word": "ping"}', schema: z.object({ ok: z.boolean(), word: z.string() }), model: "fast" });
  console.log("Gemini JSON call: OK", JSON.stringify(r));
} catch (e) { console.log("Gemini JSON call: FAILED:", String(e).slice(0, 400)); }

try {
  const w = await webResearch("What is the capital of France? Cite a source.");
  console.log("Gemini grounded search: OK |", w.sources.length, "source(s) |", w.text.slice(0, 80).replace(/\s+/g, " "));
} catch (e) { console.log("Gemini grounded search: FAILED:", String(e).slice(0, 400)); }

try {
  const db = await loadDB();
  await saveDB(db);
  console.log("Neon read/write: OK | applications stored:", Object.keys(db.applications).length);
} catch (e) { console.log("Neon read/write: FAILED:", String(e).slice(0, 400)); }
