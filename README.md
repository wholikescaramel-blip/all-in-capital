# All In Capital

First-pass review of applications for All In Capital. It makes the case; a reviewer decides. Nothing is auto-rejected or auto-advanced.
The fund's people in the case are personas; the app models them as roles (`associate`, `partner`) with no logins.

Stack (all free tier): Gemini API (scoring + grounded Google Search research), Neon Postgres (state), GitHub (repo), Vercel (review UI).

## Setup

```powershell
copy .env.example .env.local     # then fill in GEMINI_API_KEY (and DATABASE_URL for Neon)
npm install
```

- `GEMINI_API_KEY`: Google AI Studio key. Free tier is rate limited, so calls are paced (`GEMINI_MIN_INTERVAL_MS`, default 4500). A full intake of 10 applications takes roughly 10 to 15 minutes.
- `DATABASE_URL`: Neon connection string. Without it the app uses `data/db.json` locally (fine for dev, not usable on Vercel).
- Without `GEMINI_API_KEY` everything runs on offline keyword heuristics: a demo of the workflow, not judgement.

## Run it

```powershell
npm run ingest        # 10 applications -> research -> conflict check -> score -> AWAITING_REVIEW (writes to Neon)
npm run dev           # review UI at http://localhost:3000
npm run preregister   # lock thresholds + rubric + memos BEFORE the first backtest
npm run backtest      # 12 memos; refuses to run if config changed since registration
npm run tick -- 3     # simulate days passing: follow-ups, then flag after 3
npm test              # offline end-to-end self-test (state machine, corrections reuse, booking)
```

## Fund-page scraper

`npm run scrape:fund` reads the fund's own site (thesis + portfolio) directly with a polite scraper (`src/lib/scraper.ts`, `fundsite.ts`): obeys robots.txt, waits between requests, caps fetches per run, caches for 24h, never fetches LinkedIn or search pages, and does not get around bot walls (a blocked page becomes a logged gap). Every company name must appear in the fetched page text. It runs first in the fund-research step; grounded Google Search then adds anything the site omits, labelled as unverified. `npm run test:scraper` tests it against a local server. Set `SCRAPER_CONTACT` and `FUND_URL` in `.env.local`.

## Deploying to Vercel

1. Push this repo to GitHub, import it in Vercel.
2. Set env vars `DATABASE_URL` and `GEMINI_API_KEY` in the Vercel project.
3. Run `npm run ingest` and `npm run backtest` locally against the same Neon database. They are long, rate-limited jobs and do not run inside a serverless request. Vercel serves the review UI, corrections, drafting, mock send, reply handling and booking.

## Where things live

| Piece | File |
|---|---|
| Data model, hard rule (score needs evidence or gap) | `src/lib/schemas.ts` |
| Rubric v0, weights, gap penalty | `src/config/rubric.ts` |
| Thresholds, follow-up interval (3 days), slots, routing, models | `src/config/process.ts` |
| Gemini client (JSON + grounded search) | `src/lib/llm.ts` |
| Storage (Neon or local file) and state machine | `src/lib/store.ts` |
| Ingest, research (every finding = Evidence, every miss = Gap) | `src/lib/ingest.ts`, `research.ts` |
| Portfolio conflict check (default hold) | `src/lib/conflict.ts` |
| Scorer, recommendation | `src/lib/scorer.ts`, `recommend.ts` |
| Corrections memory | `src/lib/corrections.ts` |
| Mock email, replies, follow-ups, Tue/Thu slot booking | `src/lib/outreach.ts` |
| Backtest + pre-registration | `scripts/backtest.ts`, `data/backtest/` |

## Known limits

- Live research and scoring have not been run against Gemini yet. Expect prompt and parsing fixes on first live run. The Neon path is also untested.
- Grounded search returns Google redirect URLs as sources; titles are the source domains.
- Backtest cut-off dates are assumptions and search cannot be fully date-blocked. The rubric was drafted from the same 12 memos, so the backtest is in-sample for it.
- Scraped portfolio names come from link and logo text unless Gemini extraction runs (it adds descriptions); a few non-company labels can slip through (the live site gave "Early conviction"). ePlane is not listed on the live site, so it only enters via the memos.
- If the fund site can't be read, a gap is logged and conflict checks carry a warning.
- Email and calendar are mocked: sends are recorded in the `outbox` of the stored state.

## Adding applications and the email flow

- **Add applications** page: upload decks and forms (PDF or text, paired by file name such as Acme_Deck.pdf and Acme_Form.pdf), or type a company name or website. Each company is then read, researched, checked against the portfolio and scored in short steps, so it fits Vercel limits. The files in data/applications still load with npm run ingest.
- **Email**: after a reviewer approves a call, the AI writes the email from facts in the application, a second pass checks every claim against its source and rewrites if needed (up to 3 rounds), and the reviewer can ask for changes in a chat box. Every version and its fact-check is kept. Sending is mocked.
- The contact is the founder named on the application. If no email was given, a stand-in address on a reserved .example domain is shown. Real addresses are never guessed.
- Scripts: npm run status, npm run refresh-fund, npm run try-email -- grainkind (dry run, saves nothing).
