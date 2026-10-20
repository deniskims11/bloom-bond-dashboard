#!/usr/bin/env python3
"""Build the Bloom & Bond dashboard manifest from Triple Whale SQL-editor exports.

Everything comes from Triple Whale (no direct Meta access):

  raw/bb_tw_ads_<range>.tsv   one row per Meta ad (tab-separated, header row):
      ad_id ad_name adset_name campaign_name account_id spend impressions clicks
      meta_rev meta_conv pixel_rev pixel_orders nc_rev nc_orders new_visitors
      visitors first_day spend_d14 nc_rev_d14 image_url
  raw/bb_tw_weekly.csv        ad_id;week;spend;meta_rev;meta_conv;nc_rev;nc_orders

Lenses (both stated in the UI):
  * Revenue / ROAS / purchases = Meta-reported (channel_reported_*), i.e. Meta's own
    7-day click / 1-day view attribution as synced into Triple Whale.
  * New-customer revenue / orders, % new, new visitors = Triple Whale pixel,
    Triple Attribution, lifetime window (the only window TW computes per ad for
    this shop).

Two naming conventions are parsed:
  * NEW (definition sheet, data/definitions.csv):
      AdID_Product_Concept_Reason_Angle_Avatar_Script_Type_Format_Origin_Awareness_
      Writer_Editor_URL_FBPage_LaunchDate   (codes, e.g. HL / GLP / DHT / VID / IDE)
  * OLD key:value tags: LP:…_B_<no>_<product>_<format>_<desc>_PC:_OR:_LN:_AV:_SOA:_
      AG:{tag},{tag}_ST:_FR:_DES:_CS:_WR:_ED:_CR:   mapped onto the new sheet's
      Concept / Reason / Angle via data/legacy_map.json.
"""
import csv
import gzip
import json
import pathlib
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
MATURE_DAYS = 14
FUNNEL_OF = {"Unaware": "TOF", "Problem Aware": "TOF", "Solution Aware": "MOF",
             "Product Aware": "BOF", "Most Aware": "BOF"}
AWARENESS = ["Unaware", "Problem Aware", "Solution Aware", "Product Aware", "Most Aware"]


def norm_awareness(v):
    """'SolutionAware' (sheet) and 'Solution Aware' (old names) -> 'Solution Aware'."""
    key = (v or "").replace(" ", "").lower()
    return next((a for a in AWARENESS if a.replace(" ", "").lower() == key), v or None)


COPY_RE = re.compile(r"\s*[-–]\s*Copy(\s*\d+)?\s*$", re.I)


def num(v):
    try:
        return float(v) if v not in (None, "", "null") else 0.0
    except ValueError:
        return 0.0


def clean(name):
    name = (name or "").strip()
    while COPY_RE.search(name):
        name = COPY_RE.sub("", name).strip()
    return name


# ---------------------------------------------------------------- definitions
def load_definitions(path):
    """{section: {code: name}} plus {section: {name_lower: name}} from the sheet."""
    rows = list(csv.reader(open(path, encoding="utf-8")))
    head, sub = rows[0], rows[1]
    codes, names = {}, {}
    for i, h in enumerate(head):
        if "OVERVIEW" not in (h or ""):
            continue
        sec = h.replace(" · OVERVIEW", "").strip().lower()
        ci = next((j for j in range(i + 1, len(sub)) if "Code" in sub[j]), None)
        codes[sec], names[sec] = {}, {}
        for r in rows[2:]:
            nm = (r[i] if i < len(r) else "").strip()
            cd = (r[ci] if ci is not None and ci < len(r) else "").strip()
            if nm:
                names[sec][nm.lower()] = nm
                if cd:
                    codes[sec][cd.upper()] = nm
    return codes, names


