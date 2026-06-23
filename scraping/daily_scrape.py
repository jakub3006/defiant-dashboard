"""
Daily economic-data scraper for the Defiant Dashboard.

Consolidates seven pipelines into a single file so it can be run unattended
(e.g. from a GitHub Actions cron job). Each pipeline writes JSON files into
public/data/ (the Vite static-asset folder); later pipelines overwrite
earlier ones, so the order is chosen to leave the highest-quality source
last:

    1. Investing.com (Playwright)  — PMIs only (ISM Mfg / ISM Services /
       Chicago). No other free source publishes the analyst-consensus
       Forecast column for these.
    2. ForexFactory JSON           — macro consensus (NFP, Unemployment,
       Jobless Claims, CPI YoY, Core CPI YoY, PPI MoM, Michigan Sentiment).
       Plain JSON feed — no browser, no Cloudflare — the most reliable
       source for unattended runs, so it runs AFTER Investing.com and
       overwrites it for these indicators.
    3. Trading Economics fallback  — only fills indicators that the prior
       two pipelines left empty / missing. Never overwrites a populated
       file.
    4. FINRA margin statistics     — monthly customer-debit balances. Plain
       HTTP scrape of the FINRA data page. Writes margin_debt_data.json.
    5. CME FedWatch (Playwright)   — implied FOMC-rate probabilities for
       the next 5 meetings. Writes fedwatch_data.json.
    6. FRED API (HTTP)             — every FRED series the dashboard
       renders (CPI, PPI, DGS10, BAMLH0A0HYM2, ...). Baked into
       public/data/fred-<series>.json at scrape time so the frontend
       never needs the API key and renders even if FRED is down.
       Requires FRED_API_KEY env var (set as a GitHub Actions secret).
    7. Yahoo Finance (yfinance)    — VIX daily close, 12-month window.
       Replaces FRED's VIXCLS which lags by ~1 business day (a Friday
       spike doesn't show in FRED until Monday). Writes vix_data.json.

Output location is the dashboard's ``server/`` folder, resolved as
``<repo-root>/server/`` by default. Override with the ``DASHBOARD_SERVER_PATH``
environment variable (this is what the GitHub Actions workflow does).

Usage:
    python3 scraping/daily_scrape.py
"""

from __future__ import annotations

import asyncio
import datetime
import json
import os
import random
import re
import sys
import time
from pathlib import Path

import pandas as pd
import requests
from bs4 import BeautifulSoup

# Playwright is only needed for the Investing.com PMI step. Import lazily so
# the script can still run the FF + TE phases on a machine without Playwright.
try:
    from playwright.async_api import (
        TimeoutError as PlaywrightTimeoutError,
        async_playwright,
    )
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


# ---------------------------------------------------------------------------
# Paths & shared config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent

# Where the scraper writes its JSON output. Defaults to public/data/ so the
# Vite build picks the files up as static assets (Vite copies public/ into
# dist/ as-is, no import needed). Override with DASHBOARD_DATA_PATH if you
# want the files somewhere else — e.g. the legacy DASHBOARD_SERVER_PATH=server
# is still accepted for back-compat with older shell scripts.
BASE_PATH = Path(
    os.environ.get(
        "DASHBOARD_DATA_PATH",
        os.environ.get("DASHBOARD_SERVER_PATH", REPO_ROOT / "public" / "data"),
    )
).resolve()

# Debug HTML dumps live outside BASE_PATH so they never ship with the static
# build. .gitignore'd, regenerated on every scrape, useful only when a
# Playwright selector breaks.
DEBUG_PATH = Path(
    os.environ.get("DASHBOARD_DEBUG_PATH", REPO_ROOT / "scraping" / "debug")
).resolve()


def _ensure_debug_dir() -> None:
    DEBUG_PATH.mkdir(parents=True, exist_ok=True)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)


def _ensure_dir() -> None:
    BASE_PATH.mkdir(parents=True, exist_ok=True)


def _write_json(filename: str, payload) -> None:
    _ensure_dir()
    with open(BASE_PATH / filename, "w") as f:
        json.dump(payload, f, indent=2)


def _merge_rows_to_file(filename: str, new_rows: list, max_rows: int = 36) -> list:
    """
    Merge `new_rows` into the existing file at `filename`, keyed by the
    row's `date` field. Returns the merged list (also written back to disk).

    Why this exists: the ForexFactory feed only carries last-week / this-
    week / next-week events, so without merging we'd lose every released
    actual the moment its date drops out of the rolling window. With this
    merge, each scrape *adds* to the historical record instead of replacing
    it — and we keep up to `max_rows` newest-first.

    Conflict resolution (same date in existing + new), in order:
      1. New row's `source` matches existing row's `source` → new replaces
         existing (a same-source update is assumed to be a revision and is
         authoritative). This is what lets BLS revisions or FF consensus
         updates flow through without manual intervention.
      2. Otherwise, quality score = (has_actual?, has_forecast?). New row
         replaces existing only when its score is STRICTLY greater. This
         protects: (a) manual seeds against being clobbered by a future
         scrape from another source at equal quality, and (b) a high-
         quality FF row against being overwritten by a TE model fallback.
    """
    _ensure_dir()
    path = BASE_PATH / filename

    existing = []
    if path.exists():
        try:
            existing = json.loads(path.read_text())
            if not isinstance(existing, list):
                existing = []
        except Exception:
            existing = []

    def _isf(v):
        return v is not None and str(v).strip() not in ("", ".")

    def _quality(row):
        if not isinstance(row, dict):
            return (0, 0)
        return (
            1 if _isf(row.get("value")) or _isf(row.get("Actual")) else 0,
            1 if _isf(row.get("Forecast")) else 0,
        )

    by_date = {}
    for row in existing:
        if isinstance(row, dict) and row.get("date"):
            by_date[row["date"]] = row

    def _same_source(a, b):
        sa = a.get("source") if isinstance(a, dict) else None
        sb = b.get("source") if isinstance(b, dict) else None
        return bool(sa) and sa == sb

    added = updated = 0
    for row in new_rows:
        if not isinstance(row, dict) or not row.get("date"):
            continue
        d = row["date"]
        if d not in by_date:
            by_date[d] = row
            added += 1
        elif _same_source(row, by_date[d]):
            # Same source → assume revision / refresh; new wins regardless
            # of quality. This lets FF analyst-consensus updates and BLS
            # revisions flow through automatically.
            by_date[d] = row
            updated += 1
        elif _quality(row) > _quality(by_date[d]):
            by_date[d] = row
            updated += 1

    merged = sorted(by_date.values(), key=lambda r: r.get("date", ""), reverse=True)
    merged = merged[:max_rows]
    with open(path, "w") as f:
        json.dump(merged, f, indent=2)
    return merged


def _file_has_rows(filename: str) -> bool:
    """True if the file exists and contains at least one non-empty row."""
    path = BASE_PATH / filename
    if not path.exists():
        return False
    try:
        with open(path) as f:
            data = json.load(f)
        return isinstance(data, list) and len(data) > 0
    except Exception:
        return False


# ===========================================================================
# Phase 1 — Investing.com via Playwright (PMIs only)
# ===========================================================================

INVEST_TASKS = [
    {
        "name": "ISM Manufacturing PMI",
        "url": "https://www.investing.com/economic-calendar/ism-manufacturing-pmi-173",
        "file": "ism_data.json",
    },
    {
        "name": "ISM Services PMI",
        "url": "https://www.investing.com/economic-calendar/ism-non-manufacturing-pmi-176",
        "file": "ism_services_data.json",
    },
    {
        "name": "Chicago PMI",
        "url": "https://www.investing.com/economic-calendar/united-states-chicago-purchasing-managers-index-(pmi)-38",
        "file": "chicago_pmi_data.json",
    },
    {
        # FRED's UMCSENT lags by a full month, so we scrape Investing.com
        # instead — they carry the BLS-style preliminary + final prints
        # the same day the U-Mich press release goes out.
        "name": "Michigan Consumer Sentiment",
        "url": "https://www.investing.com/economic-calendar/michigan-consumer-sentiment-320",
        "file": "consumer_sentiment_data.json",
    },
]


# --- Cloudflare-bypass plumbing ------------------------------------------
# Used by both the Investing.com PMI scrape and the FedWatch fallback that
# also hits Investing.com. Two layers of defense:
#   1) _stealth_context(): browser context with realistic Chrome 122
#      fingerprint headers (Sec-Ch-Ua, Accept-*, etc.) — must match the
#      USER_AGENT major version to look coherent to CF's bot detection.
#   2) _apply_stealth_init(): a JS init script that runs BEFORE any page
#      script, hiding navigator.webdriver and faking the headless tells
#      Cloudflare checks for (plugins length, languages, window.chrome).
# When tf-playwright-stealth is installed (optional), we prefer that
# library since it covers more edge cases (WebGL, canvas fingerprinting,
# etc.). The manual fallback handles the big ones.

