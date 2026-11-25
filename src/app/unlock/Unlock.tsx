"use client";
import { useActionState } from "react";
import { unlockAction } from "../actions";

export function Unlock() {
  const [res, act, pending] = useActionState(unlockAction, null as { error?: string; ok?: boolean } | null);
  return (
    <form action={act} className="card" style={{ maxWidth: 420 }}>
      <div className="field"><label htmlFor="pc">Passcode</label><input id="pc" name="passcode" type="password" autoComplete="off" required /></div>
      <p className="row"><button disabled={pending}>{pending ? "Checking..." : "Unlock"}</button>{res?.ok && <span>Unlocked. <a href="/" className="inline">Back to the applications</a></span>}{res?.error && <span className="bad">{res.error}</span>}</p>
    </form>
  );
}
