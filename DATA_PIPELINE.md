# Defiant Dashboard — Data Pipeline

How every metric on the dashboard is fetched, stored, and updated.

## Update modes

| Mode | What it means |
|---|---|
| **Live (FRED)** | Frontend asks `server/index.js` → it proxies to the FRED API. Result is held in an in-memory map for 1 h and mirrored to `server/.fred_cache.json` so a server restart doesn't re-stampede the API. The series is **re-fetched fresh** on cache miss — no time-series JSON file on disk. |
| **Replace (rich source)** | Scraper overwrites the file each run. The source page itself has ~12 months of history, so the file stays full. (Investing.com Playwright path.) |
| **Replace (snapshot)** | Scraper overwrites the file each run; the data is forward-looking so there's no history to preserve. (FedWatch.) |
| **Merge** | Scraper *adds* new rows to the existing file keyed by `date`. Higher-quality rows (actual+forecast) replace lower-quality ones (forecast-only); equal-quality scrapes keep the existing version. (`_merge_rows_to_file` in `scraping/daily_scrape.py`.) |
| **Manual** | File is populated from `scraping/manual_*.txt` / `manual_*.json` overrides, or hand-edited in `server/`. Used when the live source is blocked (FINRA Cloudflare) or to seed historical actual+forecast rows the scrapers don't carry. |

---

## Section-by-section

### Liquidity Regime

| Metric | Actual source | Forecast source | Storage | Update |
|---|---|---|---|---|
| Federal Funds Rate | FRED `FEDFUNDS` | — | `.fred_cache.json` (1 h) | Live (FRED) |
| Fed Balance Sheet | FRED `WALCL` | — | `.fred_cache.json` (1 h) | Live (FRED) |
| FedWatch probabilities | — | CME FedWatch via Playwright; falls back to Investing.com `/central-banks/fed-rate-monitor` | `server/fedwatch_data.json` | Replace (snapshot) — overwritten every scrape; the data IS the forecast, no actuals to preserve |

### Financial Conditions

| Metric | Actual source | Forecast source | Storage | Update |
|---|---|---|---|---|
| VIX | FRED `VIXCLS` | — | `.fred_cache.json` (1 h) | Live (FRED) |
| 10Y Treasury Yield | FRED `DGS10` | — | `.fred_cache.json` (1 h) | Live (FRED) |
| HY Credit Spread | FRED `BAMLH0A0HYM2` (ICE BofA HY OAS) | — | `.fred_cache.json` (1 h) | Live (FRED) |
| Margin Debt | FINRA Margin Statistics page (Playwright); falls back to `scraping/manual_margin_debt.txt` | — | `server/margin_debt_data.json` | Manual today (Cloudflare blocks live scrape); on a working scrape it overwrites the file |

### Job Market

| Metric | Actual source | Forecast source | Storage | Update |
|---|---|---|---|---|
| Unemployment Rate | FRED `UNRATE` | ForexFactory weekly JSON feed | `server/unemployment_data.json` | Live actual; **Merge** for forecast |
| Initial Jobless Claims | FRED `ICSA` | ForexFactory | `server/jobless_claims_data.json` | Live actual; **Merge** for forecast |
| Nonfarm Payrolls (MoM) | FRED `PAYEMS` (level), MoM diff computed in the frontend → headline = monthly change in k jobs | ForexFactory | `server/nonfarm_payrolls_data.json` | Live actual; **Merge** for forecast |

### Inflation

| Metric | Actual source | Forecast source | Storage | Update |
|---|---|---|---|---|
| CPI YoY | FRED `CPIAUCNS` (NSA level), YoY computed in the frontend | ForexFactory | `server/cpi_data.json` | Live actual; **Merge** for forecast (May 2026 row currently seeded manually) |
| Core CPI YoY | FRED `CPILFENS`, YoY computed in the frontend | ForexFactory | `server/core_cpi_data.json` | Live actual; **Merge** for forecast |
| PPI MoM | FRED `PPIFIS`, MoM computed in the frontend | ForexFactory | `server/ppi_data.json` | Live actual; **Merge** for forecast |

### Economic Activities