def parse_new(name, codes):
    """New convention, '_'-separated, codes resolved through the definition sheet."""
    t = [x.strip() for x in name.split("_")]
    if len(t) < 11:
        return None
    type_codes = codes.get("type", {})
    if t[7].upper() not in type_codes or t[9].upper() not in codes.get("origin", {}):
        return None
    look = lambda sec, v: codes.get(sec, {}).get((v or "").upper(), v or None)
    aw = t[10]
    aw_name = next((n for c, n in codes.get("awareness stage", {}).items()
                    if c == aw.upper() or n.replace(" ", "").lower() == aw.replace(" ", "").lower()), aw)
    return {
        "creative_no": t[0] or None, "product": t[1] or None,
        "concept": look("concepts", t[2]), "reason": look("reason", t[3]),
        "angle": look("angles", t[4]), "avatar": t[5] or None, "script": t[6] or None,
        "type": look("type", t[7]), "format": look("formats", t[8]),
        "origin": look("origin", t[9]), "awareness_stage": aw_name,
        "writer": t[11] if len(t) > 11 and t[11] else None,
        "editor": t[12] if len(t) > 12 and t[12] else None,
        "landing_page": t[13] if len(t) > 13 and t[13] else None,
    }


TAG_RE = re.compile(r"(?:^|_)(LP|PC|OR|LN|AV|SOA|AG|ST|FR|DES|CS|WR|ED|CR):")


def parse_old(name, legacy):
    """Old key:value convention."""
    if "SOA:" not in name and "AG:" not in name:
        return None
    parts = TAG_RE.split(name)
    # parts = [prefix, key, value, key, value, ...]
    tags = {}
    for k, v in zip(parts[1::2], parts[2::2]):
        tags.setdefault(k, v.strip(" _"))
    who = lambda v: (v or "").lstrip("@").strip() or None

    # LP value holds the landing page and, after it, _B_<creative no>_<product>_<format>_<desc>
    lp_raw = tags.get("LP", "")
    m = re.match(r"(.*?)_B_([^_]+)_([^_]+)_([^_]+)_?(.*)$", lp_raw)
    lp, creative_no, product, fmt, desc = (m.groups() if m else (lp_raw, None, None, None, None))
    lp = (lp or "").split("|")[0].strip() or None
    if lp and lp.startswith("B_"):  # creative-number block landed in the LP slot
        lp = None
    if product and re.fullmatch(r"[.\d]*PSO[.\d]*", product):  # ".1PSO", "PSO.2" -> PSO
        product = "PSO"

    ag_raw = tags.get("AG", "")
    ag = [x.strip() for x in re.findall(r"\{([^}]*)\}", ag_raw)] or ([ag_raw.strip()] if ag_raw.strip() else [])
    first = lambda field: next((legacy[field][a] for a in ag if a in legacy.get(field, {})), None)
    concept = first("concept") or ("Hair Loss" if product and product.upper().startswith("PSO") else None)
    fmt_l = (fmt or "").lower()
    typ = "Image" if fmt_l.startswith("image") or "static" in fmt_l else \
          "Native" if "native" in fmt_l else ("Video" if fmt else None)
    return {
        "creative_no": creative_no, "product": product,
        "concept": concept, "reason": first("reason") or "General",
        # Fall back to the first raw tag that isn't already a Concept / Reason
        # (e.g. {GLP-1} is a Reason on the new sheet, not an angle).
        "angle": first("angle") or next((a for a in ag if a not in legacy.get("reason", {})
                                         and a not in legacy.get("concept", {})), None)
                 or ("Offer" if any(a in ("Offer", "Bottom of Funnel") for a in ag) else None),
        "angle_tags": ag or None,
        "avatar": (tags.get("AV") or "").lstrip("@").strip() or None,
        "script": (desc or "").strip() or None, "type": typ,
        "format": legacy.get("format", {}).get(fmt, fmt),
        "origin": tags.get("OR") or None, "awareness_stage": tags.get("SOA") or None,
        "length": (tags.get("LN") or "").replace("Short-From", "Short-Form") or None,
        "persuasion": tags.get("PC") or None, "static_type": (tags.get("ST") or "").rstrip("+") or None,
        "strategist": who(tags.get("CS")), "writer": who(tags.get("WR")), "editor": who(tags.get("ED")),
        "landing_page": lp,
    }


