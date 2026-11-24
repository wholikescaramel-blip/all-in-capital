"use server";
import { revalidatePath } from "next/cache";
import { loadDB, saveDB } from "@/lib/store";
import { submitReview } from "@/lib/pipeline";
import { approveAndSend, draftEmail, editDraft, handleReply, tick } from "@/lib/outreach";
import { CRITERIA } from "@/config/rubric";

async function run(appId: string, fn: (db: Awaited<ReturnType<typeof loadDB>>) => unknown | Promise<unknown>) {
  const db = await loadDB();
  try { await fn(db); await saveDB(db); } catch (e) { return { error: String((e as Error).message) }; }
  revalidatePath("/"); revalidatePath(`/apps/${appId}`);
  return { ok: true };
}

export async function reviewAction(_: unknown, fd: FormData) {
  const id = String(fd.get("id"));
  const fixes = CRITERIA.flatMap((c) => {
    const v = String(fd.get(`fix_${c.key}`) ?? "").trim();
    return v === "" ? [] : [{ criterion: c.key, new_score: Number(v), reason: String(fd.get(`why_${c.key}`) ?? "") }];
  });
  return run(id, (db) => submitReview(db, id, String(fd.get("reviewer") || "associate"), fd.get("decision") as "take_call" | "pass" | "hold", String(fd.get("reason") || "") || undefined, fixes));
}
export async function draftAction(id: string) { return run(id, (db) => draftEmail(db, id)); }
export async function saveDraftAction(id: string, body: string) { return run(id, (db) => editDraft(db, id, body)); }
export async function sendAction(id: string, approver: string) { return run(id, (db) => approveAndSend(db, id, approver)); }
export async function replyAction(_: unknown, fd: FormData) {
  const id = String(fd.get("id"));
  return run(id, (db) => handleReply(db, id, String(fd.get("text"))));
}
export async function tickAction(days: number) {
  const db = await loadDB();
  tick(db, new Date(Date.now() + days * 86400000)); await saveDB(db);
  revalidatePath("/");
}
