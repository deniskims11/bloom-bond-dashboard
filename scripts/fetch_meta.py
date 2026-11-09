#!/usr/bin/env python3
"""Pull Bloom & Bond's numbers straight from the Meta Marketing API, so the
dashboard's Meta-side metrics match Ads Manager instead of Triple Whale's copy.

    META_ACCESS_TOKEN=... python3 scripts/fetch_meta.py [--out raw/]

Both ad accounts, ad level:
  raw/meta_daily.csv   ad_id;date;spend;meta_rev;meta_conv;imps;clk;link_clk;v3s;thru
                       per ad per day, CLEAN_START → today. Revenue / purchases use
                       the account's own attribution setting (7-day click, 1-day view),
                       i.e. exactly what Ads Manager shows.
  raw/meta_ads.tsv     every ad (deleted / archived included): current name, ad set,
                       campaign, account, created time, status, destination URL.
  data/meta_created.json  every published ad with its Meta "Date created" and
                       lifetime spend (replaces the manual Ads Manager export).

Settled days (older than SETTLE_DAYS) are cached between runs in
raw/meta_cache/daily.bin (AES-GCM with the dashboard password; the workflow keeps
it with actions/cache), so each refresh only asks Meta for the recent days.

Never fails the refresh: with no token or an API error it prints a warning,
removes its stale outputs and exits 0, and fetch_tw_sql.py then falls back to
Triple Whale for everything.
"""
import argparse
import json
import os
import pathlib
import sys
import time
from datetime import date, datetime, timedelta, timezone
from urllib import parse, request as urlreq
from urllib.error import HTTPError, URLError

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = "https://graph.facebook.com/v23.0"
ACCOUNTS = {"act_2138674693666259": "SLD Ad Acc 1", "act_1431743774796886": "AD ACC 6"}
CLEAN_START = "2026-04-01"
CHUNK_DAYS = 7
SETTLE_DAYS = 14  # Meta attribution (7-day click) has settled for days older than this
PURCHASE = ("omni_purchase", "offsite_conversion.fb_pixel_purchase", "purchase")
ALL_STATUSES = ["ACTIVE", "PAUSED", "DELETED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED",
                "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ARCHIVED", "ADSET_PAUSED", "IN_PROCESS",
                "WITH_ISSUES"]
# Funnel steps for the Attribution tab (Meta-reported, same attribution as purchases).
LPV = ("landing_page_view", "omni_landing_page_view")
VIEW = ("omni_view_content", "offsite_conversion.fb_pixel_view_content", "view_content")
ATC = ("omni_add_to_cart", "offsite_conversion.fb_pixel_add_to_cart", "add_to_cart")
IC = ("omni_initiated_checkout", "offsite_conversion.fb_pixel_initiate_checkout", "initiate_checkout")
RETRY_CODES = {1, 2, 4, 17, 32, 613, 80000, 80004}


class MetaError(Exception):
    pass


def call(path, token, params=None, method="GET", tries=6):
    params = dict(params or {}, access_token=token)
    url = path if path.startswith("http") else f"{API}/{path}"
    data = None
    if method == "GET":
        url += ("&" if "?" in url else "?") + parse.urlencode(params)
    else:
        data = parse.urlencode(params).encode()
    for attempt in range(tries):
        try:
            with urlreq.urlopen(urlreq.Request(url, data=data, method=method), timeout=300) as r:
                return json.load(r)
        except HTTPError as e:
            body = e.read().decode(errors="replace")
            try:
                err = json.loads(body).get("error", {})
            except ValueError:
                err = {}
            too_big = "reduce the amount of data" in (err.get("message") or "")
            if too_big:
                # Retrying the same request can't help; pages() asks for smaller pages.
                raise MetaError(f"TOO_BIG HTTP {e.code}: {err.get('message')}")
            if (err.get("code") in RETRY_CODES or e.code >= 500) and attempt < tries - 1:
                time.sleep(30 * (attempt + 1))
                continue
            # Never echo the request URL: it carries the token.
            raise MetaError(f"HTTP {e.code}: {err.get('message') or body[:300]}")
        except URLError as e:
            if attempt < tries - 1:
                time.sleep(15 * (attempt + 1))
                continue
            raise MetaError(f"network: {e.reason}")