_STEALTH_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    # cross-site referer + Sec-Fetch-Site=cross-site makes the request look
    # like the user clicked a Google search result rather than typing the
    # URL directly. CF treats search-engine traffic with more leniency.
    "Referer": "https://www.google.com/",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

_STEALTH_INIT_JS = """
// Remove the webdriver flag — single biggest Cloudflare giveaway.
Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
});
// Fake a populated plugins list — empty plugins = headless tell.
Object.defineProperty(navigator, 'plugins', {
    get: () => [
        { name: 'PDF Viewer' },
        { name: 'Chrome PDF Viewer' },
        { name: 'Chromium PDF Viewer' },
        { name: 'Native Client' },
    ],
});
// Languages list — headless leaves this as just ['en-US'].
Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
});
// window.chrome stub — real Chrome has this object, headless does not.
if (!window.chrome) {
    window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {},
    };
}
// Permissions API quirk — headless reports 'denied' for notifications
// where real browsers return the actual prompt state.
const originalQuery = window.navigator.permissions?.query;
if (originalQuery) {
    window.navigator.permissions.query = (parameters) => (
        parameters && parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters)
    );
}
"""


async def _stealth_context(browser, viewport: dict):
    """Create a browser context with realistic Chrome 122 fingerprint headers."""
    return await browser.new_context(
        user_agent=USER_AGENT,
        viewport=viewport,
        locale="en-US",
        timezone_id="America/New_York",
        extra_http_headers=_STEALTH_HEADERS,
    )


async def _apply_stealth_init(page) -> None:
    """Apply stealth patches to a page. Library version preferred when available."""
    try:
        # tf-playwright-stealth — optional dependency. Skip silently if not
        # installed; the manual init script still runs below as fallback.
        from playwright_stealth import Stealth  # type: ignore
        await Stealth().apply_stealth_async(page.context)
    except Exception:
        pass
    # Always run manual patches too — defense in depth doesn't hurt and
    # ensures something works even if the library install lags.
    await page.add_init_script(_STEALTH_INIT_JS)


async def _wait_past_cloudflare(page, max_wait_ms: int = 30000) -> None:
    """
    Cloudflare's "Just a moment..." interstitial typically auto-resolves
    within 5-15s when the stealth signals look right (no navigator.webdriver,
    correct Sec-Ch-Ua, etc.). Without this wait the calling code rushes to
    look for the page's real content immediately after `goto`, sees CF's
    challenge HTML instead, and times out.

    We poll the page title — CF replaces "Just a moment..." with the real
    page title once it accepts us. Returns silently on success or when the
    timeout is hit (the caller's subsequent wait_for_selector will then
    surface the actual failure with the current title in the error message).
    """
    try:
        initial_title = await page.title()
    except Exception:
        return
    if "just a moment" not in initial_title.lower():
        return  # No challenge — done immediately.
    try:
        await page.wait_for_function(
            "() => !document.title.toLowerCase().includes('just a moment')",
            timeout=max_wait_ms,
        )
        # Tiny extra grace period: CF sometimes flips the title before
        # the page body is fully replaced.
        await page.wait_for_timeout(500)
    except PlaywrightTimeoutError:
        pass  # Caller will report the still-on-challenge state.


async def _fetch_invest_table(browser, url: str) -> str:
    """Each call gets its own context so fingerprints don't accumulate."""
    context = await _stealth_context(
        browser, viewport={"width": 1280, "height": 900}
    )
    page = await context.new_page()
    await _apply_stealth_init(page)
    await page.route(
        "**/*.{png,jpg,jpeg,gif,woff,woff2,otf,mp4,webm}",
        lambda route: route.abort(),
    )
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=60000)
        await _wait_past_cloudflare(page, max_wait_ms=30000)
        try:
            await page.wait_for_selector(
                'table[data-test="occurrence-table"]', timeout=20000
            )
        except PlaywrightTimeoutError:
            title = (await page.title()) or "(no title)"
            raise RuntimeError(
                f"Table never appeared. Page title: '{title}' "
                "(likely a bot-block / Cloudflare challenge)."
            )

        # Dump a snippet around the occurrence-table so we can see what
        # markup the Show-more button actually uses. Written once per
        # indicator (overwrites prior). Open in a browser / grep for
        # "showMore" to verify the selector.
        try:
            slug = re.sub(r"[^a-z0-9]+", "-", url.lower()).strip("-")[:60]
            _ensure_debug_dir()
            (DEBUG_PATH / f"invest_{slug}_debug.html").write_text(
                await page.content()
            )
        except Exception:
            pass

        # Click "Show more" up to N× to pull in additional historical rows.
        # We ONLY use id-/class-scoped selectors so we never accidentally
        # click an unrelated "show more" link elsewhere on the page (that's
        # what was breaking the table on the previous run — a Headlines/
        # Related-News widget also has a "Show more" link that, when
        # clicked, navigates the page and destroys the occurrence-table).
        #
        # If NONE of these match, the button selector has changed; the
        # HTML we just dumped above is the way to find the right one.
        # Current (Next.js) markup: the show-more is a generic <div> with
        # `cursor-pointer` and an inner <div> reading "Show More" (capital M).
        # The news section also has a "Show more" link (lowercase m, in <a>),
        # so we match case-exact "Show More" to avoid that collision.
        # Legacy id/class selectors are kept as fallback in case the markup
        # reverts.
        SHOW_MORE_SELECTORS = [
            # New markup: scoped to the occurrence-table's container so we
            # never grab a "Show More" from elsewhere on the page.
            'xpath=//table[@data-test="occurrence-table"]/ancestor::div[2]'
            '/following-sibling::div[contains(@class,"cursor-pointer")]'
            '[.//div[normalize-space(.)="Show More"]][1]',
            # New markup, unscoped — exact-case text match
            'div.cursor-pointer:has(> div:text-is("Show More"))',
            # Legacy fallbacks
            '[id^="showMoreHistory"]',
            '#showMoreHistory',
            'a.showMoreHistory',
            '.showMoreHistory a',
            'div.showMoreHistory',
        ]
        for attempt in range(5):
            rows_before = await page.locator(
                'table[data-test="occurrence-table"] tbody tr'
            ).count()
            if rows_before == 0:
                # Earlier click destroyed the table — bail before we lose more.
                print(f"    Tabelle leer — Show-more-Schleife abgebrochen.")
                break
            clicked_via = None
            for sel in SHOW_MORE_SELECTORS:
                try:
                    loc = page.locator(sel).first
                    if await loc.count() == 0:
                        continue
                    await loc.scroll_into_view_if_needed(timeout=2000)
                    await loc.click(timeout=3000)
                    clicked_via = sel
                    break
                except Exception:
                    continue
            if not clicked_via:
                print(
                    f"    'Show more' nicht klickbar nach {attempt} Klicks "
                    f"({rows_before} Zeilen). HTML in "
                    f"scraping/debug/invest_*_debug.html — Selektor "
                    "anpassen falls Button existiert."
                )
                break
            await asyncio.sleep(1.5)
            rows_after = await page.locator(
                'table[data-test="occurrence-table"] tbody tr'
            ).count()
            print(
                f"    Show more #{attempt+1} via {clicked_via}: "
                f"{rows_before} → {rows_after} Zeilen."
            )
            if rows_after == 0:
                # Defensive: a future selector regression that destroys the
                # table again should not silently empty the file.
                print(f"    Click hat Tabelle zerstört — stoppe.")
                break
            if rows_after <= rows_before:
                break

        return await page.content()
    finally:
        await context.close()


