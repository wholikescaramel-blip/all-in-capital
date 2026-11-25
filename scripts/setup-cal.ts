export {};
// Sets up Cal.com for the app: a schedule that is open only on Tuesday and Thursday afternoons (India time) and a
// 30-minute event type that uses it. By default this only SHOWS what it would do. Add --create to make the changes.
//   npm run setup:cal            (dry run)
//   npm run setup:cal -- --create
const create = process.argv.includes("--create");
const key = process.env.CAL_API_KEY;
if (!key) throw new Error("CAL_API_KEY is not set");
const api = async (method: string, path: string, version: string, body?: unknown) => {
  const r = await fetch("https://api.cal.com" + path, { method, headers: { Authorization: `Bearer ${key}`, "cal-api-version": version, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = (await r.json().catch(() => ({}))) as { data?: any; error?: { message?: string }; message?: string };
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error?.message ?? j.message ?? r.status}`);
  return j.data;
};

const SLUG = "aic-intro-30";
const schedules: any[] = await api("GET", "/v2/schedules", "2024-06-11");
const events: any[] = await api("GET", "/v2/event-types", "2024-06-14");
const mine = events.find((e) => e.slug === SLUG);
let schedule = schedules.find((s) => s.name === "Tuesday and Thursday afternoons");

console.log("Existing event types:", events.map((e) => `${e.slug} (${e.id})`).join(", ") || "none", "| they are left untouched.");
if (mine) { console.log(`Event type "${SLUG}" already exists. Put this in .env.local: CAL_EVENT_TYPE_ID=${mine.id}`); process.exit(0); }

console.log(`Would create: 1 schedule "Tuesday and Thursday afternoons" (Asia/Kolkata, 14:00 to 18:00)${schedule ? " (already exists, reused)" : ""}`);
console.log(`Would create: 1 event type "Intro call" (${SLUG}, 30 minutes) on that schedule`);
if (!create) { console.log("\nDry run only. Nothing was changed. Run with --create to apply."); process.exit(0); }

if (!schedule) schedule = await api("POST", "/v2/schedules", "2024-06-11", { name: "Tuesday and Thursday afternoons", timeZone: "Asia/Kolkata", isDefault: false, availability: [{ days: ["Tuesday", "Thursday"], startTime: "14:00", endTime: "18:00" }] });
const ev = await api("POST", "/v2/event-types", "2024-06-14", { title: "Intro call", slug: SLUG, lengthInMinutes: 30, scheduleId: schedule.id });
console.log(`Created. Put this in .env.local and in Vercel: CAL_EVENT_TYPE_ID=${ev.id}`);
