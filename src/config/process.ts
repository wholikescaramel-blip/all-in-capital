// Process config: all knobs the partners may want to change live here, not in code.
export const PROCESS = {
  // Gemini free tier. Override via env if Google renames/retires a model.
  models: { fast: process.env.GEMINI_FAST_MODEL ?? "gemini-3.5-flash-lite", smart: process.env.GEMINI_SMART_MODEL ?? "gemini-3.8-flash" },
  // Recommendation thresholds (advisory only; a partner sees every outcome).
  rec: {
    take_call_min_total: 6.0,
    take_call_min_group: 5.0, // both founder and path-to-market groups must clear this
    pass_max_total: 4.0,
  },
  // Follow-ups: case gives no number. 3 days is the chosen default (configurable).
  followups: { interval_days: 3, max: 3 },
  // Slots: Tuesday or Thursday afternoons, 30 minutes, India time.
  slots: { weekdays: [2, 4], start_hour: 14, end_hour: 18, minutes: 30, tz: "Asia/Kolkata", horizon_days: 21, propose: 3 },
  // A time the founder suggests themselves is accepted on any weekday, 10:00 to 19:00 India time, within 30 days, if the calendar is free.
  booking: { weekdays: [1, 2, 3, 4, 5], start_hour: 10, end_hour: 19, minutes: 30, horizon_days: 30, min_notice_hours: 12, reoffer_start_hour: 14, reoffer_end_hour: 18, reoffer_horizon_days: 14 },
  signer: process.env.SIGNER_NAME ?? "Riya", // the invite is signed with this name, then the fund name on the next line
  // Roles, not accounts: the case's personas are modelled as roles, there is no login or per-person access.
  roles: ["associate", "partner"] as const,
  founder_domain_placeholder: "founder.example",
  // Routing: deeptech -> the deeptech partner joins; fintech/consumer -> the associate runs the first screen.
  routing: { deeptech: ["associate", "deeptech_partner"], default: ["associate"] } as Record<string, string[]>,
  top_k_corrections: 4,
  fund_name: "All In Capital",
  fund_public_urls: (process.env.FUND_URL ?? "https://www.allincapital.vc").split(",").map((s) => s.trim()), // starting point only: set FUND_URL if wrong
  mock_only: true, // seed-data scope: no real email or calendar side effects
};