# ---------------------------------------------------------------- build
def build(ads_path, weekly_path, defs_path, legacy_path, start, end, daily_path=None):
    codes, _ = load_definitions(defs_path)
    legacy = json.loads(pathlib.Path(legacy_path).read_text())
    rows = list(csv.DictReader(open(ads_path, encoding="utf-8"), delimiter="\t"))

    weekly = defaultdict(list)
    if weekly_path and pathlib.Path(weekly_path).exists():
        lines = pathlib.Path(weekly_path).read_text().splitlines()
        cols = lines[0].split(";")
        for l in lines[1:]:
            if l.strip():
                weekly[l.split(";")[0]].append(dict(zip(cols, l.split(";"))))
    weeks = sorted({r["week"] for rs in weekly.values() for r in rs})
    widx = {w: i for i, w in enumerate(weeks)}

    # Daily per-ad rows (fetch_tw_sql.py): let the UI re-total any date range.
    daily = defaultdict(list)
    if daily_path and pathlib.Path(daily_path).exists():
        lines = pathlib.Path(daily_path).read_text().splitlines()
        dcols = lines[0].split(";")
        for l in lines[1:]:
            if l.strip():
                r = dict(zip(dcols, l.split(";")))
                daily[r["ad_id"]].append(r)
    days = sorted({r["date"] for rs in daily.values() for r in rs})
    didx = {d: i for i, d in enumerate(days)}
    DD = ["spend", "meta_rev", "meta_conv", "nc_rev", "nc_orders", "nv", "vis", "imps", "clk", "px_rev", "px_orders"]

    groups = defaultdict(list)
    for r in rows:
        if num(r["spend"]) > 0:
            groups[clean(r["ad_name"])].append(r)

    start_yy = start[2:4] + start[5:7] + start[8:10]
    end_dt = datetime.strptime(end, "%Y-%m-%d")
    ads = []
    for key, rs in groups.items():
        rs.sort(key=lambda r: -num(r["spend"]))
        top = rs[0]
        S = lambda f: sum(num(r[f]) for r in rs)
        spend, meta_rev, meta_conv = S("spend"), S("meta_rev"), S("meta_conv")
        px_rev, px_orders, nc_rev, nc_orders = S("pixel_rev"), S("pixel_orders"), S("nc_rev"), S("nc_orders")
        new_vis, vis, imps, clicks = S("new_visitors"), S("visitors"), S("impressions"), S("clicks")
        s14, n14 = S("spend_d14"), S("nc_rev_d14")

        tags = parse_new(key, codes)
        convention, status = "new", "New convention (definition sheet)"
        if not tags:
            tags = parse_old(key, legacy)
            convention, status = ("old", "Old key:value convention, mapped to new sheet") if tags else ("untagged", "Unrecognised name")
        tags = tags or {}

        firsts = sorted(r["first_day"] for r in rs if r.get("first_day"))
        d = firsts[0] if firsts else None
        date = d[2:4] + d[5:7] + d[8:10] if d else None

        wk = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])
        for r in rs:
            for w in weekly.get(r["ad_id"], []):
                v = wk[widx[w["week"]]]
                v[0] += num(w["spend"]); v[1] += num(w["meta_rev"]); v[2] += num(w["nc_rev"]); v[3] += num(w["nc_orders"])

        dd = defaultdict(lambda: [0.0] * len(DD))
        for r in rs:
            for x in daily.get(r["ad_id"], []):
                v = dd[didx[x["date"]]]
                for j, k in enumerate(DD):
                    v[j] += num(x[k])

        image = next((r["image_url"] for r in rs if r.get("image_url")), None)
        aw = norm_awareness(tags.get("awareness_stage"))
        metrics = {
            "spend": round(spend, 2),
            # Primary lens: Meta-reported (7DC/1DV) revenue and purchases.
            "rev": round(meta_rev, 2), "txns": meta_conv,
            "meta_rev": round(meta_rev, 2), "meta_txns": meta_conv,
            # Triple Whale pixel, Triple Attribution, lifetime.
            "pixel_rev": round(px_rev, 2), "pixel_txns": px_orders,
            "nc_rev": round(nc_rev, 2), "nc_txns": nc_orders,
            "ncroas": round(nc_rev / spend, 4) if spend else None,
            "nccpa": round(spend / nc_orders, 2) if nc_orders else None,
            "pct_new": round(nc_orders / px_orders * 100, 2) if px_orders else None,
            "new_visitors": new_vis, "visitors": vis,
            "pct_new_visitors": round(new_vis / vis * 100, 2) if vis else None,
            "impressions": imps, "clicks": clicks,
            "roas": round(meta_rev / spend, 4) if spend else 0,
            "pixel_roas": round(px_rev / spend, 4) if spend else 0,
            "aov": round(meta_rev / meta_conv, 2) if meta_conv else None,
            "cpa": round(spend / meta_conv, 2) if meta_conv else None,
            "cpm": round(spend / imps * 1000, 2) if imps else 0,
            "cpc": round(spend / clicks, 2) if clicks else None,
            "ctr": round(clicks / imps * 100, 3) if imps else None,
            "spend_d14": round(s14, 2), "nc_rev_d14": round(n14, 2),
            "ncroas_d14": round(n14 / s14, 4) if s14 else None,
        }
        carry = bool(date and date < start_yy)
        mature = bool(date and (end_dt - datetime.strptime("20" + date, "%Y%m%d")).days >= MATURE_DAYS)
        ads.append({
            "ad_name": key,
            "new_ad_name": key if convention == "new" else None,
            "creative_no": tags.get("creative_no"), "product": tags.get("product"),
            "concept": tags.get("concept"), "reason": tags.get("reason"),
            "angle": tags.get("angle"), "angle_tags": tags.get("angle_tags"),
            "sub_angle": tags.get("reason"), "icp": tags.get("avatar"), "avatar": tags.get("avatar"),
            "script": tags.get("script"), "type": tags.get("type"), "format": tags.get("format"),
            "origin": tags.get("origin"), "awareness_stage": aw,
            "funnel": FUNNEL_OF.get(aw), "length": tags.get("length"),
            "persuasion": tags.get("persuasion"), "static_type": tags.get("static_type"),
            "strategist": tags.get("strategist"), "writer": tags.get("writer"), "editor": tags.get("editor"),
            "landing_page": tags.get("landing_page"),
            "naming_status": status, "reviewed": convention != "untagged", "convention": convention,
            "campaign": top.get("campaign_name"), "adset": top.get("adset_name"),
            "campaigns": sorted({r["campaign_name"] for r in rs if r.get("campaign_name")})[:3],
            "adsets": [],
            "ad_account": top.get("account_id"), "meta_ad_count": len(rs),
            "buying_type": None, "batch": None, "attribution_window": None, "geo": None,
            "date": date, "launch_date": d, "carry_over": carry, "mature": mature,
            "launch_status": ("Carry-over (live before window)" if carry else
                              "Launched in window" if mature else f"Too new (< {MATURE_DAYS} days)"),
            "meta_ad_ids": [r["ad_id"] for r in rs][:5], "metrics": metrics,
            # [dayIdx, spend, meta_rev, meta_conv, nc_rev, nc_orders, new_visitors, visitors,
            #  impressions, clicks, pixel_rev, pixel_orders]
            "dd": [[k] + [round(x, 2) for x in v] for k, v in sorted(dd.items())],
            "wk": [[k, round(v[0], 2), round(v[1], 2), round(v[2], 2), v[3]] for k, v in sorted(wk.items())],
            "thumbnail_candidates": [],
            "thumbnail_url": image,
            "preview_link": f"https://business.facebook.com/adsmanager/manage/ads?selected_ad_ids={top['ad_id']}",
        })

    ads.sort(key=lambda a: -a["metrics"]["spend"])
    for i, a in enumerate(ads, 1):
        a["spend_rank"] = i
    tot = sum(a["metrics"]["spend"] for a in ads) or 1
    share = lambda c: sum(a["metrics"]["spend"] for a in ads if a["convention"] == c) / tot
    meta = sum(a["metrics"]["meta_rev"] for a in ads)
    nc = sum(a["metrics"]["nc_rev"] for a in ads)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "brand": "Bloom & Bond",
        "period": {"start": start, "end": end},
        "source": "triple-whale-sql-api" if daily else f"triple-whale-sql:{pathlib.Path(ads_path).name}",
        "shop": "6f36e3-2.myshopify.com",
        "has_nc": True,
        "labels": {"rev": "Revenue (Meta)", "roas": "ROAS (Meta)",
                   "rev_sub": "Meta-reported, 7-day click / 1-day view",
                   "nc_sub": "TW pixel, Triple Attribution, lifetime"},
        "attribution": {"primary": "Meta-reported 7-day click / 1-day view (via Triple Whale)",
                        "secondary": "New-customer: Triple Whale pixel, Triple Attribution, lifetime window",
                        "window": "7DC/1DV (Meta) · lifetime (TW NC)"},
        "ad_accounts": sorted({a["ad_account"] for a in ads if a["ad_account"]}),
        "weeks": weeks, "days": days, "mature_days": MATURE_DAYS,
        "baseline": {"roas": round(meta / tot, 4), "ncroas": round(nc / tot, 4)},
        "scope_note": (
            f"Every Meta ad that spent {start} → {end}, rolled up to {len(ads):,} creatives. "
            f"{share('new'):.0%} of spend is on the new naming convention, {share('old'):.0%} on the old "
            f"key:value names (mapped onto the new Concept / Reason / Angle sheet), {share('untagged'):.0%} unrecognised. "
            "Revenue, ROAS and purchases are Meta-reported (7-day click / 1-day view); new-customer figures "
            "are the Triple Whale pixel (Triple Attribution, lifetime), so NCROAS and ROAS use different lenses. "
            f"Launch win rates count only creatives first spending inside the window and at least {MATURE_DAYS} days old."
        ),
        "ad_count": len(ads),
        "ads": ads,
    }


