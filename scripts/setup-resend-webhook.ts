import fs from "node:fs";

// Registers the inbound webhook in Resend, so replies reach the app. By default this only SHOWS what it would do.
// It needs a key that is allowed to manage webhooks and read received mail (the send-only key cannot).
//   npm run setup:webhook -- https://your-site.vercel.app            (dry run)
//   npm run setup:webhook -- https://your-site.vercel.app --create
// The signing secret goes straight into .env.local and is never printed.
const site = process.argv.slice(2).find((a) => a.startsWith("http"));
const create = process.argv.includes("--create");
const key = process.env.RESEND_RECEIVING_KEY || process.env.RESEND_API_KEY;
if (!site) throw new Error("Pass the site address, e.g. https://all-in-capital-flame.vercel.app");
if (!key) throw new Error("No Resend key is set");
const endpoint = site.replace(/\/$/, "") + "/api/inbound";

console.log(`Would create 1 Resend webhook: ${endpoint} for the event email.received`);
if (!create) { console.log("\nDry run only. Nothing was changed. Run with --create to apply."); process.exit(0); }

const r = await fetch("https://api.resend.com/webhooks", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ endpoint, events: ["email.received"] }) });
const j = (await r.json().catch(() => ({}))) as { id?: string; signing_secret?: string; message?: string };
if (!r.ok || !j.signing_secret) throw new Error(`Resend refused: ${j.message ?? r.status}. A send-only key cannot create webhooks.`);
fs.appendFileSync(".env.local", `\nRESEND_WEBHOOK_SECRET=${j.signing_secret}\n`);
console.log(`Created webhook ${j.id}. The signing secret was added to .env.local (not shown). Add RESEND_WEBHOOK_SECRET to Vercel too.`);