async def _scrape_invest_one(browser, task, max_attempts: int = 3) -> bool:
    print(f"\n  → {task['name']}")
    for attempt in range(1, max_attempts + 1):
        try:
            print(f"    Versuch {attempt}/{max_attempts}: {task['url']}")
            content = await _fetch_invest_table(browser, task["url"])
            soup = BeautifulSoup(content, "html.parser")
            table = soup.find("table", {"data-test": "occurrence-table"})
            if not table:
                raise RuntimeError("Table missing from page HTML")

            rows = []
            for tr in table.find("tbody").find_all("tr"):
                cols = tr.find_all("td")
                if len(cols) >= 4:
                    actual = cols[2].get_text(strip=True)
                    if actual:
                        rows.append({
                            "Date": cols[0].get_text(strip=True),
                            "Actual": actual,
                            "Forecast": cols[3].get_text(strip=True),
                        })

            df = pd.DataFrame(rows)
            if df.empty:
                print(f"    ℹ️  Keine Daten für {task['name']}.")
                return False

            df["Date_Cleaned"] = df["Date"].str.split(
                " (", expand=False, regex=False
            ).str[0]
            df["date"] = pd.to_datetime(
                df["Date_Cleaned"], format="%b %d, %Y"
            ).dt.strftime("%Y-%m-%d")
            df["value"] = df["Actual"]

            _ensure_dir()
            df[["date", "value", "Forecast"]].to_json(
                BASE_PATH / task["file"], orient="records", indent=2
            )
            print(f"    ✅ {len(df)} Zeilen → {task['file']}")
            return True

        except Exception as e:
            print(f"    ⚠️  Versuch {attempt} fehlgeschlagen: {e}")
            if attempt < max_attempts:
                cooldown = random.uniform(25, 45)
                print(f"    ⏳ Cooldown {cooldown:.0f}s...")
                await asyncio.sleep(cooldown)

    print(f"    ❌ {task['name']}: aufgegeben.")
    return False


async def _phase_investing() -> None:
    if not PLAYWRIGHT_AVAILABLE:
        print("\n[1/5] Investing.com PMIs — übersprungen (Playwright nicht installiert).")
        return
    print("\n[1/5] Investing.com PMIs (Playwright)")
    async with async_playwright() as p:
        # Stealth launch args. The single most impactful flag is
        # --disable-blink-features=AutomationControlled, which removes the
        # navigator.webdriver=true signal that Cloudflare instantly
        # fingerprints. The rest are CI-friendly defaults.
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-sandbox",
                "--disable-features=IsolateOrigins,site-per-process",
            ],
        )
        try:
            for i, task in enumerate(INVEST_TASKS):
                await _scrape_invest_one(browser, task)
                if i < len(INVEST_TASKS) - 1:
                    pause = random.uniform(7, 15)
                    print(f"    --- Pause {pause:.1f}s ---")
                    await asyncio.sleep(pause)
        finally:
            await browser.close()


# ===========================================================================
# Phase 2 — ForexFactory JSON (macro consensus)
# ===========================================================================

# faireconomy.media (the ForexFactory JSON mirror) only publishes the
# `thisweek` file consistently — lastweek + nextweek 404 the vast majority
# of the time. We used to include them and silently swallow the errors,
# but the log noise was masking real failures. They're commented out
# rather than deleted in case the publisher ever fixes the cadence.
#
# Practical impact: every event has a ~7-day window in which we can
# capture it (while it's in `thisweek`). The merge-with-existing logic
# in _merge_rows_to_file preserves rows once captured, so as long as we
# scrape at least once per week — which the 2×/day cron guarantees — no
# release is missed.
FF_SOURCES = [
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    # "https://nfs.faireconomy.media/ff_calendar_lastweek.json",  # 404
    # "https://nfs.faireconomy.media/ff_calendar_nextweek.json",  # 404
]

FF_TARGETS = [
    {
        "name": "Nonfarm Payrolls",
        "file": "nonfarm_payrolls_data.json",
        "match": lambda t: t == "non-farm employment change",
    },
    {
        "name": "Unemployment Rate",
        "file": "unemployment_data.json",
        "match": lambda t: t == "unemployment rate",
    },
    {
        "name": "Initial Jobless Claims",
        "file": "jobless_claims_data.json",
        "match": lambda t: t == "unemployment claims",
    },
    {
        "name": "CPI YoY",
        "file": "cpi_data.json",
        "match": lambda t: t == "cpi y/y",
    },
    {
        "name": "Core CPI YoY",
        "file": "core_cpi_data.json",
        "match": lambda t: t == "core cpi y/y",
    },
    {
        "name": "PPI MoM",
        "file": "ppi_data.json",
        "match": lambda t: t == "ppi m/m",
    },
    {
        "name": "Michigan Consumer Sentiment",
        "file": "consumer_sentiment_data.json",
        "match": lambda t: "uom consumer sentiment" in t,
        # Sentiment is plotted directly from this file (no FRED equivalent
        # used) so we keep 5 years of history. Other FF targets only feed
        # the Forecast column, so 36 rows there is plenty.
        "max_rows": 60,
    },
]


def _ff_to_date(iso_or_str) -> str:
    if not iso_or_str:
        return ""
    s = str(iso_or_str)
    return s.split("T", 1)[0] if "T" in s else s[:10]


def _phase_forexfactory() -> None:
    print("\n[2/5] ForexFactory JSON (macro consensus)")
    events = []
    for url in FF_SOURCES:
        label = url.rsplit("/", 1)[-1]
        try:
            resp = requests.get(
                url, headers={"User-Agent": USER_AGENT}, timeout=20
            )
            resp.raise_for_status()
            data = resp.json()
            print(f"  • {label}: {len(data)} events")
            events.extend(data)
        except Exception as e:
            print(f"  ⚠️  {label}: {e}")

    if not events:
        print("  ❌ Keine FF-Events geladen.")
        return

    for target in FF_TARGETS:
        rows = []
        for ev in events:
            if (ev.get("country") or "").upper() != "USD":
                continue
            title = (ev.get("title") or "").strip().lower()
            if not target["match"](title):
                continue
            rows.append({
                "date": _ff_to_date(ev.get("date", "")),
                "value": ev.get("actual", "") or "",
                "Forecast": ev.get("forecast", "") or "",
                "source": "forexfactory.com",
            })

        if not rows:
            print(f"  ⚠️  {target['name']}: kein passendes Event.")
            continue
        rows.sort(key=lambda r: r["date"], reverse=True)
        merged = _merge_rows_to_file(
            target["file"], rows, max_rows=target.get("max_rows", 36)
        )
        latest = next((r["Forecast"] for r in rows if r["Forecast"]), "—")
        print(
            f"  ✅ {target['name']}: +{len(rows)} → {len(merged)} total, "
            f"neueste Forecast '{latest}' → {target['file']}"
        )


# ===========================================================================
# Phase 3 — Trading Economics fallback
# ===========================================================================

TE_TASKS = [
    {
        "name": "Nonfarm Payrolls",
        "url": "https://tradingeconomics.com/united-states/non-farm-payrolls",
        "file": "nonfarm_payrolls_data.json",
    },
    {
        "name": "Michigan Consumer Sentiment",
        "url": "https://tradingeconomics.com/united-states/consumer-confidence",
        "file": "consumer_sentiment_data.json",
    },
    {
        "name": "Unemployment Rate",
        "url": "https://tradingeconomics.com/united-states/unemployment-rate",
        "file": "unemployment_data.json",
    },
    {
        "name": "Initial Jobless Claims",
        "url": "https://tradingeconomics.com/united-states/jobless-claims",
        "file": "jobless_claims_data.json",
    },
    {
        "name": "PPI MoM",
        "url": "https://tradingeconomics.com/united-states/producer-price-inflation-mom",
        "file": "ppi_data.json",
    },
    {
        "name": "CPI YoY",
        "url": "https://tradingeconomics.com/united-states/inflation-cpi",
        "file": "cpi_data.json",
    },
    {
        "name": "Core CPI YoY",
        "url": "https://tradingeconomics.com/united-states/core-inflation-rate",
        "file": "core_cpi_data.json",
    },
]

TE_FORECAST_RE = re.compile(
    r"is expected to be\s+"
    r"(-?[\d.,]+(?:\s*[A-Za-z%]+)?)"
    r"\s+(?:by the end|by mid|by the close|according)",
    re.IGNORECASE,
)