def main():
    a = sys.argv[1:]
    if len(a) < 4:
        sys.exit("usage: build.py <ads.tsv> <weekly.csv> <start YYYY-MM-DD> <end YYYY-MM-DD> [daily.csv]")
    m = build(a[0], a[1], ROOT / "data" / "definitions.csv", ROOT / "data" / "legacy_map.json", a[2], a[3],
              a[4] if len(a) > 4 else None)
    out = ROOT / "public" / "data"
    (out / "history").mkdir(parents=True, exist_ok=True)
    (out / "latest.json").write_text(json.dumps(m, separators=(",", ":"), default=str))
    with gzip.open(out / "history" / f"{datetime.now(timezone.utc):%Y-%m-%d_%H%M}.json.gz", "wt") as f:
        json.dump(m, f, separators=(",", ":"), default=str)

    ads = m["ads"]
    sp = sum(x["metrics"]["spend"] for x in ads)
    g = lambda f: sum(x["metrics"][f] for x in ads)
    print(f"{len(ads)} creatives · spend ${sp:,.0f} · Meta rev ${g('meta_rev'):,.0f} (ROAS {g('meta_rev')/sp:.2f}x)"
          f" · NC rev ${g('nc_rev'):,.0f} (NCROAS {g('nc_rev')/sp:.2f}x)")
    for c in ("new", "old", "untagged"):
        s = sum(x["metrics"]["spend"] for x in ads if x["convention"] == c)
        print(f"  {c:<9} {sum(1 for x in ads if x['convention']==c):>5} creatives  ${s:>11,.0f}  {s/sp:5.1%}")
    print("coverage by spend:")
    for d in ["creative_no", "concept", "reason", "angle", "avatar", "format", "type", "origin",
              "awareness_stage", "strategist", "editor", "date", "thumbnail_url"]:
        s = sum(x["metrics"]["spend"] for x in ads if x.get(d))
        print(f"  {d:<16} {s/sp:5.1%}")
    print((ROOT / "public" / "data" / "latest.json").stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
