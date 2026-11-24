import "./globals.css";
import "./extra.css";
import { Nav } from "./Nav";

export const metadata = { title: "All In Triage", description: "First-pass application triage that makes the case; a reviewer decides." };
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en"><body>
      <header className="top">
        <a href="/" className="brand"><i />All In Triage</a>
        <Nav />
        <span className="note"><span className="dot" />Advisory only. A reviewer decides.</span>
      </header>
      <main>{children}</main>
    </body></html>
  );
}