| Metric | Actual + Forecast source | Storage | Update |
|---|---|---|---|
| ISM Manufacturing PMI | Investing.com `ism-manufacturing-pmi-173` via Playwright (full table of past releases + analyst consensus) | `server/ism_data.json` | Replace (rich source) — page already has ~12 months of history |
| ISM Services PMI | Investing.com `ism-non-manufacturing-pmi-176` (Playwright) | `server/ism_services_data.json` | Replace (rich source) |
| Chicago PMI | Investing.com `chicago-purchasing-managers-index-(pmi)-38` (Playwright) | `server/chicago_pmi_data.json` | Replace (rich source) |
| UoM Consumer Sentiment | Actual: FRED `UMCSENT`. Forecast: ForexFactory. | Actual via FRED cache; forecast in `server/consumer_sentiment_data.json` | Live actual; **Merge** for forecast |

---

## Daily scraper phases (`scraping/daily_scrape.py`)

The script runs five phases in order. Earlier phases write data; later phases either merge or fall back depending on what's already there.

| # | Phase | Indicators it touches | Write mode |
|---|---|---|---|
| 1 | Investing.com PMIs (Playwright) | ISM Mfg, ISM Services, Chicago PMI | Replace (rich source) |
| 2 | ForexFactory JSON | NFP, Unemployment, Jobless Claims, CPI, Core CPI, PPI, UoM Sentiment | **Merge** into existing files (keyed by date) |
| 3 | Trading Economics fallback | Same indicators as phase 2 | Only fills indicator files that are still empty after phase 2 — never overwrites |
| 4 | FINRA margin statistics | Margin Debt | Manual override `scraping/manual_margin_debt.txt` first; if absent, try live scrape (currently Cloudflare-blocked) |
| 5 | CME FedWatch | FedWatch probabilities | Manual override `scraping/manual_fedwatch.json` first; falls back to CME → Investing.com Fed Rate Monitor via Playwright. Replace (snapshot). |

### Quality scoring inside Merge

When phase 2 (or any future merging scrape) sees an existing row for the same date:

- A row with **both actual + forecast** beats forecast-only beats actual-only beats empty.
- The new row replaces the existing one **only when it's strictly better**. Equal-quality scrapes keep the existing version — this is what stops Trading Economics' model forecast from silently overwriting a ForexFactory analyst consensus that's already in the file.

---

## File map (`server/`)

| File | What's in it | Updated by |
|---|---|---|
| `.fred_cache.json` | Time series for every FRED series the frontend fetches, keyed by `seriesId|start|end`. 1 h TTL per entry. | `server/index.js` on cache miss |
| `cpi_data.json` | CPI YoY release rows from ForexFactory + manual seed | Phase 2 (merge) |
| `core_cpi_data.json` | Core CPI YoY release rows | Phase 2 (merge) |
| `ppi_data.json` | PPI MoM release rows | Phase 2 (merge) |
| `unemployment_data.json` | Unemployment Rate release rows | Phase 2 (merge) |
| `jobless_claims_data.json` | Initial Jobless Claims rows | Phase 2 (merge) |
| `nonfarm_payrolls_data.json` | NFP release rows | Phase 2 (merge) |
| `consumer_sentiment_data.json` | UoM Sentiment release rows | Phase 2 (merge) |
| `ism_data.json` | ISM Mfg history (actual + forecast per row) | Phase 1 (replace) |
| `ism_services_data.json` | ISM Services history | Phase 1 (replace) |
| `chicago_pmi_data.json` | Chicago PMI history | Phase 1 (replace) |
| `margin_debt_data.json` | FINRA margin balances, last 36 months | Phase 4 (manual override) |
| `fedwatch_data.json` | Implied FOMC probabilities for the next 5 meetings | Phase 5 (replace, snapshot) |
| `fedwatch_*_debug.html`, `finra_debug.html` | Last loaded HTML from failed/successful scrapes — debugging only | Scraper writes on each attempt |

---

## How the frontend reads everything

`src/api/fred.ts` is the single fetch layer:

- `fetchFredSeries(seriesId, start, end)` → `GET http://localhost:3001/api/fred/<seriesId>?start&end` (FRED proxy).
- `fetchCustom(indicator)` → `GET http://localhost:3001/api/custom/<slug>` which reads the corresponding `server/*.json` file as-is (no transformation server-side; whatever the scraper / merge / manual override wrote is what the frontend sees).

`src/App.tsx` calls all of these in `useEffect`, runs the YoY / MoM / MoM-diff transforms on the FRED series, and feeds each card the actual + matched forecast pair (`latestForecast()` picks the most recent row that has BOTH an actual and a forecast, so the headline value and the inline `→ forecast` always describe the same release).
