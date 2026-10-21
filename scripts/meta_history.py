#!/usr/bin/env python3
"""One-off: turn a Meta Ads Manager export (Ad level, Month breakdown, columns
Ad name / Ad ID / Amount spent / Purchases / Purchases conversion value) into
data/meta_history.json — per-creative launch month and spend before Triple
Whale's clean window starts (CLEAN_START).

    python3 scripts/meta_history.py raw/meta_history/*.csv

Creatives are rolled up exactly like build.py (same clean() name key). The
build then adds each creative's Triple Whale spend from CLEAN_START onward, so
win-rate thresholds for older launches keep growing without re-exporting.
"""
import csv
import json
import pathlib
import sys
from collections import defaultdict

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build import clean  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent


def num(v):
    try:
        return float(v or 0)
    except ValueError:
        return 0.0


def main(paths):
    cr = defaultdict(lambda: {"months": defaultdict(float), "rev": 0.0, "txns": 0.0, "ad_ids": set()})
    first_month = None
    for p in paths:
        for r in csv.DictReader(open(p, encoding="utf-8-sig")):
            sp = num(r.get("Amount spent (USD)"))
            m = (r.get("Reporting starts") or "")[:7]
            if not m:
                continue
            first_month = min(first_month or m, m)
            if sp <= 0 and num(r.get("Purchases conversion value")) <= 0:
                continue
            c = cr[clean(r["Ad name"])]
            c["months"][m] += sp
            c["rev"] += num(r.get("Purchases conversion value"))
            c["txns"] += num(r.get("Purchases"))
            c["ad_ids"].add(r.get("Ad ID"))
    out = []
    for name, c in cr.items():
        spent = {m: v for m, v in c["months"].items() if v > 0}
        if not spent:
            continue
        launch = min(spent)
        out.append({"ad_name": name, "launch_month": launch,
                    # launched in the first exported month = may have started earlier
                    "censored": launch == first_month,
                    "spend": round(sum(spent.values()), 2), "rev": round(c["rev"], 2),
                    "txns": round(c["txns"]), "ad_ids": sorted(i for i in c["ad_ids"] if i)[:5]})
    out.sort(key=lambda x: (x["launch_month"], -x["spend"]))
    dest = ROOT / "data" / "meta_history.json"
    dest.write_text(json.dumps({"source": "Meta Ads Manager export, monthly, Ad level",
                                "first_month": first_month, "creatives": out}, separators=(",", ":")))
    by = defaultdict(lambda: [0, 0.0])
    for x in out:
        by[x["launch_month"]][0] += 1
        by[x["launch_month"]][1] += x["spend"]
    for m in sorted(by):
        print(f"  {m}: {by[m][0]:>5} launches  ${by[m][1]:>12,.0f}")
    print(f"{len(out)} creatives -> {dest}")


if __name__ == "__main__":
    main(sys.argv[1:])
