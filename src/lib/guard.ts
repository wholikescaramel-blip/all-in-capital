import crypto from "node:crypto";
import { cookies } from "next/headers";
import { mailMode } from "./mail";

// The site is public. While mail is mock, nothing real can happen, so anyone can click around. As soon as real mail or real
// bookings are on (test or live), actions that send or book need the passcode, or a stranger could make us email or book.
export const passHash = (pass: string) => crypto.createHash("sha256").update("aic:" + pass).digest("hex");

export async function requireUnlocked() {
  if (mailMode() === "mock") return;
  const pass = process.env.ACTION_PASSCODE;
  if (!pass) throw new Error("Real mail is on but ACTION_PASSCODE is not set, so sending and booking are locked.");
  const have = (await cookies()).get("aic_pass")?.value;
  if (have !== passHash(pass)) throw new Error("Locked. Open /unlock and enter the passcode first.");
}
