// Data layer for the Defiant Dashboard.
//
// The dashboard ships as a fully static site (GitHub Pages). All data — both
// FRED series and the scraped Investing.com / ForexFactory / FINRA / CME /
// Yahoo Finance pipelines — is baked into JSON files under public/data/ by
// scraping/daily_scrape.py at scrape time (runs 2× daily via GitHub Actions).
//
// Three consequences:
//   1. No FRED API key is ever shipped to the browser; the key only exists
//      as a GitHub Actions secret used during the scrape.
//   2. The page renders even if FRED is down at view time — we're reading
//      yesterday's (or 12h-old) snapshot, not making live calls.
//   3. All fetchers below have the same shape — they just GET a static URL.
//      `start` / `end` parameters are kept on FRED fetchers for call-site
//      compatibility with the old proxy signature but are ignored; the
//      scraper has already trimmed each series to the relevant window.
//
// import.meta.env.BASE_URL is set by Vite from the `base` config option.
// In dev it's '/', in production GitHub Pages it's '/<repo-name>/'. We
// concatenate to avoid hardcoding the repo path in every URL.

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

async function fetchJson(filename: string) {
  const url = `${DATA_BASE}/${filename}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static data load failed: ${url} → ${res.statusText}`);
  return res.json();
}

// --- FRED series (pre-fetched by scraping/daily_scrape.py phase 6) ---
// All return FRED's native observation shape: [{ date, value, ... }] where
// `value` is a string and '.' marks "no observation that day".
export const fetchCPI                = (_s?: string, _e?: string) => fetchJson('fred-cpi.json');
export const fetchCoreCPI            = (_s?: string, _e?: string) => fetchJson('fred-core-cpi.json');
export const fetchPPI                = (_s?: string, _e?: string) => fetchJson('fred-ppi.json');
export const fetchInterestRate       = (_s?: string, _e?: string) => fetchJson('fred-fedfunds.json');
export const fetchFedBalanceSheet    = (_s?: string, _e?: string) => fetchJson('fred-walcl.json');
export const fetchUnemploymentRate   = (_s?: string, _e?: string) => fetchJson('fred-unrate.json');
export const fetchJoblessClaims      = (_s?: string, _e?: string) => fetchJson('fred-icsa.json');
export const fetchNonfarmPayrolls    = (_s?: string, _e?: string) => fetchJson('fred-payems.json');
export const fetch10YYield           = (_s?: string, _e?: string) => fetchJson('fred-dgs10.json');
export const fetchCreditSpread       = (_s?: string, _e?: string) => fetchJson('fred-credit-spread.json');

// --- VIX (Yahoo Finance via yfinance — see daily_scrape.py phase 7) ---
// Same observation shape as FRED so the frontend's `value !== '.'` filter
// is a no-op rather than a special case.
export const fetchVIX = (_s?: string, _e?: string) => fetchJson('vix_data.json');

// --- Consumer Sentiment (Investing.com) ---
// FRED's UMCSENT lags the U-Mich preliminary print by ~1 month, and the
// dashboard wants the freshest reading, so we use the scraped Investing.com
// row instead. Shape: [{ date, value, Forecast }].
export const fetchConsumerSentiment = (_s?: string, _e?: string) =>
  fetchJson('consumer_sentiment_data.json');

// --- Scraped actuals (Investing.com — no FRED series in use for these) ---
export const fetchISMManufacturingPMI = () => fetchJson('ism_data.json');
export const fetchISMServicesPMI      = () => fetchJson('ism_services_data.json');
export const fetchChicagoPMI          = () => fetchJson('chicago_pmi_data.json');

// --- Scraped forecasts (ForexFactory) for indicators whose actual comes from FRED ---
export const fetchCPIForecast            = () => fetchJson('cpi_data.json');
export const fetchCoreCPIForecast        = () => fetchJson('core_cpi_data.json');
export const fetchPPIForecast            = () => fetchJson('ppi_data.json');
export const fetchUnemploymentForecast   = () => fetchJson('unemployment_data.json');
export const fetchJoblessClaimsForecast  = () => fetchJson('jobless_claims_data.json');
export const fetchNonfarmForecast        = () => fetchJson('nonfarm_payrolls_data.json');
// Deprecated alias — Consumer Sentiment actual + forecast come from one
// file now. Kept so older imports still resolve.
export const fetchConsumerSentimentForecast = () => fetchJson('consumer_sentiment_data.json');

// --- Financial Conditions extras ---
export const fetchMarginDebt = () => fetchJson('margin_debt_data.json');
export const fetchFedWatch   = () => fetchJson('fedwatch_data.json');