def _te_norm_date(raw: str) -> str:
    if not raw:
        return ""
    raw_clean = raw.strip().split(" (")[0].strip()
    for fmt in (
        "%Y-%m-%d", "%b %d, %Y", "%B %d, %Y",
        "%d %b %Y", "%d %B %Y", "%b/%d/%Y",
    ):
        try:
            return datetime.datetime.strptime(raw_clean, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return raw


def _te_calendar_rows(soup: BeautifulSoup):
    for table in soup.find_all("table"):
        ths = table.find_all("th")
        if not ths:
            continue
        headers = [th.get_text(strip=True).lower() for th in ths]
        if "actual" not in headers or "forecast" not in headers:
            continue
        col_actual = headers.index("actual")
        col_forecast = headers.index("forecast")
        col_date = next(
            (i for i, h in enumerate(headers) if "date" in h), 0
        )
        rows = []
        for tr in table.find_all("tr"):
            tds = tr.find_all("td")
            if len(tds) <= max(col_actual, col_forecast, col_date):
                continue
            actual = tds[col_actual].get_text(strip=True)
            forecast = tds[col_forecast].get_text(strip=True)
            date_raw = tds[col_date].get_text(strip=True)
            if not (actual or forecast):
                continue
            rows.append({
                "date": _te_norm_date(date_raw),
                "value": actual,
                "Forecast": forecast,
                "source": "tradingeconomics.com (calendar)",
            })
        if rows:
            return rows
    return None


def _te_text_forecast(soup: BeautifulSoup):
    text = soup.get_text(separator=" ", strip=True)
    m = TE_FORECAST_RE.search(text)
    if not m:
        return None
    raw = re.sub(r"\s+", " ", m.group(1).strip())
    return [{
        "date": datetime.date.today().isoformat(),
        "value": "",
        "Forecast": raw,
        "source": "tradingeconomics.com (model)",
    }]


def _phase_trading_economics() -> None:
    # Only fills indicators whose file is still empty. Historical backfill
    # happens via _merge_rows_to_file in the ForexFactory phase, plus any
    # one-time manual seeds in the JSON files themselves.
    print("\n[3/5] Trading Economics fallback (nur leere Dateien)")
    success = 0
    for task in TE_TASKS:
        if _file_has_rows(task["file"]):
            continue

        print(f"  → {task['name']} ({task['url']})")
        try:
            resp = requests.get(
                task["url"],
                headers={"User-Agent": USER_AGENT},
                timeout=25,
            )
            resp.raise_for_status()
        except Exception as e:
            print(f"    ❌ HTTP-Fehler: {e}")
            continue

        soup = BeautifulSoup(resp.text, "html.parser")
        rows = _te_calendar_rows(soup) or _te_text_forecast(soup)
        if not rows:
            print(f"    ⚠️  Weder Kalender noch Text-Forecast gefunden.")
            continue

        _write_json(task["file"], rows)
        latest = next((r["Forecast"] for r in rows if r.get("Forecast")), "—")
        print(f"    ✅ {len(rows)} Zeilen, '{latest}' → {task['file']}")
        success += 1
        time.sleep(1.5)
    print(f"  Fallback: {success} Indikator(en) gefüllt.")


# ===========================================================================
# Phase 4 — FINRA margin debt
# ===========================================================================
#
# FINRA publishes monthly "Margin Statistics" — the total debit balance in
# customers' securities margin accounts (i.e. how much leverage retail +
# institutional investors are running). It's a classic risk-on / risk-off
# gauge: margin debt expands in bull markets and contracts sharply at tops.
#
# Source page (server-rendered HTML table):
#     https://www.finra.org/investors/learn-to-invest/advanced-investing/margin-statistics
#
# We look for a table whose headers include "Debit Balances" (the canonical
# FINRA column name) and read the most recent ~24 rows. Numeric values are
# published in millions of dollars; we convert to USD billions for the
# dashboard.

FINRA_URL = (
    "https://www.finra.org/investors/learn-to-invest/"
    "advanced-investing/margin-statistics"
)

# FINRA's CDN (Akamai) returns 403 to bare User-Agent-only requests. A full
# browser-style header set defeats their bot heuristic in practice.
FINRA_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,image/apng,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

_FINRA_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5,
    "june": 6, "july": 7, "august": 8, "september": 9, "october": 10,
    "november": 11, "december": 12,
    # FINRA sometimes abbreviates
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7,
    "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _finra_parse_period(raw: str) -> str:
    """Turn 'Apr-26' / 'March 2026' / 'Mar-2026' / '2026-03' into 'YYYY-MM-01'."""
    s = raw.strip()
    if not s:
        return ""
    # 2026-03 / 2026-03-01
    m = re.match(r"^(\d{4})[-/](\d{1,2})", s)
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
        return f"{y:04d}-{mo:02d}-01"
    # 'Apr-26' (FINRA's compact format on the margin-statistics page)
    m = re.match(r"^([A-Za-z\.]+)[-/](\d{2})$", s)
    if m:
        month_word = m.group(1).strip(".").lower()
        if month_word in _FINRA_MONTHS:
            return f"{2000 + int(m.group(2)):04d}-{_FINRA_MONTHS[month_word]:02d}-01"
    # 'March 2026' / 'Mar 2026' / 'Mar-2026'
    m = re.match(r"^([A-Za-z\.]+)[\s\-/](\d{4})$", s)
    if m:
        month_word = m.group(1).strip(".").lower()
        if month_word in _FINRA_MONTHS:
            return f"{int(m.group(2)):04d}-{_FINRA_MONTHS[month_word]:02d}-01"
    return s


def _finra_to_float(raw: str):
    """FINRA cells look like '$876,543' or '876,543.0'. Strip and return float."""
    if raw is None:
        return None
    s = re.sub(r"[^\d.\-]", "", str(raw))
    if not s or s in (".", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


async def _fetch_finra_html_via_browser() -> str:
    """
    FINRA sits behind Cloudflare's JS interstitial ('Just a moment...').
    A real browser passes the challenge in 5-15 s; headless Chromium often
    does too, but not always. We:
      1) navigate
      2) wait for the actual content text ('Debit Balances') to appear,
         NOT just any <table> — the challenge page also has tables
      3) if the challenge never clears, raise a clean error with the title
         so the user knows what's blocking us (vs. seeing an empty parse).
    """
    if not PLAYWRIGHT_AVAILABLE:
        raise RuntimeError("Playwright not installed")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            context = await browser.new_context(
                user_agent=FINRA_HEADERS["User-Agent"],
                viewport={"width": 1280, "height": 900},
                locale="en-US",
                timezone_id="America/New_York",
            )
            # Match the real-browser accept headers — Cloudflare scores
            # mismatched accept lines as a bot signal.
            await context.set_extra_http_headers({
                "Accept": FINRA_HEADERS["Accept"],
                "Accept-Language": FINRA_HEADERS["Accept-Language"],
            })
            page = await context.new_page()
            await page.goto(
                FINRA_URL, wait_until="domcontentloaded", timeout=60000
            )

            # Wait up to 30s for Cloudflare's JS challenge to clear and the
            # real table content to appear. The challenge page never
            # contains 'Debit Balances', so this only resolves on the real
            # page. If it times out, the challenge stalled us.
            try:
                await page.wait_for_function(
                    "() => /Debit Balances/i.test(document.body.innerText)",
                    timeout=30000,
                )
            except PlaywrightTimeoutError:
                title = (await page.title()) or "(no title)"
                if "moment" in title.lower() or "checking" in title.lower():
                    raise RuntimeError(
                        f"Cloudflare-Challenge nicht bestanden (Titel: '{title}'). "
                        "Headless Chrome wird blockiert. Workarounds: "
                        "(a) scraping/manual_margin_debt.txt anlegen, oder "
                        "(b) playwright-stealth installieren."
                    )
                raise RuntimeError(
                    f"FINRA content nicht gefunden (Titel: '{title}')"
                )
            return await page.content()
        finally:
            await browser.close()


# ---------------------------------------------------------------------------
# Manual override: when Cloudflare blocks the live scrape, the user can
# paste the FINRA table into scraping/manual_margin_debt.txt and we'll use
# that instead. The expected format is exactly what FINRA's HTML table
# renders as text — month label followed by 3 comma-formatted millions
# values, separated by tabs or runs of whitespace. Examples that all parse:
#
#     Apr-26   1,304,281   217,836   215,445
#     Apr-26,1304281,217836,215445
#     Apr-26 | 1304281 | 217836 | 215445
#
# Headers and stray lines are ignored.

MANUAL_FINRA_PATH = SCRIPT_DIR / "manual_margin_debt.txt"


def _parse_manual_finra(text: str):
    """Return a list of (label, debit_m, cash_m, margin_m) tuples in file order."""
    rows = []
    line_pat = re.compile(
        r"^\s*([A-Za-z]{3,9})[-/\s]*(\d{2,4})"
        r"[\s,|\t]+([\d,]+)"
        r"[\s,|\t]+([\d,]+)"
        r"[\s,|\t]+([\d,]+)\s*$"
    )
    for raw_line in text.splitlines():
        m = line_pat.match(raw_line)
        if not m:
            continue
        month_word = m.group(1).lower()
        if month_word not in _FINRA_MONTHS:
            continue
        year_raw = m.group(2)
        label = f"{m.group(1)}-{year_raw}"
        debit  = _finra_to_float(m.group(3))
        cash   = _finra_to_float(m.group(4))
        margin = _finra_to_float(m.group(5))
        if None in (debit, cash, margin):
            continue
        rows.append((label, debit, cash, margin))
    return rows


def _build_rows_from_manual(parsed) -> list:
    """Same JSON shape as the live-scrape path so the frontend doesn't care."""
    out = []
    for label, debit_m, cash_m, margin_m in parsed:
        iso_date = _finra_parse_period(label)
        out.append({
            "date": iso_date,
            "label": label,
            "value": round(debit_m / 1000.0, 1),
            "debit_millions":         debit_m,
            "credit_cash_millions":   cash_m,
            "credit_margin_millions": margin_m,
            "debit_billions":         round(debit_m  / 1000.0, 1),
            "credit_cash_billions":   round(cash_m   / 1000.0, 1),
            "credit_margin_billions": round(margin_m / 1000.0, 1),
            "source": "finra.org (manual)",
        })
    out.sort(key=lambda r: r["date"], reverse=True)
    return out[:36]


def _phase_finra_margin() -> None:
    print("\n[4/5] FINRA margin statistics")

    # Step 0 — manual override. If the user has pasted the FINRA table into
    # scraping/manual_margin_debt.txt, use that and skip the live scrape
    # entirely. Cloudflare-blocked envs (CI runners, some home networks)
    # use this path as their escape hatch.
    if MANUAL_FINRA_PATH.exists():
        try:
            parsed = _parse_manual_finra(MANUAL_FINRA_PATH.read_text())
        except Exception as e:
            print(f"  ⚠️  manual_margin_debt.txt unlesbar: {e}")
            parsed = []
        if parsed:
            rows = _build_rows_from_manual(parsed)
            _write_json("margin_debt_data.json", rows)
            print(
                f"  ✅ Manual override: {len(rows)} Monate aus "
                f"{MANUAL_FINRA_PATH.name}, neuester Debit "
                f"${rows[0]['debit_billions']}B ({rows[0]['label']})"
            )
            return
        else:
            print(f"  ⚠️  {MANUAL_FINRA_PATH.name} gefunden, "
                  "aber keine parsebaren Zeilen — versuche live scrape.")

    # Step 1 — try plain requests (cheap, no browser overhead).
    # Step 2 — fall back to Playwright if Akamai/Cloudflare 403s.
    html = None
    try:
        session = requests.Session()
        session.headers.update(FINRA_HEADERS)
        resp = session.get(FINRA_URL, timeout=25, allow_redirects=True)
        resp.raise_for_status()
        html = resp.text
    except Exception as e:
        print(f"  ⚠️  Plain HTTP fehlgeschlagen ({e}); versuche Playwright...")
        try:
            html = asyncio.run(_fetch_finra_html_via_browser())
            print(f"  ✓  Playwright hat HTML geladen.")
        except Exception as e2:
            print(f"  ❌ Auch Playwright fehlgeschlagen: {e2}")
            print(
                f"  ℹ️  Workaround: lege {MANUAL_FINRA_PATH} an und paste "
                "die FINRA-Tabelle direkt rein (siehe Beispiel im Header "
                "von _parse_manual_finra)."
            )
            return

    soup = BeautifulSoup(html, "html.parser")

    # Find the *FINRA Margin Statistics* table. The page has several other
    # tables (footnotes, methodology, historical), so we require ALL THREE
    # canonical FINRA columns. We're lenient about how the headers are
    # marked up — `<th>` is most common but FINRA's CMS sometimes renders
    # them as bold `<td>` cells, so we scan the first 3 rows of each table
    # and look at every cell regardless of tag.
    def _header_index(cells_lower, *predicates):
        """Return the first column index whose lowercased text satisfies ALL preds."""
        for i, c in enumerate(cells_lower):
            if all(p(c) for p in predicates):
                return i
        return None

    target_table = None
    col_period = col_debit = col_credit_cash = col_credit_margin = -1

    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if not rows:
            continue
        # Inspect the first up-to-3 rows. Headers usually live in row 0 or 1.
        for header_row in rows[:3]:
            cells = header_row.find_all(["th", "td"])
            if len(cells) < 4:
                continue
            cells_lower = [c.get_text(" ", strip=True).lower() for c in cells]

            debit_idx = _header_index(
                cells_lower,
                lambda c: "debit balances" in c,
                lambda c: "margin" in c,
            )
            credit_cash_idx = _header_index(
                cells_lower,
                lambda c: "free credit" in c,
                lambda c: "cash" in c,
            )
            credit_margin_idx = _header_index(
                cells_lower,
                lambda c: "free credit" in c,
                lambda c: "margin" in c,
            )
            # Same predicate matches both cash + margin credit columns if
            # FINRA only labels the cells "Free Credit Balances 1 / 2". In
            # that case _header_index returns the same index for both —
            # fall through, this isn't our table.
            if (
                debit_idx is None
                or credit_cash_idx is None
                or credit_margin_idx is None
                or credit_cash_idx == credit_margin_idx
            ):
                continue

            period_idx = _header_index(
                cells_lower,
                lambda c: any(k in c for k in ("month", "period", "date")),
            )
            if period_idx is None:
                period_idx = 0

            target_table = table
            col_period = period_idx
            col_debit = debit_idx
            col_credit_cash = credit_cash_idx
            col_credit_margin = credit_margin_idx
            break
        if target_table is not None:
            break

    if target_table is None:
        # Dump the HTML so the user can grep for the right markup.
        debug_path = DEBUG_PATH / "finra_debug.html"
        try:
            _ensure_debug_dir()
            debug_path.write_text(html)
            print(
                f"  ⚠️  FINRA Margin Statistics Tabelle nicht gefunden. "
                f"HTML zum Inspizieren: {debug_path}"
            )
        except Exception:
            print("  ⚠️  FINRA Margin Statistics Tabelle nicht gefunden.")
        return

    print(
        f"  ✓  Tabelle gefunden. Spalten: "
        f"period={col_period}, debit={col_debit}, "
        f"credit_cash={col_credit_cash}, credit_margin={col_credit_margin}"
    )

    max_col = max(col_period, col_debit, col_credit_cash, col_credit_margin)
    rows = []
    for tr in target_table.find_all("tr"):
        tds = tr.find_all("td")
        if not tds or len(tds) <= max_col:
            continue
        period_raw = tds[col_period].get_text(strip=True)
        debit_m  = _finra_to_float(tds[col_debit].get_text(strip=True))
        cash_m   = _finra_to_float(tds[col_credit_cash].get_text(strip=True))
        margin_m = _finra_to_float(tds[col_credit_margin].get_text(strip=True))
        if debit_m is None or not period_raw:
            continue
        # Headline `value` stays in BILLIONS for backward compat with the
        # existing IndicatorCard / classifier; the full *_millions and
        # *_billions fields are what the new MarginStatsTable consumes.
        debit_b  = round(debit_m / 1000.0, 1)
        cash_b   = round(cash_m / 1000.0, 1)   if cash_m   is not None else None
        margin_b = round(margin_m / 1000.0, 1) if margin_m is not None else None
        rows.append({
            "date": _finra_parse_period(period_raw),
            "label": period_raw,                 # raw 'Apr-26' for the table
            "value": debit_b,                    # headline = debit billions
            "debit_millions":         debit_m,
            "credit_cash_millions":   cash_m,
            "credit_margin_millions": margin_m,
            "debit_billions":         debit_b,
            "credit_cash_billions":   cash_b,
            "credit_margin_billions": margin_b,
            "source": "finra.org",
        })

    if not rows:
        print("  ⚠️  Tabelle gefunden, aber keine numerischen Zeilen.")
        return

    rows.sort(key=lambda r: r["date"], reverse=True)
    # 5 years of history: Margin Debt is a slow sentiment-cycle indicator;
    # a 3-year window misses the prior peak which is the reference point
    # for whether we're "frothy" by historical standards.
    rows = rows[:60]
    _write_json("margin_debt_data.json", rows)
    print(
        f"  ✅ Margin Statistics: {len(rows)} Monate, neuester Debit "
        f"${rows[0]['debit_billions']}B / Credit Cash "
        f"${rows[0]['credit_cash_billions']}B / Credit Margin "
        f"${rows[0]['credit_margin_billions']}B ({rows[0]['label']})"
    )


# ===========================================================================
# Phase 5 — CME FedWatch
# ===========================================================================
#
# CME's FedWatch tool publishes the market-implied probability of every
# possible target-rate range for each upcoming FOMC meeting, derived from
# 30-day Fed Funds futures prices.
#
# Source: https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html
#
# The tool is a JS SPA behind Akamai bot protection. We load it with the
# same Playwright stack used for Investing.com, wait for the probability
# table to render, then iterate through the meeting tabs to capture the
# next 5 meetings.
#
# Output shape:
#   [
#     {
#       "meeting_date": "2026-06-18",   # ISO YYYY-MM-DD where parsable
#       "label": "JUN 26",              # raw label as displayed by CME
#       "current_target_range": "4.25-4.50",
#       "fetched_at": "2026-06-03T19:55:00Z",
#       "probabilities": [
#         { "rate": "4.00-4.25", "probability": 0.42 },
#         ...
#       ]
#     },
#     ...
#   ]

CME_FEDWATCH_URL = (
    "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html"
)

# Fallback when CME's stack misbehaves (HTTP/2 protocol error, Akamai block,
# tool redesign breaks our selectors). Investing.com publishes the same
# market-implied FOMC probabilities, and we already successfully scrape
# investing.com elsewhere in this file via Playwright + Cloudflare wait.
INVESTING_FED_RATE_MONITOR_URL = (
    "https://www.investing.com/central-banks/fed-rate-monitor"
)

# Manual override path — same pattern as FINRA. Drop a JSON file here that
# matches the fedwatch_data.json shape (see _phase_fedwatch docstring for
# the schema) and the scraper will use it directly, skipping the live fetch.
MANUAL_FEDWATCH_PATH = SCRIPT_DIR / "manual_fedwatch.json"

# NOTE: we used to pass `--disable-http2 --disable-quic` here to dodge a
# transient ERR_HTTP2_PROTOCOL_ERROR from CME's CDN, but on some Chromium
# builds those flags break the network stack entirely (resulting in
# ERR_TIMED_OUT on subsequent navigations). Stock Chromium is more reliable.
_FEDWATCH_CHROMIUM_ARGS: list[str] = []


def _cme_label_to_iso(label: str) -> str:
    """
    Handles the label formats both sources use:
        CME           : 'JUN 26' / 'NOV 26'           → 2026-06-01
        Investing.com : 'Sep 18, 2025' / 'Sep 17'     → 2025-09-18
    The day is approximate (first of the month if absent), which is fine —
    the frontend renders the raw label too, so the user sees the exact date.
    """
    s = label.strip()
    if not s:
        return ""

    # 'Sep 18, 2025' or 'September 18, 2025'
    m = re.match(r"^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$", s)
    if m and m.group(1).lower() in _FINRA_MONTHS:
        return (
            f"{int(m.group(3)):04d}-"
            f"{_FINRA_MONTHS[m.group(1).lower()]:02d}-"
            f"{int(m.group(2)):02d}"
        )

    # 'MMM YY' (CME)
    m = re.match(r"^([A-Za-z]{3,9})\s+(\d{2})$", s)
    if m and m.group(1).lower() in _FINRA_MONTHS:
        year = 2000 + int(m.group(2))
        return f"{year:04d}-{_FINRA_MONTHS[m.group(1).lower()]:02d}-01"

    # 'MMM YYYY' or 'September 2026'
    m = re.match(r"^([A-Za-z]{3,9})\s+(\d{4})$", s)
    if m and m.group(1).lower() in _FINRA_MONTHS:
        return f"{int(m.group(2)):04d}-{_FINRA_MONTHS[m.group(1).lower()]:02d}-01"

    return ""


def _investing_parse_fedwatch(soup: BeautifulSoup, max_meetings: int = 5):
    """
    Parse Investing.com's Fed Rate Monitor page.

    Structure (verified against the debug HTML):
      - One <table class='fedRateTbl'> per upcoming FOMC meeting, soonest first.
      - Each table is row-per-rate:
            Target Rate        | Current Probability% | Prev Day % | Prev Week %
            '3.25 - 3.50'      | '3.3%'               | '2.9%'     | '0.6%'
            '3.50 - 3.75'      | '96.7%'              | '97.1%'    | '99.4%'
      - The containing `cardBlock` div holds text like
            'Meeting Time: Jun 17, 2026 02:00PM ET ...'
        which we pluck out for `meeting_date` + `label`.

    Returns up to `max_meetings` dicts in our canonical schema.
    """
    fetched_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    # Best-effort current target rate, displayed at the top of the
    # Central Banks side panel: 'FED 3.75% Jun 17, 2026'.
    current_range = ""
    cb_table = soup.find("table", class_="centralBankSideBlockTbl")
    if cb_table:
        text = cb_table.get_text(" ", strip=True)
        m = re.search(r"FED\s+([\d.]+)\s*%", text)
        if m:
            try:
                # Investing.com shows the UPPER bound of the band, e.g.
                # 'FED 3.75%' means the target range is 3.50-3.75 — verified
                # against the next-meeting 'no change' probability column.
                upper = float(m.group(1))
                current_range = f"{upper - 0.25:.2f}-{upper:.2f}"
            except ValueError:
                pass

    out = []
    meeting_date_re = re.compile(
        r"Meeting Time:\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})",
        re.IGNORECASE,
    )

    for table in soup.find_all("table", class_="fedRateTbl"):
        # Walk up to the meeting's card container; that's where the date sits.
        container = table.find_parent("div", class_="cardBlock") or table.parent
        if container is None:
            continue
        date_match = meeting_date_re.search(container.get_text(" ", strip=True))
        if not date_match:
            continue
        label = date_match.group(1)                 # 'Jun 17, 2026'
        meeting_iso = _cme_label_to_iso(label)      # handles this format already

        probs = []
        rows = table.find_all("tr")
        for tr in rows[1:]:  # skip header
            tds = tr.find_all("td")
            if len(tds) < 2:
                continue
            rate_text = tds[0].get_text(strip=True)
            prob_text = tds[1].get_text(strip=True)
            # Validate the rate range; reject anything that isn't 'X.XX - Y.YY'.
            if not re.match(r"^\d+(\.\d+)?\s*[-–]\s*\d+(\.\d+)?$", rate_text):
                continue
            if prob_text in ("—", "-", ""):
                pct = 0.0
            else:
                num = _finra_to_float(prob_text.replace("%", ""))
                if num is None:
                    continue
                pct = num / 100.0
            probs.append({
                "rate": re.sub(r"\s+", "", rate_text),  # '3.50-3.75'
                "probability": round(pct, 4),
            })

        if not probs:
            continue

        out.append({
            "meeting_date": meeting_iso,
            "label": label,
            "current_target_range": current_range,
            "fetched_at": fetched_at,
            "probabilities": probs,
        })
        if len(out) >= max_meetings:
            break

    return out


def _cme_parse_probability_table(soup: BeautifulSoup):
    """
    Walk the rendered DOM for a table that has a header row containing target
    rate ranges (e.g. '375-400', '400-425') and a single data row of
    percentages. CME's exact class names change with redesigns, so we match
    by content rather than by selector.
    """
    for table in soup.find_all("table"):
        ths = [th.get_text(strip=True) for th in table.find_all("th")]
        # Rate-range headers look like '375-400' or '4.00-4.25'
        rate_headers = [
            t for t in ths
            if re.match(r"^\d+(\.\d+)?\s*[-–]\s*\d+(\.\d+)?$", t)
        ]
        if len(rate_headers) < 2:
            continue
        # Data row: pick the first row whose cells are mostly '...%'
        for tr in table.find_all("tr"):
            tds = [td.get_text(strip=True) for td in tr.find_all("td")]
            pct_cells = [c for c in tds if c.endswith("%")]
            if len(pct_cells) >= 2 and len(tds) >= len(rate_headers):
                # Align last len(rate_headers) cells to the headers — CME
                # sometimes prepends a label cell.
                aligned = tds[-len(rate_headers):]
                probs = []
                for header, cell in zip(rate_headers, aligned):
                    pct = _finra_to_float(cell.replace("%", ""))
                    if pct is None:
                        continue
                    probs.append({
                        "rate": header.replace(" ", ""),
                        "probability": round(pct / 100.0, 4),
                    })
                if probs:
                    return probs
    return None


async def _scrape_fedwatch_page(page, url: str, source_label: str, debug_slug: str):
    """Generic FedWatch table scraper. Works against CME or Investing.com —
    both render rate-range headers (e.g. '4.25-4.50') with %-formatted
    probability cells, and our parser matches by content, not selector.

    On every attempt we save the current page HTML to
    server/fedwatch_<slug>_debug.html so the user can inspect what actually
    arrived. This is how we figure out the right selectors / fallback URLs
    when the live page is different from what we expect.

    Retries the navigation once because CDNs occasionally bounce the first
    connection.
    """
    last_err = None
    for attempt in range(1, 3):
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=60000)
            # Let Cloudflare's challenge auto-resolve before checking content
            # — same logic the Investing.com PMI scrape uses. Investing's
            # Fed Rate Monitor fallback URL sits behind the same CF tier.
            await _wait_past_cloudflare(page, max_wait_ms=30000)
            await page.wait_for_function(
                "() => /\\d+\\s*[-–]\\s*\\d+/.test(document.body.innerText)",
                timeout=45000,
            )
            # Success — also dump HTML so we can inspect the live structure
            # (helps tune the table parser without re-running the network).
            try:
                _ensure_debug_dir()
                (DEBUG_PATH / f"fedwatch_{debug_slug}_debug.html").write_text(
                    await page.content()
                )
            except Exception:
                pass
            return source_label
        except Exception as e:
            last_err = e
            title = ""
            try:
                title = (await page.title()) or "(no title)"
            except Exception:
                title = "(unreachable)"
            print(f"    {source_label} attempt {attempt} failed: {e}")
            # Dump whatever HTML we got, even on failure — that's exactly
            # what we want to inspect.
            try:
                _ensure_debug_dir()
                (DEBUG_PATH / f"fedwatch_{debug_slug}_debug.html").write_text(
                    await page.content()
                )
                print(
                    f"    HTML zum Inspizieren: "
                    f"{DEBUG_PATH / f'fedwatch_{debug_slug}_debug.html'} "
                    f"(Titel: '{title}')"
                )
            except Exception:
                pass
        if attempt < 2:
            await asyncio.sleep(5)
    raise RuntimeError(f"{source_label} table never appeared ({last_err})")


async def _scrape_cme_fedwatch():
    """Returns a list of up to 5 meeting dicts; empty list on failure."""
    if not PLAYWRIGHT_AVAILABLE:
        print("  ⚠️  Playwright nicht installiert — übersprungen.")
        return []

    async with async_playwright() as p:
        # Same stealth args we use for Investing.com — even when targeting
        # CME first, the Investing.com fallback hits the same Cloudflare
        # bot-detection that started rejecting plain headless Chromium in
        # mid-2026. _FEDWATCH_CHROMIUM_ARGS is currently empty (see comment
        # by its definition); we merge it with the stealth flags here.
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-sandbox",
                "--disable-features=IsolateOrigins,site-per-process",
                *_FEDWATCH_CHROMIUM_ARGS,
            ],
        )
        try:
            context = await _stealth_context(
                browser, viewport={"width": 1400, "height": 900}
            )
            page = await context.new_page()
            await _apply_stealth_init(page)

            # Try CME first; on any failure (HTTP/2 hiccup, Akamai block,
            # selector drift), fall back to Investing.com's Fed Rate Monitor,
            # which is the same data on a CDN that already works for us.
            source_label = "CME"
            try:
                await _scrape_fedwatch_page(
                    page, CME_FEDWATCH_URL, "CME", "cme"
                )
            except Exception as e:
                print(f"  ⚠️  CME failed ({e}). Falling back to Investing.com.")
                source_label = "Investing.com"
                try:
                    await _scrape_fedwatch_page(
                        page, INVESTING_FED_RATE_MONITOR_URL,
                        "Investing.com", "investing"
                    )
                except Exception as e2:
                    print(f"  ❌ Beide Quellen fehlgeschlagen: {e2}")
                    print(
                        f"  ℹ️  Debug-HTML in {BASE_PATH}. Workaround: "
                        f"lege {MANUAL_FEDWATCH_PATH} an (siehe Schema in "
                        "_phase_fedwatch docstring) und der Scraper benutzt "
                        "das direkt."
                    )
                    return []

            # Investing.com's HTML carries all upcoming meetings in one
            # render — one `<table class='fedRateTbl'>` per meeting. No need
            # to click through tabs. Branch the parser by source.
            if source_label == "Investing.com":
                soup = BeautifulSoup(await page.content(), "html.parser")
                return _investing_parse_fedwatch(soup, max_meetings=5)

            # Discover meeting tab labels. Both sources render them as
            # buttons / tabs / list items. CME uses 'MMM YY' ('JUN 26'),
            # Investing.com uses 'Sep 18, 2025'. Match either pattern.
            labels = await page.evaluate(
                """() => {
                    const patterns = [
                        /^[A-Z]{3,4}\\s+\\d{2}$/,                          // CME 'JUN 26'
                        /^[A-Za-z]{3,9}\\s+\\d{1,2},\\s*\\d{4}$/,          // 'Sep 18, 2025'
                        /^[A-Za-z]{3,9}\\s+\\d{4}$/                        // 'September 2026'
                    ];
                    const seen = new Set();
                    const out = [];
                    document.querySelectorAll(
                        'button, a, [role="tab"], li, span, div'
                    ).forEach((el) => {
                        const t = (el.innerText || '').trim();
                        if (t.length < 5 || t.length > 24) return;
                        if (patterns.some((re) => re.test(t)) && !seen.has(t)) {
                            seen.add(t);
                            out.push(t);
                        }
                    });
                    return out;
                }"""
            )

            meetings = []
            fetched_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

            # First meeting = whatever's selected on landing
            soup = BeautifulSoup(await page.content(), "html.parser")
            probs = _cme_parse_probability_table(soup)
            current_label = labels[0] if labels else ""
            current_range = ""
            # CME shows "Current Target Rate ..." somewhere on the page.
            m = re.search(
                r"[Cc]urrent\s+[Tt]arget\s+[Rr]ate[^0-9]*"
                r"(\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?)",
                soup.get_text(" ", strip=True),
            )
            if m:
                current_range = m.group(1).replace(" ", "")
            if probs:
                meetings.append({
                    "meeting_date": _cme_label_to_iso(current_label),
                    "label": current_label,
                    "current_target_range": current_range,
                    "fetched_at": fetched_at,
                    "probabilities": probs,
                })

            # Now click through the remaining labels (up to 5 total).
            for label in labels[1:5]:
                try:
                    # Click whatever element holds this label.
                    await page.evaluate(
                        """(t) => {
                            const els = Array.from(document.querySelectorAll(
                                'button, a, [role="tab"], li'
                            ));
                            const target = els.find((e) => (e.innerText || '').trim() === t);
                            if (target) target.click();
                        }""",
                        label,
                    )
                    await page.wait_for_timeout(1500)
                    soup = BeautifulSoup(await page.content(), "html.parser")
                    probs = _cme_parse_probability_table(soup)
                    if not probs:
                        print(f"    ⚠️  Keine Probabilities für {label}.")
                        continue
                    meetings.append({
                        "meeting_date": _cme_label_to_iso(label),
                        "label": label,
                        "current_target_range": current_range,
                        "fetched_at": fetched_at,
                        "probabilities": probs,
                    })
                except Exception as e:
                    print(f"    ⚠️  {label}: {e}")

            return meetings
        finally:
            await browser.close()


