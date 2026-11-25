import { Unlock } from "./Unlock";

export default function UnlockPage() {
  return (<>
    <h1 className="display">Unlock</h1>
    <p className="muted" style={{ maxWidth: 520, marginTop: 10 }}>Sending real email and booking real meetings need a passcode, because this site is public. Enter it once and it lasts 12 hours on this browser.</p>
    <Unlock />
  </>);
}
