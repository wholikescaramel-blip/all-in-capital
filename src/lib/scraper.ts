import fs from "node:fs";
import path from "node:path";

// Polite scraper (TypeScript port of the polite-scraper kit's rules). It knows HOW to fetch safely, not what the data means.
//  - honours robots.txt; waits `delayMs` between hits to one host; hard `maxFetches` per site; `timeBudgetMs` is only a deadline
//  - blocked hosts (LinkedIn etc.) are never fetched; no search-engine result pages
//  - a 403 / bot wall is NOT circumvented: the page is recorded as failed and the fact stays unknown
//  - cached on disk (24h) so re-runs are free; the cache is best-effort and never required (Vercel's disk is read-only)
//  - callers must gate every extracted fact with snippetInText() so nothing unsupported survives

export type ScrapeConfig = {
  userAgent: string; delayMs: number; maxFetches: number; timeBudgetMs: number; timeoutMs: number;
  blockedHosts: string[]; cachePath?: string; cacheTtlMs: number;
};

export const defaultScrapeConfig = (): ScrapeConfig => ({
  // A real, contactable UA belongs here. Set SCRAPER_CONTACT (an email or repo URL) in the environment.
  userAgent: `AllInTriageBot/0.1 (research for an MBA assignment; contact: ${process.env.SCRAPER_CONTACT ?? "set SCRAPER_CONTACT"})`,
  delayMs: 1500, maxFetches: 8, timeBudgetMs: 40000, timeoutMs: 12000,
  blockedHosts: ["linkedin.com", "www.linkedin.com", "google.com", "www.google.com", "bing.com", "duckduckgo.com"],
  cachePath: path.join(process.cwd(), "data", "scrape-cache.json"), cacheTtlMs: 24 * 3600 * 1000,
});

export type Page = { url: string; status: number; html: string; text: string; links: { href: string; text: string }[]; images: string[]; fromCache: boolean };
export type Target = { name: string; paths: string[]; linkRegex: RegExp };
export type Report = { pages: Record<string, Page>; failed: { url: string; reason: string }[]; skipped: { url: string; reason: string }[]; capHit: boolean; timeHit: boolean; elapsedMs: number; fetched: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export function extractLinks(html: string, base: string) {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { out.push({ href: new URL(m[1], base).toString(), text: htmlToText(m[2]).slice(0, 120) }); } catch { /* bad href */ }
  }
  return out;
}
export const extractImageAlts = (html: string) => [...html.matchAll(/<img\b[^>]*?alt\s*=\s*["']([^"']{2,80})["']/gi)].map((m) => m[1].trim());

// Evidence gate: a quote must literally appear on the page (whitespace and case insensitive).
export function snippetInText(quote: string, text: string) {
  const n = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = n(quote);
  return q.length >= 3 && n(text).includes(q);
}

type RobotsRules = { allow: string[]; disallow: string[] };
function parseRobots(txt: string, ua: string): RobotsRules {
  const token = ua.split(/[\/\s]/)[0].toLowerCase();
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let cur: { agents: string[]; rules: RobotsRules } | null = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: { allow: [], disallow: [] } }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && v) { if (k === "disallow") cur.rules.disallow.push(v); if (k === "allow") cur.rules.allow.push(v); }
    }
  }
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  return (specific ?? groups.find((g) => g.agents.includes("*")))?.rules ?? { allow: [], disallow: [] };
}
const robotsAllows = (r: RobotsRules, p: string) => {
  const longest = (list: string[]) => Math.max(-1, ...list.filter((x) => p.startsWith(x.replace(/\*$/, ""))).map((x) => x.length));
  return longest(r.allow) >= longest(r.disallow); // longest match wins; ties favour allow
};

export class Fetcher {
  fetched = 0; failed: Report["failed"] = []; skipped: Report["skipped"] = [];
  private start = Date.now(); private lastHit = new Map<string, number>(); private robots = new Map<string, RobotsRules>();
  private cache: Record<string, { at: number; status: number; html: string }> = {};
  constructor(public cfg: ScrapeConfig = defaultScrapeConfig()) {
    try { if (cfg.cachePath) this.cache = JSON.parse(fs.readFileSync(cfg.cachePath, "utf8")); } catch { /* no cache yet */ }
  }
  get capHit() { return this.fetched >= this.cfg.maxFetches; }
  get timeHit() { return Date.now() - this.start >= this.cfg.timeBudgetMs; }
  private saveCache() { try { if (this.cfg.cachePath) { fs.mkdirSync(path.dirname(this.cfg.cachePath), { recursive: true }); fs.writeFileSync(this.cfg.cachePath, JSON.stringify(this.cache)); } } catch { /* read-only FS: fine */ } }

