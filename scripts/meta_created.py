#!/usr/bin/env python3
"""Turn Ads Manager ad-level exports (columns: Ad name, Date created, Amount
spent (USD); "include deleted ads that contain delivery data" ticked) into
data/meta_created.json — every published ad with its Meta creation date.
The build uses it for launch win rates (a concept launches in the month its
earliest ad was created). Unpublished drafts are never in Meta's export.

    python3 scripts/meta_created.py raw/meta_created/act_*.csv
"""
import csv
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main(paths):
    rows, ends = [], []
    for p in paths:
        acct = pathlib.Path(p).stem
        for r in csv.DictReader(open(p, encoding="utf-8-sig")):
            if not r.get("Date created"):
                continue
            ends.append(r.get("Reporting ends") or "")
            rows.append({"n": r["Ad name"].strip(), "a": acct, "c": r["Date created"][:10],
                         "s": round(float(r.get("Amount spent (USD)") or 0), 2)})
    out = {"source": "Meta Ads Manager export, ad level (Date created)", "export_end": max(ends), "ads": rows}
    (ROOT / "data" / "meta_created.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(rows)} ads, created {min(r['c'] for r in rows)} → {max(r['c'] for r in rows)}, export through {out['export_end']}")


if __name__ == "__main__":
    main(sys.argv[1:])
