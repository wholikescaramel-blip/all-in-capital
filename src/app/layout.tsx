import "./globals.css";
export const metadata = { title: "All In Triage", description: "First-pass application triage that makes the case; a reviewer decides." };
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en"><body>
      <header className="top">
        <a href="/" className="brand"><i />All In Triage</a>
        <span className="note"><span className="dot" />Advisory only. A reviewer sees every outcome.</span>
      </header>
      <main>{children}</main>
    </body></html>
  );
}