  private async rawGet(url: string): Promise<{ status: number; body: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
        const res = await fetch(url, { headers: { "user-agent": this.cfg.userAgent, accept: "text/html,*/*;q=0.5" }, signal: ctl.signal, redirect: "follow" });
        clearTimeout(t);
        return { status: res.status, body: await res.text() };
      } catch (e) { if (attempt) throw e; await sleep(800); }
    }
    throw new Error("unreachable");
  }

  private async paceFor(host: string) {
    const wait = (this.lastHit.get(host) ?? 0) + this.cfg.delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastHit.set(host, Date.now());
  }

  async get(url: string): Promise<Page | null> {
    let u: URL;
    try { u = new URL(url); } catch { this.skipped.push({ url, reason: "bad url" }); return null; }
    if (!/^https?:$/.test(u.protocol)) { this.skipped.push({ url, reason: "non-http" }); return null; }
    if (this.cfg.blockedHosts.some((h) => u.hostname === h || u.hostname.endsWith("." + h))) { this.skipped.push({ url, reason: "blocked host" }); return null; }
    const hit = this.cache[url];
    if (hit && Date.now() - hit.at < this.cfg.cacheTtlMs) return this.mkPage(url, hit.status, hit.html, true);
    if (this.capHit) { this.skipped.push({ url, reason: "fetch cap" }); return null; }
    if (this.timeHit) { this.skipped.push({ url, reason: "time budget" }); return null; }

    if (!this.robots.has(u.host)) {
      await this.paceFor(u.host);
      try { const r = await this.rawGet(`${u.origin}/robots.txt`); this.robots.set(u.host, r.status === 200 ? parseRobots(r.body, this.cfg.userAgent) : { allow: [], disallow: [] }); }
      catch { this.robots.set(u.host, { allow: [], disallow: [] }); }
    }
    if (!robotsAllows(this.robots.get(u.host)!, u.pathname + u.search)) { this.skipped.push({ url, reason: "disallowed by robots.txt" }); return null; }

    await this.paceFor(u.host);
    this.fetched++;
    try {
      const r = await this.rawGet(url);
      if (r.status >= 400) { this.failed.push({ url, reason: `HTTP ${r.status}${r.status === 403 ? " (bot wall or forbidden; not circumvented)" : ""}` }); return null; }
      if (/just a moment|attention required|verify you are human|enable javascript and cookies/i.test(r.body.slice(0, 3000)) && r.body.length < 20000) {
        this.failed.push({ url, reason: "bot challenge page (not circumvented)" }); return null;
      }
      this.cache[url] = { at: Date.now(), status: r.status, html: r.body }; this.saveCache();
      return this.mkPage(url, r.status, r.body, false);
    } catch (e) { this.failed.push({ url, reason: String(e).slice(0, 120) }); return null; }
  }
  private mkPage(url: string, status: number, html: string, fromCache: boolean): Page {
    return { url, status, html, text: htmlToText(html), links: extractLinks(html, url), images: extractImageAlts(html), fromCache };
  }
  report(pages: Record<string, Page>): Report {
    return { pages, failed: this.failed, skipped: this.skipped, capHit: this.capHit, timeHit: this.timeHit, elapsedMs: Date.now() - this.start, fetched: this.fetched };
  }
}

// Homepage first, then each target in priority order. Prefers the site's own links over guessed paths.
export async function scrapeSite(site: string, f: Fetcher, targets: Target[]): Promise<Report> {
  const base = site.startsWith("http") ? site : `https://${site}`;
  const pages: Record<string, Page> = {};
  const home = await f.get(base);
  if (home) pages.home = home;
  const host = new URL(base).host;
  for (const t of targets) {
    if (f.capHit || f.timeHit) break;
    const own = home?.links.find((l) => new URL(l.href).host === host && (t.linkRegex.test(l.href) || t.linkRegex.test(l.text)));
    const candidates = [...(own ? [own.href] : []), ...t.paths.map((p) => new URL(p, base).toString())];
    for (const url of [...new Set(candidates)]) {
      const p = await f.get(url);
      if (p) { pages[t.name] = p; break; }
    }
  }
  return f.report(pages);
}
