import crypto from "node:crypto";
import { cookies } from "next/headers";
import { mailMode } from "./mail";

// The site is public. In mock and test mode anyone can use it: mock sends nothing, and test only ever sends to the one test inbox
// (MAIL_TEST_RECIPIENT), never to a founder. Only live mode, which writes to real founders, needs the passcode.
export const passHash = (pass: string) => crypto.createHash("sha256").update("aic:" + pass).digest("hex");

export async function requireUnlocked() {
  if (mailMode() !== "live") return;
  const pass = process.env.ACTION_PASSCODE;
  if (!pass) throw new Error("Real mail is on but ACTION_PASSCODE is not set, so sending and booking are locked.");
  const have = (await cookies()).get("aic_pass")?.value;
  if (have !== passHash(pass)) throw new Error("Locked. Open /unlock and enter the passcode first.");
}
