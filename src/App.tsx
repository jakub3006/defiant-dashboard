import { useEffect, useState } from 'react';
import {
  fetchCPI,
  fetchCoreCPI,
  fetchPPI,
  fetchInterestRate,
  fetchUnemploymentRate,
  fetchJoblessClaims,
  fetchNonfarmPayrolls,
  fetchISMManufacturingPMI,
  fetchISMServicesPMI,
  fetchChicagoPMI,
  fetchConsumerSentiment,
  fetchCPIForecast,
  fetchCoreCPIForecast,
  fetchPPIForecast,
  fetchUnemploymentForecast,
  fetchJoblessClaimsForecast,
  fetchNonfarmForecast,
  fetchFedBalanceSheet,
  fetchVIX,
  fetch10YYield,
  fetchCreditSpread,
  fetchMarginDebt,
  fetchFedWatch,
} from './api/fred';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { IndicatorCard } from './components/IndicatorCard';
import type { IndicatorInfo } from './components/IndicatorCard';
import { LiquidityQuadrant } from './components/LiquidityQuadrant';
import { FedWatchChart } from './components/FedWatchChart';
import type { FedWatchMeeting } from './components/FedWatchChart';
import './globals.css';

// Classifies a numeric reading into 'high' | 'normal' | 'low' for a given
// indicator. Used to highlight which row of the info panel matches the
// current value. Returns undefined when the value can't be parsed.
type Level = 'high' | 'normal' | 'low';
const classify = (
  v: number,
  lowMax: number,
  highMin: number
): Level | undefined => {
  if (!Number.isFinite(v)) return undefined;
  if (v < lowMax) return 'low';
  if (v >= highMin) return 'high';
  return 'normal';
};

// Window-toggle options for the daily Financial Conditions series. Monthly
// series (CPI, NFP, ISM, etc.) don't have enough points to zoom usefully, so
// they don't get a toggle. Margin Debt is monthly too — also skipped.
const DAILY_WINDOWS = [
  { label: '1M',  months: 1 },
  { label: '3M',  months: 3 },
  { label: '6M',  months: 6 },
  { label: '12M', months: 12 },
];

// Per-indicator classifiers. Boundaries match INDICATOR_INFO ranges below.
const CLASSIFIERS: Record<string, (v: number) => Level | undefined> = {
  unemployment:  (v) => classify(v, 4, 5.5),
  joblessClaims: (v) => classify(v, 250, 350),    // value passed in thousands
  nonfarm:       (v) => classify(v, 50, 250),     // value passed in thousands
  cpi:           (v) => classify(v, 1.8, 2.2),    // "~2%" treated as 1.8–2.2
  coreCpi:       (v) => classify(v, 1.8, 2.2),
  ppi:           (v) => classify(v, 0, 0.2),
  ismMfg:        (v) => classify(v, 50, 55),
  ismSvc:        (v) => classify(v, 50, 55),
  chicagoPmi:    (v) => classify(v, 50, 55),
  consumer:      (v) => classify(v, 100, 120),
  // --- Financial Conditions ---
  // VIX: <15 complacent, 15-25 normal, >25 stressed
  vix:           (v) => classify(v, 15, 25),
  // 10Y yield: <3% accommodative, 3-4.5% normal, >4.5% tight
  tenYear:       (v) => classify(v, 3, 4.5),
  // HY credit spread (%): <3.5 risk-on, 3.5-5.5 normal, >5.5 stress
  creditSpread:  (v) => classify(v, 3.5, 5.5),
  // FINRA margin debt: <$700B contraction, 700-900 normal, >$900B exuberance
  marginDebt:    (v) => classify(v, 700, 900),
};

