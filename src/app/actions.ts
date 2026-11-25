"use server";
import { revalidatePath } from "next/cache";
import { extractText, getDocumentProxy } from "unpdf";
import { loadDB, saveDB } from "@/lib/store";
import { submitReview } from "@/lib/pipeline";
import { approveAndSend, draftEmail, sendFollowup, tick } from "@/lib/outreach";
import { processReply } from "@/lib/replies";
import { flushMail } from "@/lib/mail";
import { passHash, requireUnlocked } from "@/lib/guard";
import { draftFounderReply, type Scenario } from "@/lib/foundersim";
import { calCancel } from "@/lib/cal";
import { getOut } from "@/lib/emailflow";
import { cookies } from "next/headers";
import { removeNote, reviseDraft, restoreVersion, saveEdits } from "@/lib/emailflow";
import { advance, createFromFiles, createFromName, type AddResult } from "@/lib/addflow";
import { CRITERIA } from "@/config/rubric";

type Res = { ok?: boolean; error?: string };

async function run(appId: string, fn: (db: Awaited<ReturnType<typeof loadDB>>) => unknown | Promise<unknown>, guard = false): Promise<Res> {
  const db = await loadDB();
  try { if (guard) await requireUnlocked(); await fn(db); await flushMail(db); await saveDB(db); } catch (e) { return { error: String((e as Error).message) }; }
  revalidatePath("/"); revalidatePath(`/apps/${appId}`);
  return { ok: true };
}

// ---------- review ----------
export async function reviewAction(_: unknown, fd: FormData): Promise<Res> {
  const id = String(fd.get("id"));
  const fixes = CRITERIA.flatMap((c) => {
    const v = String(fd.get(`fix_${c.key}`) ?? "").trim();
    return v === "" ? [] : [{ criterion: c.key, new_score: Number(v), reason: String(fd.get(`why_${c.key}`) ?? "") }];
  });
  return run(id, (db) => submitReview(db, id, String(fd.get("reviewer") || "associate"), fd.get("decision") as "take_call" | "pass" | "hold", String(fd.get("reason") || "") || undefined, fixes));
}

// ---------- email: draft, fact-check, revise ----------
export async function draftAction(id: string) { return run(id, (db) => draftEmail(db, id)); }
export async function saveDraftAction(id: string, body: string) { return run(id, (db) => saveEdits(db, id, body)); }
export async function reviseAction(id: string, instruction: string) { return run(id, (db) => reviseDraft(db, id, instruction)); }
export async function restoreAction(id: string, n: number) { return run(id, (db) => restoreVersion(db, id, n)); }
export async function sendAction(id: string, approver: string, confirmTo?: string) { return run(id, (db) => approveAndSend(db, id, approver, new Date(), { expectTo: confirmTo }), true); }
export async function sendFollowupAction(id: string) { return run(id, (db) => sendFollowup(db, id), true); }
// ---------- replies: simulated, pasted, or received ----------
export async function founderDraftAction(id: string, scenario: string): Promise<{ text?: string; error?: string }> {
  const db = await loadDB();
  try { return { text: await draftFounderReply(db, id, scenario as Scenario) }; } catch (e) { return { error: String((e as Error).message) }; }
}
export async function deliverReplyAction(id: string, text: string, via: "simulated" | "pasted") {
  if (!text.trim()) return { error: "Write or paste a reply first." };
  return run(id, (db) => processReply(db, id, text, { via }), true);
}
export async function cancelMeetingAction(id: string) {
  return run(id, async (db) => {
    const o = getOut(db, id);
    if (!o.meeting) throw new Error("No meeting to cancel");
    if (o.meeting.provider === "cal" && o.meeting.uid) await calCancel(o.meeting.uid);
    o.meeting = undefined; o.slot = undefined; o.needs_human = "The meeting was cancelled. A person decides what happens next."; o.state = "FLAGGED_PARTNER";
    const { transition } = await import("@/lib/store");
    transition(db, id, "FLAGGED", "reviewer", "meeting cancelled");
  }, true);
}
export async function unlockAction(_: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const pass = process.env.ACTION_PASSCODE;
  if (!pass) return { error: "ACTION_PASSCODE is not set on the server." };
  if (String(fd.get("passcode") ?? "") !== pass) return { error: "Wrong passcode." };
  (await cookies()).set("aic_pass", passHash(pass), { httpOnly: true, secure: true, sameSite: "lax", maxAge: 12 * 3600, path: "/" });
  return { ok: true };
}
export async function tickAction(days: number) {
  const db = await loadDB();
  await requireUnlocked();
  await tick(db, new Date(Date.now() + days * 86400000));
  await flushMail(db);
  await saveDB(db);
  revalidatePath("/");
}


// ---------- adding applications ----------
export type AddState = (Res & Partial<AddResult>) | null;

async function textOf(f: File): Promise<string> {
  const buf = await f.arrayBuffer();
  if (/\.pdf$/i.test(f.name)) {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    return (await extractText(pdf, { mergePages: true })).text;
  }
  return new TextDecoder().decode(buf);
}

export async function uploadAction(_: unknown, fd: FormData): Promise<AddState> {
  const files = fd.getAll("files").filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (!files.length) return { error: "Choose at least one file." };
  if (files.length > 30) return { error: "Up to 30 files at a time." };
  const texts: { name: string; text: string }[] = [];
  try {
    for (const f of files) {
      const text = await textOf(f);
      if (!text.trim()) return { error: `${f.name} has no readable text. If it's a scan, upload a text version.` };
      texts.push({ name: f.name, text });
    }
    const db = await loadDB();
    const res = await createFromFiles(db, texts);
    await saveDB(db);
    revalidatePath("/"); revalidatePath("/add");
    return { ok: true, ...res };
  } catch (e) { return { error: String((e as Error).message) }; }
}

export async function addByNameAction(_: unknown, fd: FormData): Promise<AddState> {
  try {
    const db = await loadDB();
    const res = await createFromName(db, String(fd.get("name") ?? ""), String(fd.get("email") ?? ""));
    await saveDB(db);
    revalidatePath("/"); revalidatePath("/add");
    return { ok: true, ...res };
  } catch (e) { return { error: String((e as Error).message) }; }
}

// One processing step per call, so each stays inside a serverless time limit.
export async function advanceAction(id: string): Promise<{ done?: boolean; stage?: number; label?: string; error?: string }> {
  const db = await loadDB();
  try {
    const r = await advance(db, id);
    await saveDB(db);
    revalidatePath("/");
    return r;
  } catch (e) {
    const msg = String((e as Error).message).slice(0, 200);
    if (db.pending[id]) db.pending[id].error = msg;
    await saveDB(db);
    return { error: msg };
  }
}

export async function removeNoteAction(appId: string, noteId: string) { return run(appId, (db) => removeNote(db, noteId)); }

// "Check now": read replies and book for one application (or all). Locked behind the passcode whenever real mail is on.
export async function checkRepliesAction(id?: string) {
  await requireUnlocked();
  const { runScheduler } = await import("@/lib/scheduler");
  const r = await runScheduler({ only: id });
  revalidatePath("/"); if (id) revalidatePath(`/apps/${id}`);
  return r;
}