def pages(path, token, params):
    """All pages of a list call. When Meta says a page is too much data, the same
    page is asked for again at half the size (down to 10 rows)."""
    def fetch(url_or_path, p):
        limit = int(p.get("limit") or 200)
        while True:
            try:
                return call(url_or_path, token, dict(p, limit=limit))
            except MetaError as e:
                if not str(e).startswith("TOO_BIG") or limit <= 10:
                    raise
                limit = max(10, limit // 2)
                print(f"    Meta: page too large, retrying with {limit} rows")
    out = fetch(path, params)
    while True:
        yield from out.get("data", [])
        nxt = (out.get("paging") or {}).get("next")
        if not nxt:
            return
        u = parse.urlsplit(nxt)
        q = dict((k, v) for k, v in parse.parse_qsl(u.query, keep_blank_values=True) if k != "access_token")
        out = fetch(parse.urlunsplit((u.scheme, u.netloc, u.path, "", "")), q)


def report(act, token, params):
    """Async insights job (large ad-level pulls time out synchronously)."""
    job = call(f"{act}/insights", token, dict(params, limit=500), method="POST")
    rid = job["report_run_id"]
    for _ in range(240):
        st = call(rid, token, {"fields": "async_status,async_percent_completion"})
        if st.get("async_status") == "Job Completed":
            return list(pages(f"{rid}/insights", token, {"limit": 500}))
        if st.get("async_status") in ("Job Failed", "Job Skipped"):
            raise MetaError(f"insights job {st.get('async_status')}")
        time.sleep(5)
    raise MetaError("insights job timed out")


def act_val(rows, kinds):
    by = {r.get("action_type"): r.get("value") for r in rows or []}
    for k in kinds:
        if by.get(k) is not None:
            return float(by[k])
    return 0.0


def dest_url(cr):
    """Where the ad sends people: the creative's link (single image / video /
    carousel) or the first URL of a dynamic-creative asset feed."""
    if not cr:
        return ""
    oss = cr.get("object_story_spec") or {}
    for k in ("link_data", "video_data", "template_data"):
        d = oss.get(k) or {}
        link = d.get("link") or ((d.get("call_to_action") or {}).get("value") or {}).get("link")
        if link:
            return link
        for ch in d.get("child_attachments") or []:
            if ch.get("link"):
                return ch["link"]
    for u in (cr.get("asset_feed_spec") or {}).get("link_urls") or []:
        if u.get("website_url"):
            return u["website_url"]
    return cr.get("link_url") or cr.get("object_url") or ""


def fmt(v):
    v = round(float(v or 0), 2)
    return str(int(v)) if v == int(v) else str(v)


def cents(v):
    """Meta budgets come in the account currency's minor unit (cents)."""
    return round(int(v) / 100, 2) if v not in (None, "", "0") else None


def clean(v):
    return str(v or "").replace("\t", " ").replace("\n", " ").replace(";", ",")


def _aes(password):
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        import subprocess
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "cryptography"], check=True)
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    import hashlib
    salt = hashlib.sha256(b"bloom-bond-dashboard/meta-cache/v1").digest()[:16]
    return AESGCM(hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000, 32))


def load_cache(path, start):
    """Cached settled Meta ad-days: (rows, last cached day) or ([], None)."""
    pw = os.environ.get("DASHBOARD_PASSWORD")
    if not (pw and path.exists()):
        return [], None
    try:
        import gzip
        raw = path.read_bytes()
        c = json.loads(gzip.decompress(_aes(pw).decrypt(raw[:12], raw[12:], None)))
        if c.get("start") != start.isoformat() or sorted(c.get("accounts", [])) != sorted(ACCOUNTS):
            return [], None
        return c["rows"], date.fromisoformat(c["until"])
    except Exception as e:  # unreadable cache: pull everything again
        print(f"  Meta cache ignored ({e.__class__.__name__})")
        return [], None


