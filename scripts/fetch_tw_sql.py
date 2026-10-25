#!/usr/bin/env python3
"""Pull every input the Bloom & Bond build needs from the Triple Whale SQL API,
so the dashboard refreshes unattended.

    TW_API_KEY=... python3 scripts/fetch_tw_sql.py [--out raw/]

Window: CLEAN_START (the first day Triple Whale's per-ad data is complete for
both ad accounts, incl. new-customer attribution) through today, capped at
MAX_DAYS. Pixel / new-customer figures use Triple Attribution + Views, 7-day
window; Meta's own 7DC/1DV numbers are the channel_reported_* columns.

Writes raw/tw_ads.tsv, raw/tw_weekly.csv and raw/tw_daily.csv in the formats
scripts/build.py reads, then runs the build.

API: POST /api/v2/orcabase/api/sql, header x-api-key; the response is a bare
JSON array of row objects ({"data": [...]} also handled).
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from urllib import request as urlreq
from urllib.error import HTTPError

# Checkout fix (Adam, Oct 21 call): pixel matches Meta from this day on.
PIXEL_FIX = "2026-10-19"
API = "https://api.triplewhale.com/api/v2/orcabase/api/sql"
SHOP = "6f36e3-2.myshopify.com"
CLEAN_START = "2026-09-05"
MAX_DAYS = 180
LAUNCH_LOOKBACK = "2025-01-01"
CHUNK_DAYS = 7
ROOT = pathlib.Path(__file__).resolve().parent.parent
# Closest Triple Whale lens to Meta's 7-day click / 1-day view. The model and
# window must be named explicitly: without them the SQL API silently returns
# only the default (lifetime) rows.
WHERE = ("channel = 'facebook-ads' AND model = 'Triple Attribution + Views' "
         "AND attribution_window = '7_days'")
DAILY = ["spend", "meta_rev", "meta_conv", "nc_rev", "nc_orders", "nv", "vis", "imps", "clk", "px_rev", "px_orders"]


def sql(query, start, end, key, tries=4):
    body = json.dumps({"shopId": SHOP, "query": query,
                       "period": {"startDate": start, "endDate": end}}).encode()
    req = urlreq.Request(API, data=body, method="POST", headers={
        "x-api-key": key, "content-type": "application/json", "accept": "application/json",
        "user-agent": "Mozilla/5.0 (bloom-bond-dashboard refresh)"})
    for attempt in range(tries):
        try:
            with urlreq.urlopen(req, timeout=300) as r:
                data = json.load(r)
            if isinstance(data, dict):
                data = data.get("data") or data.get("rows") or []
            return data
        except HTTPError as e:
            msg = e.read().decode(errors="replace")[:500]
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(15 * (attempt + 1))
                continue
            sys.exit(f"Triple Whale SQL API {e.code}: {msg}")
    return []


def f(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def fmt(v):
    v = round(f(v), 2)
    return str(int(v)) if v == int(v) else str(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "raw"))
    ap.add_argument("--no-build", action="store_true")
    a = ap.parse_args()
    key = os.environ.get("TW_API_KEY")
    if not key:
        sys.exit("TW_API_KEY is not set")

    end = datetime.now(timezone.utc).date()
    start = max(date.fromisoformat(CLEAN_START), end - timedelta(days=MAX_DAYS - 1))
    s, e = start.isoformat(), end.isoformat()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    print(f"window {s} → {e}")

    daily = []
    d = start
    while d <= end:
        ce = min(d + timedelta(days=CHUNK_DAYS - 1), end)
        rows = sql(f"""
            SELECT ad_id, toString(event_date) AS d,
                   sum(spend) AS spend, sum(channel_reported_conversion_value) AS meta_rev,
                   sum(channel_reported_conversions) AS meta_conv,
                   sum(new_customer_order_revenue) AS nc_rev, sum(new_customer_orders) AS nc_orders,
                   sum(new_visitors) AS nv, sum(unique_visitors) AS vis,
                   sum(impressions) AS imps, sum(outbound_clicks) AS clk,
                   sum(order_revenue) AS px_rev, sum(orders_quantity) AS px_orders
            FROM pixel_joined_tvf()
            WHERE {WHERE} AND event_date BETWEEN '{d}' AND '{ce}'
            GROUP BY ad_id, d
            HAVING spend > 0 OR meta_rev > 0 OR px_rev > 0""", d.isoformat(), ce.isoformat(), key)
        print(f"  daily {d} → {ce}: {len(rows)} rows")
        daily += rows
        d = ce + timedelta(days=1)

    meta = sql(f"""
        SELECT ad_id, argMax(ad_name, event_date) AS ad_name, argMax(adset_name, event_date) AS adset,
               argMax(campaign_name, event_date) AS campaign, toString(argMax(account_id, event_date)) AS account
        FROM pixel_joined_tvf()
        WHERE {WHERE} AND event_date BETWEEN '{s}' AND '{e}' AND spend > 0
        GROUP BY ad_id""", s, e, key)
    launch = sql(f"""
        SELECT ad_id, toString(minIf(event_date, spend > 0)) AS first_day,
               argMaxIf(ad_image_url, event_date, ad_image_url != '') AS image_url
        FROM pixel_joined_tvf()
        WHERE {WHERE} AND event_date BETWEEN '{LAUNCH_LOOKBACK}' AND '{e}'
          AND ad_id IN (SELECT DISTINCT ad_id FROM pixel_joined_tvf()
                        WHERE {WHERE} AND event_date BETWEEN '{s}' AND '{e}' AND spend > 0)
        GROUP BY ad_id""", LAUNCH_LOOKBACK, e, key)
    print(f"  ads {len(meta)} · launch {len(launch)}")

    # Corrected NC (Meta only). Until the checkout fix on PIXEL_FIX the TW pixel
    # missed part of Meta's orders, so its new-customer numbers run low. Per day,
    # scale pixel NC by Meta-reported ÷ pixel revenue (orders for NC orders) on
    # the Meta channel itself — the pixel's new-vs-returning split is kept, no
    # other channel's revenue is borrowed. From PIXEL_FIX on, pixel is used as is.
    per_day = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])
    for r in daily:
        t = per_day[r["d"][:10]]
        t[0] += f(r["meta_rev"]); t[1] += f(r["px_rev"]); t[2] += f(r["meta_conv"]); t[3] += f(r["px_orders"])
    with open(out / "tw_nc_adjust.csv", "w") as fh:
        fh.write("date;factor;order_factor;meta_rev;pixel_rev\n")
        for dte, (mr, pr, mc, po) in sorted(per_day.items()):
            pre = dte < PIXEL_FIX
            fac = min(3.0, max(1.0, mr / pr)) if (pre and pr) else 1.0
            ofac = min(3.0, max(1.0, mc / po)) if (pre and po) else 1.0
            fh.write(f"{dte};{fac:.4f};{ofac:.4f};{mr:.2f};{pr:.2f}\n")
    if not daily or not meta:
        sys.exit("Triple Whale returned no rows — refusing to overwrite the dashboard")

    by_ad = defaultdict(list)
    for r in daily:
        by_ad[str(r["ad_id"])].append(r)
    names = {str(r["ad_id"]): r for r in meta}
    first = {str(r["ad_id"]): r for r in launch}

    with open(out / "tw_daily.csv", "w") as fh:
        fh.write("ad_id;date;" + ";".join(DAILY) + "\n")
        for r in sorted(daily, key=lambda r: (str(r["ad_id"]), r["d"])):
            fh.write(";".join([str(r["ad_id"]), r["d"][:10]] + [fmt(r[k]) for k in DAILY]) + "\n")

    wk = defaultdict(lambda: [0.0] * 5)
    for r in daily:
        dd = date.fromisoformat(r["d"][:10])
        v = wk[(str(r["ad_id"]), (dd - timedelta(days=dd.weekday())).isoformat())]
        for j, k in enumerate(["spend", "meta_rev", "meta_conv", "nc_rev", "nc_orders"]):
            v[j] += f(r[k])
    with open(out / "tw_weekly.csv", "w") as fh:
        fh.write("ad_id;week;spend;meta_rev;meta_conv;nc_rev;nc_orders\n")
        for (ad, w), v in sorted(wk.items()):
            fh.write(";".join([ad, w] + [fmt(x) for x in v]) + "\n")

    cols = ["ad_id", "ad_name", "adset_name", "campaign_name", "account_id", "spend", "impressions", "clicks",
            "meta_rev", "meta_conv", "pixel_rev", "pixel_orders", "nc_rev", "nc_orders", "new_visitors",
            "visitors", "first_day", "spend_d14", "nc_rev_d14", "image_url"]
    clean = lambda v: str(v or "").replace("\t", " ").replace("\n", " ")
    with open(out / "tw_ads.tsv", "w") as fh:
        fh.write("\t".join(cols) + "\n")
        for ad, rs in by_ad.items():
            t = {k: sum(f(x[k]) for x in rs) for k in DAILY}
            if t["spend"] <= 0:
                continue
            n, l = names.get(ad, {}), first.get(ad, {})
            fd = (l.get("first_day") or "")[:10]
            s14 = n14 = 0.0
            if fd and fd >= s:  # day 0–13 only knowable when the launch is inside the window
                cut = (date.fromisoformat(fd) + timedelta(days=13)).isoformat()
                for x in rs:
                    if x["d"][:10] <= cut:
                        s14 += f(x["spend"]); n14 += f(x["nc_rev"])
            fh.write("\t".join([ad, clean(n.get("ad_name") or ad), clean(n.get("adset")), clean(n.get("campaign")),
                                clean(n.get("account"))] +
                               [fmt(t[k]) for k in ("spend", "imps", "clk", "meta_rev", "meta_conv", "px_rev",
                                                    "px_orders", "nc_rev", "nc_orders", "nv", "vis")] +
                               [fd, fmt(s14), fmt(n14), clean(l.get("image_url"))]) + "\n")

    print(f"spend ${sum(f(r['spend']) for r in daily):,.0f} across {len(by_ad)} ads")
    if not a.no_build:
        subprocess.run([sys.executable, str(ROOT / "scripts" / "build.py"), str(out / "tw_ads.tsv"),
                        str(out / "tw_weekly.csv"), s, e, str(out / "tw_daily.csv"), str(out / "tw_nc_adjust.csv")], check=True)


if __name__ == "__main__":
    main()
