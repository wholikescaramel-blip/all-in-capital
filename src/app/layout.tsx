import "./globals.css";
import "./extra.css";
import { Nav } from "./Nav";

export const metadata = { title: "All In Capital", description: "First-pass review of applications. It makes the case; a reviewer decides." };
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en"><body>
      <header className="top">
        <a href="/" className="brand"><i />All In Capital</a>
        <Nav />
        <span className="note"><span className="dot" />Advisory only. A reviewer decides.</span>
      </header>
      <main>{children}</main>
    </body></html>
  );
}
