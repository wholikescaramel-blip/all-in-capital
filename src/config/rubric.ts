// Rubric v0. Drafted from the 12 deal memos and the partner meeting notes.
// Weights are CONFIG, to be tuned by the backtest. This is guidance for the scorer, not a checklist:
// the partners explicitly said written rules turn into checklists that founders learn to pass.

export type Group = "founder" | "path";

export type Criterion = {
  key: string;
  group: Group;
  label: string;
  weight: number;
  question: string; // what the scorer asks of the evidence
  seed_evidence: string; // which past cases motivate it
  low_evidence_from_deck?: boolean; // candour: a deck cannot show it
  always_gap?: string; // evidence that is structurally unavailable from a deck/form
};

export const RUBRIC_VERSION = "v0";

export const CRITERIA: Criterion[] = [
  {
    key: "risk_ownership", group: "founder", label: "Risk ownership", weight: 1,
    question: "Do the founders own the central risk of the business (credit, regulation, ops, supply) rather than hand it to a partner, a regulator or 'later'? Sector label matters less than this.",
    seed_evidence: "CampusCredit (pass: default rates are 'the NBFC's problem') vs Jai Kisan (yes: built credit-risk plan). AeroDrop pass.",
  },
  {
    key: "numeric_fluency", group: "founder", label: "Numeric fluency", weight: 1,
    question: "Do the materials show the founders know their own repeat rate, CAC by channel, margin, retention? Absent numbers LOWER the score.",
    seed_evidence: "Giva (yes: CAC by channel, repeat %) vs Petalry, Prepnest (pass: no repeat or retention data).",
  },
  {
    key: "field_first", group: "founder", label: "Field-first behaviour", weight: 1,
    question: "Did the founders talk to or work with customers directly before building or scaling (store visits, manual transactions, farmer registration)?",
    seed_evidence: "Wint Wealth, SuperK, Jai Kisan (yes), Unbox Robotics (talked about pilot failures).",
  },
  {
    key: "candour", group: "founder", label: "Candour under pressure", weight: 0.5,
    question: "Does the founder volunteer weaknesses and engage when pushed on weak spots, or get defensive? Defensiveness is signal.",
    seed_evidence: "Prepnest (bristled at copy-risk question), Unbox (described failures before asked).",
    low_evidence_from_deck: true,
    always_gap: "Can't tell from a deck. This one needs the call.",
  },
  {
    key: "customer_traction", group: "path", label: "Customer and traction evidence", weight: 1,
    question: "Is there evidence of a paying customer, signed pilot, or traction that is real (not just downloads or audience)? Score evidence, not pedigree.",
    seed_evidence: "AeroDrop pass (no signed customer; credentials scored 7.5). Unbox (live sites).",
  },
  {
    key: "unit_economics", group: "path", label: "Unit economics and repeat", weight: 1,
    question: "Do the numbers show growth that is earned (repeat, positive contribution margin) rather than bought (rising CAC, paid-social dependence)?",
    seed_evidence: "Petalry (2/3 paid social, CAC rising), HopBox (negative contribution margin), Giva.",
  },
  {
    key: "structure_capital", group: "path", label: "Structure and capital fit", weight: 1,
    question: "Does the model fit a pre-seed cheque, or does it need density / far more capital than we deploy to work?",
    seed_evidence: "HopBox (pass on structure not people). ePlane accepted as long-duration bet with sized cheque.",
  },
  {
    key: "regulatory_dependence", group: "path", label: "Regulatory dependence", weight: 1,
    question: "Does the business depend on a favourable regulatory change, and do founders have a milestone plan for the regulator if it does not come?",
    seed_evidence: "Coinlane (pass: bet on friendlier rules), AeroDrop (no regulator plan) vs ePlane (milestone sequence).",
  },
  {
    key: "sector_thesis_fit", group: "path", label: "Sector and thesis fit", weight: 1,
    question: "Does it fit fintech, deeptech, consumer tech or consumer brands, judged on observed behaviour of the fund as well as the written line? Record which basis you used and why.",
    seed_evidence: "Jai Kisan (label stretched, still yes). Partner note 5 on thesis drift.",
  },
];

export const GROUP_WEIGHTS: Record<Group, number> = { founder: 0.5, path: 0.5 };

// Each unresolved gap on a criterion pulls the score down. Missing data is never skipped.
export const GAP_PENALTY = { per_gap: 1.0, max_total: 3.5 };
// A criterion with no evidence at all (only gaps) is capped here.
export const NO_EVIDENCE_CAP = 3.5;

export const SECTOR_KEYWORDS: Record<string, string[]> = {
  deeptech: ["deeptech", "deep tech", "drone", "robot", "evtol", "aerospace", "hardware", "semiconductor"],
  fintech: ["fintech", "credit", "lending", "payments", "bond", "insurance", "wealth", "tax", "ca ", "accounting", "invest"],
  consumer_brand: ["d2c", "brand", "skincare", "jewellery", "snacks", "apparel"],
  consumer_tech: ["consumer", "app", "marketplace", "edtech", "travel", "rent"],
  commerce_infrastructure: ["commerce infrastructure", "kirana", "small-town", "distributor", "wholesale", "retail network", "supply and billing"],
};
