import crypto from "node:crypto";
import { runScheduler } from "@/lib/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// One address that does the whole job: read new replies on every open invite, book what can be booked, answer clashes.
// Call it by hand, or from any outside timer, with the header  Authorization: Bearer <CRON_SECRET>.
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not set, so this address is closed." }, { status: 503 });
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!same(given, secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const only = new URL(req.url).searchParams.get("app") ?? undefined;
  return Response.json(await runScheduler({ only }));
}
export const GET = handle;
export const POST = handle;
