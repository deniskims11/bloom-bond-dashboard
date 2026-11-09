import { Fragment, useMemo, useState } from "react";
import { NC } from "./aggregator.js";
import { ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, LabelList } from "recharts";
import { openExternal, adsManagerUrl, campaignUrl, adsetUrl } from "./links.js";
import AdPreview, { PlayBadge, playable } from "./AdPreview.jsx";

// Attribution (Meta), modelled on Moby's Attribution › Meta page: four chart cards
// for the selected date range, then a Campaigns / Ad Sets / Ads table with the
// Triple Whale pixel and Meta-reported numbers side by side.
//
// manifest.attr (scripts/build.py build_attribution):
//   campaigns: [key, name, status, daily_budget, lifetime_budget]
//   adsets:    [key, name, campaignIdx, status, daily_budget, lifetime_budget]
//   ads:       [ad_id, name, adsetIdx, status, account, dd]
//   dd rows:   [dayIdx, spend, meta_rev, meta_conv, px_rev, px_orders, imps, clk, nc_rev, nc_orders, lpv, view, atc, ic, new_visitors, visitors]

const META = "#0284C7";
const TW = "#CC6138";
const SPEND = "#E3C9B8";
const INK = "#3A1B11";
const MUTED = "#8A6F68";
const LINE = "#EBDDD0";