// Reference thresholds + Fed action mapping for each indicator. Sourced from
// the macro framework chart the user provided. Surfaced via the hamburger
// menu on each card so a viewer can mouse over and see what the current
// number means and how the Fed typically reacts at that level.
const INDICATOR_INFO: Record<string, IndicatorInfo> = {
  unemployment: {
    high:   { range: '>5.5%',   impact: 'weak economy',     fed: 'Expansionary' },
    normal: { range: '4–5.5%',  impact: 'OK economy',       fed: 'Neutral' },
    low:    { range: '<4%',     impact: 'strong economy',   fed: 'Contractionary' },
  },
  joblessClaims: {
    high:   { range: '>350k',     impact: 'weak economy',   fed: 'Expansionary' },
    normal: { range: '250–350k',  impact: 'OK economy',     fed: 'Neutral' },
    low:    { range: '<250k',     impact: 'strong economy', fed: 'Contractionary' },
  },
  nonfarm: {
    high:   { range: '>250k',     impact: 'strong economy', fed: 'Contractionary' },
    normal: { range: '50–250k',   impact: 'OK economy',     fed: 'Neutral' },
    low:    { range: '<50k',      impact: 'weak economy',   fed: 'Expansionary' },
  },
  cpi: {
    high:   { range: '>2%',  impact: 'high inflation', fed: 'Contractionary' },
    normal: { range: '~2%',  impact: 'OK inflation',   fed: 'Neutral' },
    low:    { range: '<2%',  impact: 'low inflation',  fed: 'Expansionary' },
  },
  coreCpi: {
    high:   { range: '>2%',  impact: 'high inflation', fed: 'Contractionary' },
    normal: { range: '~2%',  impact: 'OK inflation',   fed: 'Neutral' },
    low:    { range: '<2%',  impact: 'low inflation',  fed: 'Expansionary' },
  },
  ppi: {
    high:   { range: '>0.2%',     impact: 'high inflation', fed: 'Contractionary' },
    normal: { range: '0–0.2%',    impact: 'OK inflation',   fed: 'Neutral' },
    low:    { range: '<0%',       impact: 'low inflation',  fed: 'Expansionary' },
  },
  ismMfg: {
    high:   { range: '>55',   impact: 'strong expansion', fed: 'Contractionary' },
    normal: { range: '50–55', impact: 'OK expansion',     fed: 'Neutral' },
    low:    { range: '<50',   impact: 'contraction',      fed: 'Expansionary' },
  },
  ismSvc: {
    high:   { range: '>55',   impact: 'strong expansion', fed: 'Contractionary' },
    normal: { range: '50–55', impact: 'OK expansion',     fed: 'Neutral' },
    low:    { range: '<50',   impact: 'contraction',      fed: 'Expansionary' },
  },
  chicagoPmi: {
    high:   { range: '>55',   impact: 'strong expansion', fed: 'Contractionary' },
    normal: { range: '50–55', impact: 'OK expansion',     fed: 'Neutral' },
    low:    { range: '<50',   impact: 'contraction',      fed: 'Expansionary' },
  },
  consumer: {
    high:   { range: '>120',    impact: 'strong sentiment',  fed: 'Contractionary' },
    normal: { range: '100–120', impact: 'OK sentiment',      fed: 'Neutral' },
    low:    { range: '<100',    impact: 'negative sentiment',fed: 'Expansionary' },
  },
  // --- Financial Conditions ---
  // VIX measures expected S&P 500 volatility over the next 30 days. Low VIX
  // = complacency / risk-on; high VIX = fear / risk-off.
  vix: {
    high:   { range: '>25',     impact: 'market stress',  fed: 'Expansionary' },
    normal: { range: '15–25',   impact: 'normal regime',  fed: 'Neutral' },
    low:    { range: '<15',     impact: 'complacent',     fed: 'Contractionary' },
  },
  // 10Y Treasury yield drives mortgage rates, corporate borrowing, and the
  // discount rate on equities. Higher yields tighten conditions broadly.
  tenYear: {
    high:   { range: '>4.5%',   impact: 'tight conditions',     fed: 'Contractionary' },
    normal: { range: '3–4.5%',  impact: 'normal conditions',    fed: 'Neutral' },
    low:    { range: '<3%',     impact: 'accommodative',        fed: 'Expansionary' },
  },
  // ICE BofA High Yield OAS — the extra yield investors demand to lend to
  // junk-rated borrowers vs Treasuries. Widening = credit stress.
  creditSpread: {
    high:   { range: '>5.5%',   impact: 'credit stress',    fed: 'Expansionary' },
    normal: { range: '3.5–5.5%',impact: 'normal risk',      fed: 'Neutral' },
    low:    { range: '<3.5%',   impact: 'risk-on / euphoria',fed: 'Contractionary' },
  },
  // FINRA margin debt — total customer-margin balance in USD billions. Peaks
  // typically precede market tops; sharp contractions accompany sell-offs.
  marginDebt: {
    high:   { range: '>$900B',  impact: 'high leverage',  fed: 'Contractionary' },
    normal: { range: '$700–900B',impact: 'normal',         fed: 'Neutral' },
    low:    { range: '<$700B',  impact: 'deleveraging',   fed: 'Expansionary' },
  },
};

