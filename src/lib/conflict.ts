import { z } from "zod";
import type { Application, Assessment, DB } from "./schemas";
import { completeJSON, hasLLM } from "./llm";
import { nameKey } from "./fundsite";

type Flag = Assessment["conflict_flags"][number];

const STOP = new Set("the a an and or of for to in on with by is are that this their its from as at it be we our your you into using use via based platform app startup company india indian".split(" "));
const toks = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

function jaccard(a: Set<string>, b: Set<string>) {
  const i = [...a].filter((x) => b.has(x)).length;
  return i / (a.size + b.size - i || 1);
}

// Deliberately sensitive: the fund would rather get a false alarm than miss a real conflict.
export async function conflictCheck(db: DB, app: Application): Promise<Flag[]> {
  const norm = (s: string) => s.toLowerCase().replace(/^the /, "").replace(/[^a-z0-9]/g, "");
  // In a backtest the company under test is itself in the portfolio list; never flag it against itself.
  // Backtest only. The company under test is never its own overlap (under any alias, e.g. "ePlane" and "The ePlane Company"),
  // and the other memo companies are left out too: the order in which the fund backed them is unknown, so counting them
  // against each other would compare a company with investments made after the decision being tested.
  const same = (a: string, b: string) => { const x = nameKey(a), y = nameKey(b); return x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))); };
  const skip = app.is_backtest ? [app.company, ...(app.conflict_exclude ?? [])] : [];
  const portfolio = db.fund.portfolio.filter((p) => !skip.some((s) => same(p.name, s)));
  const flags: Flag[] = [];
  const appText = `${app.one_liner} ${app.form_fields["What have you built?"] ?? ""} ${app.deck_text.slice(0, 1200)}`;

  if (hasLLM()) {
    try {
      const r = await completeJSON({
        system: "You check a startup against an investor's portfolio for sector or product overlap. Err on the side of flagging: a false alarm is better than a miss. Flag direct competitors AND adjacent products serving the same customer for the same job.",
        user: `STARTUP: ${app.company}. ${appText}\n\nPORTFOLIO:\n${portfolio.map((p) => `- ${p.name}: ${p.description}`).join("\n")}\n\nReturn {"overlaps":[{"portfolio_company","reason"}]} (empty list if none).`,
        schema: z.object({ overlaps: z.array(z.object({ portfolio_company: z.string(), reason: z.string() })) }), model: "smart",
      });
      for (const o of r.overlaps) flags.push({ ...o, severity: "overlap" });
    } catch { /* fall through to lexical check */ }
  }
  // Lexical backstop always runs, so an LLM miss can still be caught.
  const a = toks(appText);
  for (const p of portfolio) {
    if (flags.some((f) => f.portfolio_company === p.name)) continue;
    const sim = jaccard(a, toks(p.description));
    const nameHit = appText.toLowerCase().includes(p.name.toLowerCase());
    if (sim >= 0.08 || nameHit) flags.push({ portfolio_company: p.name, reason: `${nameHit ? "Application mentions the portfolio company. " : ""}Lexical similarity ${sim.toFixed(2)} to portfolio description "${p.description}".`, severity: "overlap" });
  }
  if (db.fund.gaps.some((g) => /portfolio/i.test(g))) {
    flags.push({ portfolio_company: "(unverified list)", reason: "Full public portfolio list not confirmed in this run; an overlap with a company not on the working list cannot be ruled out.", severity: "warning" });
  }
  return flags;
}
