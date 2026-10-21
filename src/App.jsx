import DailyView, { dailyRows } from "./Daily.jsx";
import SpendMix from "./SpendMix.jsx";
import NvpLedger from "./NvpLedger.jsx";
import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell, ComposedChart,
} from "recharts";
import {
  aggregate, groupBy, monthly, winRate, toBreakdownRows, weekly, weeklyFromDaily,
  DIMENSIONS, dimensionValues, BASELINE, setBaseline,
} from "./aggregator.js";

const fmt = (n) => n == null ? "—" : n >= 1000000 ? `$${(n/1000000).toFixed(1)}M` : n >= 1000 ? `$${(n/1000).toFixed(0)}K` : `$${n.toFixed(0)}`;
const fmtFull = (n) => `$${Math.round(n).toLocaleString()}`;
const fmtNum = (n) => n == null ? "—" : Number(n).toLocaleString();
const fmtPct = (n) => n == null ? "—" : `${Number(n).toFixed(1)}%`;

const MAX_AN_RULES = 8;
const DEPTH_BG = ["transparent", "#FBF5F0", "#F5EDE5", "#EFE3D8", "#E9DACD"];
const depthBg = (d) => DEPTH_BG[Math.min(d, DEPTH_BG.length - 1)];
const TABS = ["Overview", "Win Rate", "Concepts", "Reasons", "Angles", "Avatars", "Formats", "NVP Buckets", "Breakdowns", "Analysis", "Data Clean Up"];
const THRESHOLDS = ["$1K", "$5K", "$15K", "$25K", "$50K", "$100K", "$150K+"];

// Coloured relative to the account baseline (set from the manifest), so the
// badges separate better-than-average from worse-than-average instead of all
// sitting under a fixed 1.0x line. Pass base="ncroas" for NCROAS columns.
const RoasBadge = ({ roas, base = "roas" }) => {
  const r = roas ?? 0;
  const b = BASELINE[base] || 1;
  const bg = r >= b * 1.2 ? "#dcfce7" : r >= b ? "#f0fdf4" : r >= b * 0.85 ? "#fef9c3" : "#fee2e2";
  const color = r >= b * 1.2 ? "#166534" : r >= b ? "#15803d" : r >= b * 0.85 ? "#854d0e" : "#991b1b";
  return <span style={{ background: bg, color, padding: "2px 8px", borderRadius: 4, fontWeight: 600, fontSize: 13 }}>{r.toFixed(2)}x</span>;
};

const th = { padding: "8px 10px", color: "#8a6f68", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 };
const td = { padding: "8px 10px", color: "#3a2429", fontSize: 12 };

// Convert YYMMDD ↔ YYYY-MM-DD for <input type="date"> round-trips.
const yymmddToIso = (s) => s && /^\d{6}$/.test(s) ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : "";
const isoToYymmdd = (s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(2, 4) + s.slice(5, 7) + s.slice(8, 10) : null;

// Creation-date range picker shown above the tabs.
function DateRangePicker({ bounds, start, end, setStart, setEnd, mode, setMode, canActivity }) {
  if (!bounds) return null;
  const minIso = yymmddToIso(bounds.min);
  const maxIso = yymmddToIso(bounds.max);
  const isFiltered = start || end;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "10px 14px", background: "#fff", border: "1px solid #E8DCD0", borderRadius: 8, flexWrap: "wrap" }}>
      {canActivity ? (
        <select value={mode} onChange={e => { setMode(e.target.value); setStart(null); setEnd(null); }}
          style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 11, fontWeight: 600, color: "#3a2429", textTransform: "uppercase", letterSpacing: 0.3 }}>
          <option value="activity">Date range (spend in period)</option>
          <option value="launch">Launch date (cohort)</option>
        </select>
      ) : (
        <div style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Launch date</div>
      )}
      <input type="date" value={yymmddToIso(start) || minIso} min={minIso} max={maxIso}
        onChange={e => setStart(isoToYymmdd(e.target.value))}
        style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, color: "#3a2429" }} />
      <span style={{ color: "#b0978f", fontSize: 12 }}>→</span>
      <input type="date" value={yymmddToIso(end) || maxIso} min={minIso} max={maxIso}
        onChange={e => setEnd(isoToYymmdd(e.target.value))}
        style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, color: "#3a2429" }} />
      {isFiltered && (
        <button onClick={() => { setStart(null); setEnd(null); }}
          style={{ padding: "4px 10px", border: "1px solid #D8C8BC", background: "#fff", color: "#8a6f68", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Reset</button>
      )}
      <span style={{ marginLeft: "auto", fontSize: 10, color: "#b0978f", fontStyle: "italic" }}>
        {mode === "activity" && canActivity
          ? `ⓘ All figures are what was spent and earned between these dates (data through ${yymmddToIso(bounds.max)})`
          : "ⓘ Shows creatives first launched in this range — their figures are lifetime totals, not period totals"}
      </span>
    </div>
  );
}

// Activity-date filter: rebuild every creative's metrics from its daily rows
// ([dayIdx, spend, rev, orders, nc_rev, nc_orders, new_visitors, visitors,
// impressions, clicks]) inside the selected range, so totals are exactly what
// was spent and earned in that period. Creatives with no activity drop out.
function periodAds(ads, days, startYy, endYy) {
  const iso = (yy) => (yy ? `20${yy.slice(0, 2)}-${yy.slice(2, 4)}-${yy.slice(4, 6)}` : null);
  const s = iso(startYy), e = iso(endYy);
  const lo = s ? days.findIndex(d => d >= s) : 0;
  let hi = e ? days.length - 1 - [...days].reverse().findIndex(d => d <= e) : days.length - 1;
  if (lo < 0 || hi < lo) return [];
  const out = [];
  for (const a of ads) {
    // Optional trailing fields 10–11: TW pixel revenue / orders (when rev is Meta-reported).
    const t = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let hasPx = false;
    for (const r of a.dd || []) {
      if (r[0] < lo || r[0] > hi) continue;
      for (let j = 0; j < r.length - 1; j++) t[j] += r[j + 1];
      hasPx = hasPx || r.length > 10;
    }
    const [spend, rev, txns, nc_rev, nc_txns, nv, vis, imps, clicks] = t;
    const pxRev = hasPx ? t[9] : rev, pxTxns = hasPx ? t[10] : txns;
    if (spend <= 0 && rev <= 0) continue;
    const m = {
      ...a.metrics, spend, rev, txns, meta_rev: hasPx ? rev : a.metrics.meta_rev, meta_txns: hasPx ? txns : a.metrics.meta_txns,
      pixel_rev: pxRev, pixel_txns: pxTxns, nc_rev, nc_txns,
      new_visitors: nv, visitors: vis, impressions: imps, clicks,
      roas: spend ? rev / spend : 0, pixel_roas: spend ? pxRev / spend : 0,
      ncroas: spend ? nc_rev / spend : null, nccpa: nc_txns ? spend / nc_txns : null,
      pct_new: pxTxns ? (nc_txns / pxTxns) * 100 : null, pct_new_visitors: vis ? (nv / vis) * 100 : null,
      aov: txns ? rev / txns : null, cpa: txns ? spend / txns : null,
      cpm: imps ? (spend / imps) * 1000 : 0, cpc: clicks ? spend / clicks : null,
      ctr: imps ? (clicks / imps) * 100 : null,
    };
    // Weekly rows trimmed to the same range, rebuilt from daily data.
    out.push({ ...a, metrics: m });
  }
  return out;
}

// Sortable header that cycles through desc → asc → none on click.
function SortHeader({ label, col, sort, setSort, align = "right" }) {
  const active = sort.col === col;
  const arrow = active ? (sort.dir === "desc" ? "↓" : "↑") : "";
  const onClick = () => {
    if (!active) return setSort({ col, dir: "desc" });
    if (sort.dir === "desc") return setSort({ col, dir: "asc" });
    return setSort({ col: "_spend", dir: "desc" }); // reset to default
  };
  return (
    <th
      onClick={onClick}
      style={{ ...th, textAlign: align, cursor: "pointer", userSelect: "none", color: active ? "#3A1B11" : "#8a6f68" }}
      title="Click to sort"
    >
      {label} {arrow}
    </th>
  );
}

// Sort helper: respects string / number / nulls.
function sortRows(rows, col, dir) {
  const mul = dir === "desc" ? -1 : 1;
  return rows.slice().sort((a, b) => {
    let va = a[col], vb = b[col];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string" && typeof vb === "string") return mul * va.localeCompare(vb);
    return mul * (va - vb);
  });
}