def _phase_fedwatch() -> None:
    """
    Output schema for `fedwatch_data.json` (and the manual override):

        [
          {
            "meeting_date": "2026-06-18",   # ISO; "" if not parsable
            "label": "JUN 26",              # whatever the source displays
            "current_target_range": "4.25-4.50",
            "fetched_at": "2026-06-06T18:30:00Z",
            "probabilities": [
              { "rate": "4.00-4.25", "probability": 0.42 },
              { "rate": "4.25-4.50", "probability": 0.55 },
              { "rate": "4.50-4.75", "probability": 0.03 }
            ]
          },
          ...
        ]
    """
    print("\n[5/5] CME FedWatch")

    # Step 0 — manual override. If the user has dropped manual_fedwatch.json
    # into the scraping folder, use it directly. Same escape hatch we built
    # for FINRA.
    if MANUAL_FEDWATCH_PATH.exists():
        try:
            data = json.loads(MANUAL_FEDWATCH_PATH.read_text())
            if isinstance(data, list) and data:
                _write_json("fedwatch_data.json", data)
                print(
                    f"  ✅ Manual override: {len(data)} Meeting(s) aus "
                    f"{MANUAL_FEDWATCH_PATH.name}"
                )
                return
            print(f"  ⚠️  {MANUAL_FEDWATCH_PATH.name} ist leer — live scrape.")
        except Exception as e:
            print(f"  ⚠️  {MANUAL_FEDWATCH_PATH.name} unlesbar: {e}")

    meetings = []
    try:
        meetings = asyncio.run(_scrape_cme_fedwatch())
    except Exception as e:
        print(f"  ❌ FedWatch-Scrape fehlgeschlagen: {e}")
        return

    if not meetings:
        print("  ⚠️  Keine Meetings extrahiert.")
        return

    _write_json("fedwatch_data.json", meetings)
    print(
        f"  ✅ FedWatch: {len(meetings)} Meeting(s), "
        f"nächstes = {meetings[0].get('label')} "
        f"({len(meetings[0]['probabilities'])} Raten) → fedwatch_data.json"
    )


