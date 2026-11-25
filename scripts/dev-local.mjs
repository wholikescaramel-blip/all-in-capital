// Runs the app against the local file store (data/db.json) with mock mail and no model, so nothing touches Neon, Resend or Cal.com.
// npm run dev:local
import { spawn } from "node:child_process";
const env = { ...process.env, DATABASE_URL: "", GEMINI_API_KEY: "", MAIL_MODE: "mock", RESEND_API_KEY: "", CAL_API_KEY: "" };
const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "dev", "-p", String(process.env.PORT ?? 3100)], { env, stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (c) => process.exit(c ?? 0));
