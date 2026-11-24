import { z } from "zod";
import { PROCESS } from "../config/process";

// All model access goes through here (Gemini free tier, REST, no SDK). With no GEMINI_API_KEY the pipeline falls back to
// clearly labelled offline heuristics so the state machine, UI and corrections loop can still be exercised.
export const hasLLM = () => !!process.env.GEMINI_API_KEY;

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MIN_GAP_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 4500); // free tier is rate-limited (~10-15 requests/min)
let lastCall = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export class QuotaError extends Error {}
let groundingOff = "";

const T0 = Date.now();
const log = (m: string) => console.log(`  [llm +${Math.round((Date.now() - T0) / 1000)}s] ${m}`);

// failFastAfter: on 5xx overload give up after this many tries so a caller can fall back; 6 = never fail fast.
async function gemini(model: string, body: unknown, failFastAfter = 6): Promise<any> {
  const kind = (body as any).tools ? "grounded" : "json";
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let res: Response;
    try {
      res = await fetch(`${BASE}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
    } catch (e) { // network drop or timeout: back off and retry
      if (attempt === 5) throw new Error(`Gemini network error after retries: ${String(e)}`);
      await sleep(3000 * (attempt + 1));
      continue;
    }
    log(`${model} ${kind} attempt ${attempt + 1}: HTTP ${res.status}`);
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      const t = await res.text();
      const m = t.match(/"retryDelay":\s*"(\d+)s"/);
      // 429 with no retryDelay = hard quota (e.g. grounded search not included in the free tier): retrying only wastes time.
      if (res.status === 429 && !m && /RESOURCE_EXHAUSTED/.test(t)) throw new QuotaError(`Gemini quota exhausted for ${model}${(body as any).tools ? " (grounded search)" : ""}`);
      // A long rate-limit wait would blow a 60s serverless limit: let a caller with a fallback switch models instead of waiting.
      if (res.status === 429 && m && Number(m[1]) > 15 && failFastAfter < 6) throw new Error(`Gemini 429 UNAVAILABLE for ${model}: retry in ${m[1]}s`);
      if (res.status >= 500 && attempt + 1 >= failFastAfter) throw new Error(`Gemini ${res.status} UNAVAILABLE for ${model} after ${attempt + 1} tries`); // overload: let the caller fall back
      await sleep(m ? Number(m[1]) * 1000 + 500 : Math.min(60000, 4000 * 2 ** attempt));
      continue;
    }
    throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  throw new Error("Gemini rate limit: retries exhausted");
}

function extractJSON(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.search(/[\[{]/);
  if (start < 0) throw new Error("No JSON in model output");
  const close = body[start] === "{" ? "}" : "]";
  return JSON.parse(body.slice(start, body.lastIndexOf(close) + 1));
}

const textOf = (r: any): string => (r.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");

// Which model actually answered the most recent completeJSON call (differs from the request when the primary was overloaded).
export let lastModelUsed = "";

export async function completeJSON<T>(opts: {
  system: string; user: string; schema: z.ZodType<T, z.ZodTypeDef, unknown>; model?: "fast" | "smart"; max_tokens?: number; temperature?: number;
}): Promise<T> {
  try {
    return await completeJSONWith(PROCESS.models[opts.model ?? "smart"], opts, (opts.model ?? "smart") === "smart" ? 3 : 6);
  } catch (e) {
    // The primary model can be overloaded (503) for minutes at a time on the free tier. Fall back to the fast model once.
    if ((opts.model ?? "smart") === "smart" && /retries exhausted|503|UNAVAILABLE|network error/i.test(String(e))) {
      console.warn(`  [llm] ${PROCESS.models.smart} unavailable; falling back to ${PROCESS.models.fast}`);
      return completeJSONWith(PROCESS.models.fast, opts, 6);
    }
    throw e;
  }
}

async function completeJSONWith<T>(model: string, opts: {
  system: string; user: string; schema: z.ZodType<T, z.ZodTypeDef, unknown>; max_tokens?: number; temperature?: number;
}, failFastAfter = 6): Promise<T> {
  lastModelUsed = model;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await gemini(model, {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: "user", parts: [{ text: opts.user + (attempt ? `\n\nYour previous output failed validation: ${String(lastErr)}. Fix it.` : "") }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: opts.max_tokens ?? 8000, temperature: opts.temperature ?? 0.2 },
    }, failFastAfter);
    try {
      return opts.schema.parse(extractJSON(textOf(r)));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`LLM JSON failed validation: ${String(lastErr)}`);
}

export type WebFinding = { text: string; sources: { url: string; title: string; snippet: string }[] };

// Live research using Gemini's Google Search grounding. Every grounded source becomes Evidence;
// the caller logs a Gap when none come back. (Grounding cannot be combined with JSON mode, so this returns prose.)
export async function webResearch(prompt: string, _maxUses = 5): Promise<WebFinding> {
  if (groundingOff) throw new QuotaError(groundingOff);
  let r: any;
  try {
    r = await gemini(PROCESS.models.smart, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 4000, temperature: 0.1 },
    });
  } catch (e) {
    if (e instanceof QuotaError) groundingOff = e.message + "; grounded search disabled for the rest of this run"; // circuit breaker
    throw e;
  }
  const cand = r.candidates?.[0];
  const chunks: { web?: { uri: string; title?: string } }[] = cand?.groundingMetadata?.groundingChunks ?? [];
  const supports: { segment?: { text?: string }; groundingChunkIndices?: number[] }[] = cand?.groundingMetadata?.groundingSupports ?? [];
  const sources = new Map<string, { url: string; title: string; snippet: string }>();
  chunks.forEach((c, i) => {
    if (!c.web?.uri) return;
    const snippet = supports.filter((s) => s.groundingChunkIndices?.includes(i)).map((s) => s.segment?.text ?? "").join(" … ").slice(0, 500);
    sources.set(c.web.uri, { url: c.web.uri, title: c.web.title ?? "", snippet });
  });
  return { text: textOf(r), sources: [...sources.values()] };
}
