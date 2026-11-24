import type { Application, Assessment } from "./schemas";

// Display helpers: keep wording short and plain, and keep implementation detail out of the reasoning text.
export const SECTOR_LABEL: Record<string, string> = {
  fintech: "Fintech", deeptech: "Deeptech", consumer_tech: "Consumer tech", consumer_brand: "Consumer brand", other: "Other",
};
export const nice = (s: string) => s.replace(/_/g, " ").toLowerCase();

// Older stored assessments have a model note glued onto the reason. Strip it from the text; show the model quietly elsewhere.
export const cleanReason = (s: string) => s.replace(/\s*\[Scored by fallback model[^\]]*\]\s*/g, " ").replace(/\s+/g, " ").trim();
export const scoredBy = (a: Assessment) => a.scored_by ?? a.basis_reason.match(/fallback model ([\w.-]+?):/)?.[1];

// Older stored bullets use the earlier wording; show the plain version everywhere.
export const cleanBullet = (s: string) =>
  s.replace(/^Open gaps \(scores penalised, not skipped\):/, "Missing info (each gap lowers the score):")
    .replace(/^Portfolio overlap: (.*?)\. Held by default until a partner speaks to the portfolio founder\.$/, "Overlaps with $1, already in the portfolio. On hold until someone speaks to that founder.");

// The fit line reads best as one sentence; drop an opening that only repeats the label.
export const cleanFit = (s: string) => cleanReason(s).replace(/^(The )?(startup|company) clearly (falls|fits) (under|within) the written thesis categor(y|ies) of /i, "It is a ").replace(/^Evaluated against /, "");

export const BASIS_LABEL = { written: "the stated thesis", observed: "what the fund actually backs" } as const;

export const REC_LABEL: Record<string, string> = { take_call: "Take the call", hold: "Hold", pass: "Pass" };

// The few facts a reviewer wants at a glance, pulled from the application form.
export function keyFacts(app: Application): { label: string; value: string }[] {
  const f = app.form_fields;
  const pick = (label: string, ...keys: string[]) => {
    const k = keys.find((x) => f[x]);
    return k ? { label, value: f[k].replace(/\s+/g, " ").slice(0, 70) } : null;
  };
  return [
    { label: "Sector", value: SECTOR_LABEL[app.sector] ?? app.sector },
    { label: "Stage", value: app.stage },
    pick("Raising", "Amount raising"),
    pick("Based in", "Location"),
    pick("Team", "Team size"),
    pick("Customers", "Active customers"),
    pick("Revenue", "Revenue / GMV"),
    { label: "Came via", value: app.source === "warm_intro" ? "Warm intro" : app.kind === "domain" ? "Added by name or website" : "Application form" },
  ].filter(Boolean) as { label: string; value: string }[];
}