# ===========================================================================
# Phase 6 — FRED series (CPI, PPI, DGS10, ...)
# ===========================================================================
#
# Why this lives in the scraper instead of the frontend / a Node proxy:
# GitHub Pages is static-only, so we can't run the Node proxy in production.
# Instead we pre-fetch every FRED series we render and bake them into
# public/data/fred-<series>.json at scrape time. The frontend then loads
# those JSON files like any other static asset — no API key in the browser
# bundle, no rate-limit risk on page load, and the dashboard renders even
# if FRED is down at view time.
#
# The output shape mirrors what FRED's /series/observations endpoint returns,
# so the frontend's existing filter on `value !== '.'` (FRED's marker for
# "no observation that day") keeps working unchanged:
#   [{ "date": "YYYY-MM-DD", "value": "3.21", "realtime_start": ..., ... }]
# We pass through whatever FRED gives us instead of reshaping, partly for
# back-compat and partly so any FRED-added fields (e.g. realtime_start)
# remain available without further code changes.

FRED_API_BASE = "https://api.stlouisfed.org/fred/series/observations"

# (series_id, output_filename, window_months)
# window_months is how far back to fetch. Daily series get 13 (≈ "last year"),
# monthly series get 60 so the dashboard can build longer YoY comparisons
# without re-fetching everything.
FRED_SERIES = [
    # --- Inflation (monthly) ---
    # CPI gets 72m raw so calculateYoY (which loses the first 12m to compute
    # the prior-year baseline) can output a clean 60-month / 5-year YoY
    # series. The dashboard renders the full post-2022 inflation episode
    # including the 9%+ peak, not just the tail.
    ("CPIAUCNS",     "fred-cpi.json",            72),
    ("CPILFENS",     "fred-core-cpi.json",       72),
    ("PPIFIS",       "fred-ppi.json",            60),
    # --- Rates & liquidity ---
    ("FEDFUNDS",     "fred-fedfunds.json",       60),  # monthly
    ("WALCL",        "fred-walcl.json",          60),  # weekly Fed balance sheet
    ("DGS10",        "fred-dgs10.json",          13),  # daily
    ("BAMLH0A0HYM2", "fred-credit-spread.json",  13),  # daily HY OAS
    # --- Labor ---
    ("UNRATE",       "fred-unrate.json",         60),  # monthly
    ("ICSA",         "fred-icsa.json",           13),  # weekly jobless claims
    ("PAYEMS",       "fred-payems.json",         60),  # monthly NFP level
]