const money = v => (v == null ? "—" : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toLocaleString(undefined, { maximumFractionDigits: v >= 100 ? 0 : 2 })}`);
const x2 = v => (v == null ? "—" : v.toFixed(2));
const pct = v => (v == null ? "—" : `${v.toFixed(2)}%`);
const int = v => (v == null ? "—" : Math.round(v).toLocaleString());
const shortDay = iso => { const d = new Date(iso + "T00:00:00Z"); return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); };

// 15 metric slots per dd row (after dayIdx) + slot 15 = spend on days with new-customer data.
const N = 16;
const zero = () => new Array(N).fill(0);
const add = (t, r) => { for (let j = 0; j < 15; j++) t[j] += r[j + 1] || 0; if (r[0] >= NC.start) t[15] += r[1] || 0; };

// Table column layout (order + hidden), remembered per browser.
const COL_STORE = "bb_attr_cols_v1";
const loadCols = () => { try { const v = JSON.parse(localStorage.getItem(COL_STORE)); return v && Array.isArray(v.order) ? v : null; } catch { return null; } };
const saveCols = v => { try { v ? localStorage.setItem(COL_STORE, JSON.stringify(v)) : localStorage.removeItem(COL_STORE); } catch {} };

// Derived metrics from a summed slot vector.
function kpis(v) {
  const [spend, mrev, mord, prev, pord, imps, clk] = v;
  return {
    spend, mrev, mord, prev, pord, imps, clk,
    lpv: v[9], view: v[10], atc: v[11], ic: v[12], nv: v[13], vis: v[14],
    nvp: v[14] ? (v[13] / v[14]) * 100 : null,
    mroas: spend ? mrev / spend : null, proas: spend ? prev / spend : null,
    mcpa: mord ? spend / mord : null, pcpa: pord ? spend / pord : null,
    ctr: imps ? (clk / imps) * 100 : null, cpc: clk ? spend / clk : null,
    cpm: imps ? (spend / imps) * 1000 : null, cvr: clk ? (mord / clk) * 100 : null,
    maov: mord ? mrev / mord : null, paov: pord ? prev / pord : null,
    ncrev: v[7], ncord: v[8],
    ncroas: v[15] ? v[7] / v[15] : null, nccpa: v[8] ? v[15] / v[8] : null,
  };
}

const STATUS = {
  ACTIVE: { label: "On", color: "#16A34A" },
  PAUSED: { label: "Off", color: "#B7A79D" }, CAMPAIGN_PAUSED: { label: "Off", color: "#B7A79D" },
  ADSET_PAUSED: { label: "Off", color: "#B7A79D" }, ARCHIVED: { label: "Archived", color: "#D8C8BC" },
  DELETED: { label: "Deleted", color: "#D8C8BC" }, WITH_ISSUES: { label: "Issues", color: "#D97706" },
  DISAPPROVED: { label: "Rejected", color: "#B91C1C" }, IN_PROCESS: { label: "Processing", color: "#0284C7" },
  PENDING_REVIEW: { label: "In review", color: "#0284C7" },
  // Without a Meta connection: did it spend on the latest day of data?
  SPENDING: { label: "Spending", color: "#16A34A" }, IDLE: { label: "No spend", color: "#B7A79D" },
};
const isOn = s => s === "ACTIVE" || s === "SPENDING";
function StatusDot({ status }) {
  const s = STATUS[status] || (status ? { label: status.toLowerCase(), color: "#D8C8BC" } : null);
  if (!s) return <span style={{ color: "#D8C8BC" }}>—</span>;
  return (
    <span title={status} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>
      <span style={{ width: 8, height: 8, borderRadius: 8, background: s.color }} />{s.label}
    </span>
  );
}

const budgetText = (d, l) => (d ? `${money(d)}/day` : l ? `${money(l)} total` : "—");

// Read-only toggle chips.
function Seg({ options, value, onChange }) {
  return (
    <div style={{ display: "inline-flex", background: "#F6EDE5", borderRadius: 7, padding: 2 }}>
      {options.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} style={{
          border: "none", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer",
          background: value === k ? "#fff" : "transparent", color: value === k ? INK : MUTED,
          boxShadow: value === k ? "0 1px 2px rgba(58,27,17,0.12)" : "none",
        }}>{label}</button>
      ))}
    </div>
  );
}

const card = { background: "#fff", border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, minWidth: 0 };
const head = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 };
const stat = (label, value, color) => (
  <span style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>{label} <b style={{ color: color || INK }}>{value}</b></span>
);
const axis = { fontSize: 10, fill: MUTED };

function TipBox({ active, payload, label, rows }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: "#fff", border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 10px", fontSize: 11, boxShadow: "0 4px 12px rgba(58,27,17,0.08)" }}>
      <div style={{ fontWeight: 700, color: INK, marginBottom: 4 }}>{p.label || label}</div>
      {rows.map(([k, l, f, c]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 14, color: MUTED }}>
          <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: c, marginRight: 5 }} />{l}</span>
          <b style={{ color: INK }}>{f(p[k])}</b>
        </div>
      ))}
    </div>
  );
}

export default function Attribution({ attr, days, start, end, accent = "var(--bb-terracotta)" }) {
  const [level, setLevel] = useState("campaign");
  const [open, setOpen] = useState(() => new Set());
  const [picked, setPicked] = useState(() => new Set()); // "c:i" | "s:i" | "a:i"
  const [q, setQ] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [sort, setSort] = useState(["spend", -1]);
  const [limit, setLimit] = useState(100);
  const [spendVs, setSpendVs] = useState("roas");
  const [lens, setLens] = useState("meta");
  const [revMetric, setRevMetric] = useState("rev");
  const [lineMetric, setLineMetric] = useState("cvr");
  const [colLayout, setColLayoutState] = useState(loadCols); // { order: [keys], hidden: [keys] } | null = default
  const setColLayout = v => { setColLayoutState(v); saveCols(v); };
  const [dragCol, setDragCol] = useState(null);
  const [overCol, setOverCol] = useState(null);
  const [colMenu, setColMenu] = useState(false);
  const [preview, setPreview] = useState(null);

  const lo = useMemo(() => { if (!start) return 0; const i = days.findIndex(d => d >= start); return i < 0 ? days.length : i; }, [days, start]);
  const hi = useMemo(() => { if (!end) return days.length - 1; let i = days.length - 1; while (i >= 0 && days[i] > end) i--; return i; }, [days, end]);

  // Per-ad totals for the range, then ad set / campaign roll-ups.
  const tree = useMemo(() => {
    if (!attr) return null;
    const camps = attr.campaigns.map((c, i) => ({ kind: "c", i, key: `c:${i}`, name: c[1], status: c[2], db: c[3], lb: c[4], id: c[5] || "", v: zero(), kids: [], ads: [] }));
    const sets = attr.adsets.map((s, i) => ({ kind: "s", i, key: `s:${i}`, name: s[1], ci: s[2], status: s[3], db: s[4], lb: s[5], id: s[6] || "", v: zero(), kids: [] }));
    for (const s of sets) camps[s.ci]?.kids.push(s);
    const ads = attr.ads.map((a, i) => {
      const v = zero();
      for (const r of a[5]) if (r[0] >= lo && r[0] <= hi) add(v, r);
      const set = sets[a[2]];
      const node = { kind: "a", i, key: `a:${i}`, id: a[0], name: a[1], si: a[2], ci: set?.ci, status: a[3], account: a[4], v, dd: a[5], img: a[6] || "", video: a[7] || "" };
      if (set) {
        set.kids.push(node); for (let j = 0; j < N; j++) set.v[j] += v[j];
        if (!set.account && node.account) set.account = node.account;
        const c = camps[set.ci]; if (c && !c.account && node.account) c.account = node.account;
      }
      return node;
    });
    for (const s of sets) { const c = camps[s.ci]; if (c) for (let j = 0; j < N; j++) c.v[j] += s.v[j]; }
    // Campaign / ad set with no status from Meta: "On" if any of its ads is.
    for (const s of sets) if (!s.status) s.status = s.kids.find(a => isOn(a.status))?.status || s.kids[0]?.status || "";
    for (const c of camps) if (!c.status) c.status = c.kids.find(s => isOn(s.status))?.status || c.kids[0]?.status || "";
    return { camps, sets, ads };
  }, [attr, lo, hi]);

  // Ads feeding the charts: the ticked rows (any level), else everything.
  const chartAds = useMemo(() => {
    if (!tree) return [];
    if (!picked.size) return tree.ads;
    return tree.ads.filter(a => picked.has(a.key) || picked.has(`s:${a.si}`) || picked.has(`c:${a.ci}`));
  }, [tree, picked]);

  const series = useMemo(() => {
    const t = new Map();
    for (const a of chartAds) for (const r of a.dd) {
      if (r[0] < lo || r[0] > hi) continue;
      const v = t.get(r[0]) || zero();
      add(v, r);
      t.set(r[0], v);
    }
    const out = [];
    for (let i = lo; i <= hi; i++) out.push({ day: days[i], label: shortDay(days[i]), ...kpis(t.get(i) || zero()) });
    return out;
  }, [chartAds, lo, hi, days]);

  const total = useMemo(() => {
    const v = zero();
    for (const a of chartAds) for (let j = 0; j < N; j++) v[j] += a.v[j];
    return kpis(v);
  }, [chartAds]);

  if (!attr) return <div style={{ ...card, color: MUTED, fontSize: 13 }}>Attribution data appears after the next data refresh.</div>;

  // ---- table rows ----
  const match = n => !q || n.name.toLowerCase().includes(q.toLowerCase());
  const visible = n => (n.v[0] > 0 || isOn(n.status)) && (!activeOnly || isOn(n.status));
  const val = (n, k) => { const m = kpis(n.v); return k === "name" ? n.name.toLowerCase() : k === "budget" ? (n.db || n.lb || 0) : m[k] ?? -1; };
  const sorter = (a, b) => { const x = val(a, sort[0]), y = val(b, sort[0]); return x < y ? -sort[1] : x > y ? sort[1] : 0; };
  const top = (level === "campaign" ? tree.camps : level === "adset" ? tree.sets : tree.ads).filter(n => visible(n) && match(n)).sort(sorter);
  const toggle = (set, setter, k) => { const s = new Set(set); s.has(k) ? s.delete(k) : s.add(k); setter(s); };
  const shownTotal = kpis(top.reduce((v, n) => { for (let j = 0; j < N; j++) v[j] += n.v[j]; return v; }, zero()));

  const ALL_COLS = [
    ["budget", "Budget", n => (n.kind === "a" ? "—" : budgetText(n.db, n.lb))],
    ["spend", "Spend", n => money(n.m.spend)],
    ["proas", "ROAS", n => x2(n.m.proas), "tw"], ["mroas", "ROAS", n => x2(n.m.mroas), "meta"],
    ["ncroas", "NC ROAS", n => x2(n.m.ncroas), "tw"],
    ["prev", "Revenue", n => money(n.m.prev), "tw"], ["mrev", "Revenue", n => money(n.m.mrev), "meta"],
    ["pcpa", "CPA", n => money(n.m.pcpa), "tw"], ["mcpa", "CPA", n => money(n.m.mcpa), "meta"],
    ["nccpa", "NC CPA", n => money(n.m.nccpa), "tw"],
    ["pord", "Orders", n => int(n.m.pord), "tw"], ["mord", "Orders", n => int(n.m.mord), "meta"],
    ["ctr", "CTR", n => pct(n.m.ctr)], ["cpc", "CPC", n => money(n.m.cpc)],
    ["cpm", "CPM", n => money(n.m.cpm)], ["cvr", "CVR", n => pct(n.m.cvr)],
    ["nvp", "% New Vis.", n => (n.m.nvp == null ? "—" : `${n.m.nvp.toFixed(1)}%`), "tw"],
  ];
  const colKeys = ALL_COLS.map(c => c[0]);
  const order = colLayout ? [...colLayout.order.filter(k => colKeys.includes(k)), ...colKeys.filter(k => !colLayout.order.includes(k))] : colKeys;
  const hidden = new Set(colLayout?.hidden || []);
  const byKey = Object.fromEntries(ALL_COLS.map(c => [c[0], c]));
  const COLS = order.filter(k => !hidden.has(k)).map(k => byKey[k]);
  const moveCol = (from, to) => {
    if (!from || from === to) return;
    const o = order.filter(k => k !== from);
    o.splice(o.indexOf(to) + (order.indexOf(from) < order.indexOf(to) ? 1 : 0), 0, from);
    setColLayout({ order: o, hidden: [...hidden] });
  };
  const toggleCol = k => { const h = new Set(hidden); h.has(k) ? h.delete(k) : h.add(k); setColLayout({ order, hidden: [...h] }); };
  const colName = ([, label, , src]) => `${label}${src ? (src === "tw" ? " (TW)" : " (Meta)") : ""}`;
  const th = { padding: "9px 10px", fontSize: 10, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "right", whiteSpace: "nowrap", cursor: "pointer", borderBottom: `2px solid ${LINE}`, background: "#FDF9F6", position: "sticky", top: 0 };
  const td = { padding: "8px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap", borderBottom: `1px solid #F5EDE5`, color: INK, fontVariantNumeric: "tabular-nums" };
  const chip = src => (
    <span style={{ marginLeft: 4, fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, color: "#fff", background: src === "tw" ? TW : META }}>{src === "tw" ? "TW" : "META"}</span>
  );

  const rowsOut = [];
  const pushRow = (n, depth) => {
    n.m = kpis(n.v);
    const kids = n.kind === "c" ? n.kids.filter(visible).sort(sorter) : n.kind === "s" ? n.kids.filter(visible).sort(sorter) : [];
    rowsOut.push({ n, depth, canOpen: kids.length > 0 });
    if (open.has(n.key)) for (const k of kids) pushRow(k, depth + 1);
  };
  for (const n of top.slice(0, limit)) pushRow(n, 0);

  // ---- funnel ----
  const steps = [
    ["lpv", "Landing page views"], ["view", "Product views"], ["atc", "Add to cart"], ["ic", "Checkout started"], ["mord", "Purchases"],
  ].map(([k, label]) => ({ k, label, value: total[k] || 0 }));
  const funnel = steps.map((s, i) => ({ ...s, step: i && steps[i - 1].value ? (s.value / steps[i - 1].value) * 100 : null }));

  const lensRoas = lens === "meta" ? "mroas" : "proas";
  const lensCpa = lens === "meta" ? "mcpa" : "pcpa";
  const svKey = spendVs === "roas" ? lensRoas : lensCpa;
  const svFmt = spendVs === "roas" ? (v => (v == null ? "—" : `${v.toFixed(2)}x`)) : money;
  const lensColor = lens === "meta" ? META : TW;
  const REV = {
    rev: ["mrev", "prev", money, "Revenue"], orders: ["mord", "pord", int, "Orders"], aov: ["maov", "paov", money, "AOV"],
  }[revMetric];
  const LINES = {
    cpc: ["CPC (outbound)", money], cvr: ["CVR", v => pct(v)], ctr: ["CTR (outbound)", v => pct(v)],
    cpm: ["CPM", money], mcpa: ["CPA (Meta)", money], maov: ["AOV (Meta)", money],
    nvp: ["% New Visitors", v => (v == null ? "—" : `${v.toFixed(1)}%`)],
    ncroas: ["NC ROAS (TW)", v => (v == null ? "—" : `${v.toFixed(2)}x`)], nccpa: ["NC CPA (TW)", money],
  };
  const pickedNote = picked.size ? `${picked.size} row${picked.size > 1 ? "s" : ""} ticked` : "All Meta";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: MUTED }}>
          Charts show <b style={{ color: INK }}>{pickedNote}</b> for the selected dates. Tick rows below to chart just those.
          {picked.size > 0 && <button onClick={() => setPicked(new Set())} style={{ marginLeft: 8, border: `1px solid ${LINE}`, background: "#fff", borderRadius: 6, fontSize: 11, padding: "2px 8px", cursor: "pointer", color: INK }}>Clear</button>}
        </div>
        <div style={{ display: "flex", gap: 10, fontSize: 11, color: MUTED }}>
          <span>{chip("tw")} {attr.tw_label || "Triple Whale pixel"}</span>
          <span>{chip("meta")} Meta-reported, 7-day click / 1-day view</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 16 }}>
        {/* 1. Spend vs ROAS / CPA */}
        <div style={card}>
          <div style={head}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <b style={{ fontSize: 12, color: INK }}>Spend vs</b>
              <Seg options={[["roas", "ROAS"], ["cpa", "CPA"]]} value={spendVs} onChange={setSpendVs} />
              <Seg options={[["meta", "Meta"], ["tw", "TW"]]} value={lens} onChange={setLens} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>{stat("Spend", money(total.spend))}{stat(spendVs.toUpperCase(), svFmt(total[svKey]), lensColor)}</div>
          </div>
          <ResponsiveContainer width="100%" height={92}>
            <ComposedChart data={series} syncId="attr" margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#F3EAE2" vertical={false} />
              <XAxis dataKey="label" hide />
              <YAxis tick={axis} width={38} tickFormatter={v => (spendVs === "roas" ? v.toFixed(1) : `$${Math.round(v)}`)} />
              <Tooltip content={<TipBox rows={[[svKey, spendVs === "roas" ? `ROAS (${lens === "meta" ? "Meta" : "TW"})` : `CPA (${lens === "meta" ? "Meta" : "TW"})`, svFmt, lensColor], ["spend", "Spend", money, SPEND]]} />} />
              <Line type="monotone" dataKey={svKey} stroke={lensColor} strokeWidth={2} dot={series.length < 3 ? { r: 4 } : false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
          <ResponsiveContainer width="100%" height={96}>
            <BarChart data={series} syncId="attr" margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#F3EAE2" vertical={false} />
              <XAxis dataKey="label" tick={axis} minTickGap={18} />
              <YAxis tick={axis} width={38} tickFormatter={v => (v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${v}`)} />
              <Tooltip content={<TipBox rows={[["spend", "Spend", money, SPEND], [svKey, spendVs.toUpperCase(), svFmt, lensColor]]} />} cursor={{ fill: "rgba(204,97,56,0.06)" }} />
              <Bar dataKey="spend" fill={SPEND} radius={[4, 4, 0, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 10, color: MUTED, textAlign: "right" }}>top: {spendVs.toUpperCase()} · bottom: spend</div>
        </div>

        {/* 2. Revenue / Orders / AOV, TW vs Meta */}
        <div style={card}>
          <div style={head}>
            <Seg options={[["rev", "Revenue"], ["orders", "Orders"], ["aov", "AOV"]]} value={revMetric} onChange={setRevMetric} />
            <div style={{ display: "flex", gap: 10 }}>{stat("TW", REV[2](total[REV[1]]), TW)}{stat("Meta", REV[2](total[REV[0]]), META)}</div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#F3EAE2" vertical={false} />
              <XAxis dataKey="label" tick={axis} minTickGap={18} />
              <YAxis tick={axis} width={42} tickFormatter={v => (revMetric === "orders" ? v : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${Math.round(v)}`)} />
              <Tooltip content={<TipBox rows={[[REV[1], `${REV[3]} (TW)`, REV[2], TW], [REV[0], `${REV[3]} (Meta)`, REV[2], META]]} />} />
              <Line type="monotone" dataKey={REV[1]} stroke={TW} strokeWidth={2} dot={series.length < 3 ? { r: 4 } : false} connectNulls />
              <Line type="monotone" dataKey={REV[0]} stroke={META} strokeWidth={2} dot={series.length < 3 ? { r: 4 } : false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ display: "flex", gap: 12, fontSize: 10, color: MUTED, justifyContent: "flex-end" }}>
            <span><span style={{ display: "inline-block", width: 10, height: 2, background: TW, verticalAlign: "middle", marginRight: 4 }} />Triple Whale</span>
            <span><span style={{ display: "inline-block", width: 10, height: 2, background: META, verticalAlign: "middle", marginRight: 4 }} />Meta</span>
          </div>
        </div>

        {/* 3. Funnel (Meta-reported) */}
        {(attr.has_funnel || attr.meta_api) && <div style={card}>
          <div style={head}>
            <b style={{ fontSize: 12, color: INK }}>Funnel</b>
            <div style={{ display: "flex", gap: 10 }}>{stat("Click → purchase", pct(total.cvr))}</div>
          </div>
          {attr.has_funnel ? (
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={funnel} margin={{ top: 18, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#F3EAE2" vertical={false} />
                <XAxis dataKey="label" tick={{ ...axis, fontSize: 9 }} interval={0} />
                <YAxis tick={axis} width={42} tickFormatter={v => (v >= 1000 ? `${Math.round(v / 1000)}K` : v)} />
                <Tooltip content={<TipBox rows={[["value", "Count", int, META], ["step", "From previous step", pct, MUTED]]} />} cursor={{ fill: "rgba(2,132,199,0.05)" }} />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={48}>
                  {funnel.map((f, i) => <Cell key={f.k} fill={i === funnel.length - 1 ? "#16A34A" : "#9CC9E4"} />)}
                  <LabelList dataKey="step" position="top" formatter={v => (v == null ? "" : `${v.toFixed(1)}%`)} style={{ fontSize: 10, fill: INK, fontWeight: 600 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 210, display: "flex", alignItems: "center", justifyContent: "center", color: MUTED, fontSize: 12, textAlign: "center", padding: 12 }}>
              Funnel counts (landing page views → product views → add to cart → checkout) arrive with the next Meta refresh.
            </div>
          )}
          <div style={{ fontSize: 10, color: MUTED, textAlign: "right" }}>Meta-reported events · % = share of the previous step</div>
        </div>}

        {/* 4. Metric picker */}
        <div style={card}>
          <div style={{ ...head, marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {Object.entries(LINES).map(([k, [label]]) => (
                <button key={k} onClick={() => setLineMetric(k)} style={{
                  border: `1px solid ${lineMetric === k ? INK : LINE}`, borderRadius: 999, padding: "3px 9px", fontSize: 10, fontWeight: 600, cursor: "pointer",
                  background: lineMetric === k ? INK : "#fff", color: lineMetric === k ? "#fff" : MUTED,
                }}>{label}</button>
              ))}
            </div>
            {stat(LINES[lineMetric][0], LINES[lineMetric][1](total[lineMetric]))}
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#F3EAE2" vertical={false} />
              <XAxis dataKey="label" tick={axis} minTickGap={18} />
              <YAxis tick={axis} width={42} tickFormatter={v => (lineMetric === "ncroas" ? `${v.toFixed(1)}x` : ["cvr", "ctr", "nvp"].includes(lineMetric) ? `${v.toFixed(1)}%` : `$${v >= 100 ? Math.round(v) : v.toFixed(1)}`)} />
              <Tooltip content={<TipBox rows={[[lineMetric, LINES[lineMetric][0], LINES[lineMetric][1], "#7C3AED"]]} />} />
              <Line type="monotone" dataKey={lineMetric} stroke="#7C3AED" strokeWidth={2} dot={series.length < 3 ? { r: 4 } : false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Table */}
      <div style={{ ...card, padding: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "12px 14px", borderBottom: `1px solid ${LINE}` }}>
          <div style={{ display: "flex", gap: 4 }}>
            {[["campaign", "Campaigns"], ["adset", "Ad Sets"], ["ad", "Ads"]].map(([k, label]) => (
              <button key={k} onClick={() => { setLevel(k); setLimit(100); }} style={{
                border: "none", borderBottom: `2px solid ${level === k ? accent : "transparent"}`, background: "none",
                padding: "6px 10px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: level === k ? accent : MUTED,
              }}>{label}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ position: "relative" }}>
              <button onClick={() => setColMenu(v => !v)} style={{ border: `1px solid ${LINE}`, background: colMenu ? "#F3F4F6" : "#fff", borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 600, color: INK, cursor: "pointer" }}>
                Columns{hidden.size ? ` (${COLS.length}/${ALL_COLS.length})` : ""} ▾
              </button>
              {colMenu && (
                <>
                  <div onClick={() => setColMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
                  <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 21, background: "#fff", border: `1px solid ${LINE}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: 8, width: 230, maxHeight: 420, overflowY: "auto" }}>
                    <div style={{ fontSize: 11, color: MUTED, padding: "2px 6px 8px" }}>Tick to show. Drag rows (or the table headers) to reorder.</div>
                    {order.map(k => (
                      <label key={k} draggable
                        onDragStart={e => { setDragCol(k); e.dataTransfer.effectAllowed = "move"; }}
                        onDragOver={e => { e.preventDefault(); setOverCol(k); }}
                        onDrop={e => { e.preventDefault(); moveCol(dragCol, k); setDragCol(null); setOverCol(null); }}
                        onDragEnd={() => { setDragCol(null); setOverCol(null); }}
                        style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 6px", borderRadius: 6, fontSize: 12, color: INK, cursor: "grab",
                          background: overCol === k && dragCol && dragCol !== k ? "#F6EDE5" : "transparent", opacity: dragCol === k ? 0.4 : 1 }}>
                        <span style={{ color: "#9CA3AF", fontSize: 11 }}>⋮⋮</span>
                        <input type="checkbox" checked={!hidden.has(k)} onChange={() => toggleCol(k)} />
                        {colName(byKey[k])}
                      </label>
                    ))}
                    <button onClick={() => setColLayout(null)} disabled={!colLayout}
                      style={{ marginTop: 6, width: "100%", border: `1px solid ${LINE}`, background: "#fff", borderRadius: 6, padding: "6px 8px", fontSize: 12, color: colLayout ? INK : "#9CA3AF", cursor: colLayout ? "pointer" : "default" }}>Reset to default</button>
                  </div>
                </>
              )}
            </div>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: INK, cursor: "pointer" }}>
              <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} /> Active only
            </label>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${level === "campaign" ? "campaigns" : level === "adset" ? "ad sets" : "ads"}`}
              style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: "6px 10px", fontSize: 12, width: 220, maxWidth: "50vw" }} />
          </div>
        </div>
        <div style={{ overflowX: "auto", maxHeight: 640, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 28, cursor: "default" }} />
                <th style={{ ...th, textAlign: "left", cursor: "default" }}>Status</th>
                <th style={{ ...th, textAlign: "center", cursor: "default" }}>Preview</th>
                <th style={{ ...th, textAlign: "left", minWidth: 280 }} onClick={() => setSort(["name", sort[0] === "name" ? -sort[1] : 1])}>Name{sort[0] === "name" ? (sort[1] < 0 ? " ↓" : " ↑") : ""}</th>
                {COLS.map(([k, label, , src]) => (
                  <th key={k} draggable title="Click to sort · drag to move"
                    onDragStart={e => { setDragCol(k); e.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={e => { e.preventDefault(); setOverCol(k); }}
                    onDrop={e => { e.preventDefault(); moveCol(dragCol, k); setDragCol(null); setOverCol(null); }}
                    onDragEnd={() => { setDragCol(null); setOverCol(null); }}
                    style={{ ...th, opacity: dragCol === k ? 0.4 : 1,
                      boxShadow: overCol === k && dragCol && dragCol !== k ? `inset ${order.indexOf(dragCol) < order.indexOf(k) ? "-3px" : "3px"} 0 0 ${accent}` : "none" }}
                    onClick={() => setSort([k, sort[0] === k ? -sort[1] : -1])}>
                    {label}{src && chip(src)}{sort[0] === k ? (sort[1] < 0 ? " ↓" : " ↑") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowsOut.map(({ n, depth, canOpen }) => {
                const url = n.kind === "a" ? adsManagerUrl(n.account, [n.id])
                  : n.id ? (n.kind === "c" ? campaignUrl(n.account, n.id) : adsetUrl(n.account, n.id)) : null;
                const isPicked = picked.has(n.key);
                return (
                  <tr key={n.key} style={{ background: isPicked ? "#FFF6F0" : depth ? "#FDFBF9" : "#fff" }}>
                    <td style={{ ...td, textAlign: "center" }}>
                      <input type="checkbox" checked={isPicked} onChange={() => toggle(picked, setPicked, n.key)} title="Chart this row" />
                    </td>
                    <td style={{ ...td, textAlign: "left" }}><StatusDot status={n.status} /></td>
                    <td style={{ ...td, textAlign: "center", padding: "4px 8px", width: 56 }}>
                      {n.kind === "a" && n.img ? (
                        <button onClick={() => setPreview({ name: n.name, image: n.img, video: n.video, managerUrl: url })}
                          title={playable(n.video) ? "Play the video" : "View the ad"} style={{ position: "relative", display: "inline-block", lineHeight: 0, padding: 0, border: "none", background: "none", cursor: "pointer" }}>
                          <img src={n.img} alt="" loading="lazy" referrerPolicy="no-referrer"
                            onError={e => { e.currentTarget.style.display = "none"; }}
                            style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 4, border: `1px solid ${LINE}`, display: "block" }} />
                          {playable(n.video) && <PlayBadge />}
                        </button>
                      ) : null}
                    </td>
                    <td style={{ ...td, textAlign: "left", maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", paddingLeft: 10 + depth * 18 }} title={n.name}>
                      {canOpen ? (
                        <button onClick={() => toggle(open, setOpen, n.key)} style={{ border: "none", background: "none", cursor: "pointer", color: MUTED, padding: "0 6px 0 0", fontSize: 11 }}>{open.has(n.key) ? "▾" : "▸"}</button>
                      ) : <span style={{ display: "inline-block", width: 17 }} />}
                      {depth > 0 && <span style={{ fontSize: 9, color: MUTED, marginRight: 6, textTransform: "uppercase" }}>{n.kind === "s" ? "ad set" : "ad"}</span>}
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" onClick={e => openExternal(e, url)} title={`${n.name}\nOpen in Ads Manager`} style={{ color: INK, textDecoration: "none", borderBottom: `1px dotted ${MUTED}` }}>{n.name}</a>
                      ) : n.name}
                    </td>
                    {COLS.map(([k, , f]) => <td key={k} style={td}>{f(n)}</td>)}
                  </tr>
                );
              })}
              {!rowsOut.length && (
                <tr><td colSpan={COLS.length + 4} style={{ ...td, textAlign: "center", color: MUTED, padding: 24 }}>Nothing spent in this date range{activeOnly ? " among active rows" : ""}.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr style={{ background: "#FDF9F6" }}>
                <td style={{ ...td, fontWeight: 700 }} />
                <td style={{ ...td, fontWeight: 700, textAlign: "left" }} colSpan={3}>Total · {top.length.toLocaleString()} {level === "campaign" ? "campaigns" : level === "adset" ? "ad sets" : "ads"}</td>
                {COLS.map(([k, , f]) => <td key={k} style={{ ...td, fontWeight: 700 }}>{k === "budget" ? "" : f({ kind: "t", m: shownTotal })}</td>)}
              </tr>
            </tfoot>
          </table>
        </div>
        {top.length > limit && (
          <div style={{ padding: 10, textAlign: "center" }}>
            <button onClick={() => setLimit(limit + 200)} style={{ border: `1px solid ${LINE}`, background: "#fff", borderRadius: 8, padding: "6px 14px", fontSize: 12, cursor: "pointer", color: INK }}>
              Show more ({(top.length - limit).toLocaleString()} left)
            </button>
          </div>
        )}
        <div style={{ padding: "8px 14px 12px", fontSize: 11, color: MUTED }}>
          {attr.meta_api ? "Status and budgets are read from Meta (view only)." : "Status = spent on the latest day of data (no Meta connection, so no budgets)."} CVR = Meta purchases ÷ outbound clicks. {attr.note || ""}
          Rows show anything that spent in the selected dates, plus everything currently on.
        </div>
      </div>
      <AdPreview ad={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