def save_cache(path, start, until, rows):
    pw = os.environ.get("DASHBOARD_PASSWORD")
    if not pw:
        return
    import gzip
    path.parent.mkdir(parents=True, exist_ok=True)
    iv = os.urandom(12)
    body = gzip.compress(json.dumps({"start": start.isoformat(), "until": until.isoformat(),
                                     "accounts": sorted(ACCOUNTS), "rows": rows},
                                    separators=(",", ":")).encode(), 6)
    path.write_bytes(iv + _aes(pw).encrypt(iv, body, None))
    print(f"  Meta cache saved: {len(rows)} settled ad-days through {until}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "raw"))
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    files = [out / "meta_daily.csv", out / "meta_ads.tsv", out / "meta_structure.json"]
    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        print("META_ACCESS_TOKEN not set: Meta-direct metrics skipped, Triple Whale used for everything")
        for f in files:
            f.unlink(missing_ok=True)
        return

    end = datetime.now(timezone.utc).date()
    start = date.fromisoformat(CLEAN_START)
    cache_path = out / "meta_cache" / "daily.bin"
    cached, cached_until = load_cache(cache_path, start)
    fetch_from = cached_until + timedelta(days=1) if cached_until else start
    print(f"  Meta daily: {len(cached)} cached ad-days through {cached_until}, pulling {fetch_from} → {end}"
          if cached_until else f"  Meta daily: no cache, pulling {start} → {end}")
    try:
        ads, daily, lifetime = {}, [], {}
        for act, label in ACCOUNTS.items():
            n0 = len(ads)
            for r in pages(f"{act}/ads", token, {
                    "fields": "id,name,created_time,effective_status,adset{id,name},campaign{id,name},"
                              "creative{object_story_spec,asset_feed_spec,link_url,object_url}",
                    "filtering": json.dumps([{"field": "effective_status", "operator": "IN", "value": ALL_STATUSES}]),
                    "limit": 200}):
                ads[r["id"]] = {
                    "name": r.get("name", ""), "adset": (r.get("adset") or {}).get("name", ""),
                    "campaign": (r.get("campaign") or {}).get("name", ""), "account": act.split("_")[1],
                    "created": (r.get("created_time") or "")[:10], "status": r.get("effective_status", ""),
                    "adset_id": (r.get("adset") or {}).get("id", ""), "campaign_id": (r.get("campaign") or {}).get("id", ""),
                    "url": dest_url(r.get("creative")),
                }
            print(f"  {label}: {len(ads) - n0} ads")
            for r in report(act, token, {"level": "ad", "date_preset": "maximum", "fields": "ad_id,spend"}):
                lifetime[r["ad_id"]] = lifetime.get(r["ad_id"], 0.0) + float(r.get("spend") or 0)
            d = fetch_from
            while d <= end:
                ce = min(d + timedelta(days=CHUNK_DAYS - 1), end)
                rows = report(act, token, {
                    "level": "ad", "time_increment": 1, "use_unified_attribution_setting": "true",
                    "time_range": json.dumps({"since": d.isoformat(), "until": ce.isoformat()}),
                    "fields": "ad_id,spend,impressions,inline_link_clicks,outbound_clicks,actions,"
                              "action_values,video_thruplay_watched_actions"})
                for r in rows:
                    daily.append([r["ad_id"], r["date_start"], float(r.get("spend") or 0),
                                  act_val(r.get("action_values"), PURCHASE), act_val(r.get("actions"), PURCHASE),
                                  float(r.get("impressions") or 0), act_val(r.get("outbound_clicks"), ("outbound_click",)),
                                  float(r.get("inline_link_clicks") or 0), act_val(r.get("actions"), ("video_view",)),
                                  act_val(r.get("video_thruplay_watched_actions"), ("video_view",)),
                                  act_val(r.get("actions"), LPV), act_val(r.get("actions"), VIEW),
                                  act_val(r.get("actions"), ATC), act_val(r.get("actions"), IC)])
                print(f"  {label} {d} → {ce}: {len(rows)} ad-days")
                d = ce + timedelta(days=1)
    except (MetaError, KeyError) as e:
        print(f"WARNING Meta API failed ({e}): Triple Whale used for everything this refresh")
        for f in files:
            f.unlink(missing_ok=True)
        return
    fresh = {(r[0], r[1]) for r in daily}
    daily = [r for r in cached if (r[0], r[1]) not in fresh] + daily
    settled_until = end - timedelta(days=SETTLE_DAYS + 1)
    if settled_until >= start:
        save_cache(cache_path, start, settled_until, [r for r in daily if r[1] <= settled_until.isoformat()])
    if not daily:
        print("WARNING Meta returned no rows: Triple Whale used for everything this refresh")
        for f in files:
            f.unlink(missing_ok=True)
        return

    with open(out / "meta_daily.csv", "w") as fh:
        fh.write("ad_id;date;spend;meta_rev;meta_conv;imps;clk;link_clk;v3s;thru;lpv;view;atc;ic\n")
        for r in sorted(daily, key=lambda r: (r[0], r[1])):
            fh.write(";".join([r[0], r[1]] + [fmt(x) for x in r[2:]]) + "\n")
    with open(out / "meta_ads.tsv", "w") as fh:
        cols = ["ad_id", "name", "adset", "campaign", "account", "created", "status", "url"]
        fh.write("\t".join(cols) + "\n")
        for i, x in ads.items():
            fh.write("\t".join([i] + [clean(x[c]) for c in cols[1:]]) + "\n")
    # Campaign / ad set budgets and on-off status for the Attribution tab (read-only;
    # a failure here only drops budgets, never the rest of the Meta pull).
    camps, adsets = {}, {}
    try:
        for act in ACCOUNTS:
            for r in pages(f"{act}/campaigns", token, {
                    "fields": "id,name,effective_status,daily_budget,lifetime_budget", "limit": 200}):
                camps[r["id"]] = {"name": r.get("name", ""), "status": r.get("effective_status", ""),
                                  "daily_budget": cents(r.get("daily_budget")), "lifetime_budget": cents(r.get("lifetime_budget"))}
            for r in pages(f"{act}/adsets", token, {
                    "fields": "id,name,campaign_id,effective_status,daily_budget,lifetime_budget", "limit": 200}):
                adsets[r["id"]] = {"name": r.get("name", ""), "campaign_id": r.get("campaign_id", ""),
                                   "status": r.get("effective_status", ""),
                                   "daily_budget": cents(r.get("daily_budget")), "lifetime_budget": cents(r.get("lifetime_budget"))}
        print(f"  structure: {len(camps)} campaigns · {len(adsets)} ad sets")
    except (MetaError, KeyError) as e:
        print(f"WARNING Meta budgets skipped ({e})")
    (out / "meta_structure.json").write_text(json.dumps({
        "campaigns": camps, "adsets": adsets,
        "ads": {i: {"adset_id": x["adset_id"], "campaign_id": x["campaign_id"], "status": x["status"],
                    "adset": x["adset"], "campaign": x["campaign"], "name": x["name"], "account": x["account"]}
                for i, x in ads.items()}}, separators=(",", ":")))
    # Same shape as the old Ads Manager export (scripts/meta_created.py): published
    # ads only; a deleted ad counts only if it delivered.
    mc = [{"n": x["name"].strip(), "a": "act_" + x["account"], "c": x["created"], "s": round(lifetime.get(i, 0.0), 2)}
          for i, x in ads.items() if x["created"] and (x["status"] != "DELETED" or lifetime.get(i))]
    (ROOT / "data" / "meta_created.json").write_text(json.dumps(
        {"source": "Meta Marketing API, ad level (created_time, lifetime spend)",
         "export_end": end.isoformat(), "ads": mc}, separators=(",", ":")))
    sp = sum(r[2] for r in daily)
    print(f"Meta: {len(ads)} ads · {len(daily)} ad-days · spend ${sp:,.0f} since {start} · {len(mc)} ads in meta_created.json")


if __name__ == "__main__":
    main()
