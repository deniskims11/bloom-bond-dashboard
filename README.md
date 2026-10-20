# Bloom & Bond — Creative Performance Dashboard

Ad-level creative performance for Bloom & Bond, built entirely from Triple Whale
(shop `6f36e3-2.myshopify.com`, both Meta ad accounts).

## How it refreshes

`.github/workflows/deploy-pages.yml` runs every 4 hours, on every push and on
manual "Run workflow". It calls `scripts/fetch_tw_sql.py`, which queries the
Triple Whale SQL API (`POST /api/v2/orcabase/api/sql`, header `x-api-key`,
repo secret `TW_API_KEY`) and writes `raw/tw_ads.tsv`, `raw/tw_weekly.csv` and
`raw/tw_daily.csv`; `scripts/build.py` turns them into `public/data/latest.json`
and Pages publishes the build. No data is committed.

## Data rules

- Window starts **2026-09-05** (`CLEAN_START`): before that Triple Whale's per-ad
  data is incomplete (second ad account missing until Sep 3, a $0 week in July,
  no per-ad new-customer data until Sep 5). It grows to at most 180 days.
- Revenue / ROAS / purchases: Meta-reported, 7-day click / 1-day view
  (`channel_reported_*`).
- New-customer revenue / NCROAS, pixel revenue, new-visitor share: Triple Whale
  pixel, Triple Attribution, lifetime window (the only window with per-ad data
  for this shop).
- The date picker re-totals every metric from daily rows ("spend in period");
  win rates stay launch-cohort based.

## Naming

New convention codes come from the definition sheet (`data/definitions.csv`);
old key:value names (`LP:…_PC:…_AG:{…}`) are mapped onto it via
`data/legacy_map.json`.

## Local

```bash
TW_API_KEY=... python3 scripts/fetch_tw_sql.py
npm ci && npm run dev
```