// 12 Months
function getDateRange() {
  const end = new Date();
  const start = new Date();
  start.setMonth(end.getMonth() - 11);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// 24 Months (Needed for YoY math)
function get24MonthsDateRange() {
  const end = new Date();
  const start = new Date();
  start.setMonth(end.getMonth() - 23);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// 8 Weeks
function getEightWeeksDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 56);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// Helper: Year-over-Year (YoY)
function calculateYoY(data: any[]) {
  const yoyData: any[] = [];
  const valueMap = new Map();
  
  data.forEach(d => {
    if (d.value !== '.') {
      const yearMonth = d.date.substring(0, 7);
      valueMap.set(yearMonth, parseFloat(d.value));
    }
  });

  data.forEach(currentItem => {
    if (currentItem.value === '.') return;
    const yearMonth = currentItem.date.substring(0, 7); 
    const [year, month] = yearMonth.split('-');
    
    const pastYear = String(parseInt(year) - 1);
    const pastYearMonth = `${pastYear}-${month}`; 
    
    if (valueMap.has(pastYearMonth)) {
      const currentVal = parseFloat(currentItem.value);
      const pastVal = valueMap.get(pastYearMonth);
      const yoy = (((currentVal - pastVal) / pastVal) * 100).toFixed(1);
      
      yoyData.push({ date: currentItem.date, value: yoy });
    }
  });
  return yoyData;
}

// MoM ABSOLUTE difference (current value minus previous month). Used for
// series like Nonfarm Payrolls where the headline number is the monthly
// change in jobs, not the cumulative employment level FRED publishes.
function calculateMoMDiff(data: any[], months: number = 12) {
  const diffData: any[] = [];
  const valueMap = new Map<string, number>();

  data.forEach((d) => {
    if (d.value !== '.') {
      const yearMonth = d.date.substring(0, 7);
      valueMap.set(yearMonth, parseFloat(d.value));
    }
  });

  data.forEach((currentItem) => {
    if (currentItem.value === '.') return;
    const yearMonth = currentItem.date.substring(0, 7);
    const [year, month] = yearMonth.split('-');
    let pastYear = parseInt(year);
    let pastMonth = parseInt(month) - 1;
    if (pastMonth === 0) {
      pastMonth = 12;
      pastYear -= 1;
    }
    const pastYearMonth = `${pastYear}-${String(pastMonth).padStart(2, '0')}`;
    if (valueMap.has(pastYearMonth)) {
      const currentVal = parseFloat(currentItem.value);
      const pastVal = valueMap.get(pastYearMonth)!;
      diffData.push({
        date: currentItem.date,
        value: (currentVal - pastVal).toFixed(0),
      });
    }
  });

  return diffData.slice(-months);
}

function calculateMoM(data: any[], months: number = 12) {
  const momData: any[] = [];
  const valueMap = new Map();
  
  data.forEach(d => {
    if (d.value !== '.') {
      const yearMonth = d.date.substring(0, 7);
      valueMap.set(yearMonth, parseFloat(d.value));
    }
  });

  data.forEach(currentItem => {
    if (currentItem.value === '.') return;
    const yearMonth = currentItem.date.substring(0, 7);
    let [year, month] = yearMonth.split('-');
    
    let pastYear = parseInt(year);
    let pastMonth = parseInt(month) - 1;
    if (pastMonth === 0) {
      pastMonth = 12;
      pastYear -= 1;
    }
    
    const pastYearMonth = `${pastYear}-${String(pastMonth).padStart(2, '0')}`;
    
    if (valueMap.has(pastYearMonth)) {
      const currentVal = parseFloat(currentItem.value);
      const pastVal = valueMap.get(pastYearMonth);
      const mom = (((currentVal - pastVal) / pastVal) * 100).toFixed(1);
      
      momData.push({ date: currentItem.date, value: mom });
    }
  });
  
  return momData.slice(-months);
}

// ISO-date "YYYY-MM-DD" as a comparable string for `today` and `now+grace`.
// We compare strings instead of Date objects to keep the logic timezone-
// independent: a row dated "2026-06-10" is "past" once the user's local
// clock reads any time on or after 2026-06-10, no DST or UTC drift.
function _todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Return the forecast for the NEXT upcoming release — the most recent row
// whose `date` is in the FUTURE and carries a Forecast. Returns both the
// value and the row's `date` so the IndicatorCard can render the release
// month (YYYY/MM Est) alongside the number. Empty strings when no such
// row exists (e.g. ForexFactory's rolling window doesn't yet contain the
// next release).
//
// Why we DON'T just look at "Forecast without Actual": when FF is slow
// to backfill the Actual after a release lands (sometimes hours, sometimes
// days), we'd keep showing that row as "upcoming" — pointing the user at
// a release date that's already in the past. The date-in-future gate is
// the only honest signal.
function upcomingForecast(arr: any[] | null): { value: string; date: string } {
  if (!arr || !Array.isArray(arr) || arr.length === 0) return { value: '', date: '' };

  const isFilled = (v: any) =>
    v != null && String(v).trim() !== '' && String(v).trim() !== '.';
  const hasForecast = (d: any) => isFilled(d?.Forecast);

  const today = _todayIso();
  const sorted = [...arr].sort((a, b) =>
    String(b?.date ?? '').localeCompare(String(a?.date ?? ''))
  );
  // Strictly future (>= today is fine on release day itself — the value
  // typically lands hours after the date string starts ticking).
  const upcoming = sorted.find(
    (d) => hasForecast(d) && String(d?.date ?? '') >= today
  );
  return upcoming
    ? { value: String(upcoming.Forecast), date: String(upcoming.date ?? '') }
    : { value: '', date: '' };
}

// Return the Forecast value matched to the most recent RELEASED data point
// — i.e. the consensus that was published for the release whose actual is
// currently on the headline.
//
// Old behaviour required the same row to carry BOTH value+Forecast (matched
// pair). That breaks when the upstream feed publishes the Forecast row
// before the release but is slow to backfill the Actual: we'd skip that
// row and fall back to the previous month's matched pair, showing stale
// data on the card (e.g. "3.9% → 3.7%" pairing this month's actual with
// last month's consensus).
//
// New behaviour: take the most recent forecast whose RELEASE DATE is in
// the past. The FRED-sourced actual on the headline is for that same
// period by definition, regardless of whether FF/scrape eventually
// filled in the Actual column in our scraped JSON.
function latestForecast(arr: any[] | null): string {
  if (!arr || !Array.isArray(arr) || arr.length === 0) return '—';

  const isFilled = (v: any) =>
    v != null && String(v).trim() !== '' && String(v).trim() !== '.';
  const hasForecast = (d: any) => isFilled(d?.Forecast);

  const today = _todayIso();
  const sorted = [...arr].sort((a, b) =>
    String(b?.date ?? '').localeCompare(String(a?.date ?? ''))
  );

  // Most recent forecast for a release that has already happened.
  const matched = sorted.find(
    (d) => hasForecast(d) && String(d?.date ?? '') <= today
  );
  if (matched) return String(matched.Forecast);

  // Defensive fallback: no past forecast at all (the file only has future
  // forecast rows, very rare). Show the oldest forecast we have so the
  // card isn't blank.
  const anyForecast = sorted.find(hasForecast);
  return anyForecast ? String(anyForecast.Forecast) : '—';
}

function App() {
  const [cpi, setCpi] = useState<any[] | null>(null);
  const [cpiForecast, setCpiForecast] = useState<any[] | null>(null);
  const [coreCpiForecast, setCoreCpiForecast] = useState<any[] | null>(null);
  const [ppiForecast, setPpiForecast] = useState<any[] | null>(null);
  const [unemploymentForecast, setUnemploymentForecast] = useState<any[] | null>(null);
  const [joblessClaimsForecast, setJoblessClaimsForecast] = useState<any[] | null>(null);
  const [nonfarmForecast, setNonfarmForecast] = useState<any[] | null>(null);
  const [coreCpi, setCoreCpi] = useState<any[] | null>(null);
  const [ppi, setPpi] = useState<any[] | null>(null);
  const [rate, setRate] = useState<any[] | null>(null);
  const [unemploymentRate, setUnemploymentRate] = useState<any[] | null>(null);
  const [joblessClaims, setJoblessClaims] = useState<any[] | null>(null);
  const [nonfarmPayrolls, setNonfarmPayrolls] = useState<any[] | null>(null);
  const [consumerSentiment, setConsumerSentiment] = useState<any[] | null>(null); 
  const [fedBalanceSheet, setFedBalanceSheet] = useState<any[] | null>(null);
  
  // Scraper States
  const [ismPmi, setIsmPmi] = useState<any[] | null>(null);
  const [ismServices, setIsmServices] = useState<any[] | null>(null);
  const [chicagoPmi, setChicagoPmi] = useState<any[] | null>(null);

  // --- Financial Conditions ---
  const [vix, setVix] = useState<any[] | null>(null);
  const [tenYearYield, setTenYearYield] = useState<any[] | null>(null);
  const [creditSpread, setCreditSpread] = useState<any[] | null>(null);
  const [marginDebt, setMarginDebt] = useState<any[] | null>(null);
  const [fedWatch, setFedWatch] = useState<FedWatchMeeting[] | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const { start: start12m, end: end12m } = getDateRange();
    const { start: start24m, end: end24m } = get24MonthsDateRange();
    const { start: claimsStart, end: claimsEnd } = getEightWeeksDateRange();

    setLoading(true);
    setError(null);
    
    Promise.all([
      fetchCPI(start24m, end24m), 
      fetchCoreCPI(start24m, end24m), 
      // PPI MoM needs ~13 raw months to produce 12 month-over-month values;
      // we ask for 24 to be safe (FRED can lag a release by a few weeks).
      fetchPPI(start24m, end24m),
      fetchInterestRate(start12m, end12m),
      fetchUnemploymentRate(start12m, end12m),
      fetchJoblessClaims(claimsStart, claimsEnd),
      fetchNonfarmPayrolls(start12m, end12m),
      fetchConsumerSentiment(start12m, end12m),
      fetchISMManufacturingPMI(),
      fetchISMServicesPMI(),
      fetchChicagoPMI(),
      fetchCPIForecast().catch(() => null),
      fetchCoreCPIForecast().catch(() => null),
      fetchPPIForecast().catch(() => null),
      fetchFedBalanceSheet(start12m, end12m).catch(() => null),
      fetchUnemploymentForecast().catch(() => null),
      fetchJoblessClaimsForecast().catch(() => null),
      fetchNonfarmForecast().catch(() => null),
      // --- Financial Conditions ---
      fetchVIX(start12m, end12m).catch(() => null),
      fetch10YYield(start12m, end12m).catch(() => null),
      fetchCreditSpread(start12m, end12m).catch(() => null),
      fetchMarginDebt().catch(() => null),
      fetchFedWatch().catch(() => null),
    ])
      .then(([
        cpiData,
        coreCpiData,
        ppiData,
        rateData,
        unemploymentData,
        joblessClaimsData,
        nonfarmData,
        sentimentData,
        ismPmiData,
        ismServicesData,
        chicagoPmiData,
        cpiForecastData,
        coreCpiForecastData,
        ppiForecastData,
        balanceSheetData,
        unemploymentForecastData,
        joblessClaimsForecastData,
        nonfarmForecastData,
        vixData,
        tenYearData,
        creditSpreadData,
        marginDebtData,
        fedWatchData,
      ]) => {
        console.log("🔥 --- ACTUAL (FRED) DATA --- 🔥");
        console.log("CPI (FRED):", cpiData?.length, cpiData);
        console.log("Core CPI (FRED):", coreCpiData?.length, coreCpiData);
        console.log("PPI (FRED):", ppiData?.length, ppiData);
        console.log("Fed Funds (FRED):", rateData?.length, rateData);
        console.log("Unemployment (FRED):", unemploymentData?.length, unemploymentData);
        console.log("Jobless Claims (FRED):", joblessClaimsData?.length, joblessClaimsData);
        console.log("Nonfarm (FRED):", nonfarmData?.length, nonfarmData);
        console.log("Sentiment (FRED):", sentimentData?.length, sentimentData);
        console.log("Fed Balance Sheet (FRED):", balanceSheetData?.length, balanceSheetData);
        console.log("🟢 --- SCRAPED FORECASTS --- 🟢");
        console.log("CPI forecast:", cpiForecastData);
        console.log("Core CPI forecast:", coreCpiForecastData);
        console.log("PPI forecast:", ppiForecastData);
        console.log("-----------------------------------");
        setCpi(cpiData);
        setCoreCpi(coreCpiData);
        setPpi(ppiData);
        setRate(rateData);
        setUnemploymentRate(unemploymentData);
        setJoblessClaims(joblessClaimsData);
        setNonfarmPayrolls(nonfarmData);
        setConsumerSentiment(sentimentData); 
        setIsmPmi(ismPmiData);
        setIsmServices(ismServicesData);
        setChicagoPmi(chicagoPmiData);
        setCpiForecast(cpiForecastData);
        setCoreCpiForecast(coreCpiForecastData);
        setPpiForecast(ppiForecastData);
        setFedBalanceSheet(balanceSheetData);
        setUnemploymentForecast(unemploymentForecastData);
        setJoblessClaimsForecast(joblessClaimsForecastData);
        setNonfarmForecast(nonfarmForecastData);
        setVix(vixData);
        setTenYearYield(tenYearData);
        setCreditSpread(creditSpreadData);
        setMarginDebt(marginDebtData);
        setFedWatch(fedWatchData);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // 1. FILTER MISSING DATA
  const validCpiRaw = cpi?.filter((d) => d.value !== '.') || [];
  const validCoreCpiRaw = coreCpi?.filter((d) => d.value !== '.') || [];
  const validPpiRaw = ppi?.filter((d) => d.value !== '.') || [];
  const validRate = rate?.filter((d) => d.value !== '.') || [];
  const validUnemp = unemploymentRate?.filter((d) => d.value !== '.') || [];
  const validClaims = joblessClaims?.filter((d) => d.value !== '.') || [];
  const validNonfarm = nonfarmPayrolls?.filter((d) => d.value !== '.') || [];
  // Scraped from Investing.com (FRED's UMCSENT lags by a month). UoM
  // publishes TWO prints per month — a preliminary mid-month and a final
  // end-of-month — so the scraped data has roughly 2 rows per month. For
  // the time series we keep only the FINAL print per month (the later
  // date) so the sparkline reads one point per month, matching the other
  // monthly cards. This is what makes the UoM card cover the same ~10-12
  // months of history as Chicago PMI even though each month has 2 prints.
  const validSentimentRaw = (() => {
    if (!consumerSentiment) return [];
    const filtered = consumerSentiment.filter(
      (d) => d.value && String(d.value).trim() !== '' && d.value !== '.',
    );
    const byMonth = new Map<string, any>();
    for (const row of filtered) {
      if (!row?.date) continue;
      const monthKey = String(row.date).slice(0, 7); // "YYYY-MM"
      const existing = byMonth.get(monthKey);
      if (!existing || String(row.date) > String(existing.date)) {
        byMonth.set(monthKey, row);
      }
    }
    return Array.from(byMonth.values()).sort((a, b) =>
      String(a.date).localeCompare(String(b.date)),
    );
  })();
  const validBalanceSheet = fedBalanceSheet?.filter((d) => d.value !== '.') || [];
  
  const validIsmPmi = ismPmi 
    ? [...ismPmi].reverse().filter((d) => d.value && d.value.trim() !== '' && d.value !== '.') 
    : [];
    
  const validIsmServices = ismServices 
    ? [...ismServices].reverse().filter((d) => d.value && d.value.trim() !== '' && d.value !== '.') 
    : [];
    
  const validChicagoPmi = chicagoPmi
    ? [...chicagoPmi].reverse().filter((d) => d.value && d.value.trim() !== '' && d.value !== '.')
    : [];

  // --- Financial Conditions (FRED series) ---
  const validVix = vix?.filter((d) => d.value !== '.') || [];
  const validTenYear = tenYearYield?.filter((d) => d.value !== '.') || [];
  const validCreditSpread = creditSpread?.filter((d) => d.value !== '.') || [];
  // Margin debt rows arrive newest-first (sorted by daily_scrape.py).
  // Reverse so the sparkline reads left→right as time progresses. We only
  // plot the Debit Balance column (`value` field, in $B).
  const validMarginDebt = marginDebt
    ? [...marginDebt].reverse().filter((d) => d.value != null)
    : [];

  // 2. CALCULATE INFLATION (YoY / MoM)
  const cpiYoy = calculateYoY(validCpiRaw);
  const coreCpiYoy = calculateYoY(validCoreCpiRaw);
  // 24 months: PPI MoM is too noisy on a 12-point window to read a trend.
  // 2-year view shows ~2 inflation cycles and gives the eye enough datapoints
  // to spot the trajectory.
  const ppiMom = calculateMoM(validPpiRaw, 24);
  // PAYEMS publishes the total employment level in thousands; the headline
  // economic indicator is the monthly *change*, so we diff consecutive
  // months. Result is already in "k jobs added" — directly usable.
  // 24 months: NFP MoM at 12M shows just the last year — we lose the
  // pre-cooling baseline (2023/24 averages) that gives "300k vs 50k" its
  // context. fred-payems already carries 60 months of raw, so this is
  // purely a slice-cap change.
  const nonfarmMom = calculateMoMDiff(validNonfarm, 24);

  // 3. GET LATEST VALUES
  const latestCpi = cpiYoy[cpiYoy.length - 1]?.value || '—';
  const latestCoreCpi = coreCpiYoy[coreCpiYoy.length - 1]?.value || '—';
  const latestPpi = ppiMom[ppiMom.length - 1]?.value || '—';
  const latestRate = validRate[validRate.length - 1]?.value || '—';
  const latestUnemploymentRate = validUnemp[validUnemp.length - 1]?.value || '—';

  const rawLatestJobless = validClaims[validClaims.length - 1]?.value;
  const latestJoblessClaims = rawLatestJobless 
    ? (parseFloat(rawLatestJobless) / 1000).toFixed(0) 
    : '—';

  // Headline = monthly change in thousands, matching how every BLS release
  // and analyst forecast is reported (e.g. "+85K jobs added").
  const latestNonfarm = nonfarmMom[nonfarmMom.length - 1]?.value
    ? parseFloat(nonfarmMom[nonfarmMom.length - 1].value).toFixed(0)
    : '—';

  const latestSentiment = validSentimentRaw[validSentimentRaw.length - 1]?.value
    ? parseFloat(validSentimentRaw[validSentimentRaw.length - 1].value).toFixed(1)
    : '—';

  const latestIsmPmi = validIsmPmi[validIsmPmi.length - 1]?.value
    ? parseFloat(validIsmPmi[validIsmPmi.length - 1].value).toFixed(1)
    : '—';
    
  const latestIsmServices = validIsmServices[validIsmServices.length - 1]?.value
    ? parseFloat(validIsmServices[validIsmServices.length - 1].value).toFixed(1)
    : '—';
    
  const latestChicagoPmi = validChicagoPmi[validChicagoPmi.length - 1]?.value
    ? parseFloat(validChicagoPmi[validChicagoPmi.length - 1].value).toFixed(1)
    : '—';

  // WALCL is in millions — convert to trillions
  const latestBalanceSheet = validBalanceSheet[validBalanceSheet.length - 1]?.value
    ? (parseFloat(validBalanceSheet[validBalanceSheet.length - 1].value) / 1_000_000).toFixed(2)
    : '—';

  // --- Financial Conditions latest values ---
  const latestVix = validVix[validVix.length - 1]?.value
    ? parseFloat(validVix[validVix.length - 1].value).toFixed(1)
    : '—';
  const latestTenYear = validTenYear[validTenYear.length - 1]?.value
    ? parseFloat(validTenYear[validTenYear.length - 1].value).toFixed(2)
    : '—';
  const latestCreditSpread = validCreditSpread[validCreditSpread.length - 1]?.value
    ? parseFloat(validCreditSpread[validCreditSpread.length - 1].value).toFixed(2)
    : '—';
  // FINRA Margin Debt — only the Debit Balance column makes it onto the
  // dashboard (the Free Credit columns are still scraped, just not shown).
  const latestMarginDebt = validMarginDebt[validMarginDebt.length - 1]?.value != null
    ? parseFloat(String(validMarginDebt[validMarginDebt.length - 1].value)).toFixed(0)
    : '—';

  // (Fed Balance Sheet trend QT/QE badge removed when the status badge in
  // IndicatorCard was replaced by the data date range.)

  // --- Inputs for the Liquidity Quadrant ---
  // Regime signal: % change in WALCL across the full 12-month window. This is
  // what determines whether we are macroeconomically in QE or QT — a window
  // short enough to be responsive but long enough to filter weekly WALCL noise
  // (repo/discount window/Treasury settlement) from the actual policy stance.
  const balanceSheetChangePct12m = validBalanceSheet.length >= 2
    ? ((parseFloat(validBalanceSheet[validBalanceSheet.length - 1].value) -
        parseFloat(validBalanceSheet[0].value)) /
        parseFloat(validBalanceSheet[0].value)) * 100
    : 0;

  // Latest (nominal) Federal Funds Rate as a number (falls back to 0 if unavailable)
  const currentFedFundsRate = validRate.length
    ? parseFloat(validRate[validRate.length - 1].value)
    : 0;

  // Latest headline inflation (CPI YoY %) — used to derive the real rate
  const currentInflationRate = cpiYoy.length
    ? parseFloat(cpiYoy[cpiYoy.length - 1].value)
    : 0;

  // 4. GENERATE SPARKLINE PATHS
  // Every sparkline auto-scales to its own data's min/max so the curve uses
  // the full chart height regardless of the value range. Previously each
  // series had a hand-tuned fixed denominator (e.g. divide by 10 for CPI,
  // by 400000 for jobless claims) which left lines like UoM Sentiment or
  // ISM (small relative moves on a large baseline) flattened against the
  // edge. Centralised here so every card scales consistently.
  //
  // viewBox is 0 0 100 30. We map values into y=[4, 26] — 4-unit padding
  // top and bottom keeps the curve from kissing the SVG edges and leaves
  // room for the 2px stroke without clipping.
  const buildSparkline = (arr: any[]): string => {
    if (!arr || arr.length < 2) return 'M0 15 L100 15';
    const values = arr.map((d) => parseFloat(String(d.value).replace(/[^\d.-]/g, '')));
    const clean = values.filter((v) => Number.isFinite(v));
    if (clean.length < 2) return 'M0 15 L100 15';
    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const range = max - min || 1;
    const Y_TOP = 4;
    const Y_BOTTOM = 26;
    const yOf = (v: number) => Y_BOTTOM - ((v - min) / range) * (Y_BOTTOM - Y_TOP);
    return values
      .map((v, i) => {
        const x = ((i / (values.length - 1)) * 100).toFixed(2);
        const y = (Number.isFinite(v) ? yOf(v) : (Y_TOP + Y_BOTTOM) / 2).toFixed(2);
        return `${i === 0 ? 'M' : 'L'}${x} ${y}`;
      })
      .join(' ');
  };

  const cpiSparkline = buildSparkline(cpiYoy);
  const coreCpiSparkline = buildSparkline(coreCpiYoy);
  const ppiSparkline = buildSparkline(ppiMom);
  const rateSparkline = buildSparkline(validRate);
  const unemploymentRateSparkline = buildSparkline(validUnemp);
  const joblessClaimsSparkline = buildSparkline(validClaims);
  const nonfarmSparkline = buildSparkline(nonfarmMom);
  const sentimentSparkline = buildSparkline(validSentimentRaw);
  const ismPmiSparkline = buildSparkline(validIsmPmi);
  const ismServicesSparkline = buildSparkline(validIsmServices);
  const chicagoPmiSparkline = buildSparkline(validChicagoPmi);
  const balanceSheetSparkline = buildSparkline(validBalanceSheet);
  const vixSparkline = buildSparkline(validVix);
  const tenYearSparkline = buildSparkline(validTenYear);
  const creditSpreadSparkline = buildSparkline(validCreditSpread);
  const marginDebtSparkline = buildSparkline(validMarginDebt);

  // 5. PER-POINT DATA FOR HOVER TOOLTIPS
  // The card components need both the rendered path AND the underlying
  // points so a mouse hover can show the exact (date, value) for each spot
  // on the curve. We pre-parse value -> number and apply the same unit
  // transform the headline number uses (k for thousands, M for millions,
  // T for trillions, etc.) so the tooltip reads consistently.
  // Keep the array shape identical to what buildSparkline consumes — both
  // index by position so the hover dot lines up with the rendered curve.
  // We mark non-numeric entries with NaN rather than filtering them.
  const toPoints = (
    arr: any[] | null | undefined,
    transform: (raw: number) => number = (v) => v
  ) => {
    if (!arr) return [];
    return arr.map((d) => {
      const n = parseFloat(String(d.value).replace(/[^\d.-]/g, ''));
      return { date: d.date as string, value: Number.isFinite(n) ? transform(n) : NaN };
    });
  };

  const cpiPoints = toPoints(cpiYoy);
  const coreCpiPoints = toPoints(coreCpiYoy);
  const ppiPoints = toPoints(ppiMom);
  const ratePoints = toPoints(validRate);
  const unemploymentPoints = toPoints(validUnemp);
  const joblessClaimsPoints = toPoints(validClaims, (v) => v / 1000); // raw is people, card shows "k"
  const nonfarmPoints = toPoints(nonfarmMom); // already in k jobs added/lost
  const sentimentPoints = toPoints(validSentimentRaw);
  const ismPmiPoints = toPoints(validIsmPmi);
  const ismServicesPoints = toPoints(validIsmServices);
  const chicagoPmiPoints = toPoints(validChicagoPmi);
  const balanceSheetPoints = toPoints(validBalanceSheet, (v) => v / 1_000_000); // raw is millions, card shows "T"
  const vixPoints = toPoints(validVix);
  const tenYearPoints = toPoints(validTenYear);
  const creditSpreadPoints = toPoints(validCreditSpread);
  const marginDebtPoints = toPoints(validMarginDebt);

  // 6. CLASSIFY THE CURRENT VALUE PER INDICATOR (for the info panel highlight)
  // Most card headlines are pre-formatted strings (e.g. "3.8", "215"),
  // so we parse the same number we display. Jobless and Nonfarm are passed
  // in thousands (raw / 1000) because the classifier thresholds are in
  // "k" units, matching the visual card unit.
  const num = (s: string) => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  };
  const cpiLevel        = CLASSIFIERS.cpi(num(latestCpi));
  const coreCpiLevel    = CLASSIFIERS.coreCpi(num(latestCoreCpi));
  const ppiLevel        = CLASSIFIERS.ppi(num(latestPpi));
  const unempLevel      = CLASSIFIERS.unemployment(num(latestUnemploymentRate));
  const joblessLevel    = CLASSIFIERS.joblessClaims(num(latestJoblessClaims));
  const nonfarmLevel    = CLASSIFIERS.nonfarm(num(latestNonfarm)); // already in k MoM
  const sentimentLevel  = CLASSIFIERS.consumer(num(latestSentiment));
  const ismMfgLevel     = CLASSIFIERS.ismMfg(num(latestIsmPmi));
  const ismSvcLevel     = CLASSIFIERS.ismSvc(num(latestIsmServices));
  const chicagoPmiLevel = CLASSIFIERS.chicagoPmi(num(latestChicagoPmi));
  const vixLevel          = CLASSIFIERS.vix(num(latestVix));
  const tenYearLevel      = CLASSIFIERS.tenYear(num(latestTenYear));
  const creditSpreadLevel = CLASSIFIERS.creditSpread(num(latestCreditSpread));
  // Classifier thresholds are in $B; latestMarginDebt is debit billions.
  const marginDebtLevel   = CLASSIFIERS.marginDebt(num(latestMarginDebt));

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <Header />
      {/* Width strategy: capped at 1600px on laptop-class screens, but on
          larger monitors (2K/4K) the cap lifts and the layout goes fluid
          with a small viewport-relative gutter — no dead space left/right. */}
      <main className="pt-8 pb-4 px-4 sm:px-6 lg:px-8 max-w-[1600px] 2xl:max-w-none 2xl:px-[3vw] mx-auto">
        {loading && (
          <div className="flex justify-center items-center py-20">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
          </div>
        )}

        {error && (
          <div className="bg-error-container/20 border border-error/30 rounded-xl p-4 mb-6 text-error">
            <p className="font-semibold">Error loading data</p>
            <p className="text-sm">{error}</p>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* === TOP ROW: LIQUIDITY REGIME ===
                The Liquidity Quadrant (regime visual), the Fed Funds Rate, and
                the Fed Balance Sheet sit together because they all describe
                the same thing from different angles: the current monetary
                policy stance. Everything below is downstream of these.

                Layout: quadrant takes 2/3 width on desktop, the two cards
                stack vertically in the right 1/3. This is what stops the
                sparklines from getting visually scaled up — at equal widths
                + items-stretch the cards inherited the quadrant's full
                height, blowing up the SVG. */}
            <section className="mb-10">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-1 h-5 bg-primary rounded-full"></span>
                <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-on-surface">
                  Liquidity Regime
                </h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 items-center">
                <LiquidityQuadrant
                  nominalRate={currentFedFundsRate}
                  inflationRate={currentInflationRate}
                  balanceSheetChangePct12m={balanceSheetChangePct12m}
                />
                <IndicatorCard
                  title="Federal Funds Rate"
                  value={latestRate}
                  unit="%"
                  icon="trending_up"
                  color="secondary"
                  sparkline={rateSparkline}
                  sparklineData={ratePoints}
                  formatValue={(p) => `${p.value.toFixed(2)}%`}
                />
                <IndicatorCard
                  title="Fed Balance Sheet"
                  value={latestBalanceSheet}
                  unit="T"
                  icon="account_balance"
                  color="secondary"
                  sparkline={balanceSheetSparkline}
                  sparklineData={balanceSheetPoints}
                  formatValue={(p) => `$${p.value.toFixed(2)}T`}
                />
              </div>

              {/* FedWatch lives inside the Liquidity Regime section because
                  market-implied FOMC probabilities are part of the same
                  policy-stance story: today's stance + what the market
                  expects next. Full width below the quadrant + cards so the
                  horizontal bars have room to breathe. */}
              <div className="mt-6">
                <FedWatchChart meetings={fedWatch} />
              </div>
            </section>

            {/* === FINANCIAL CONDITIONS ===
                Market-pricing signals that describe how investors are
                pricing risk and rates right now. Sits directly under
                Liquidity Regime because the two read together: when
                liquidity tightens, spreads widen, VIX rises, margin debt
                contracts. */}
            <section className="mb-10">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-1 h-5 bg-primary rounded-full"></span>
                <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-on-surface">
                  Financial Conditions
                </h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <IndicatorCard
                  title="VIX"
                  value={latestVix}
                  unit=""
                  icon="bolt"
                  color={num(latestVix) >= 25 ? 'error' : num(latestVix) >= 15 ? 'secondary' : 'primary'}
                  sparkline={vixSparkline}
                  sparklineData={vixPoints}
                  formatValue={(p) => p.value.toFixed(1)}
                  info={INDICATOR_INFO.vix}
                  currentLevel={vixLevel}
                  windowOptions={DAILY_WINDOWS}
                />
                <IndicatorCard
                  title="10Y Treasury Yield"
                  value={latestTenYear}
                  unit="%"
                  icon="show_chart"
                  color={num(latestTenYear) >= 4.5 ? 'error' : 'secondary'}
                  sparkline={tenYearSparkline}
                  sparklineData={tenYearPoints}
                  formatValue={(p) => `${p.value.toFixed(2)}%`}
                  info={INDICATOR_INFO.tenYear}
                  currentLevel={tenYearLevel}
                  windowOptions={DAILY_WINDOWS}
                />
                <IndicatorCard
                  title="HY Credit Spread"
                  value={latestCreditSpread}
                  unit="%"
                  icon="trending_down"
                  color={num(latestCreditSpread) >= 5.5 ? 'error' : 'primary'}
                  sparkline={creditSpreadSparkline}
                  sparklineData={creditSpreadPoints}
                  formatValue={(p) => `${p.value.toFixed(2)}%`}
                  info={INDICATOR_INFO.creditSpread}
                  currentLevel={creditSpreadLevel}
                  windowOptions={DAILY_WINDOWS}
                />
                <IndicatorCard
                  title="Margin Debt"
                  value={latestMarginDebt}
                  unit="B"
                  icon="account_balance_wallet"
                  color={num(latestMarginDebt) >= 900 ? 'error' : 'primary'}
                  sparkline={marginDebtSparkline}
                  sparklineData={marginDebtPoints}
                  formatValue={(p) => `$${p.value.toFixed(0)}B`}
                  info={INDICATOR_INFO.marginDebt}
                  currentLevel={marginDebtLevel}
                />
              </div>
            </section>

            {/* === JOB MARKET === */}
            <section className="mb-10">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-1 h-5 bg-primary rounded-full"></span>
                <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-on-surface">
                  Job Market
                </h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <IndicatorCard
                  title="Unemployment Rate"
                  value={latestUnemploymentRate}
                  unit="%"
                  icon="people"
                  color="primary"
                  sparkline={unemploymentRateSparkline}
                  sparklineData={unemploymentPoints}
                  formatValue={(p) => `${p.value.toFixed(1)}%`}
                  info={INDICATOR_INFO.unemployment}
                  currentLevel={unempLevel}
                  forecastValue={latestForecast(unemploymentForecast)}
                  upcomingForecast={upcomingForecast(unemploymentForecast)}
                />
                <IndicatorCard
                  title="Initial Jobless Claims"
                  value={latestJoblessClaims}
                  unit="k"
                  icon="work_outline"
                  color="secondary"
                  sparkline={joblessClaimsSparkline}
                  sparklineData={joblessClaimsPoints}
                  formatValue={(p) => `${p.value.toFixed(0)}k`}
                  info={INDICATOR_INFO.joblessClaims}
                  currentLevel={joblessLevel}
                  forecastValue={latestForecast(joblessClaimsForecast)}
                  upcomingForecast={upcomingForecast(joblessClaimsForecast)}
                />
                <IndicatorCard
                  title="Nonfarm Payrolls (MoM)"
                  value={latestNonfarm}
                  unit="k"
                  icon="badge"
                  color="primary"
                  sparkline={nonfarmSparkline}
                  sparklineData={nonfarmPoints}
                  formatValue={(p) => `${p.value >= 0 ? '+' : ''}${p.value.toFixed(0)}k`}
                  info={INDICATOR_INFO.nonfarm}
                  currentLevel={nonfarmLevel}
                  forecastValue={latestForecast(nonfarmForecast)}
                  upcomingForecast={upcomingForecast(nonfarmForecast)}
                />
              </div>
            </section>

            {/* === INFLATION === */}
            <section className="mb-10">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-1 h-5 bg-primary rounded-full"></span>
                <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-on-surface">
                  Inflation
                </h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <IndicatorCard
                  title="CPI YoY (Headline)"
                  value={latestCpi}
                  unit="%"
                  icon="payments"
                  color="primary"
                  sparkline={cpiSparkline}
                  sparklineData={cpiPoints}
                  formatValue={(p) => `${p.value.toFixed(1)}%`}
                  info={INDICATOR_INFO.cpi}
                  currentLevel={cpiLevel}
                  forecastValue={latestForecast(cpiForecast)}
                  upcomingForecast={upcomingForecast(cpiForecast)}
                />
                <IndicatorCard
                  title="Core CPI YoY"
                  value={latestCoreCpi}
                  unit="%"
                  icon="shopping_cart"
                  color="primary"
                  sparkline={coreCpiSparkline}
                  sparklineData={coreCpiPoints}
                  formatValue={(p) => `${p.value.toFixed(1)}%`}
                  info={INDICATOR_INFO.coreCpi}
                  currentLevel={coreCpiLevel}
                  forecastValue={latestForecast(coreCpiForecast)}
                  upcomingForecast={upcomingForecast(coreCpiForecast)}
                />
                <IndicatorCard
                  title="PPI MoM"
                  value={latestPpi}
                  unit="%"
                  icon="factory"
                  color="secondary"
                  sparkline={ppiSparkline}
                  sparklineData={ppiPoints}
                  formatValue={(p) => `${p.value.toFixed(1)}%`}
                  info={INDICATOR_INFO.ppi}
                  currentLevel={ppiLevel}
                  forecastValue={latestForecast(ppiForecast)}
                  upcomingForecast={upcomingForecast(ppiForecast)}
                />
              </div>
            </section>

            {/* === ECONOMIC ACTIVITIES === */}
            <section className="mb-10">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-1 h-5 bg-primary rounded-full"></span>
                <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-on-surface">
                  Economic Activities
                </h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <IndicatorCard
                  title="ISM Manufacturing PMI"
                  value={latestIsmPmi}
                  unit=""
                  icon="precision_manufacturing"
                  color={parseFloat(latestIsmPmi) >= 50 ? "primary" : "secondary"}
                  sparkline={ismPmiSparkline}
                  sparklineData={ismPmiPoints}
                  formatValue={(p) => p.value.toFixed(1)}
                  info={INDICATOR_INFO.ismMfg}
                  currentLevel={ismMfgLevel}
                  forecastValue={validIsmPmi[validIsmPmi.length - 1]?.Forecast || ''}
                />
                <IndicatorCard
                  title="ISM Services PMI"
                  value={latestIsmServices}
                  unit=""
                  icon="support_agent"
                  color={parseFloat(latestIsmServices) >= 50 ? "primary" : "secondary"}
                  sparkline={ismServicesSparkline}
                  sparklineData={ismServicesPoints}
                  formatValue={(p) => p.value.toFixed(1)}
                  info={INDICATOR_INFO.ismSvc}
                  currentLevel={ismSvcLevel}
                  forecastValue={validIsmServices[validIsmServices.length - 1]?.Forecast || ''}
                />
                <IndicatorCard
                  title="Chicago PMI"
                  value={latestChicagoPmi}
                  unit=""
                  icon="location_city"
                  color={parseFloat(latestChicagoPmi) >= 50 ? "primary" : "secondary"}
                  sparkline={chicagoPmiSparkline}
                  sparklineData={chicagoPmiPoints}
                  formatValue={(p) => p.value.toFixed(1)}
                  info={INDICATOR_INFO.chicagoPmi}
                  currentLevel={chicagoPmiLevel}
                  forecastValue={validChicagoPmi[validChicagoPmi.length - 1]?.Forecast || ''}
                />
                <IndicatorCard
                  title="UoM Consumer Sentiment"
                  value={latestSentiment}
                  unit=""
                  icon="mood"
                  color={parseFloat(latestSentiment) >= 70 ? "primary" : "secondary"}
                  sparkline={sentimentSparkline}
                  sparklineData={sentimentPoints}
                  formatValue={(p) => p.value.toFixed(1)}
                  info={INDICATOR_INFO.consumer}
                  currentLevel={sentimentLevel}
                  forecastValue={validSentimentRaw[validSentimentRaw.length - 1]?.Forecast || ''}
                  upcomingForecast={upcomingForecast(consumerSentiment)}
                />
              </div>
            </section>

          </>
        )}
      </main>
      <Footer />
    </div>
  );
}

export default App;