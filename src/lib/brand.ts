import { PNG } from "pngjs";
import { defaultScrapeConfig } from "./scraper";

// A company's brand colour, taken from its own logo: the site's touch icon or favicon first, then Google's favicon image for the
// domain, then the page's theme-color. The colour that wins is the most common saturated one in the icon, so white backgrounds,
// black text and grey outlines do not count. Used only to tint the portfolio cards.
export type Brand = { color?: string; source?: string };

const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const sat = (r: number, g: number, b: number) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };

export function dominantColor(png: Buffer): string | undefined {
  let img: PNG;
  try { img = PNG.sync.read(png); } catch { return undefined; }
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < img.data.length; i += 4) {
    const [r, g, b, a] = [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
    if (a < 128) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mn > 225 || mx < 45 || sat(r, g, b) < 0.3) continue; // white, black, grey
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n += 1; e.r += r; e.g += g; e.b += b; bins.set(k, e);
  }
  const best = [...bins.values()].sort((x, y) => y.n - x.n)[0];
  const total = [...bins.values()].reduce((t, x) => t + x.n, 0);
  if (!best || best.n < Math.max(6, total * 0.04)) return undefined;
  return hex(best.r / best.n, best.g / best.n, best.b / best.n);
}

async function getPng(url: string): Promise<{ buf: Buffer; w: number } | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": defaultScrapeConfig().userAgent }, signal: AbortSignal.timeout(10000), redirect: "follow" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100 || buf.length > 600000 || buf.readUInt32BE(0) !== 0x89504e47) return null; // PNG only
    return { buf, w: buf.readUInt32BE(16) };
  } catch { return null; }
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1];

export function iconCandidates(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attr(m[0], "rel") ?? "", href = attr(m[0], "href");
    if (!href || !/icon/i.test(rel) || /\.(svg|ico)(\?|$)/i.test(href)) continue;
    try { out.push(new URL(href, base).toString()); } catch { /* skip */ }
  }
  return out.sort((a) => (/apple-touch/i.test(a) ? -1 : 0)).slice(0, 4);
}

export async function brandColor(website: string, html = ""): Promise<Brand> {
  for (const u of html ? iconCandidates(html, website) : []) {
    const p = await getPng(u);
    const c = p && p.w >= 32 ? dominantColor(p.buf) : undefined;
    if (c) return { color: c, source: "logo on the company's site" };
  }
  const host = new URL(website).hostname;
  const g = await getPng(`https://www.google.com/s2/favicons?domain=${host}&sz=128`);
  const gc = g && g.w >= 32 ? dominantColor(g.buf) : undefined; // a 16px answer is Google's generic globe, not a logo
  if (gc) return { color: gc, source: "favicon" };
  const theme = html.match(/<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)?.[1];
  if (theme && /^#[0-9a-f]{6}$/i.test(theme)) {
    const [r, g2, b] = [1, 3, 5].map((i) => parseInt(theme.slice(i, i + 2), 16));
    if (sat(r, g2, b) >= 0.3 && Math.max(r, g2, b) > 60) return { color: theme.toLowerCase(), source: "theme colour of the site" };
  }
  return {};
}

// Text on top of a brand colour: black or white, whichever reads better.
export const inkOn = (color: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)); return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111" : "#fff"; };