def _phase_fred() -> None:
    """Fetch all FRED series we render and write them into public/data/.

    Skips silently (with a warning) if FRED_API_KEY isn't set — useful for
    local development where the user might not have a key configured.
    """
    print("\n[6/7] FRED series")

    key = os.environ.get("FRED_API_KEY") or os.environ.get("VITE_FRED_API_KEY")
    if not key:
        print(
            "  ⚠️  FRED_API_KEY nicht gesetzt — Phase übersprungen. "
            "(In GitHub Actions als Repository Secret eintragen.)"
        )
        return

    today = datetime.date.today()
    headers = {"User-Agent": USER_AGENT}
    ok = failed = 0

    for series_id, filename, window_months in FRED_SERIES:
        start = (today - datetime.timedelta(days=int(window_months * 31))).isoformat()
        end = today.isoformat()
        params = {
            "series_id": series_id,
            "api_key": key,
            "file_type": "json",
            "observation_start": start,
            "observation_end": end,
        }
        try:
            r = requests.get(FRED_API_BASE, params=params, headers=headers, timeout=30)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f"  ❌ {series_id}: {e}")
            failed += 1
            continue

        observations = data.get("observations") or []
        if not observations:
            print(f"  ⚠️  {series_id}: 0 Beobachtungen für {start}..{end}")
            failed += 1
            continue

        # Pass-through write: frontend already knows FRED's shape. We keep
        # the same array-of-observations contract the Node proxy returned,
        # so the only change in src/api/fred.ts is the fetch URL.
        _write_json(filename, observations)
        # Find the most recent observation that has a real value (FRED uses
        # "." for "no observation that day") — useful sanity output.
        latest = next(
            (o for o in reversed(observations) if (o.get("value") or "") != "."),
            None,
        )
        latest_str = (
            f"{latest['date']}={latest['value']}" if latest else "n/a"
        )
        print(
            f"  ✅ {series_id}: {len(observations)} Punkte ({latest_str}) → {filename}"
        )
        ok += 1
        # FRED rate-limits at 120 req/min; we're nowhere near that, but be
        # polite anyway.
        time.sleep(0.2)

    print(f"  → {ok} OK, {failed} fehlgeschlagen.")