// --------- Ad list modal (shown when a bucket row is clicked) ---------
function AdListModal({ open, title, subtitle, ads, onClose, days, range, initialMode }) {
  const [sort, setSort] = useState({ col: "spend", dir: "desc" });
  const [mode, setMode] = useState("ads");
  const [focus, setFocus] = useState(null); // one ad shown by day
  useEffect(() => { setMode(initialMode || "ads"); setFocus(null); }, [open, title, initialMode]);
  const sortedAds = useMemo(() => {
    if (!ads) return [];
    return ads.slice().sort((a, b) => {
      const mul = sort.dir === "desc" ? -1 : 1;
      let va = sort.col === "spend" ? a.metrics.spend
             : sort.col === "rev" ? a.metrics.rev
             : sort.col === "roas" ? a.metrics.roas
             : sort.col === "nc_txns" ? a.metrics.nc_txns
             : sort.col === "clicks" ? a.metrics.clicks
             : sort.col === "ad_name" ? a.ad_name
             : a.metrics[sort.col];
      let vb = sort.col === "spend" ? b.metrics.spend
             : sort.col === "rev" ? b.metrics.rev
             : sort.col === "roas" ? b.metrics.roas
             : sort.col === "nc_txns" ? b.metrics.nc_txns
             : sort.col === "clicks" ? b.metrics.clicks
             : sort.col === "ad_name" ? b.ad_name
             : b.metrics[sort.col];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string" && typeof vb === "string") return mul * va.localeCompare(vb);
      return mul * (va - vb);
    });
  }, [ads, sort]);

  if (!open) return null;

  const downloadCsv = () => {
    const headers = ["ad_name", "new_ad_name", "creative_no", "product", "concept", "reason", "angle", "icp", "type", "origin", "script", "format", "awareness_stage", "strategist", "naming_status", "buying_type", "campaign", "adset", "spend", "rev", "txns", "nc_rev", "nc_txns", "ncroas", "nccpa", "spend_rank"];
    if (HAS_NV) headers.push("pct_new_visitors");
    const escape = (v) => v == null ? "" : typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v);
    const lines = [headers.join(",")];
    for (const a of sortedAds) {
      lines.push(headers.map(h => escape(h in a.metrics ? a.metrics[h] : a[h])).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.replace(/[^a-z0-9]+/gi, "_")}_ads.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 20, width: "min(1100px, 100%)", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#3A1B11" }}>{title}</h3>
            {subtitle && <p style={{ margin: "4px 0 0", fontSize: 12, color: "#8a6f68" }}>{subtitle}</p>}
            <p style={{ margin: "4px 0 0", fontSize: 11, color: "#b0978f" }}>{sortedAds.length.toLocaleString()} ads</p>
            {days?.length > 0 && (
              <div style={{ display: "flex", gap: 3, background: "#E8DCD0", borderRadius: 6, padding: 2, marginTop: 8, width: "fit-content" }}>
                {[["ads", "Ads"], ["daily", "By day"]].map(([k, l]) => (
                  <button key={k} onClick={() => { setMode(k); setFocus(null); }} style={{ padding: "4px 12px", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600,
                    background: mode === k && !focus ? "#fff" : "transparent", color: mode === k && !focus ? "#3A1B11" : "#8a6f68" }}>{l}</button>
                ))}
                {focus && <span style={{ padding: "4px 10px", fontSize: 11, fontWeight: 600, color: "#3A1B11", background: "#fff", borderRadius: 5, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={focus.ad_name}>By day: {focus.ad_name}</span>}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={downloadCsv} style={{ padding: "6px 12px", border: "1px solid #D8C8BC", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#3a2429" }}>Download CSV ({sortedAds.length})</button>
            <button onClick={onClose} style={{ padding: "6px 12px", border: "none", background: "#3A1B11", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Close</button>
          </div>
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          {(mode === "daily" || focus) ? (
            <div>
              <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 8px" }}>
                {focus ? "This ad" : `All ${sortedAds.length.toLocaleString()} ads in this list`}, day by day for {range?.[0] || days[0]} → {range?.[1] || days[days.length - 1]} (the calendar range at the top). Newest day first.
                {focus && <> · <span style={{ color: "#CC6138", cursor: "pointer", fontWeight: 600 }} onClick={() => setFocus(null)}>back to ads</span></>}
              </p>
              <DailyView ads={focus ? [focus] : ads} days={days} start={range?.[0]} end={range?.[1]} roasLabel={LBL.roas || "ROAS"} hasNc={HAS_NC} />
            </div>
          ) : (<>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead style={{ position: "sticky", top: 0, background: "#fff", zIndex: 1 }}>
              <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
                <SortHeader label="Ad Name" col="ad_name" sort={sort} setSort={setSort} align="left" />
                <th style={{ ...th, textAlign: "center" }}>Preview</th>
                <SortHeader label="Spend" col="spend" sort={sort} setSort={setSort} />
                <SortHeader label="Revenue" col="rev" sort={sort} setSort={setSort} />
                <SortHeader label="ROAS" col="roas" sort={sort} setSort={setSort} />
                <SortHeader label="% New Cust." col="nc_txns" sort={sort} setSort={setSort} />
                <SortHeader label="Clicks" col="clicks" sort={sort} setSort={setSort} />
                <SortHeader label="Txns" col="txns" sort={sort} setSort={setSort} />
              </tr>
            </thead>
            <tbody>
              {sortedAds.slice(0, 500).map((a, i) => {
                const pctNew = a.metrics.pixel_txns ? (a.metrics.nc_txns / a.metrics.pixel_txns) * 100 : null;
                const adIds = a.meta_ad_ids || [];
                const managerUrl = adIds[0] ? `https://business.facebook.com/adsmanager/manage/ads?selected_ad_ids=${adIds[0]}` : null;
                const previewUrl = a.preview_link || managerUrl;
                const previewTitle = a.preview_link
                  ? `Preview the creative (no login). Meta ad ID: ${adIds[0] || "?"}`
                  : `Open in Ads Manager (Meta login required). Ad ID: ${adIds[0] || "?"}`;
                return (
                  <tr key={i} style={{ borderBottom: "1px solid #F5EDE5" }}>
                    <td style={{ ...td, fontSize: 10, fontFamily: "ui-monospace, monospace", maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.ad_name}>
                      {days?.length > 0 && <button onClick={() => setFocus(a)} title="This ad by day" style={{ border: "1px solid #E8DCD0", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 10, padding: "1px 5px", marginRight: 6 }}>📈</button>}
                      {a.ad_name}</td>
                    <td style={{ ...td, textAlign: "center", width: 72 }}>
                      {a.thumbnail_url && previewUrl ? (
                        <a href={previewUrl} target="_blank" rel="noopener noreferrer" title={previewTitle} style={{ display: "inline-block", lineHeight: 0 }}>
                          <img src={a.thumbnail_url} alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={e => {
                              // Triple Whale serves thumbnails per ad account and we
                              // do not know which account owns this ad, so walk the
                              // candidate list before giving up.
                              const el = e.currentTarget;
                              const cands = a.thumbnail_candidates || [];
                              const i = Number(el.dataset.ci || 0) + 1;
                              if (i < cands.length) { el.dataset.ci = i; el.src = cands[i]; return; }
                              el.style.display = "none";
                              el.parentElement.textContent = "Manager ↗";
                            }}
                            style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 4, border: "1px solid #E8DCD0", display: "block" }} />
                        </a>
                      ) : a.preview_link ? (
                        <a href={a.preview_link} target="_blank" rel="noopener noreferrer"
                          title={previewTitle}
                          style={{ color: "#CC6138", textDecoration: "none", fontSize: 10, fontWeight: 600 }}>
                          Preview ↗
                        </a>
                      ) : managerUrl ? (
                        <a href={managerUrl} target="_blank" rel="noopener noreferrer"
                          title={previewTitle}
                          style={{ color: "#b0978f", textDecoration: "none", fontSize: 10, fontWeight: 600 }}>
                          Manager ↗
                        </a>
                      ) : <span style={{ color: "#D8C8BC", fontSize: 10 }}>—</span>}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(a.metrics.spend)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(a.metrics.rev)}</td>
                    <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={a.metrics.roas} /></td>
                    <td style={{ ...td, textAlign: "right" }}>{fmtPct(pctNew)}</td>
                    <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(a.metrics.clicks)}</td>
                    <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(a.metrics.txns)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sortedAds.length > 500 && <p style={{ fontSize: 11, color: "#b0978f", marginTop: 12, textAlign: "center" }}>Showing top 500 — CSV export includes all {sortedAds.length.toLocaleString()}.</p>}
          </>)}
        </div>
      </div>
    </div>
  );
}

// --------- Sortable breakdown table (used across Concepts / Agencies / Creators / ICP) ---------
// Set from the manifest: false when the data has no Triple Whale new-customer metrics.
let HAS_NC = true;
// Metric labels — the manifest can override them (Bloom & Bond reports Meta's own
// 7DC/1DV revenue as the primary lens and the TW pixel only for new-customer data).
const LBL = { rev: "Pixel Revenue", roas: "Pixel ROAS", roas_sub: "pixel rev / spend", nc_sub: "" };
function setLabels(m) {
  const l = (m && m.labels) || {};
  LBL.rev = l.rev || (m && m.has_nc === false ? "Revenue" : "Pixel Revenue");
  LBL.roas = l.roas || (m && m.has_nc === false ? "ROAS" : "Pixel ROAS");
  LBL.roas_sub = l.rev_sub || (m && m.has_nc === false ? "Meta-attributed rev / spend" : "pixel rev / spend");
  LBL.nc_sub = l.nc_sub || "";
}
// Set from the manifest: true when per-ad visitor counts are present.
let HAS_NV = false;

function BreakdownTable({ rows, nameLabel = "Name", onRowClick }) {
  const [sort, setSort] = useState({ col: "spend", dir: "desc" });
  const cols = [
    { key: "name", label: nameLabel, align: "left" },
    { key: "creatives", label: "Ads" },
    { key: "spend", label: "Spend" },
    { key: "revenue", label: "Revenue" },
    { key: "roas", label: LBL.roas },
    ...(HAS_NC ? [{ key: "ncroas", label: "NCROAS" }, { key: "pct_new", label: "% New Cust." }] : []),
    ...(HAS_NV ? [{ key: "pct_new_visitors", label: "% New Visitors" }] : []),
    { key: "purchases", label: "Orders" },
    { key: "aov", label: "AOV" },
    ...(HAS_NC ? [{ key: "nccpa", label: "NC CPA" }] : []),
    { key: "winRate1k", label: "WR $1K" },
    { key: "winRate15k", label: "WR $15K" },
    { key: "winRate50k", label: "WR $50K" },
    ...(HAS_NC ? [{ key: "effRate", label: "Efficient WR" }] : []),
  ];
  const sorted = useMemo(() => sortRows(rows, sort.col, sort.dir), [rows, sort]);
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
          {cols.map(c => <SortHeader key={c.key} label={c.label} col={c.key} sort={sort} setSort={setSort} align={c.align || "right"} />)}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r, i) => (
          <tr key={i} onClick={() => onRowClick?.(r)} style={{ borderBottom: "1px solid #F5EDE5", cursor: onRowClick ? "pointer" : "default" }}
              onMouseEnter={e => onRowClick && (e.currentTarget.style.background = "#FBF5F0")}
              onMouseLeave={e => onRowClick && (e.currentTarget.style.background = "transparent")}>
            <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(r.creatives)}</td>
            <td style={{ ...td, textAlign: "right", fontWeight: 500 }}>{fmt(r.spend)}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmt(r.revenue)}</td>
            <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={r.roas} /></td>
            {HAS_NC && <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={r.ncroas} base="ncroas" /></td>}
            {HAS_NC && <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.pct_new)}</td>}
            {HAS_NV && <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.pct_new_visitors)}</td>}
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(r.purchases)}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{r.aov ? `$${r.aov.toFixed(0)}` : "—"}</td>
            {HAS_NC && <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{r.nccpa ? `$${r.nccpa.toFixed(0)}` : "—"}</td>}
            {[r.winRate1k, r.winRate15k, r.winRate50k, ...(HAS_NC ? [r.effRate] : [])].map((v, j) => (
              <td key={j} title={`${r.eligible ?? "?"} launches eligible`} style={{ ...td, textAlign: "right", color: (r.eligible ?? 99) < 5 ? "#cbb8b0" : td.color }}>
                {(r.eligible ?? 1) === 0 ? "—" : fmtPct(v)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --------- Win Rate table with sortable columns ---------
// Threshold columns present in this win-rate data ("Efficient" only exists when
// the manifest carries new-customer metrics).
const wrCols = (wrData) => THRESHOLDS.concat(wrData.some(r => r.thresholds && r.thresholds.Efficient) ? ["Efficient"] : []);

function WinRateTable({ wrData }) {
  const [sort, setSort] = useState({ col: "month", dir: "desc" });
  const { total, rows } = useMemo(() => {
    const total = wrData.find(r => r.month === "TOTAL");
    const rest = wrData.filter(r => r.month !== "TOTAL");
    const mul = sort.dir === "desc" ? -1 : 1;
    const sorted = rest.slice().sort((a, b) => {
      if (sort.col === "month") return mul * a.month.localeCompare(b.month);
      if (sort.col === "total") return mul * (a.total - b.total);
      // threshold key — sort by rate
      const ra = a.thresholds[sort.col]?.rate ?? 0;
      const rb = b.thresholds[sort.col]?.rate ?? 0;
      return mul * (ra - rb);
    });
    return { total, rows: sorted };
  }, [wrData, sort]);
  return (
    <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
            <SortHeader label="Month" col="month" sort={sort} setSort={setSort} align="left" />
            <SortHeader label="Launched" col="total" sort={sort} setSort={setSort} />
            {wrCols(wrData).map(t => <SortHeader key={t} label={t === "Efficient" ? "Efficient ($1K + NCROAS ≥ acct)" : t} col={t} sort={sort} setSort={setSort} align="center" />)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #F5EDE5" }}>
              <td style={td}>{row.month}{row.history && <span title="Launch cohort from the Meta Ads Manager export (before Triple Whale data starts); later spend added from Triple Whale" style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: "#CC6138", border: "1px solid #EBDDD0", borderRadius: 4, padding: "0 4px" }}>META</span>}</td>
              <td style={{ ...td, textAlign: "right" }}>{row.total.toLocaleString()}</td>
              {wrCols(wrData).map(t => {
                const d = row.thresholds[t];
                if (d && d.n == null) return <td key={t} style={{ padding: "6px 6px", textAlign: "center", color: "#b0978f", fontSize: 11 }} title="Meta history has no new-customer data">—</td>;
                return (
                  <td key={t} style={{ padding: "6px 6px", textAlign: "center" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#3A1B11" }}>{d?.n ?? 0}</div>
                    <div style={{ fontSize: 10, color: (d?.rate ?? 0) >= 10 ? "#16a34a" : (d?.rate ?? 0) < 2 ? "#dc2626" : "#8a6f68" }}>{(d?.rate ?? 0).toFixed(1)}%</div>
                  </td>
                );
              })}
            </tr>
          ))}
          {total && (
            <tr style={{ borderBottom: "1px solid #F5EDE5", background: "#FBF5F0", fontWeight: 700 }}>
              <td style={td}>{total.month}</td>
              <td style={{ ...td, textAlign: "right" }}>{total.total.toLocaleString()}</td>
              {wrCols(wrData).map(t => {
                const d = total.thresholds[t];
                return (
                  <td key={t} style={{ padding: "6px 6px", textAlign: "center" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#3A1B11" }}>{d?.n ?? 0}</div>
                    <div style={{ fontSize: 10, color: (d?.rate ?? 0) >= 10 ? "#16a34a" : (d?.rate ?? 0) < 2 ? "#dc2626" : "#8a6f68" }}>{(d?.rate ?? 0).toFixed(1)}%</div>
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// --------- Multi-dim grouping used by Analysis + Creator × Concept ---------
function multiGroupBy(ads, dims) {
  const buckets = new Map();
  for (const ad of ads) {
    const key = dims.map(d => ad[d] ?? "(untagged)").join(" × ");
    if (!buckets.has(key)) buckets.set(key, { key, ads: [], values: dims.map(d => ad[d] ?? "(untagged)") });
    buckets.get(key).ads.push(ad);
  }
  return Array.from(buckets.values()).map(b => ({ name: b.key, values: b.values, ads: b.ads, ...aggregate(b.ads) }));
}

// ====================== Main component ======================
export default function Dashboard() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("Overview");

  // Win Rate state
  const [wrFormat, setWrFormat] = useState("blended");
  const [wrStrategist, setWrStrategist] = useState("all");
  const [wrThreshold, setWrThreshold] = useState("$1K");

  // Breakdowns state
  const [bdView, setBdView] = useState("Format");
  const [ccSearch, setCcSearch] = useState("");
  const [ccMinSpend, setCcMinSpend] = useState(5000);

  // Analysis state. Each "rule" is {dim, values:Set} — empty set = "all values for this dim".
  const [anRules, setAnRules] = useState([{ dim: "angle", values: new Set() }]);
  const [anMetric, setAnMetric] = useState("spend");
  const [anMinSpend, setAnMinSpend] = useState(0);
  const [anTopN, setAnTopN] = useState(20);
  const [anExclusions, setAnExclusions] = useState({}); // {dim: Set of excluded values} — secondary exclude-list filter

  // Data Clean Up state
  const [cleanDim, setCleanDim] = useState("angle");
  const [mappings, setMappings] = useState({}); // {dim: {oldVal: newVal}}
  const [cleanSelectedValue, setCleanSelectedValue] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  // Creation-date filter. Null = "full range"; otherwise YYMMDD strings.
  const [dateStart, setDateStart] = useState(null);
  const [dateMode, setDateMode] = useState("activity");
  // New-customer lens: "adjusted" adds Meta's spend share of TW's Non-attributed +
  // organic new-customer revenue (see fetch_tw_sql.py); "pixel" is TW as reported.
  const [ncLens, setNcLens] = useState("adjusted");
  const lensOn = ncLens === "adjusted" && !!manifest?.has_nc_adj;
  const lensBaseline = manifest ? { ...manifest.baseline, ncroas: lensOn ? manifest.baseline.ncroas_adj : manifest.baseline.ncroas } : null;
  const lensAds = useMemo(() => {
    const src = manifest?.ads ?? [];
    if (!lensOn) return src;
    return src.map(a => {
      const m = a.metrics; const nc = m.nc_rev_adj ?? m.nc_rev, nco = m.nc_txns_adj ?? m.nc_txns;
      return { ...a,
        // The reallocated new-customer orders are real orders, so they join the pixel totals too.
        metrics: { ...m, nc_rev: nc, nc_txns: nco, ncroas: m.spend ? nc / m.spend : null, nccpa: nco ? m.spend / nco : null,
          pixel_rev: (m.pixel_rev || 0) + (nc - (m.nc_rev || 0)), pixel_txns: (m.pixel_txns || 0) + (nco - (m.nc_txns || 0)),
          pct_new: ((m.pixel_txns || 0) + (nco - (m.nc_txns || 0))) ? (nco / ((m.pixel_txns || 0) + (nco - (m.nc_txns || 0)))) * 100 : null },
        dd: (a.dd || []).map(r => (r.length > 13
          ? [r[0], r[1], r[2], r[3], r[12], r[13], r[6], r[7], r[8], r[9], r[10] + (r[12] - r[4]), r[11] + (r[13] - r[5]), r[12], r[13]]
          : r)) };
    });
  }, [manifest, lensOn]);
  const [dateEnd, setDateEnd] = useState(null);

  // Global modal state (shared across tabs)
  const [modalState, setModalState] = useState({ open: false, title: "", subtitle: "", ads: [] });
  const openModal = (title, subtitle, ads, mode) => setModalState({ open: true, title, subtitle, ads, mode });
  const closeModal = () => setModalState(s => ({ ...s, open: false }));

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/latest.json`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}: ${r.statusText}`);
        return r.json();
      })
      .then(setManifest)
      .catch(e => setError(String(e)));
    // Mappings are owned by GitHub (data/mappings.json) — fetch fresh every
    // load. The cache-buster prevents raw.githubusercontent.com's ~5 min CDN
    // cache from serving stale data right after a Save.
    fetch(`https://raw.githubusercontent.com/deniskims11/bloom-bond-dashboard/main/data/mappings.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : {})
      .then(m => setMappings(m || {}))
      .catch(() => setMappings({}));
  }, []);

  // Bounds of ad creation dates in the raw data (YYMMDD strings).
  const canActivity = !!(manifest?.days?.length);
  const dateBounds = useMemo(() => {
    if (canActivity && dateMode === "activity") {
      const toYy = (d) => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
      return { min: toYy(manifest.days[0]), max: toYy(manifest.days[manifest.days.length - 1]) };
    }
    const dates = (manifest?.ads ?? []).map(a => a.date).filter(d => d && /^\d{6}$/.test(d));
    if (!dates.length) return null;
    return { min: dates.reduce((a, b) => a < b ? a : b), max: dates.reduce((a, b) => a > b ? a : b) };
  }, [manifest, dateMode, canActivity]);

  // Apply mappings + creation-date filter to ads.
  const ads = useMemo(() => {
    // Baseline must be in place before any memo below derives badges / efficient wins.
    setBaseline(lensBaseline);
    setLabels(manifest);
    let raw = lensAds;
    if ((dateStart || dateEnd) && canActivity && dateMode === "activity") {
      raw = periodAds(raw, manifest.days, dateStart, dateEnd);
    } else if (dateStart || dateEnd) {
      raw = raw.filter(a => {
        if (!a.date || !/^\d{6}$/.test(a.date)) return false;
        if (dateStart && a.date < dateStart) return false;
        if (dateEnd && a.date > dateEnd) return false;
        return true;
      });
    }
    if (!Object.keys(mappings).length) return raw;
    return raw.map(a => {
      const copy = { ...a };
      for (const [dim, map] of Object.entries(mappings)) {
        if (copy[dim] != null && map[copy[dim]]) copy[dim] = map[copy[dim]];
      }
      return copy;
    });
  }, [manifest, lensAds, mappings, dateStart, dateEnd, dateMode, canActivity]);

  const totals = useMemo(() => aggregate(ads), [ads]);
  const monthlyData = useMemo(() => monthly(ads), [ads]);
  const [wkDim, setWkDim] = useState("angle");
  const isoOf = (yy) => (yy ? `20${yy.slice(0, 2)}-${yy.slice(2, 4)}-${yy.slice(4, 6)}` : null);
  const wkRange = canActivity && dateMode === "activity" ? [isoOf(dateStart), isoOf(dateEnd)] : [null, null];
  const weeklyTotals = useMemo(() => (canActivity
    ? weeklyFromDaily(ads, manifest.days, wkRange[0], wkRange[1])
    : weekly(ads, manifest?.weeks)), [ads, manifest, canActivity, wkRange[0], wkRange[1]]);
  const weeklyMix = useMemo(() => (canActivity
    ? weeklyFromDaily(ads, manifest.days, wkRange[0], wkRange[1], wkDim, 6)
    : weekly(ads, manifest?.weeks, wkDim, 6)), [ads, manifest, canActivity, wkDim, wkRange[0], wkRange[1]]);
  // Win rates are launch-cohort metrics, so the activity-date filter doesn't apply.
  // Win rates are launch cohorts: current-window creatives plus the Meta history
  // (launches before the Triple Whale window, spend = Meta before it + TW after).
  const wrAds = useMemo(() => (dateMode === "activity" && canActivity ? lensAds : ads).concat(manifest?.history_ads ?? []),
    [ads, lensAds, manifest, dateMode, canActivity]);
  const wrData = useMemo(() => winRate(wrAds, wrFormat, wrStrategist), [wrAds, wrFormat, wrStrategist]);
  const strategistList = useMemo(
    () => Array.from(new Set(ads.map(a => a.strategist).filter(Boolean))).sort(),
    [ads]
  );
  // Strategist × win-rate matrix: one row per strategist, columns = thresholds.
  const wrByStrategist = useMemo(
    () => ["(untagged)", ...strategistList].map(s => ({ name: s, rows: winRate(wrAds, wrFormat, s) }))
      .map(x => ({ name: x.name, total: x.rows.find(r => r.month === "TOTAL") }))
      .filter(x => x.total && x.total.total > 0),
    [wrAds, wrFormat, strategistList]
  );
  const funnels = useMemo(() => toBreakdownRows(groupBy(ads, "funnel")), [ads]);
  const concepts = useMemo(() => toBreakdownRows(groupBy(ads, "concept")), [ads]);
  const angles = useMemo(() => toBreakdownRows(groupBy(ads, "angle")), [ads]);
  const icps = useMemo(() => toBreakdownRows(groupBy(ads, "icp")), [ads]);
  const reasons = useMemo(() => toBreakdownRows(groupBy(ads, "reason")), [ads]);
  // Two-level combos from the definition sheet hierarchy, flattened to "A · B" rows.
  const comboRows = (d1, d2) => toBreakdownRows(groupBy(
    ads.map(a => ({ ...a, _combo: `${a[d1] ?? "(untagged)"} · ${a[d2] ?? "(untagged)"}` })), "_combo"));
  const conceptReason = useMemo(() => comboRows("concept", "reason"), [ads]);
  const reasonAngle = useMemo(() => comboRows("reason", "angle"), [ads]);
  const awareness = useMemo(() => toBreakdownRows(groupBy(ads, "awareness_stage")), [ads]);
  const scripts = useMemo(() => toBreakdownRows(groupBy(ads, "script")), [ads]);
  const formatList = useMemo(
    () => Array.from(new Set(ads.map(a => a.format).filter(Boolean))).sort(),
    [ads]
  );
  const formats = useMemo(() => toBreakdownRows(groupBy(ads, "format")), [ads]);
  const strategists = useMemo(() => toBreakdownRows(groupBy(ads, "strategist")), [ads]);
  const launchStatuses = useMemo(() => toBreakdownRows(groupBy(ads, "launch_status")), [ads]);
  // Generic one-dimension breakdowns (Bloom & Bond naming fields).
  const EXTRA_BD = { "Reason": "reason", "Origin": "origin", "Type": "type", "Length": "length",
    "Persuasion": "persuasion", "Editor": "editor", "Writer": "writer", "Creator": "creator", "Landing Page": "landing_page" };
  const extraRows = useMemo(
    () => (EXTRA_BD[bdView] ? toBreakdownRows(groupBy(ads, EXTRA_BD[bdView])) : []),
    [ads, bdView]
  );

  // Creator × Concept with filter
  const creatorConceptGroups = useMemo(() => {
    const filtered = ads.filter(a =>
      (a.metrics.spend || 0) >= ccMinSpend &&
      (!ccSearch || [a.angle, a.concept].some(v => (v || "").toLowerCase().includes(ccSearch.toLowerCase())))
    );
    return multiGroupBy(filtered, ["angle", "concept"])
      .map(g => ({ ...g, name: g.values.join(" × ") }))
      .sort((a, b) => b.spend - a.spend);
  }, [ads, ccMinSpend, ccSearch]);

  // ---- Analysis: apply inclusion rules, exclusions, then build tree ----
  const analysisAds = useMemo(() => {
    return ads.filter(a => {
      // Inclusion: for each rule with selected values, ad must match
      for (const rule of anRules) {
        if (!rule.dim || rule.values.size === 0) continue;
        const v = a[rule.dim] ?? "(untagged)";
        if (!rule.values.has(v)) return false;
      }
      // Exclusions
      for (const [dim, excluded] of Object.entries(anExclusions)) {
        if (excluded.size === 0) continue;
        const v = a[dim] ?? "(untagged)";
        if (excluded.has(v)) return false;
      }
      return true;
    });
  }, [ads, anRules, anExclusions]);

  // Previous period of the same length, grouped along the same dimensions, so
  // the Analysis "Tendency" toggle can show change per row (path -> aggregate).
  const prevInfo = useMemo(() => {
    if (!(canActivity && dateMode === "activity" && dateStart && dateEnd)) return null;
    const toD = yy => new Date(Date.UTC(2000 + +yy.slice(0, 2), +yy.slice(2, 4) - 1, +yy.slice(4, 6)));
    const toYy = d => d.toISOString().slice(2, 10).replace(/-/g, "");
    const s0 = toD(dateStart), e0 = toD(dateEnd); const len = Math.round((e0 - s0) / 864e5) + 1;
    const pe = new Date(s0.getTime() - 864e5), ps = new Date(pe.getTime() - (len - 1) * 864e5);
    let raw = periodAds(lensAds, manifest.days, toYy(ps), toYy(pe));
    if (Object.keys(mappings).length) raw = raw.map(a => { const c = { ...a }; for (const [dim, map] of Object.entries(mappings)) if (c[dim] != null && map[c[dim]]) c[dim] = map[c[dim]]; return c; });
    raw = raw.filter(a => {
      for (const rule of anRules) { if (!rule.dim || rule.values.size === 0) continue; if (!rule.values.has(a[rule.dim] ?? "(untagged)")) return false; }
      for (const [dim, ex] of Object.entries(anExclusions)) { if (ex.size && ex.has(a[dim] ?? "(untagged)")) return false; }
      return true;
    });
    const dims = anRules.map(r => r.dim).filter(Boolean); const map = new Map();
    const walk = (rows, i, path) => {
      if (i >= dims.length) return;
      const g = new Map(); for (const a of rows) { const v = a[dims[i]] ?? "(untagged)"; if (!g.has(v)) g.set(v, []); g.get(v).push(a); }
      for (const [v, rs] of g) { const p = path ? `${path}\u241F${v}` : String(v); map.set(p, aggregate(rs)); walk(rs, i + 1, p); }
    };
    walk(raw, 0, "");
    return { map, label: `${ps.toISOString().slice(0, 10)} → ${pe.toISOString().slice(0, 10)}`, empty: raw.length === 0 };
  }, [manifest, lensAds, mappings, dateStart, dateEnd, dateMode, canActivity, anRules, anExclusions]);

  // Build tree: dims = anRules ordered
  const analysisTree = useMemo(() => {
    const dims = anRules.map(r => r.dim).filter(Boolean);
    if (dims.length === 0) return [];
    const build = (ads, dimsLeft) => {
      const [d, ...rest] = dimsLeft;
      const groups = new Map();
      for (const ad of ads) {
        const v = ad[d] ?? "(untagged)";
        if (!groups.has(v)) groups.set(v, []);
        groups.get(v).push(ad);
      }
      return Array.from(groups.entries())
        .map(([v, rows]) => ({
          value: v,
          dim: d,
          ads: rows,
          agg: aggregate(rows),
          children: rest.length ? build(rows, rest) : null,
        }))
        .filter(n => n.agg.spend >= anMinSpend || dimsLeft.length < dims.length)
        .sort((a, b) => (b.agg[anMetric] ?? 0) - (a.agg[anMetric] ?? 0));
    };
    const root = build(analysisAds, dims);
    // Top-level: respect topN + min spend
    return root.filter(n => n.agg.spend >= anMinSpend).slice(0, anTopN);
  }, [analysisAds, anRules, anMetric, anMinSpend, anTopN]);

  // Flat list for the chart (top-level nodes only)
  const analysisChartData = useMemo(() =>
    analysisTree.map(n => ({ name: n.value, ...n.agg })),
    [analysisTree]
  );

  // Dimension values per dim (for exclude filter + Data Clean Up).
  const cleanValuesForDim = useMemo(() => dimensionValues(ads, cleanDim), [ads, cleanDim]);

  // Data Clean Up: sample ads for the selected value
  const cleanSampleAds = useMemo(() => {
    if (!cleanSelectedValue) return [];
    const target = cleanSelectedValue === "(untagged)" ? null : cleanSelectedValue;
    return ads.filter(a => a[cleanDim] === target || (a[cleanDim] == null && cleanSelectedValue === "(untagged)"));
  }, [ads, cleanDim, cleanSelectedValue]);

  // Mapping editor helpers
  const setMapping = (dim, oldVal, newVal) => {
    setMappings(m => {
      const nextDim = { ...(m[dim] || {}) };
      if (!newVal || newVal === oldVal) delete nextDim[oldVal];
      else nextDim[oldVal] = newVal;
      const next = { ...m, [dim]: nextDim };
      if (!Object.keys(nextDim).length) delete next[dim];
      return next;
    });
  };

  const [saveState, setSaveState] = useState({ status: "idle", msg: "" }); // idle | saving | ok | err
  const [patModalOpen, setPatModalOpen] = useState(false);
  const [categoryInspector, setCategoryInspector] = useState(null); // {dim, target} | null

  const pushToGithub = async (pat) => {
    setSaveState({ status: "saving", msg: "Pushing to GitHub…" });
    const repo = "deniskims11/bloom-bond-dashboard";
    const path = "data/mappings.json";
    const api = `https://api.github.com/repos/${repo}/contents/${path}`;
    const headers = { Authorization: `token ${pat.trim()}`, Accept: "application/vnd.github+json" };
    // Every fetch gets a 30s AbortController so nothing hangs silently.
    const withTimeout = (ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(t) }; };
    try {
      let sha;
      const t1 = withTimeout(30000);
      const head = await fetch(api, { headers, signal: t1.signal }); t1.done();
      if (head.ok) sha = (await head.json()).sha;
      else if (head.status !== 404) throw new Error(`GET ${path}: ${head.status}`);
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(mappings, null, 2))));
      const t2 = withTimeout(30000);
      const put = await fetch(api, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        signal: t2.signal,
        body: JSON.stringify({
          message: `chore(mappings): update via dashboard @ ${new Date().toISOString()}`,
          content,
          ...(sha ? { sha } : {}),
        }),
      }); t2.done();
      if (!put.ok) {
        const body = await put.text();
        if (put.status === 401 || put.status === 403) {
          try { localStorage.removeItem("nr_creative_dashboard_gh_pat"); } catch {}
          setSaveState({ status: "err", msg: "Saved token rejected. Re-enter PAT." });
          setPatModalOpen(true);
          return;
        }
        throw new Error(`${put.status}: ${body.slice(0, 200)}`);
      }
      const res = await put.json();
      const sha7 = res.commit?.sha?.slice(0, 7) || "ok";
      setSaveState({ status: "ok", msg: `Committed — ${sha7}` });
      window.alert(`✓ Mappings pushed to GitHub (commit ${sha7}). Next data refresh will re-apply them to latest.json.`);
    } catch (err) {
      console.error("[saveMappings]", err);
      const msg = err.name === "AbortError" ? "Timed out after 30s — check network / PAT and retry." : String(err).slice(0, 300);
      setSaveState({ status: "err", msg });
      window.alert(`Save failed: ${msg}`);
    }
  };

  // Safe localStorage helpers — the github.io origin is shared across every
  // Pages site on this account, so the quota can be exhausted by a sibling.
  const safeLocalSet = (key, value) => {
    try { localStorage.setItem(key, value); return true; }
    catch (err) { console.warn(`[localStorage full] failed to set ${key}:`, err.message); return false; }
  };
  const safeLocalGet = (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
  };

  const saveMappings = () => {
    // Immediate visible state so the user always sees the click register, even
    // if the button handler hands off to a modal or a slow API call.
    setSaveState({ status: "saving", msg: "Saving…" });
    setSavedAt(new Date());
    const pat = safeLocalGet("nr_creative_dashboard_gh_pat");
    if (pat) pushToGithub(pat);
    else { setPatModalOpen(true); setSaveState({ status: "idle", msg: "" }); }
  };

  const handlePatSaved = (pat) => {
    safeLocalSet("nr_creative_dashboard_gh_pat", pat.trim());
    setPatModalOpen(false);
    pushToGithub(pat);
  };

  const handlePatSkipped = () => {
    setPatModalOpen(false);
    const blob = new Blob([JSON.stringify(mappings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "mappings.json"; a.click();
    URL.revokeObjectURL(url);
    setSaveState({ status: "ok", msg: "Downloaded mappings.json (skipped GitHub sync)" });
  };

  const clearGithubPat = () => {
    try { localStorage.removeItem("nr_creative_dashboard_gh_pat"); } catch {}
    setSaveState({ status: "ok", msg: "GitHub token cleared — you'll be prompted on next save." });
  };

  if (error) return <div style={{ padding: 24, fontFamily: "sans-serif", color: "#991b1b" }}>Error loading data: {error}</div>;
  if (!manifest) return <div style={{ padding: 24, fontFamily: "sans-serif", color: "#8a6f68" }}>Loading data…</div>;

  HAS_NC = manifest.has_nc !== false;
  setBaseline(lensBaseline);
  if (lensOn) LBL.nc_sub = "Adjusted: TW pixel + Meta's spend share of unattributed / organic NC";
  HAS_NV = (manifest.ads || []).some(a => a.metrics && a.metrics.visitors);
  const fromMaster = (manifest.source || "").startsWith("master-workbook");

  const ALL_DIMS_LABELS = {
    angle: "Angle", reason: "Reason", concept: "Concept", icp: "Avatar",
    origin: "Origin", type: "Type", length: "Length", persuasion: "Persuasion",
    writer: "Writer", creator: "Creator", editor: "Editor", landing_page: "Landing Page", static_type: "Static Type",
    script: "Script / Hook", format: "Format", awareness_stage: "Awareness Stage",
    product: "Product", creative_no: "Ad Number", buying_type: "Buying Type",
    batch: "Batch", attribution_window: "Attribution Window", geo: "Geo",
    strategist: "Strategist", editor: "Editor", hook: "Hook", funnel: "Funnel Stage",
    launch_status: "Launch Status",
    naming_status: "Naming Status", convention: "Review Status",
  };

  const METRIC_MAP = {
    spend: { label: "Spend", fmt },
    rev: { label: "Revenue", fmt },
    roas: { label: "ROAS", fmt: v => v == null ? "—" : `${v.toFixed(2)}x` },
    pixel_roas: { label: "Pixel ROAS", fmt: v => v == null ? "—" : `${v.toFixed(2)}x` },
    ...(HAS_NC ? {
      ncroas: { label: "NCROAS", fmt: v => v == null ? "—" : `${v.toFixed(2)}x` },
      nc_rev: { label: "NC Revenue", fmt },
      pct_new: { label: "% New Cust.", fmt: fmtPct },
    } : {}),
    ...(HAS_NV ? { pct_new_visitors: { label: "% New Visitors", fmt: fmtPct } } : {}),
    count: { label: "# Creatives", fmt: fmtNum },
    txns: { label: "Purchases", fmt: fmtNum },
    cpm: { label: "CPM", fmt: v => v == null ? "—" : `$${v.toFixed(2)}` },
    aov: { label: "AOV", fmt: v => v == null ? "—" : `$${v.toFixed(0)}` },
  };

  return (
    <div style={{ fontFamily: "var(--font-body)", background: "var(--bb-cream)", minHeight: "100vh" }}>
      <header style={{ background: "var(--bb-brown)", color: "var(--bb-cream)", padding: "22px 24px 20px", marginBottom: 24 }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
            <img src={`${import.meta.env.BASE_URL}brand/logo.png`} alt="Bloom & Bond" style={{ height: 34, display: "block" }} />
            <span style={{ width: 1, height: 30, background: "rgba(250,243,237,0.25)" }} />
            <div>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 22, fontWeight: 500, letterSpacing: -0.2, lineHeight: 1.1 }}>Creative Performance</div>
              <div style={{ fontSize: 11, color: "rgba(250,243,237,0.65)", marginTop: 3, letterSpacing: 0.3 }}>Meta · Triple Whale · updated every 4 hours</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              ["Data", `${manifest.period.start.slice(0, 10)} → ${manifest.period.end.slice(0, 10)}`],
              ["Creatives", ads.length.toLocaleString()],
              ["Attribution", "7DC / 1DV"],
              ["Refreshed", new Date(manifest.generated_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })],
            ].map(([k, v]) => (
              <div key={k} style={{ background: "rgba(250,243,237,0.08)", border: "1px solid rgba(250,243,237,0.16)", borderRadius: 999, padding: "6px 12px", fontSize: 11 }}>
                <span style={{ color: "rgba(250,243,237,0.6)", marginRight: 6 }}>{k}</span><span style={{ fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </header>
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 24px 40px" }}>

        {manifest.scope_note && (
          <details style={{ marginBottom: 16, padding: "10px 14px", background: "#fff", border: "1px solid var(--bb-line)", borderRadius: 10 }}>
            <summary style={{ fontSize: 12, fontWeight: 600, color: "var(--bb-brown)", cursor: "pointer" }}>
              About this data <span style={{ fontWeight: 400, color: "var(--bb-muted)" }}>· ROAS = {manifest.attribution?.primary ?? "—"} · NCROAS = {LBL.nc_sub || "TW pixel"}</span>
            </summary>
            <div style={{ fontSize: 11, color: "var(--bb-muted)", lineHeight: 1.6, marginTop: 8 }}>{manifest.scope_note}</div>
          </details>
        )}

        <DateRangePicker
          mode={dateMode}
          setMode={setDateMode}
          canActivity={canActivity}
          bounds={dateBounds}
          start={dateStart}
          end={dateEnd}
          setStart={setDateStart}
          setEnd={setDateEnd}
        />
        {manifest.has_nc_adj && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "-6px 0 16px", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--bb-muted)", letterSpacing: 0.3 }}>NEW-CUSTOMER NUMBERS</span>
            <div style={{ display: "flex", gap: 3, background: "#fff", border: "1px solid var(--bb-line)", borderRadius: 8, padding: 2 }}>
              {[["adjusted", "Adjusted"], ["pixel", "Pixel only"]].map(([k, l]) => (
                <button key={k} onClick={() => setNcLens(k)} style={{ padding: "4px 12px", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600,
                  background: ncLens === k ? "var(--bb-brown)" : "transparent", color: ncLens === k ? "#fff" : "var(--bb-muted)" }}>{l}</button>
              ))}
            </div>
            <span style={{ fontSize: 11, color: "var(--bb-muted)" }}>
              {lensOn
                ? `Adjusted adds Meta's daily spend share of the new-customer revenue Triple Whale leaves "Non-attributed" or "organic" (untracked checkout / lander domains). Account NCROAS ${manifest.baseline.ncroas_adj?.toFixed(2)}x adjusted vs ${manifest.baseline.ncroas.toFixed(2)}x pixel.`
                : `Triple Whale pixel as reported (Triple Attribution + Views, 7-day).`}
            </span>
          </div>
        )}

        <div style={{ display: "flex", gap: 4, marginBottom: 22, padding: 5, background: "#fff", border: "1px solid var(--bb-line)", borderRadius: 12, overflowX: "auto" }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "9px 16px", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
              letterSpacing: 0.2,
              background: tab === t ? "var(--bb-terracotta)" : "transparent",
              color: tab === t ? "#fff" : "var(--bb-muted)",
              transition: "background 0.15s, color 0.15s",
            }}>{t}</button>
          ))}
        </div>

        {tab === "Overview" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${HAS_NC && HAS_NV ? 6 : 5}, 1fr)`, gap: 12, marginBottom: 20 }}>
              {[
                { label: "Total Spend", value: fmt(totals.spend), sub: "channel-reported" },
                { label: LBL.rev, value: fmt(totals.rev), sub: `${fmtNum(totals.txns)} orders` },
                { label: LBL.roas, value: `${totals.roas.toFixed(2)}x`, sub: LBL.roas_sub },
                ...(HAS_NC ? [
                  { label: "NCROAS", value: `${(totals.ncroas ?? 0).toFixed(2)}x`, sub: `NC rev ${fmt(totals.nc_rev)}${LBL.nc_sub ? ` · ${LBL.nc_sub}` : ""}` },
                  { label: "% New Cust.", value: fmtPct(totals.pct_new), sub: `${fmtNum(totals.nc_txns)} NC orders` },
                  ...(HAS_NV ? [{ label: "% New Visitors", value: fmtPct(totals.pct_new_visitors), sub: `${fmtNum(totals.new_visitors)} of ${fmtNum(totals.visitors)}` }] : []),
                ] : [
                  { label: "CPA", value: totals.txns ? `$${(totals.spend / totals.txns).toFixed(0)}` : "—", sub: "spend / purchases" },
                  { label: "AOV", value: totals.txns ? `$${(totals.rev / totals.txns).toFixed(0)}` : "—", sub: "rev / purchases" },
                ]),
              ].map((kpi, i) => (
                <div key={i} style={{ background: "#fff", borderRadius: 10, padding: "16px 14px", border: "1px solid #E8DCD0" }}>
                  <div style={{ fontSize: 10, color: "#b0978f", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{kpi.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#3A1B11", marginTop: 4 }}>{kpi.value}</div>
                  <div style={{ fontSize: 11, color: "#b0978f", marginTop: 2 }}>{kpi.sub}</div>
                </div>
              ))}
            </div>

            {canActivity && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #E8DCD0", marginBottom: 20 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "#3a2429" }}>Daily metrics <span style={{ fontWeight: 400, fontSize: 11, color: "#b0978f" }}>· every creative in view, day by day for the calendar range · tick metrics to plot them</span></h3>
                <DailyView ads={ads} days={manifest.days} start={isoOf(dateStart)} end={isoOf(dateEnd)} roasLabel={LBL.roas || "ROAS"} hasNc={HAS_NC} />
              </div>
            )}

            {weeklyTotals.rows.length > 0 && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #E8DCD0", marginBottom: 20 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 16px", color: "#3a2429" }}>Weekly spend, revenue & ROAS <span style={{ fontWeight: 400, fontSize: 11, color: "#b0978f" }}>· calendar weeks (Mon start); first and last weeks are partial</span></h3>
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={weeklyTotals.rows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F5EDE5" />
                    <XAxis dataKey="week" tick={{ fontSize: 11, fill: "#b0978f" }} />
                    <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#b0978f" }} tickFormatter={v => fmt(v)} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#b0978f" }} tickFormatter={v => `${v.toFixed(1)}x`} />
                    <Tooltip formatter={(v, n) => (n.includes("ROAS")) ? `${(v ?? 0).toFixed(2)}x` : fmtFull(v)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar yAxisId="left" dataKey="spend" fill="#93c5fd" name="Spend" radius={[3, 3, 0, 0]} />
                    <Bar yAxisId="left" dataKey="rev" fill="#86efac" name="Revenue" radius={[3, 3, 0, 0]} />
                    <Line yAxisId="right" dataKey="roas" stroke="#f97316" strokeWidth={2.5} dot={{ r: 3 }} name={LBL.roas} />
                    {HAS_NC && <Line yAxisId="right" dataKey="ncroas" stroke="#0ea5e9" strokeWidth={2} dot={{ r: 3 }} name="NCROAS" />}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            {weeklyMix.rows.length > 0 && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #E8DCD0", marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: "#3a2429" }}>Weekly spend mix <span style={{ fontWeight: 400, fontSize: 11, color: "#b0978f" }}>· share of each week's spend, top 6 + other</span></h3>
                  <select value={wkDim} onChange={e => setWkDim(e.target.value)}
                    style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontWeight: 600, color: "#3a2429" }}>
                    {["angle", "concept", "reason", "format", "type", "origin", "awareness_stage", "strategist", "icp"].map(d => <option key={d} value={d}>{ALL_DIMS_LABELS[d] || d}</option>)}
                  </select>
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={weeklyMix.rows} stackOffset="expand">
                    <CartesianGrid strokeDasharray="3 3" stroke="#F5EDE5" />
                    <XAxis dataKey="week" tick={{ fontSize: 11, fill: "#b0978f" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#b0978f" }} tickFormatter={v => `${Math.round(v * 100)}%`} />
                    <Tooltip formatter={(v) => fmtFull(v)} itemSorter={(it) => (it.name === "Other" ? Infinity : -(it.value || 0))} />
                    <Legend wrapperStyle={{ fontSize: 11 }} itemSorter={(it) => weeklyMix.keys.indexOf(it.value)} />
                    {weeklyMix.keys.map((k, i) => (
                      <Bar key={k} dataKey={k} stackId="mix" name={k}
                        fill={["#3A1B11", "#b45309", "#0e7490", "#7c3aed", "#15803d", "#be185d", "#cbb8b0"][i % 7]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #E8DCD0", marginBottom: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 16px", color: "#3a2429" }}>Launch cohorts — spend, revenue & ROAS of creatives launched each month <span style={{ fontWeight: 400, fontSize: 11, color: "#b0978f" }}>· in-window spend; carry-over creatives excluded</span></h3>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F5EDE5" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#b0978f" }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#b0978f" }} tickFormatter={v => fmt(v)} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#b0978f" }} domain={[0, 1.5]} tickFormatter={v => `${v}x`} />
                  <Tooltip formatter={(v, n) => (n === LBL.roas || n === "NCROAS") ? `${v.toFixed(2)}x` : fmtFull(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="left" dataKey="spend" fill="#93c5fd" name="Spend" radius={[3, 3, 0, 0]} />
                  <Bar yAxisId="left" dataKey="revenue" fill="#86efac" name="Revenue" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" dataKey="roas" stroke="#f97316" strokeWidth={2.5} dot={{ r: 4 }} name={LBL.roas} />
                  {HAS_NC && <Line yAxisId="right" dataKey="ncroas" stroke="#0ea5e9" strokeWidth={2} dot={{ r: 3 }} name="NCROAS" />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #E8DCD0" }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 16px", color: "#3a2429" }}>Creatives Launched per Month <span style={{ fontWeight: 400, fontSize: 11, color: "#b0978f" }}>· by first spend day; carry-over creatives excluded</span></h3>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F5EDE5" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#b0978f" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#b0978f" }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="total" fill="#818cf8" name="Creatives launched" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {tab === "Win Rate" && (
          <div>
            {fromMaster && (
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 16, padding: "10px 14px", background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 8 }}>
              <span style={{ fontSize: 13, lineHeight: 1.2 }}>⚠</span>
              <div style={{ fontSize: 11, color: "#7f1d1d", lineHeight: 1.5 }}>
                <strong>Read these rates with care.</strong> Win rate asks what share of
                launched creatives reach a spend level — which needs the creatives that
                never got there. Every ad in this dataset already spent over $1,000
                (minimum {fmtFull(Math.min(...ads.map(a => a.metrics.spend || 0)))}), so the non-starters are absent and <strong>WR $1K is
                100% by construction</strong>. The $15K and $50K columns are still
                informative <em>relative to each other</em>, but none of these are
                whole-account launch win rates. A full export including low-spend and
                static creatives would be needed for that.
              </div>
            </div>)}
            {!fromMaster && (
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 16, padding: "10px 14px", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 8 }}>
                <span style={{ fontSize: 13, lineHeight: 1.2 }}>ⓘ</span>
                <div style={{ fontSize: 11, color: "#1e3a5f", lineHeight: 1.5 }}>
                  <strong>How these are counted.</strong> A launch is a creative whose first-ever spend day falls inside the window and that is at least {manifest.mature_days ?? 14} days old,
                  so carry-over ads ({fmtNum(ads.filter(a => a.carry_over).length)}) and ads too new to judge ({fmtNum(ads.filter(a => !a.carry_over && a.mature === false).length)}) are left out.
                  Thresholds are lifetime-in-window spend. <strong>Efficient</strong> = spent $1K+ and beat the account NCROAS ({(BASELINE.ncroas).toFixed(2)}x).
                  {(manifest.history_ads?.length > 0) && <> Months tagged <strong>META</strong> are launches from before the Triple Whale data starts, taken from the Meta Ads Manager export: spend = Meta spend up to {manifest.period.start} plus Triple Whale spend since (lifetime to date); no new-customer data, so no Efficient column for them.</>}
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
              <select value={wrFormat} onChange={e => setWrFormat(e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontWeight: 600, color: "#3a2429" }}>
                <option value="blended">All formats</option>
                {formatList.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <select value={wrStrategist} onChange={e => setWrStrategist(e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontWeight: 600, color: "#3a2429" }}>
                <option value="all">All strategists</option>
                {strategistList.map(s => <option key={s} value={s}>{s}</option>)}
                <option value="(untagged)">(no strategist in name)</option>
              </select>
              <select value={wrThreshold} onChange={e => setWrThreshold(e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontWeight: 600, color: "#3a2429" }}>
                {wrCols(wrData).map(t => <option key={t} value={t}>{t === "Efficient" ? "Efficient win ($1K + NCROAS ≥ account)" : `Threshold: ${t}`}</option>)}
              </select>
            </div>

            <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #E8DCD0", marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>
                Win Rate Trend — {wrThreshold} ({wrFormat === "blended" ? "All formats" : wrFormat})
              </h3>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={wrData.filter(d => d.month !== "TOTAL")}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F5EDE5" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#b0978f" }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#b0978f" }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#b0978f" }} tickFormatter={v => `${v}%`} />
                  <Tooltip formatter={(v, n) => n === "Win Rate" ? `${v.toFixed(1)}%` : v} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="left" dataKey="total" fill="#D8C8BC" name="Total Launched" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" type="monotone" stroke="#ef4444" strokeWidth={2.5} dot={{ r: 4 }} name="Win Rate"
                    dataKey={(d) => d.thresholds[wrThreshold]?.rate || 0} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <WinRateTable wrData={wrData} />

            {wrByStrategist.length > 1 && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto", marginTop: 16 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px", color: "#3a2429" }}>Hit rate by strategist</h3>
                <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 12px" }}>Share of each strategist's eligible launches reaching each spend level. Strategist comes from the 10th field of renamed ad names, so older launches sit under "(untagged)". $50K+ lags — recent launches are still climbing.</p>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
                      <th style={{ ...th, textAlign: "left" }}>Strategist</th>
                      <th style={{ ...th, textAlign: "right" }}>Launches</th>
                      {wrCols(wrData).map(t => <th key={t} style={{ ...th, textAlign: "center" }}>{t}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {wrByStrategist.map(x => (
                      <tr key={x.name} style={{ borderBottom: "1px solid #F5EDE5" }}>
                        <td style={{ ...td, fontWeight: 600 }}>{x.name}</td>
                        <td style={{ ...td, textAlign: "right" }}>{fmtNum(x.total.total)}</td>
                        {wrCols(wrData).map(t => {
                          const d = x.total.thresholds[t];
                          return (
                            <td key={t} style={{ padding: "6px 6px", textAlign: "center", color: x.total.total < 10 ? "#cbb8b0" : undefined }}>
                              <div style={{ fontSize: 13, fontWeight: 600 }}>{d?.n ?? 0}</div>
                              <div style={{ fontSize: 10 }}>{(d?.rate ?? 0).toFixed(1)}%</div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "Angles" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Angle Performance ({angles.length} angles) · <span style={{ fontWeight: 400, color: "#b0978f" }}>click a row to drill into creatives</span></h3>
            <BreakdownTable rows={angles} nameLabel="Angle" onRowClick={r => openModal(`Angle: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}

        {tab === "Concepts" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Concept Performance ({concepts.length} concepts) · <span style={{ fontWeight: 400, color: "#b0978f" }}>click a row to drill into creatives</span></h3>
            <BreakdownTable rows={concepts} nameLabel="Concept" onRowClick={r => openModal(`Concept: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}

        {tab === "Reasons" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px", color: "#3a2429" }}>Reason Performance ({reasons.length} reasons) · <span style={{ fontWeight: 400, color: "#b0978f" }}>click a row to drill into creatives</span></h3>
            <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 12px" }}>Why it is happening to her (definition sheet: General, Menopause, GLP-1, PCOS, AGA, Thyroid, Insulin Resistance). Sits between Concept and Angle — see Breakdowns → Concept × Reason and Reason × Angle.</p>
            <BreakdownTable rows={reasons} nameLabel="Reason" onRowClick={r => openModal(`Reason: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}
        {tab === "Formats" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px", color: "#3a2429" }}>Format Performance ({formats.length} formats) · <span style={{ fontWeight: 400, color: "#b0978f" }}>click a row to drill into creatives</span></h3>
            <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 12px" }}>Creative format. Old-convention names are mapped onto the definition sheet formats where the match is unambiguous (e.g. AiC - Podcast → AIPodcast); Image / Native Ad stay as their Type.</p>
            <BreakdownTable rows={formats} nameLabel="Format" onRowClick={r => openModal(`Format: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}
        {tab === "NVP Buckets" && (
          canActivity ? (
            <NvpLedger ads={lensAds} days={manifest.days} baselineNc={BASELINE.ncroas}
              roasLabel={LBL.roas || "ROAS"} />
          ) : <p style={{ color: "#8a6f68" }}>Needs daily data — available after the next refresh.</p>
        )}

        {tab === "Avatars" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Avatar Performance ({icps.length} avatars) · <span style={{ fontWeight: 400, color: "#b0978f" }}>click a row to drill into creatives</span></h3>
            <BreakdownTable rows={icps} nameLabel="Avatar" onRowClick={r => openModal(`Avatar: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}

        {tab === "Breakdowns" && (
          <div>
            <div style={{ display: "flex", gap: 3, background: "#E8DCD0", borderRadius: 6, padding: 2, marginBottom: 16, width: "fit-content", flexWrap: "wrap" }}>
              {["Funnel (TOF/MOF/BOF)", "Format", "Type", "Reason", "Origin", "Awareness Stage", "Strategist", "Editor", "Writer", "Creator", "Length", "Persuasion", "Landing Page", "Script", "Launch Status", "Concept × Reason", "Reason × Angle", "Angle × Concept"].map(v => (
                <button key={v} onClick={() => setBdView(v)} style={{
                  padding: "6px 14px", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: 600,
                  background: bdView === v ? "#fff" : "transparent", color: bdView === v ? "#3A1B11" : "#8a6f68",
                }}>{v}</button>
              ))}
            </div>

            {bdView === "Awareness Stage" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Performance by Awareness Stage ({awareness.length})</h3>
                <BreakdownTable rows={awareness} nameLabel="Awareness Stage" onRowClick={r => openModal(`Awareness: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Concept × Reason" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Performance by Concept × Reason ({conceptReason.length})</h3>
                <BreakdownTable rows={conceptReason} nameLabel="Concept × Reason" onRowClick={r => openModal(`Concept × Reason: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Reason × Angle" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Performance by Reason × Angle ({reasonAngle.length})</h3>
                <BreakdownTable rows={reasonAngle} nameLabel="Reason × Angle" onRowClick={r => openModal(`Reason × Angle: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Script" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Performance by Script / Hook ({scripts.length})</h3>
                <BreakdownTable rows={scripts} nameLabel="Script" onRowClick={r => openModal(`Script: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {EXTRA_BD[bdView] && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Performance by {bdView} ({extraRows.length})</h3>
                <BreakdownTable rows={extraRows} nameLabel={bdView} onRowClick={r => openModal(`${bdView}: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Funnel (TOF/MOF/BOF)" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px", color: "#3a2429" }}>Account efficiency by funnel stage</h3>
                <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 12px" }}>TOF = Unaware / Problem Aware, MOF = Solution Aware, BOF = Product / Most Aware (from the awareness field); NR_ names use their own TOF/MOF/BOF token. For strategist × funnel, use Analysis → Strategist then Funnel Stage.</p>
                <BreakdownTable rows={funnels} nameLabel="Funnel" onRowClick={r => openModal(`Funnel: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Strategist" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Performance by Strategist ({strategists.length}) <span style={{ fontWeight: 400, fontSize: 11, color: "#b0978f" }}>· from the 10th field of renamed ad names; older names carry no strategist</span></h3>
                <BreakdownTable rows={strategists} nameLabel="Strategist" onRowClick={r => openModal(`Strategist: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Launch Status" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Carry-over vs new launches</h3>
                <BreakdownTable rows={launchStatuses} nameLabel="Launch Status" onRowClick={r => openModal(`Launch status: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Format" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Performance by Format ({formats.length} formats)</h3>
                <BreakdownTable rows={formats} nameLabel="Format" onRowClick={r => openModal(`Format: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Angle × Concept" && (
              <div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                  <input type="text" placeholder="Search angle or concept..." value={ccSearch} onChange={e => setCcSearch(e.target.value)}
                    style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, width: 240 }} />
                  <label style={{ fontSize: 12, color: "#8a6f68" }}>Min spend: <strong style={{ color: "#3A1B11" }}>{fmt(ccMinSpend)}</strong></label>
                  <input type="range" min={0} max={500000} step={1000} value={ccMinSpend} onChange={e => setCcMinSpend(+e.target.value)} style={{ width: 200 }} />
                  <span style={{ fontSize: 12, color: "#b0978f" }}>{creatorConceptGroups.length} rows · click to drill in</span>
                </div>
                <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto", maxHeight: 600, overflowY: "auto" }}>
                  <BreakdownTable rows={creatorConceptGroups.map(g => ({
                    name: g.name, creatives: g.count, ads: g.ads, spend: g.spend, revenue: g.rev, roas: g.roas,
                    pct_new: g.pct_new, purchases: g.txns, aov: g.aov, cpm: g.cpm,
                    winRate1k: (g.ads.filter(a => (a.metrics.spend||0) >= 1000).length / (g.ads.length||1)) * 100,
                    winRate15k: (g.ads.filter(a => (a.metrics.spend||0) >= 15000).length / (g.ads.length||1)) * 100,
                    winRate50k: (g.ads.filter(a => (a.metrics.spend||0) >= 50000).length / (g.ads.length||1)) * 100,
                  }))} nameLabel="Angle × Concept" onRowClick={r => openModal(r.name, `${r.creatives} ads · Spend ${fmt(r.spend)}`, r.ads)} />
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "Analysis" && (
          <AnalysisTab
            ads={ads}
            prevInfo={prevInfo} days={manifest?.days} range={[isoOf(dateStart), isoOf(dateEnd)]}
            ALL_DIMS_LABELS={ALL_DIMS_LABELS}
            METRIC_MAP={METRIC_MAP}
            anRules={anRules} setAnRules={setAnRules}
            anMetric={anMetric} setAnMetric={setAnMetric}
            anMinSpend={anMinSpend} setAnMinSpend={setAnMinSpend}
            anTopN={anTopN} setAnTopN={setAnTopN}
            anExclusions={anExclusions} setAnExclusions={setAnExclusions}
            analysisTree={analysisTree}
            analysisChartData={analysisChartData}
            openModal={openModal}
          />
        )}

        {tab === "Data Clean Up" && (
          <div>
            <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: 12, gap: 12 }}>
                <p style={{ fontSize: 12, color: "#8a6f68", margin: 0, maxWidth: 720 }}>
                  Review unique values parsed from ad names. Click any value to preview 10 sample ads + download full CSV.
                  Use <strong>Edit</strong> to reclassify a value into an existing category or create a new one (e.g. <code>MULTIPLESUPP</code> → <code>MULTISUPP</code>).
                  Save pushes <code>data/mappings.json</code> to GitHub so the next data refresh picks it up.
                </p>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {saveState.status === "ok" && <span style={{ fontSize: 11, color: "#16a34a", maxWidth: 240 }} title={saveState.msg}>✓ {saveState.msg}</span>}
                  {saveState.status === "err" && <span style={{ fontSize: 11, color: "#dc2626", maxWidth: 240 }} title={saveState.msg}>✕ {saveState.msg}</span>}
                  {saveState.status === "saving" && <span style={{ fontSize: 11, color: "#8a6f68" }}>Saving…</span>}
                  {savedAt && saveState.status === "idle" && <span style={{ fontSize: 11, color: "#16a34a" }}>Saved {savedAt.toLocaleTimeString()}</span>}
                  <button onClick={saveMappings} disabled={saveState.status === "saving"}
                    style={{ padding: "6px 14px", border: "none", background: saveState.status === "saving" ? "#b0978f" : "#3A1B11", color: "#fff", borderRadius: 6, cursor: saveState.status === "saving" ? "wait" : "pointer", fontSize: 12, fontWeight: 600 }}>
                    Save mappings
                  </button>
                  <button onClick={clearGithubPat} title="Clear saved GitHub token"
                    style={{ padding: "6px 8px", border: "1px solid #D8C8BC", background: "#fff", color: "#8a6f68", borderRadius: 6, cursor: "pointer", fontSize: 11 }}>
                    ⚙
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {DIMENSIONS.map(d => {
                  const mapped = Object.keys(mappings[d] || {}).length;
                  return (
                    <button key={d} onClick={() => { setCleanDim(d); setCleanSelectedValue(null); }} style={{
                      padding: "4px 10px", border: "1px solid #D8C8BC", borderRadius: 5, cursor: "pointer",
                      fontSize: 12, fontWeight: 600,
                      background: cleanDim === d ? "#3A1B11" : "#fff",
                      color: cleanDim === d ? "#fff" : "#8a6f68",
                    }}>{d}{mapped > 0 && <span style={{ marginLeft: 4, fontSize: 10, color: cleanDim === d ? "#86efac" : "#16a34a" }}>· {mapped}</span>}</button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: cleanSelectedValue ? "1fr 380px" : "1fr", gap: 16 }}>
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>
                  {cleanDim} — {cleanValuesForDim.length} unique values
                </h3>
                <CleanupTable values={cleanValuesForDim} mappings={mappings[cleanDim] || {}} setMapping={(o, n) => setMapping(cleanDim, o, n)} selected={cleanSelectedValue} onSelect={setCleanSelectedValue}
                  onInspectCategory={(target) => setCategoryInspector({ dim: cleanDim, target })} />
              </div>

              {cleanSelectedValue && (
                <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "#3a2429" }}>Sample ads: <code>{cleanSelectedValue}</code></h3>
                    <button onClick={() => setCleanSelectedValue(null)} style={{ border: "none", background: "transparent", color: "#b0978f", cursor: "pointer", fontSize: 14 }}>×</button>
                  </div>
                  <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 10px" }}>
                    {cleanSampleAds.length} ads · showing 10 ·
                    <button onClick={() => openModal(`${cleanDim}=${cleanSelectedValue}`, `${cleanSampleAds.length} ads`, cleanSampleAds)}
                      style={{ marginLeft: 6, border: "none", background: "transparent", color: "#CC6138", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>see all / download CSV</button>
                  </p>
                  <div style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", color: "#3a2429", maxHeight: 400, overflowY: "auto" }}>
                    {cleanSampleAds.slice(0, 10).map((a, i) => (
                      <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid #F5EDE5", wordBreak: "break-all" }}>
                        <div style={{ fontSize: 10, color: "#b0978f" }}>{fmt(a.metrics.spend)} spend · {fmtNum(a.metrics.txns)} txns</div>
                        {a.ad_name}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <AdListModal open={modalState.open} title={modalState.title} subtitle={modalState.subtitle} ads={modalState.ads} onClose={closeModal}
        days={manifest?.days} range={[isoOf(dateStart), isoOf(dateEnd)]} initialMode={modalState.mode} />
      <PatModal open={patModalOpen} onSave={handlePatSaved} onSkip={handlePatSkipped} onClose={() => setPatModalOpen(false)} />
      {categoryInspector && (
        <CategoryMembersModal
          dim={categoryInspector.dim}
          target={categoryInspector.target}
          mappings={mappings}
          values={dimensionValues(manifest?.ads ?? [], categoryInspector.dim)}
          onRemove={(raw) => setMapping(categoryInspector.dim, raw, "")}
          onClose={() => setCategoryInspector(null)}
        />
      )}
    </div>
  );
}

// -------- Cleanup table subcomponent (sortable, clickable, Edit-popover) --------
function CleanupTable({ values, mappings, setMapping, selected, onSelect, onInspectCategory }) {
  const [sort, setSort] = useState({ col: "spend", dir: "desc" });
  const [editingValue, setEditingValue] = useState(null);

  const sorted = useMemo(() => {
    const mul = sort.dir === "desc" ? -1 : 1;
    return values.slice().sort((a, b) => {
      const va = a[sort.col], vb = b[sort.col];
      if (typeof va === "string") return mul * va.localeCompare(vb);
      return mul * (va - vb);
    });
  }, [values, sort]);

  // Union of raw values + existing mapping targets — these are the "categories" available.
  const categories = useMemo(() => {
    const set = new Set(values.map(v => v.value));
    for (const target of Object.values(mappings)) if (target) set.add(target);
    return Array.from(set).sort((a, b) => String(a).localeCompare(String(b)));
  }, [values, mappings]);

  // Reverse index: for each target, list of raw values that merge into it.
  const mergedInto = useMemo(() => {
    const m = {};
    for (const [raw, target] of Object.entries(mappings)) {
      if (!target) continue;
      (m[target] ||= []).push(raw);
    }
    return m;
  }, [mappings]);

  return (
    <>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
            <SortHeader label="Value" col="value" sort={sort} setSort={setSort} align="left" />
            <SortHeader label="Ads" col="n" sort={sort} setSort={setSort} />
            <SortHeader label="Total Spend" col="spend" sort={sort} setSort={setSort} />
            <th style={{ ...th, textAlign: "left" }}>Mapped to</th>
            <th style={{ ...th, textAlign: "right" }}></th>
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 300).map((v) => {
            const mapped = mappings[v.value];
            return (
              <tr key={v.value} onClick={() => onSelect(v.value)}
                  style={{ borderBottom: "1px solid #F5EDE5", cursor: "pointer", background: selected === v.value ? "#FDE9BF" : "transparent" }}>
                <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>{v.value}</td>
                <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(v.n)}</td>
                <td style={{ ...td, textAlign: "right" }}>{fmt(v.spend)}</td>
                <td style={{ ...td, fontFamily: "ui-monospace, monospace" }} onClick={e => e.stopPropagation()}>
                  {mapped ? (
                    <button onClick={() => onInspectCategory?.(mapped)}
                      title="Click to see everything merged into this master category"
                      style={{ background: "#dcfce7", color: "#166534", padding: "2px 8px", borderRadius: 4, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                      {mapped} ↗
                    </button>
                  ) : mergedInto[v.value]?.length ? (
                    <button onClick={() => onInspectCategory?.(v.value)}
                      title={`${mergedInto[v.value].length} value(s) merged into this master category — click to see`}
                      style={{ background: "#e0e7ff", color: "#3730a3", padding: "2px 8px", borderRadius: 4, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                      +{mergedInto[v.value].length} merged ↗
                    </button>
                  ) : <span style={{ color: "#D8C8BC" }}>—</span>}
                </td>
                <td style={{ ...td, textAlign: "right" }} onClick={e => e.stopPropagation()}>
                  <button onClick={() => setEditingValue(v.value)}
                    style={{ padding: "3px 10px", border: "1px solid #D8C8BC", background: "#fff", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600, color: "#3a2429" }}>
                    Edit
                  </button>
                  {mapped && (
                    <button onClick={() => setMapping(v.value, "")} title="Clear mapping"
                      style={{ marginLeft: 4, padding: "3px 6px", border: "1px solid #fecaca", background: "#fff", color: "#dc2626", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                      ×
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editingValue != null && (
        <EditCategoryModal
          value={editingValue}
          current={mappings[editingValue] || ""}
          categories={categories.filter(c => c !== editingValue)}
          onSave={(newVal) => { setMapping(editingValue, newVal); setEditingValue(null); }}
          onClose={() => setEditingValue(null)}
        />
      )}
    </>
  );
}

// -------- GitHub PAT entry modal (replaces window.prompt which Pages can block) --------
function PatModal({ open, onSave, onSkip, onClose }) {
  const [pat, setPat] = useState("");
  if (!open) return null;
  const submit = () => { if (pat.trim()) onSave(pat); };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 10, width: 480, boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "16px 18px", borderBottom: "1px solid #E8DCD0" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#3A1B11" }}>Sync mappings to GitHub</div>
          <div style={{ fontSize: 12, color: "#8a6f68", marginTop: 4 }}>Paste a GitHub Personal Access Token to push <code>data/mappings.json</code> to the repo. Stored in this browser only.</div>
        </div>
        <div style={{ padding: "14px 18px" }}>
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 11, color: "#CC6138", textDecoration: "none", fontWeight: 600 }}>Create a fine-grained PAT (repo contents: R&W) →</a>
          <input
            type="password"
            autoFocus
            value={pat}
            onChange={e => setPat(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submit(); }}
            placeholder="github_pat_... or ghp_..."
            style={{ width: "100%", marginTop: 10, padding: "8px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontFamily: "ui-monospace, monospace" }}
          />
          <div style={{ fontSize: 10, color: "#b0978f", marginTop: 6 }}>Token stays in localStorage. Clear it anytime via the ⚙ button on the Data Clean Up tab.</div>
        </div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid #E8DCD0", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onSkip}
            style={{ padding: "6px 12px", border: "1px solid #D8C8BC", background: "#fff", color: "#8a6f68", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
            Skip (download JSON)
          </button>
          <button onClick={submit} disabled={!pat.trim()}
            style={{ padding: "6px 14px", border: "none", background: pat.trim() ? "#3A1B11" : "#D8C8BC", color: "#fff", borderRadius: 6, cursor: pat.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600 }}>
            Save & push to GitHub
          </button>
        </div>
      </div>
    </div>
  );
}

// -------- Category members modal — shows all raw values currently resolving to a target --------
function CategoryMembersModal({ dim, target, mappings, values, onRemove, onClose }) {
  const dimMappings = mappings[dim] || {};
  // Members = raw values explicitly mapped to this target, plus the target itself if it's a native raw value.
  const members = useMemo(() => {
    const mapped = Object.entries(dimMappings).filter(([, t]) => t === target).map(([raw]) => raw);
    const self = values.find(v => v.value === target) && !dimMappings[target] ? [target] : [];
    const all = [...new Set([...self, ...mapped])];
    return all.map(raw => {
      const stat = values.find(v => v.value === raw);
      return { raw, n: stat?.n ?? 0, spend: stat?.spend ?? 0, isSelf: raw === target && !dimMappings[raw] };
    }).sort((a, b) => b.spend - a.spend);
  }, [dim, target, mappings, values, dimMappings]);
  const totals = members.reduce((a, m) => ({ n: a.n + m.n, spend: a.spend + m.spend }), { n: 0, spend: 0 });
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 2050, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 10, width: 520, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #E8DCD0" }}>
          <div style={{ fontSize: 11, color: "#b0978f", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Master category · {dim}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#3A1B11", fontFamily: "ui-monospace, monospace" }}>{target}</div>
          <div style={{ fontSize: 11, color: "#8a6f68", marginTop: 2 }}>{members.length} member{members.length !== 1 ? "s" : ""} · {fmtNum(totals.n)} ads · {fmt(totals.spend)}</div>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {members.map(m => (
            <div key={m.raw} style={{ display: "flex", alignItems: "center", padding: "8px 14px", borderBottom: "1px solid #F5EDE5", gap: 10 }}>
              <div style={{ flex: 1, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                {m.raw}
                {m.isSelf && <span style={{ marginLeft: 6, fontSize: 9, color: "#8a6f68", background: "#F5EDE5", padding: "1px 5px", borderRadius: 3 }}>CANONICAL</span>}
              </div>
              <div style={{ fontSize: 11, color: "#8a6f68", minWidth: 60, textAlign: "right" }}>{fmtNum(m.n)}</div>
              <div style={{ fontSize: 11, color: "#3a2429", minWidth: 70, textAlign: "right", fontWeight: 500 }}>{fmt(m.spend)}</div>
              {!m.isSelf && (
                <button onClick={() => onRemove(m.raw)} title="Remove this mapping"
                  style={{ border: "1px solid #fecaca", background: "#fff", color: "#dc2626", borderRadius: 4, cursor: "pointer", fontSize: 10, padding: "2px 6px", fontWeight: 600 }}>
                  Unmap
                </button>
              )}
            </div>
          ))}
          {members.length === 0 && <div style={{ padding: 20, textAlign: "center", fontSize: 11, color: "#b0978f" }}>No members yet</div>}
        </div>
        <div style={{ padding: "10px 14px", borderTop: "1px solid #E8DCD0", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose}
            style={{ padding: "6px 14px", border: "none", background: "#3A1B11", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// -------- Edit category modal (pick existing or create new) --------
function EditCategoryModal({ value, current, categories, onSave, onClose }) {
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const filtered = useMemo(
    () => categories.filter(c => !search || String(c).toLowerCase().includes(search.toLowerCase())),
    [categories, search]
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 10, width: 420, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #E8DCD0" }}>
          <div style={{ fontSize: 11, color: "#b0978f", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Reclassify</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#3A1B11", fontFamily: "ui-monospace, monospace", marginTop: 2, wordBreak: "break-all" }}>{value}</div>
          {current && <div style={{ fontSize: 11, color: "#8a6f68", marginTop: 4 }}>Currently mapped to <strong style={{ color: "#166534" }}>{current}</strong></div>}
        </div>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid #E8DCD0" }}>
          <input autoFocus placeholder="Search existing categories…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12 }} />
        </div>
        <div style={{ overflowY: "auto", flex: 1, maxHeight: 320 }}>
          {filtered.map(c => (
            <div key={c} onClick={() => onSave(c)}
              style={{ padding: "8px 14px", fontSize: 12, fontFamily: "ui-monospace, monospace", cursor: "pointer", borderBottom: "1px solid #F5EDE5", background: c === current ? "#FDE9BF" : "transparent", display: "flex", alignItems: "center", gap: 6 }}
              onMouseEnter={e => e.currentTarget.style.background = "#FBF5F0"}
              onMouseLeave={e => e.currentTarget.style.background = c === current ? "#FDE9BF" : "transparent"}>
              {c === current && <span style={{ color: "#16a34a", fontSize: 11 }}>✓</span>}
              <span>{c}</span>
            </div>
          ))}
          {filtered.length === 0 && <div style={{ padding: 20, textAlign: "center", fontSize: 11, color: "#b0978f" }}>No matches</div>}
        </div>
        <div style={{ padding: "10px 12px", borderTop: "1px solid #E8DCD0", display: "flex", gap: 8, alignItems: "center" }}>
          {creating ? (
            <>
              <input autoFocus placeholder="New category name" value={newName} onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && newName.trim()) onSave(newName.trim()); }}
                style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontFamily: "ui-monospace, monospace" }} />
              <button onClick={() => newName.trim() && onSave(newName.trim())}
                style={{ padding: "6px 12px", border: "none", background: "#3A1B11", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Save</button>
              <button onClick={() => { setCreating(false); setNewName(""); }}
                style={{ padding: "6px 10px", border: "1px solid #D8C8BC", background: "#fff", color: "#8a6f68", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>Cancel</button>
            </>
          ) : (
            <>
              <button onClick={() => setCreating(true)}
                style={{ padding: "6px 12px", border: "1px dashed #b0978f", background: "#fff", color: "#3a2429", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>+ Create new category</button>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "#b0978f" }}>Click a category to apply</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// -------- Chip multiselect for a dimension's values --------
function ValuePicker({ ads, dim, selected, onToggle, onClear }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const values = useMemo(() => dim ? dimensionValues(ads, dim) : [], [ads, dim]);
  const filtered = useMemo(
    () => values.filter(v => !search || String(v.value).toLowerCase().includes(search.toLowerCase())),
    [values, search]
  );
  const selArr = Array.from(selected);

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 280 }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", padding: "6px 10px", background: "#fff", border: "1px solid #D8C8BC", borderRadius: 6, cursor: "pointer", minHeight: 32 }}>
        {selArr.length === 0 ? (
          <span style={{ color: "#b0978f", fontSize: 12 }}>{dim ? `All ${values.length} values` : "Pick a dimension first"}</span>
        ) : (
          <>
            {selArr.slice(0, 4).map(v => (
              <span key={v} style={{ fontSize: 11, background: "#FDE9BF", color: "#3A1B11", padding: "2px 6px", borderRadius: 4, display: "inline-flex", alignItems: "center", gap: 4 }}>
                {v}
                <button onClick={e => { e.stopPropagation(); onToggle(v); }} style={{ border: "none", background: "transparent", color: "#3A1B11", cursor: "pointer", padding: 0, fontSize: 12 }}>×</button>
              </span>
            ))}
            {selArr.length > 4 && <span style={{ fontSize: 11, color: "#8a6f68" }}>+{selArr.length - 4} more</span>}
          </>
        )}
        <span style={{ marginLeft: "auto", color: "#b0978f", fontSize: 11 }}>▾</span>
      </div>
      {open && dim && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, background: "#fff", border: "1px solid #D8C8BC", borderRadius: 6, boxShadow: "0 6px 16px rgba(0,0,0,0.1)", zIndex: 20, maxHeight: 360, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 8, borderBottom: "1px solid #E8DCD0", background: "#fff", display: "flex", gap: 8, alignItems: "center" }}>
            <input autoFocus placeholder="Search values…" value={search} onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, padding: "4px 8px", borderRadius: 4, border: "1px solid #E8DCD0", fontSize: 11 }} />
            {selArr.length > 0 && <button onClick={onClear} style={{ border: "none", background: "transparent", color: "#dc2626", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Clear</button>}
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filtered.slice(0, 200).map(v => (
              <label key={v.value} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", cursor: "pointer", fontSize: 11 }}>
                <input type="checkbox" checked={selected.has(v.value)} onChange={() => onToggle(v.value)} />
                <span style={{ fontFamily: "ui-monospace, monospace", flex: 1 }}>{v.value}</span>
                <span style={{ color: "#b0978f" }}>{v.n}</span>
              </label>
            ))}
            {filtered.length > 200 && <div style={{ padding: 8, fontSize: 10, color: "#b0978f", textAlign: "center" }}>Showing 200 of {filtered.length} — refine search.</div>}
          </div>
          <div style={{ padding: 8, borderTop: "1px solid #E8DCD0", background: "#fff", display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button onClick={() => setOpen(false)}
              style={{ padding: "6px 16px", border: "none", background: "#3A1B11", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
              Select{selArr.length > 0 ? ` (${selArr.length})` : ""}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// -------- Tree table with expand/collapse + leaf drilldown --------
function TreeTable({ nodes, dimLabels, onLeafClick, onDaily, tendency, prevMap, timeline, days, range }) {
  const [expanded, setExpanded] = useState(new Set());
  const [sortCol, setSortCol] = useState("spend");
  const [sortDir, setSortDir] = useState("desc");
  const toggle = (path) => setExpanded(s => {
    const next = new Set(s);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
  const sortHeader = (label, col, align = "right") => {
    const active = sortCol === col;
    return (
      <th key={col} onClick={() => { if (active) setSortDir(d => d === "desc" ? "asc" : "desc"); else { setSortCol(col); setSortDir("desc"); } }}
        style={{ ...th, textAlign: align, cursor: "pointer", userSelect: "none", color: active ? "#3A1B11" : "#8a6f68" }}>
        {label} {active && (sortDir === "desc" ? "↓" : "↑")}
      </th>
    );
  };
  const sortNodes = (nodes) => {
    const mul = sortDir === "desc" ? -1 : 1;
    return nodes.slice().sort((a, b) => {
      if (sortCol === "value") return mul * String(a.value).localeCompare(String(b.value));
      const va = a.agg[sortCol], vb = b.agg[sortCol];
      if (va == null) return 1;
      if (vb == null) return -1;
      return mul * (va - vb);
    });
  };
  const rows = [];
  const walk = (nodes, depth, parentPath) => {
    for (const n of sortNodes(nodes)) {
      const path = parentPath ? `${parentPath}\u241F${n.value}` : n.value;
      const isLeaf = !n.children;
      const isOpen = expanded.has(path);
      rows.push({ n, depth, path, isLeaf, isOpen });
      // Timeline view: an open row lists its days (newest first) before its children.
      if (timeline && isOpen && days?.length) {
        for (const d of dailyRows(n.ads, days, range?.[0], range?.[1])) rows.push({ day: d, depth: depth + 1, path: `${path}\u241F@${d.date}` });
      }
      if (!isLeaf && isOpen) walk(n.children, depth + 1, path);
    }
  };
  walk(nodes, 0, "");

  // Tendency: change vs the previous period of the same length (same grouping path).
  const delta = (path, key, cur, inverse = false) => {
    if (!tendency || !prevMap) return null;
    const p = prevMap.get(path)?.[key];
    if (p == null || !p || cur == null) return <span style={{ fontSize: 9, color: "#b0978f", marginLeft: 4 }}>new</span>;
    const ch = (cur - p) / Math.abs(p) * 100;
    const good = inverse ? ch < 0 : ch > 0;
    return <span style={{ fontSize: 9, fontWeight: 700, marginLeft: 4, padding: "0 3px", borderRadius: 3,
      color: good ? "#15803d" : "#b91c1c", background: good ? "#EAF6EE" : "#FBEAEA" }}>{ch >= 0 ? "↗" : "↘"}{Math.abs(ch) >= 999 ? "999+" : Math.abs(ch).toFixed(0)}%</span>;
  };
  const dayRow = (r) => {
    const d = r.day;
    return (
      <tr key={r.path} style={{ borderBottom: "1px solid #F5EDE5", background: "#FFFDF9" }}>
        <td style={{ ...td, paddingLeft: 10 + r.depth * 20, color: "#5a4046" }}>
          <span style={{ display: "inline-block", width: 14, color: "#b0978f" }}>🗓</span>{d.date}
        </td>
        <td style={{ ...td, textAlign: "right", color: "#b0978f" }}>—</td>
        <td style={{ ...td, textAlign: "right" }}>{fmt(d.spend)}</td>
        <td style={{ ...td, textAlign: "right" }}>{fmt(d.rev)}</td>
        <td style={{ ...td, textAlign: "right" }}>{d.roas == null ? "—" : `${d.roas.toFixed(2)}x`}</td>
        {HAS_NC && <td style={{ ...td, textAlign: "right" }}>{d.ncroas == null ? "—" : `${d.ncroas.toFixed(2)}x`}</td>}
        <td style={{ ...td, textAlign: "right", color: "#b0978f" }}>—</td>
        <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(d.orders)}</td>
        <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{d.aov ? `$${d.aov.toFixed(0)}` : "—"}</td>
        <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{d.cpm ? `$${d.cpm.toFixed(1)}` : "—"}</td>
      </tr>
    );
  };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
          {sortHeader(dimLabels.join(" / "), "value", "left")}
          {sortHeader("Ads", "count")}
          {sortHeader("Spend", "spend")}
          {sortHeader("Revenue", "rev")}
          {sortHeader("ROAS", "roas")}
          {HAS_NC && sortHeader("NCROAS", "ncroas")}
          {sortHeader("% New Cust.", "pct_new")}
          {sortHeader("Purchases", "txns")}
          {sortHeader("AOV", "aov")}
          {sortHeader("CPM", "cpm")}
        </tr>
      </thead>
      <tbody>
        {rows.map(r => r.day ? dayRow(r) : (
          <tr key={r.path}
            onClick={() => (r.isLeaf && !timeline) ? onLeafClick(r.n, r.path) : toggle(r.path)}
            style={{ borderBottom: "1px solid #F5EDE5", cursor: "pointer", background: depthBg(r.depth) }}
            onMouseEnter={e => (e.currentTarget.style.background = "#FDE9BF")}
            onMouseLeave={e => (e.currentTarget.style.background = depthBg(r.depth))}>
            <td style={{ ...td, paddingLeft: 10 + r.depth * 20, fontWeight: r.depth === 0 ? 600 : 500 }}>
              <span style={{ display: "inline-block", width: 14, color: "#b0978f" }}>{(!r.isLeaf || timeline) ? (r.isOpen ? "▼" : "▶") : "•"}</span>
              {r.n.value}
              <span style={{ fontSize: 10, color: "#b0978f", marginLeft: 6 }}>({r.n.agg.count})</span>
              {onDaily && <button onClick={e => { e.stopPropagation(); onDaily(r.n, r.path); }} title="By day"
                style={{ marginLeft: 8, border: "1px solid #E8DCD0", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 10, padding: "1px 5px" }}>📈</button>}
            </td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(r.n.agg.count)}</td>
            <td style={{ ...td, textAlign: "right", fontWeight: 500 }}>{fmt(r.n.agg.spend)}{delta(r.path, "spend", r.n.agg.spend)}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmt(r.n.agg.rev)}{delta(r.path, "rev", r.n.agg.rev)}</td>
            <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={r.n.agg.roas} />{delta(r.path, "roas", r.n.agg.roas)}</td>
            {HAS_NC && <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={r.n.agg.ncroas} base="ncroas" />{delta(r.path, "ncroas", r.n.agg.ncroas)}</td>}
            <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.n.agg.pct_new)}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(r.n.agg.txns)}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{r.n.agg.aov ? `$${r.n.agg.aov.toFixed(0)}` : "—"}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{r.n.agg.cpm ? `$${r.n.agg.cpm.toFixed(1)}` : "—"}{delta(r.path, "cpm", r.n.agg.cpm, true)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// -------- Analysis tab with row-based rule picker + tree table --------
function AnalysisTab({ ads, prevInfo, days, range, ALL_DIMS_LABELS, METRIC_MAP, anRules, setAnRules, anMetric, setAnMetric, anMinSpend, setAnMinSpend, anTopN, setAnTopN, anExclusions, setAnExclusions, analysisTree, analysisChartData, openModal }) {
  const [expandedExcludeDim, setExpandedExcludeDim] = useState(null);
  const [tendency, setTendency] = useState(false);
  const [timeline, setTimeline] = useState(false);

  const setRuleDim = (i, dim) => setAnRules(rs => rs.map((r, idx) => idx === i ? { dim, values: new Set() } : r));
  const toggleRuleValue = (i, v) => setAnRules(rs => rs.map((r, idx) => {
    if (idx !== i) return r;
    const next = new Set(r.values);
    if (next.has(v)) next.delete(v); else next.add(v);
    return { ...r, values: next };
  }));
  const clearRuleValues = (i) => setAnRules(rs => rs.map((r, idx) => idx === i ? { ...r, values: new Set() } : r));
  const removeRule = (i) => setAnRules(rs => rs.filter((_, idx) => idx !== i));
  const addRule = () => setAnRules(rs => rs.length < MAX_AN_RULES ? [...rs, { dim: "", values: new Set() }] : rs);

  const toggleExclude = (dim, value) => {
    setAnExclusions(ex => {
      const set = new Set(ex[dim] || []);
      if (set.has(value)) set.delete(value); else set.add(value);
      return { ...ex, [dim]: set };
    });
  };

  const setExcludeAll = (dim, values) => {
    setAnExclusions(ex => ({ ...ex, [dim]: new Set(values.map(v => v.value)) }));
  };

  const clearExcludeForDim = (dim) => {
    setAnExclusions(ex => {
      const next = { ...ex };
      delete next[dim];
      return next;
    });
  };

  const allExcludeValues = useMemo(() => expandedExcludeDim ? dimensionValues(ads, expandedExcludeDim).slice().sort((a, b) => String(a.value).localeCompare(String(b.value))) : [], [ads, expandedExcludeDim]);
  const excludeDimValues = useMemo(() => allExcludeValues.slice(0, 100), [allExcludeValues]);

  // Dims actually used (non-empty)
  const activeDims = anRules.map(r => r.dim).filter(Boolean);
  const usedDims = new Set(activeDims);

  return (
    <div>
      <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: "#3a2429", margin: "0 0 10px" }}>Concept Analysis</h3>

        {/* Rule rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {anRules.map((rule, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ width: 20, color: "#b0978f", fontSize: 12, textAlign: "center" }}>{i + 1}</span>
              <select value={rule.dim} onChange={e => setRuleDim(i, e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, minWidth: 160, background: "#fff" }}>
                <option value="">Pick dimension…</option>
                {Object.entries(ALL_DIMS_LABELS).map(([k, lbl]) => {
                  const disabled = usedDims.has(k) && k !== rule.dim;
                  return <option key={k} value={k} disabled={disabled}>{lbl}{disabled ? " (used)" : ""}</option>;
                })}
              </select>
              <span style={{ color: "#b0978f" }}>›</span>
              <ValuePicker
                ads={ads}
                dim={rule.dim}
                selected={rule.values}
                onToggle={v => toggleRuleValue(i, v)}
                onClear={() => clearRuleValues(i)}
              />
              <button onClick={() => removeRule(i)} title="Remove row"
                style={{ border: "none", background: "transparent", color: "#b0978f", cursor: "pointer", fontSize: 16, padding: 4 }}>🗑</button>
            </div>
          ))}
        </div>

        {anRules.length < MAX_AN_RULES && (
          <button onClick={addRule} style={{ marginTop: 10, padding: "6px 12px", border: "1px dashed #D8C8BC", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#CC6138" }}>+ Add dimension</button>
        )}

        {/* Controls row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, alignItems: "end", marginTop: 12, paddingTop: 12, borderTop: "1px solid #E8DCD0" }}>
          <div>
            <label style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, display: "block", marginBottom: 4 }}>CHART METRIC</label>
            <select value={anMetric} onChange={e => setAnMetric(e.target.value)} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12 }}>
              {Object.entries(METRIC_MAP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, display: "block", marginBottom: 4 }}>MIN SPEND</label>
            <select value={anMinSpend} onChange={e => setAnMinSpend(+e.target.value)} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12 }}>
              <option value={0}>None</option>
              <option value={1000}>$1K+</option>
              <option value={10000}>$10K+</option>
              <option value={50000}>$50K+</option>
              <option value={100000}>$100K+</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, display: "block", marginBottom: 4 }}>TOP N (top level)</label>
            <select value={anTopN} onChange={e => setAnTopN(+e.target.value)} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12 }}>
              <option value={10}>Top 10</option>
              <option value={20}>Top 20</option>
              <option value={50}>Top 50</option>
              <option value={200}>Top 200</option>
            </select>
          </div>
          <div style={{ fontSize: 11, color: "#8a6f68" }}>
            <strong style={{ color: "#3A1B11" }}>{analysisTree.length}</strong> top-level groups
          </div>
        </div>

        {/* Exclude values section (kept as secondary tool) */}
        <div style={{ marginTop: 12, borderTop: "1px solid #E8DCD0", paddingTop: 12 }}>
          <label style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, display: "block", marginBottom: 6 }}>EXCLUDE VALUES (secondary filter)</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {Object.keys(ALL_DIMS_LABELS).map(k => {
              const excluded = anExclusions[k]?.size || 0;
              return (
                <button key={k} onClick={() => setExpandedExcludeDim(expandedExcludeDim === k ? null : k)} style={{
                  padding: "4px 10px", border: "1px solid #D8C8BC", borderRadius: 5, cursor: "pointer",
                  fontSize: 11, fontWeight: 600,
                  background: expandedExcludeDim === k ? "#fef3c7" : "#fff",
                  color: excluded > 0 ? "#c2410c" : "#8a6f68",
                }}>{ALL_DIMS_LABELS[k]}{excluded > 0 && ` (−${excluded})`}</button>
              );
            })}
            {Object.values(anExclusions).some(s => s.size > 0) &&
              <button onClick={() => setAnExclusions({})} style={{ fontSize: 11, border: "none", background: "transparent", color: "#dc2626", cursor: "pointer", fontWeight: 600 }}>Clear all exclusions</button>
            }
          </div>
          {expandedExcludeDim && (() => {
            const excludedCount = anExclusions[expandedExcludeDim]?.size || 0;
            const allSelected = excludedCount >= allExcludeValues.length && allExcludeValues.length > 0;
            return (
              <div style={{ marginTop: 10, padding: 10, background: "#FBF5F0", borderRadius: 6, maxHeight: 280, overflowY: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 11, color: "#8a6f68" }}>Check values to exclude from <strong>{ALL_DIMS_LABELS[expandedExcludeDim]}</strong>:</div>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button
                      onClick={() => allSelected ? clearExcludeForDim(expandedExcludeDim) : setExcludeAll(expandedExcludeDim, allExcludeValues)}
                      style={{ padding: "3px 10px", border: "1px solid #D8C8BC", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#3a2429" }}>
                      {allSelected ? "Deselect all" : `Select all (${allExcludeValues.length})`}
                    </button>
                    {excludedCount > 0 && !allSelected && (
                      <button onClick={() => clearExcludeForDim(expandedExcludeDim)}
                        style={{ padding: "3px 10px", border: "1px solid #fecaca", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#dc2626" }}>
                        Clear ({excludedCount})
                      </button>
                    )}
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 4 }}>
                  {excludeDimValues.map(v => (
                    <label key={v.value} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer" }}>
                      <input type="checkbox" checked={anExclusions[expandedExcludeDim]?.has(v.value) || false} onChange={() => toggleExclude(expandedExcludeDim, v.value)} />
                      <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 10 }}>{v.value}</span>
                      <span style={{ color: "#b0978f", fontSize: 10 }}>({v.n})</span>
                    </label>
                  ))}
                </div>
                {allExcludeValues.length > excludeDimValues.length && (
                  <div style={{ marginTop: 8, fontSize: 10, color: "#b0978f", textAlign: "center" }}>
                    Showing {excludeDimValues.length} of {allExcludeValues.length} values — "Select all" applies to every value.
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {activeDims.length > 0 && (
        <>
          <SpendMix tree={analysisTree} dims={activeDims} labels={ALL_DIMS_LABELS} baselineNc={BASELINE.ncroas}
            onAds={(name, rows) => openModal(name, `${rows.length} creatives`, rows)} />
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "#3a2429" }}>Breakdown</h3>
              {[["Tendency", tendency, setTendency, prevInfo ? `vs previous period ${prevInfo.label}${prevInfo.empty ? " (no data)" : ""}` : "pick a date range (spend in period) to compare"],
                ["Timeline view", timeline, setTimeline, "expand any row to see it day by day"]].map(([label, on, set, hint]) => (
                <label key={label} title={hint} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#3a2429", cursor: "pointer" }}>
                  <span onClick={() => set(!on)} style={{ width: 30, height: 16, borderRadius: 8, background: on ? "#CC6138" : "#D8C8BC", position: "relative", transition: "background .15s" }}>
                    <span style={{ position: "absolute", top: 2, left: on ? 16 : 2, width: 12, height: 12, borderRadius: 6, background: "#fff", transition: "left .15s" }} />
                  </span>
                  <span onClick={() => set(!on)}>{label}</span>
                </label>
              ))}
              {tendency && prevInfo && <span style={{ fontSize: 11, color: "#b0978f" }}>change vs {prevInfo.label}</span>}
              {tendency && !prevInfo && <span style={{ fontSize: 11, color: "#b91c1c" }}>pick a date range at the top to compare periods</span>}
            </div>
            <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 10px" }}>Click a row to expand to the next dimension. Click a leaf row to see ad-level data.</p>
            <TreeTable
              nodes={analysisTree}
              dimLabels={activeDims.map(d => ALL_DIMS_LABELS[d])}
              onLeafClick={(node, path) => openModal(path.replaceAll("\u241F", " › "), `${node.agg.count} ads · Spend ${fmt(node.agg.spend)}`, node.ads)}
              onDaily={(node, path) => openModal(path.replaceAll("\u241F", " › "), `${node.agg.count} ads · Spend ${fmt(node.agg.spend)}`, node.ads, "daily")}
              tendency={tendency && !!prevInfo} prevMap={prevInfo?.map} timeline={timeline} days={days} range={range}
            />
          </div>
        </>
      )}
    </div>
  );
}

