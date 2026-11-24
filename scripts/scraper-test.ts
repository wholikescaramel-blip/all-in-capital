// Tests the scraper against a local HTTP server: robots.txt, fetch cap, own-link preference, 403 handling,
// blocked hosts, snippet gate, and portfolio extraction (offline fallback path).
process.env.SKIP_FUND_SCRAPE = "";
import assert from "node:assert/strict";
import http from "node:http";
import { Fetcher, defaultScrapeConfig, scrapeSite, snippetInText, htmlToText } from "../src/lib/scraper";
import { scrapeFundSite } from "../src/lib/fundsite";

const hits: string[] = [];
const server = http.createServer((req, res) => {
  hits.push(req.url!);
  const send = (code: number, body: string) => { res.writeHead(code, { "content-type": "text/html" }); res.end(body); };
  switch (req.url) {
    case "/robots.txt": return send(200, "User-agent: *\nDisallow: /private\n");
    case "/": return send(200, `<html><body><a href="/our-companies">Portfolio</a> <a href="/about-us">About</a><script>x=1</script></body></html>`);
    case "/our-companies": return send(200, `<h1>Our companies</h1><a href="/c/alpha">Alpha Robotics</a><a href="/c/beta">Beta Pay</a><img alt="Gamma Foods"><a href="/team">Team</a><a href="/c/x">Read more</a><a href="/c/y">Apply</a><a href="/c/z">Beta Pay.ai</a><a href="/founder_story">Founder story about investing</a>`);
    case "/founder_story": return send(200, `<p>Our founder loved us</p>`);
    case "/about-us": return send(200, `<p>We invest at pre-seed in fintech, deeptech and consumer founders.</p><p>Cookie banner text</p>`);
    case "/private": return send(200, "secret");
    case "/forbidden": return send(403, "nope");
    default: return send(404, "nf");
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const cfg = () => ({ ...defaultScrapeConfig(), cachePath: undefined, delayMs: 5, timeBudgetMs: 10000 });

// robots + 403 + blocked hosts + fetch cap
let f = new Fetcher(cfg());
assert.equal(await f.get(`${base}/private`), null); assert.ok(f.skipped.some((s) => /robots/.test(s.reason)), "robots.txt honoured");
assert.equal(hits.includes("/private"), false, "disallowed path never requested");
assert.equal(await f.get(`${base}/forbidden`), null); assert.ok(f.failed.some((x) => /403/.test(x.reason)), "403 recorded, not circumvented");
assert.equal(await f.get("https://www.linkedin.com/in/someone"), null); assert.ok(f.skipped.some((s) => /blocked host/.test(s.reason)));
f = new Fetcher({ ...cfg(), maxFetches: 2 });
await f.get(`${base}/`); await f.get(`${base}/about-us`); assert.equal(await f.get(`${base}/our-companies`), null); assert.ok(f.capHit, "hard fetch cap");

// prefers the site's own link ('/our-companies') over guessed '/portfolio'
hits.length = 0;
const rep = await scrapeSite(base, new Fetcher(cfg()), [{ name: "portfolio", paths: ["/portfolio"], linkRegex: /portfolio|companies/i }]);
assert.ok(rep.pages.portfolio?.url.endsWith("/our-companies")); assert.ok(!hits.includes("/portfolio"), "own link tried first");

// evidence gate
assert.ok(snippetInText("pre-seed in fintech", htmlToText("<p>We invest at  pre-seed\nin FinTech</p>")));
assert.ok(!snippetInText("series b in biotech", "We invest at pre-seed in fintech"));

// end to end: portfolio + thesis from a (local) fund site, offline fallback extraction
process.env.GEMINI_API_KEY = ""; // force offline extraction path
const site = await scrapeFundSite([base]);
const names = site.portfolio.map((p) => p.name);
assert.ok(["Alpha Robotics", "Beta Pay", "Gamma Foods"].every((n) => names.includes(n)), `names: ${names}`);
assert.ok(["Team","Read more","Apply"].every((n) => !names.includes(n)), "navigation text filtered");
assert.equal(names.filter((n) => /beta/i.test(n)).length, 1, "duplicates merged");
assert.ok(!names.some((n) => /story/i.test(n)), "sentence-like link text is not a company name");
assert.ok(/pre-seed/.test(site.thesis_text), "thesis read from page");
assert.ok(site.gaps.some((g) => /links and logos/.test(g)), "low-confidence extraction is logged as a gap");
console.log("scraper tests OK. Portfolio read:", names.join(", "));
server.close();