# ===========================================================================
# Phase 7 — Yahoo Finance VIX (^VIX)
# ===========================================================================
#
# Why this exists outside the FRED proxy:
# FRED's VIXCLS series is end-of-day-only AND posts with ~1 business day lag.
# A Friday spike doesn't show in FRED until Monday morning, and weekend runs
# see stale data. yfinance hits Yahoo's public quote endpoint, which is
# refreshed within minutes of every EOD close and is good enough for a
# twice-daily refresh.
#
# Output shape mirrors what the rest of the dashboard expects from a FRED
# series so the frontend swap is a 1-line change in src/api/fred.ts:
#     [{ "date": "YYYY-MM-DD", "value": "16.83", "source": "yahoo" }]
# Sorted oldest → newest to match FRED's observation order.

VIX_FILE = "vix_data.json"
VIX_WINDOW_MONTHS = 12  # match the 12M window the dashboard renders


def _phase_vix() -> None:
    print("\n[7/7] Yahoo Finance VIX")

    try:
        import yfinance as yf  # lazy import: don't crash other phases if missing
    except ImportError:
        print(
            "  ❌ yfinance ist nicht installiert. "
            "`pip install yfinance` (oder requirements.txt aktualisieren) "
            "und erneut ausführen."
        )
        return

    end = datetime.date.today()
    # 12 calendar months back; yfinance accepts 'period' shortcuts but we
    # use explicit start/end to mirror the FRED window contract exactly.
    start = end - datetime.timedelta(days=int(VIX_WINDOW_MONTHS * 31))

    try:
        df = yf.download(
            "^VIX",
            start=start.isoformat(),
            end=(end + datetime.timedelta(days=1)).isoformat(),  # inclusive
            interval="1d",
            progress=False,
            auto_adjust=False,
        )
    except Exception as e:
        print(f"  ❌ yfinance-Aufruf fehlgeschlagen: {e}")
        return

    if df is None or df.empty:
        print("  ⚠️  yfinance hat 0 Zeilen geliefert — Quelle vorübergehend leer?")
        return

    # yfinance returns a DataFrame indexed by date with OHLC + Volume columns.
    # We want the daily close. When called with a single ticker the columns
    # are flat ('Close', 'High', ...), but yfinance occasionally returns a
    # MultiIndex even for a single symbol, so we handle both.
    close_series = df["Close"]
    if hasattr(close_series, "columns"):  # MultiIndex DataFrame
        close_series = close_series.iloc[:, 0]

    rows = []
    for ts, val in close_series.dropna().items():
        # ts is a pandas Timestamp; .date() gives a plain date.
        rows.append(
            {
                "date": ts.date().isoformat(),
                "value": f"{float(val):.2f}",  # string to match FRED's shape
                "source": "yahoo",
            }
        )

    if not rows:
        print("  ⚠️  Keine VIX-Close-Werte nach Filterung — nichts geschrieben.")
        return

    rows.sort(key=lambda r: r["date"])  # oldest → newest (FRED-style)
    _write_json(VIX_FILE, rows)
    print(
        f"  ✅ VIX: {len(rows)} Tageswerte ({rows[0]['date']} → "
        f"{rows[-1]['date']}, letzter Close = {rows[-1]['value']}) → {VIX_FILE}"
    )


# ===========================================================================
# Entry point
# ===========================================================================

def main() -> int:
    started = datetime.datetime.now()
    print(f"Defiant Dashboard daily scrape — {started:%Y-%m-%d %H:%M:%S}")
    print(f"Output directory: {BASE_PATH}")

    phases = [
        ("[1/7] Investing.com PMIs",        lambda: asyncio.run(_phase_investing())),
        ("[2/7] ForexFactory consensus",    _phase_forexfactory),
        ("[3/7] Trading Economics fallback", _phase_trading_economics),
        ("[4/7] FINRA margin debt",         _phase_finra_margin),
        ("[5/7] CME FedWatch",              _phase_fedwatch),
        ("[6/7] FRED series",               _phase_fred),
        ("[7/7] Yahoo Finance VIX",         _phase_vix),
    ]

    for label, fn in phases:
        try:
            fn()
        except Exception as e:
            print(f"\n{label} fehlgeschlagen: {e}")

    elapsed = datetime.datetime.now() - started
    print(f"\n🏁 Fertig in {elapsed.total_seconds():.1f}s.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
