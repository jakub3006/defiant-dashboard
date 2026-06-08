# Defiant Dashboard

A static, AI-free macro dashboard. US inflation, labor and financial-conditions
indicators on one page. Refreshes itself twice a day via GitHub Actions.

- **Live:** https://gatekeeperdesk.com _(set up below)_
- **Stack:** React + TypeScript + Vite (frontend) · Python + Playwright (scrapers)
- **Hosting:** GitHub Pages + Cloudflare DNS — fully static, no server, no API keys in the browser
- **Data flow:** [DATA_PIPELINE.md](./DATA_PIPELINE.md)

## Architecture in 30 seconds

The Python scraper (`scraping/daily_scrape.py`) pulls everything we render
— Investing.com PMIs, ForexFactory consensus, FINRA margin debt, CME
FedWatch, every FRED series we use, and ^VIX from Yahoo — and writes JSON
files into `public/data/`. Vite ships those files as static assets. The
frontend just `fetch()`s them. No backend.

A GitHub Actions cron runs the scraper twice daily (12:00 + 22:00 UTC),
commits the refreshed JSON back to the repo, rebuilds the site, and
deploys it to Pages.

## Deploy to GitHub Pages (first-time setup)

1. **Create the repo on GitHub.** Name it `defiant-dashboard` so the
   `BASE_PATH` in `.github/workflows/deploy.yml` matches without edits.
   If you pick a different name, change `BASE_PATH: /<name>/` to match.

2. **Push this folder to it.**
   ```bash
   git init
   git remote add origin git@github.com:<your-user>/defiant-dashboard.git
   git add .
   git commit -m "chore: initial commit"
   git branch -M main
   git push -u origin main
   ```

3. **Enable GitHub Pages.** Repo → Settings → Pages →
   _Build and deployment_ → **Source: GitHub Actions**.
   (No branch selection — the workflow handles uploads via the
   `actions/deploy-pages` action.)

4. **Add the FRED API key as a secret.** Repo → Settings →
   Secrets and variables → Actions → **New repository secret**:
   - Name: `FRED_API_KEY`
   - Value: your key from https://fred.stlouisfed.org/docs/api/api_key.html

5. **Wire up the custom domain.** See the next section. Do this before
   the first workflow run so HTTPS provisioning kicks in immediately.

6. **Trigger the first run.** Actions tab → "Scrape data and deploy to
   GitHub Pages" → **Run workflow** → main → Run. First run takes ~5
   minutes (mostly Playwright + Chromium install). Subsequent runs are
   cached and finish in ~2 minutes.

7. **Open the site.** Once the workflow completes and DNS propagates
   (usually <1h), the dashboard is live at https://gatekeeperdesk.com.

After this, the workflow runs on its own twice a day. No further action
needed unless you change the code or want to refresh data manually
(click "Run workflow" any time).

## Custom domain (gatekeeperdesk.com)

The repo already includes `public/CNAME` so GitHub Pages knows which
domain to bind. You just need to point DNS at it.

### Cloudflare DNS records

Once the domain is registered (Cloudflare → Domain Registration), open
the **DNS** tab and add these records:

| Type  | Name | Content                       | Proxy status |
| ----- | ---- | ----------------------------- | ------------ |
| A     | @    | 185.199.108.153               | DNS only ⚪  |
| A     | @    | 185.199.109.153               | DNS only ⚪  |
| A     | @    | 185.199.110.153               | DNS only ⚪  |
| A     | @    | 185.199.111.153               | DNS only ⚪  |
| CNAME | www  | &lt;your-github-user&gt;.github.io | DNS only ⚪  |

> **Important:** Set proxy status to **DNS only** (grey cloud), not
> proxied (orange). GitHub Pages issues its Let's Encrypt cert via the
> Apex domain; Cloudflare's proxy interferes with the ACME challenge
> until the cert is provisioned. Once HTTPS is green in GitHub, you can
> optionally flip to proxied (orange) with SSL/TLS mode = Full strict.

### GitHub Pages binding

After adding the DNS records:

1. Repo → Settings → Pages → **Custom domain** → enter
   `gatekeeperdesk.com` → Save.
2. GitHub runs a DNS check (usually green within 5 minutes). If it stays
   red, wait — propagation can take up to 1 hour.
3. Once the check is green, tick **Enforce HTTPS** (might be greyed out
   for ~30min while Let's Encrypt issues the cert).

After that, both `gatekeeperdesk.com` and `www.gatekeeperdesk.com`
resolve to the dashboard; GitHub automatically redirects www → apex.

## Local development

```bash
# Frontend dev server (auto-reloads on changes to src/)
npm install
npm run dev
# Open http://localhost:5173

# Refresh data locally — needs FRED_API_KEY in .env (or as env var)
cd scraping
pip install -r requirements.txt
python -m playwright install chromium
cd ..
python scraping/daily_scrape.py
```

Vite's dev server serves `public/data/` directly at `/data/*.json`, so the
exact same fetch URLs work in dev and prod.

## Files of note

| Path | What it does |
| --- | --- |
| `scraping/daily_scrape.py` | All seven scrape phases. Single entry point. |
| `scraping/debug/` | HTML dumps when Playwright selectors break. Gitignored. |
| `public/data/*.json` | The data the frontend reads. Committed; refreshed by Actions. |
| `src/api/fred.ts` | Thin fetcher — each function loads one JSON file. |
| `src/App.tsx` | Card layout + classifiers (what's "normal/stressed" per indicator). |
| `.github/workflows/deploy.yml` | Cron + scrape + build + deploy in one workflow. |
| `vite.config.ts` | `BASE_PATH` env var → Vite `base` for the Pages subpath. |
