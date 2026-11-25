"use client";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Applications" },
  { href: "/dashboard", label: "Pipeline" },
  { href: "/add", label: "Add applications" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/fund", label: "The fund" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="Sections">
      {TABS.map((t) => {
        const on = t.href === "/" ? path === "/" || path.startsWith("/apps") : path.startsWith(t.href);
        return <a key={t.href} href={t.href} className={`tab ${on ? "on" : ""}`} aria-current={on ? "page" : undefined}>{t.label}</a>;
      })}
    </nav>
  );
}
