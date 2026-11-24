// Rubric v1. Drafted from the 12 deal memos and the partner meeting notes, then reworked after the first live runs.
// Weights are config. This is guidance for the scorer, not a checklist: the partners said written rules turn into
// checklists that founders learn to pass, so each criterion has a question and three behaviour anchors, not pass/fail tests.

export type Group = "founder" | "path";

export type Criterion = {
  key: string;
  group: Group;
  label: string;
  weight: number;
  question: string; // what the scorer asks of the evidence
  // What a low, middle and high score look like. Behaviour only (no company names), so the same anchors are safe in a backtest.
  anchors: { low: string; mid: string; high: string };
  seed_evidence: string; // which past cases motivate it (withheld from the scorer in a backtest)
  fixed_score?: number; // evidence a deck cannot show: scored neutral, never guessed
  always_gap?: string; // note shown for that unavailable evidence
};

export const RUBRIC_VERSION = "v1";

export const CRITERIA: Criterion[] = [
  {
    key: "risk_ownership", group: "founder", label: "Risk ownership", weight: 1,
    question: "Do the founders own the central risk of the business (credit, regulation, operations, supply) rather than hand it to a partner, a regulator or 'later'? The sector label matters less than this.",
    anchors: {
      low: "Hands the central risk to someone else (a lending partner, a regulator, 'solved once the tech works').",
      mid: "Names the risk and has a partial plan, or has not met it yet.",
      high: "Owns the risk themselves with a concrete plan or hire, and has done the groundwork.",
    },
    seed_evidence: "CampusCredit (pass: default rates are 'the NBFC's problem') vs Jai Kisan (yes: built credit-risk plan). AeroDrop pass.",
  },
  {
    key: "numeric_fluency", group: "founder", label: "Numeric fluency", weight: 1,
    question: "Do the founders know and state their own numbers (repeat rate, CAC by channel, margin, retention), and do the deck and form agree? This is about whether they know the figures. What the figures say is scored under unit economics.",
    anchors: {
      low: "No repeat, CAC or margin figures, or figures that contradict each other.",
      mid: "Some figures, blended across channels, with no cohort split.",
      high: "States CAC by channel, cohort repeat and margin, and they agree across deck and form.",
    },
    seed_evidence: "Giva (yes: CAC by channel, repeat %) vs Petalry, Prepnest (pass: no repeat or retention data).",
  },
  {
    key: "field_first", group: "founder", label: "Field-first behaviour", weight: 1,
    question: "Did the founders work with customers directly before building or scaling (store visits, manual transactions, field registration)?",
    anchors: {
      low: "Built from desk research. No direct customer contact described.",
      mid: "Some customer conversations, or pilots run by others.",
      high: "Worked inside the customer's world first: store visits, hand-run transactions, field sign-ups.",
    },
    seed_evidence: "Wint Wealth, SuperK, Jai Kisan (yes), Unbox Robotics (talked about pilot failures).",
  },
  {
    key: "candour", group: "founder", label: "Candour under pressure", weight: 0.5,
    question: "Does the founder volunteer weaknesses and engage when pushed on weak spots, or get defensive?",
    anchors: { low: "Defensive when pushed.", mid: "Not observed.", high: "Volunteers weaknesses before being asked." },
    seed_evidence: "Prepnest (bristled at copy-risk question), Unbox (described failures before asked).",
    fixed_score: 5,
    always_gap: "Can't tell from a deck. This one needs the call.",
  },
  {
    key: "customer_traction", group: "path", label: "Customer and traction evidence", weight: 1,
    question: "Is there evidence of a paying customer, a signed pilot, or traction that is real (not downloads, audience or waitlist)? Score evidence, not pedigree.",
    anchors: {
      low: "No customer, or only downloads, audience or a waitlist.",
      mid: "Pilots, or a small paying base with early repeat.",
      high: "Paying customers at meaningful volume, growing, with repeat.",
    },
    seed_evidence: "AeroDrop pass (no signed customer; credentials scored 7.5). Unbox (live sites).",
  },
  {
    key: "unit_economics", group: "path", label: "Unit economics and repeat", weight: 1,
    question: "What do the numbers say: is growth earned (repeat, positive contribution margin) or bought (rising CAC, paid channels doing the work)?",
    anchors: {
      low: "Growth is bought: rising CAC, negative contribution margin, paid channels dominate.",
      mid: "Margins positive but thin or unproven. Repeat unclear.",
      high: "Growth is earned: strong repeat, positive contribution margin, CAC flat or falling.",
    },
    seed_evidence: "Petalry (2/3 paid social, CAC rising), HopBox (negative contribution margin), Giva.",
  },
  {
    key: "structure_capital", group: "path", label: "Structure and capital fit", weight: 1,
    question: "Does the model fit a pre-seed cheque, or does it need density or far more capital than we deploy to work?",
    anchors: {
      low: "Only works at a density or capital level far beyond a pre-seed cheque.",
      mid: "Capital-hungry but can be funded in stages.",
      high: "Works at small scale. A pre-seed cheque reaches real proof.",
    },
    seed_evidence: "HopBox (pass on structure not people). ePlane accepted as long-duration bet with sized cheque.",
  },
  {
    key: "regulatory_dependence", group: "path", label: "Regulatory dependence", weight: 1,
    question: "Does the business depend on a favourable regulatory change, and do the founders have a milestone plan for the regulator if it does not come?",
    anchors: {
      low: "Only exists if a rule changes in its favour, with no plan B.",
      mid: "Regulated, with an approval path that is long or partly in others' hands.",
      high: "Not regulation-dependent, or has a milestone plan agreed with the regulator.",
    },
    seed_evidence: "Coinlane (pass: bet on friendlier rules), AeroDrop (no regulator plan) vs ePlane (milestone sequence).",
  },
  {
    key: "sector_thesis_fit", group: "path", label: "Sector and thesis fit", weight: 1,
    question: "Does it fit what the fund backs: fintech, deeptech, consumer tech, consumer brands, and lately commerce infrastructure? Judge on the written line and on what the fund has actually backed recently. Say which you used and why.",
    anchors: {
      low: "Outside what the fund backs, on the written line and in practice.",
      mid: "Adjacent: the label stretches but the founders' behaviour fits.",
      high: "Squarely inside the thesis and the recent backing.",
    },
    seed_evidence: "Jai Kisan (label stretched, still yes). Partner note 5 on thesis drift.",
  },
];

export const GROUP_WEIGHTS: Record<Group, number> = { founder: 0.5, path: 0.5 };

// Missing information always lowers a score (it is never skipped), by severity and not by how many bullets the model wrote:
// none = everything this criterion needs is present; some = a useful detail is missing; key = the main figure or fact is missing.
export type MissingLevel = "none" | "some" | "key";
export const MISSING_PENALTY: Record<MissingLevel, number> = { none: 0, some: 1, key: 2 };
// A criterion with no supporting evidence at all is capped here.
export const NO_EVIDENCE_CAP = 3.5;

export const SECTOR_KEYWORDS: Record<string, string[]> = {
  deeptech: ["deeptech", "deep tech", "drone", "robot", "evtol", "aerospace", "hardware", "semiconductor"],
  fintech: ["fintech", "credit", "lending", "payments", "bond", "insurance", "wealth", "tax", "ca ", "accounting", "invest"],
  consumer_brand: ["d2c", "brand", "skincare", "jewellery", "snacks", "apparel"],
  consumer_tech: ["consumer", "app", "marketplace", "edtech", "travel", "rent"],
  commerce_infrastructure: ["commerce infrastructure", "kirana", "small-town", "distributor", "wholesale", "retail network", "supply and billing"],
};
