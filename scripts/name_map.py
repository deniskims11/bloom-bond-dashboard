#!/usr/bin/env python3
"""Ad-name mapping: Meta ad ID -> new (Notion-formula) ad name, for ads whose
names can't be changed in Meta. The build applies a mapped name before parsing,
and the mapping wins over the Notion card and the old name.

    data/name_map.csv   columns: Ad ID, Current ad name, New ad name

    python3 scripts/name_map.py            # validate + write reports/name_map_report.md

Only rows that pass every check are applied; the rest are listed in the report
for the team to fix. New names use the current 16-part Notion order:

    Number_LP_Product_ConceptName_Concept_Reason_Angle_Type_Format_Origin_
    Awareness_Writer_Editor_Creator_FBPage_LaunchDate      (blank part = "N")
"""
import csv
import json
import pathlib
import re
import sys
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAP_PATH = ROOT / "data" / "name_map.csv"
SLOTS = ["Number", "LP", "Product", "ConceptName", "Concept", "Reason", "Angle", "Type", "Format",
         "Origin", "Awareness", "Writer", "Editor", "Creator", "FBPage", "LaunchDate"]
# slot index -> definitions-sheet section (codes) / Notion snapshot column
CODED = {4: ("concepts", "concept"), 5: ("reason", "reason"), 6: ("angles", "angle"), 7: ("type", "type"),
         8: ("formats", "format"), 9: ("origin", "origin"), 10: ("awareness stage", "awareness")}
FLEX_RE = re.compile(r"\bflexible ad\b", re.I)


def is_flexible(name):
    """Meta flexible ads bundle several concepts in one ad ("(PDP) Flexible ad with 321.2, 303.1, …")."""
    return bool(FLEX_RE.search(name or ""))


def allowed_codes(codes, notion_rows, notion_cols):
    """Per coded slot: definition-sheet codes plus every code used on a Notion card."""
    allowed = {}
    for i, (sec, col) in CODED.items():
        s = {c.upper() for c in codes.get(sec, {})}
        if col in notion_cols:
            j = notion_cols.index(col)
            s |= {str(r[j]).strip().upper() for r in notion_rows if j < len(r) and str(r[j]).strip()}
        allowed[i] = s
    return allowed


def people_index(notion_rows, notion_cols):
    """'athenadiago' -> 'Athena Diago' from the Notion writer/editor/creator fields."""
    idx = {}
    for col in ("writer", "editor", "creator"):
        if col not in notion_cols:
            continue
        j = notion_cols.index(col)
        for r in notion_rows:
            for p in str(r[j] if j < len(r) else "").split("|"):
                p = p.strip()
                if p:
                    idx[re.sub(r"[^a-z]", "", p.lower())] = p
    return idx


def check_name(new, allowed):
    """List of problems with one new name (empty = valid)."""
    errs = []
    if "|" in new:
        errs.append('contains "|"')
    t = new.split("_")
    if len(t) != 16:
        return errs + [f"{len(t)} parts (needs exactly 16, '_'-separated; no '_' inside a value)"]
    if not re.fullmatch(r"\d+(\.\d+)?[a-z]?", t[0], re.I):
        errs.append(f"Number '{t[0]}' is not a card number like 370.3")
    for i, ok in allowed.items():
        v = t[i].strip()
        if v in ("", "N"):
            continue
        if v.upper() not in ok:
            errs.append(f"{SLOTS[i]} '{v}' is not a known code")
    if t[15] not in ("", "N") and not re.fullmatch(r"\d{2}\.\d{2}\.\d{2}", t[15]):
        errs.append(f"LaunchDate '{t[15]}' is not DD.MM.YY")
    if any(p != p.strip() for p in t):
        errs.append("leading/trailing spaces in a part")
    return errs


def load_rows(path=MAP_PATH):
    if not path.exists():
        return []
    rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
    out = []
    for i, r in enumerate(rows, start=2):
        k = {re.sub(r"\s+", " ", (key or "").strip().lower()): (v or "").strip() for key, v in r.items()}
        out.append({"line": i, "ad_id": k.get("ad id", ""), "current": k.get("current ad name", ""),
                    "new": k.get("new ad name", "")})
    return out


def validate(rows, codes, notion_rows, notion_cols, known_ids=None):
    """-> (valid {ad_id: new_name}, problems [(line, ad_id, message)])."""
    allowed = allowed_codes(codes, notion_rows, notion_cols)
    problems, valid = [], {}
    by_id = defaultdict(set)
    for r in rows:
        if r["ad_id"]:
            by_id[r["ad_id"]].add(r["new"])
    for r in rows:
        line, aid, new = r["line"], r["ad_id"], r["new"]
        errs = []
        if not re.fullmatch(r"\d{10,20}", aid):
            errs.append(f"Ad ID '{aid}' is not a Meta ad ID")
        elif len(by_id[aid]) > 1:
            errs.append("same Ad ID mapped to different new names")
        if not new:
            errs.append("New ad name is empty")
        else:
            errs += check_name(new, allowed)
        if errs:
            problems += [(line, aid, e) for e in errs]
        else:
            valid[aid] = new
            if known_ids is not None and aid not in known_ids:
                problems.append((line, aid, "WARNING: Ad ID not in the dashboard's Meta data (no spend since Sep 5?) — applied anyway"))
    return valid, problems


def main():
    sys.path.insert(0, str(ROOT / "scripts"))
    import build  # noqa: E402
    codes, _ = build.load_definitions(ROOT / "data" / "definitions.csv")
    nt = json.loads((ROOT / "data" / "notion_attributes.json").read_text())
    rows = load_rows()
    if not rows:
        sys.exit(f"No mapping rows in {MAP_PATH}")
    tw = {}
    ads_tsv = ROOT / "raw" / "tw_ads.tsv"
    if ads_tsv.exists():
        for r in csv.DictReader(open(ads_tsv), delimiter="\t"):
            tw[r["ad_id"]] = (r["ad_name"], float(r["spend"] or 0))
    valid, problems = validate(rows, codes, nt["rows"], nt["cols"], set(tw) if tw else None)
    errors = [p for p in problems if not p[2].startswith("WARNING")]
    lines = [f"# Name-mapping check", "",
             f"- Rows: {len(rows)} · valid (applied): {len(valid)} · rows with errors (NOT applied): {len({p[0] for p in errors})}", ""]
    if problems:
        lines += ["| Line | Ad ID | Problem |", "|---|---|---|"] + [f"| {l} | {a} | {m} |" for l, a, m in problems]
    if tw:
        tot = sum(s for _, s in tw.values()) or 1
        mapped = sum(tw[a][1] for a in valid if a in tw)
        lines += ["", f"- Spend covered by valid mappings (Sep 5 → latest pull): ${mapped:,.0f} ({mapped / tot:.1%})"]
    out = ROOT / "reports" / "name_map_report.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:4]))
    print(f"report -> {out}")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
