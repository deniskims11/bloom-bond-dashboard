import { useMemo, useState } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";

// Day-by-day performance for any set of creatives, inside the date range the
// calendar has selected. Reads the per-ad daily rows (a.dd) from the manifest:
//   [dayIdx, spend, rev, orders, nc_rev, nc_orders, new_visitors, visitors, impressions, clicks, ...]

const money = v => (v == null ? "—" : `$${Math.round(v).toLocaleString()}`);
const x2 = v => (v == null ? "—" : `${v.toFixed(2)}x`);
const pct = v => (v == null ? "—" : `${v.toFixed(1)}%`);

export function dailyRows(ads, days, startIso, endIso) {
  const lo = startIso ? days.findIndex(d => d >= startIso) : 0;
  const hiRev = endIso ? [...days].reverse().findIndex(d => d <= endIso) : 0;
  const hi = hiRev < 0 ? -1 : days.length - 1 - hiRev;
  if (lo < 0 || hi < lo) return [];
  const t = new Map();
  for (const a of ads) for (const r of a.dd || []) {
    if (r[0] < lo || r[0] > hi) continue;
    const v = t.get(r[0]) || [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let j = 0; j < 9; j++) v[j] += r[j + 1] || 0;
    t.set(r[0], v);
  }
  const out = [];
  for (let i = hi; i >= lo; i--) {
    const [spend, rev, orders, nc_rev, nc_orders, nv, vis, imps, clicks] = t.get(i) || [0, 0, 0, 0, 0, 0, 0, 0, 0];
    out.push({
      date: days[i], spend, rev, orders, nc_rev, nc_orders, imps, clicks, nv, vis,
      roas: spend ? rev / spend : null, ncroas: spend ? nc_rev / spend : null,
      cpa: orders ? spend / orders : null, cpc: clicks ? spend / clicks : null,
      ctr: imps ? (clicks / imps) * 100 : null, cpm: imps ? (spend / imps) * 1000 : null,
      nvp: vis ? (nv / vis) * 100 : null,
      aov: orders ? rev / orders : null, cvr: clicks ? (orders / clicks) * 100 : null,
    });
  }
  return out; // newest first
}

const derive = (r) => ({
  ...r,
  roas: r.spend ? r.rev / r.spend : null, ncroas: r.spend ? r.nc_rev / r.spend : null,
  cpa: r.orders ? r.spend / r.orders : null, cpc: r.clicks ? r.spend / r.clicks : null,
  ctr: r.imps ? (r.clicks / r.imps) * 100 : null, cpm: r.imps ? (r.spend / r.imps) * 1000 : null,
  nvp: r.vis ? (r.nv / r.vis) * 100 : null, aov: r.orders ? r.rev / r.orders : null,
  cvr: r.clicks ? (r.orders / r.clicks) * 100 : null,
});
const mondayOf = (iso) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

// Daily rows (newest first) -> week (Mon start) or month chunks, newest first.
export function groupRows(rows, gran) {
  if (gran === "day") return rows;
  const m = new Map();
  for (const r of rows) {
    const k = gran === "week" ? mondayOf(r.date) : r.date.slice(0, 7);
    const t = m.get(k) || { date: k, first: r.date, last: r.date, n: 0, spend: 0, rev: 0, orders: 0, nc_rev: 0, nc_orders: 0, imps: 0, clicks: 0, nv: 0, vis: 0 };
    for (const f of ["spend", "rev", "orders", "nc_rev", "nc_orders", "imps", "clicks", "nv", "vis"]) t[f] += r[f] || 0;
    t.first = r.date < t.first ? r.date : t.first; t.last = r.date > t.last ? r.date : t.last; t.n += 1;
    m.set(k, t);
  }
  return [...m.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).map(derive);
}

// Metrics the chart can plot (each on its own scale, like Moby's metric picker).
export const DAILY_METRICS = [
  { key: "roas", label: "ROAS", color: "#CC6138", fmt: v => `${v.toFixed(2)}x` },
  { key: "ncroas", label: "NCROAS", color: "#0ea5e9", fmt: v => `${v.toFixed(2)}x`, nc: true },
  { key: "cpa", label: "CPA", color: "#d97706", fmt: v => `$${v.toFixed(0)}` },
  { key: "cpc", label: "CPC", color: "#16a34a", fmt: v => `$${v.toFixed(2)}` },
  { key: "ctr", label: "CTR", color: "#9333ea", fmt: v => `${v.toFixed(2)}%` },
  { key: "cvr", label: "CVR", color: "#db2777", fmt: v => `${v.toFixed(2)}%` },
  { key: "cpm", label: "CPM", color: "#475569", fmt: v => `$${v.toFixed(2)}` },
  { key: "aov", label: "AOV", color: "#0d9488", fmt: v => `$${v.toFixed(0)}` },
  { key: "nvp", label: "% New Vis.", color: "#ca8a04", fmt: v => `${v.toFixed(1)}%` },
];

export default function DailyView({ ads, days, start, end, roasLabel = "ROAS", hasNc = true, showTable = true }) {
  const rows = useMemo(() => dailyRows(ads, days || [], start, end), [ads, days, start, end]);
  const [picked, setPicked] = useState(["roas", "ncroas"]);
  const [gran, setGran] = useState("day");
  const grouped = useMemo(() => groupRows(rows, gran), [rows, gran]);
  const label = r => gran === "day" ? r.date : gran === "week" ? `${r.first} → ${r.last}${r.n < 7 ? ` (${r.n}d)` : ""}` : `${r.date}${r.n < 28 ? ` (${r.n}d)` : ""}`;
  // Change vs the previous (older) chunk: WoW / MoM / DoD.
  const chg = (i, key, inverse = false) => {
    const row = grouped[i], prev = grouped[i + 1];
    if (!prev || prev[key] == null || !prev[key] || row[key] == null) return null;
    // Totals over chunks of different length (partial week / month) compare per-day pace.
    const pace = ["spend", "rev", "nc_rev", "orders"].includes(key) && gran !== "day" && row.n !== prev.n;
    const cur = pace ? row[key] / row.n : row[key], base = pace ? prev[key] / prev.n : prev[key];
    const c = ((cur - base) / Math.abs(base)) * 100; const good = inverse ? c < 0 : c > 0;
    return <div title={pace ? "per-day pace (chunks have different lengths)" : `${cmpName} change`} style={{ fontSize: 9, fontWeight: 700, color: good ? "#15803d" : "#b91c1c" }}>{c >= 0 ? "↗" : "↘"}{Math.abs(c) >= 999 ? "999+" : Math.abs(c).toFixed(0)}%{pace ? "/d" : ""}</div>;
  };
  const cmpName = gran === "day" ? "DoD" : gran === "week" ? "WoW" : "MoM";
  if (!days || !days.length) return <p style={{ fontSize: 12, color: "#8a6f68" }}>Daily data is not available in this build.</p>;
  if (!rows.length) return <p style={{ fontSize: 12, color: "#8a6f68" }}>No days in the selected range.</p>;
  const tot = rows.reduce((t, r) => { for (const k of ["spend", "rev", "orders", "nc_rev", "imps", "clicks"]) t[k] += r[k]; return t; },
    { spend: 0, rev: 0, orders: 0, nc_rev: 0, imps: 0, clicks: 0 });
  const chart = [...grouped].reverse().map(r => ({ ...r, day: gran === "month" ? r.date : r.date.slice(5) }));
  const th = { padding: "6px 8px", fontSize: 10, fontWeight: 700, color: "#8a6f68", textTransform: "uppercase", textAlign: "right", position: "sticky", top: 0, background: "#fff" };
  const td = { padding: "6px 8px", fontSize: 11, textAlign: "right", borderBottom: "1px solid #F5EDE5" };
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#8a6f68" }}>Aggregate by</span>
        <div style={{ display: "flex", gap: 3, background: "#F6E6D9", borderRadius: 7, padding: 2 }}>
          {[["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"]].map(([k, l]) => (
            <button key={k} onClick={() => setGran(k)} style={{ padding: "4px 12px", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600,
              background: gran === k ? "#CC6138" : "transparent", color: gran === k ? "#fff" : "#8a6f68" }}>{l}</button>
          ))}
        </div>
        {gran !== "day" && <span style={{ fontSize: 10, color: "#b0978f" }}>{gran === "week" ? "Mon–Sun weeks" : "calendar months"}, clipped to the selected range · arrows = {cmpName} change</span>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginBottom: 6 }}>
        {DAILY_METRICS.filter(m => hasNc || !m.nc).map(m => {
          const on = picked.includes(m.key);
          const t = m.key === "roas" ? (tot.spend ? tot.rev / tot.spend : null) : m.key === "ncroas" ? (tot.spend ? tot.nc_rev / tot.spend : null)
            : m.key === "cpa" ? (tot.orders ? tot.spend / tot.orders : null) : m.key === "cpc" ? (tot.clicks ? tot.spend / tot.clicks : null)
            : m.key === "ctr" ? (tot.imps ? tot.clicks / tot.imps * 100 : null) : m.key === "cvr" ? (tot.clicks ? tot.orders / tot.clicks * 100 : null)
            : m.key === "cpm" ? (tot.imps ? tot.spend / tot.imps * 1000 : null) : m.key === "aov" ? (tot.orders ? tot.rev / tot.orders : null) : null;
          return (
            <label key={m.key} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer", color: on ? "#3a2429" : "#8a6f68" }}>
              <input type="checkbox" checked={on} onChange={() => setPicked(p => on ? p.filter(k => k !== m.key) : [...p, m.key])} style={{ accentColor: m.color }} />
              <span style={{ fontWeight: 600, color: on ? m.color : undefined }}>{m.key === "roas" ? roasLabel : m.label}</span>
              {t != null && <span style={{ color: "#8a6f68" }}>{m.fmt(t)}</span>}
            </label>
          );
        })}
      </div>
      <div style={{ height: 230, marginBottom: 10 }}>
        <ResponsiveContainer>
          <ComposedChart data={chart} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#F0E6DD" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 10 }} />
            <YAxis yAxisId="l" tick={{ fontSize: 10 }} tickFormatter={v => `$${v >= 1000 ? Math.round(v / 1000) + "K" : v}`} />
            {DAILY_METRICS.filter(m => picked.includes(m.key)).map((m, i) => (
              <YAxis key={m.key} yAxisId={m.key} orientation="right" hide={i > 0} tick={{ fontSize: 10 }} tickFormatter={v => m.fmt(v)} width={i > 0 ? 0 : 52} />
            ))}
            <Tooltip formatter={(v, n) => { const m = DAILY_METRICS.find(x => x.label === n || (x.key === "roas" && n === roasLabel)); return v == null ? "—" : m ? m.fmt(v) : money(v); }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="l" dataKey="spend" name="Spend" fill="#E8DCD0" radius={[3, 3, 0, 0]} />
            {DAILY_METRICS.filter(m => picked.includes(m.key) && (hasNc || !m.nc)).map(m => (
              <Line key={m.key} yAxisId={m.key} dataKey={m.key} name={m.key === "roas" ? roasLabel : m.label} stroke={m.color} strokeWidth={2} dot={{ r: 2 }} connectNulls />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {showTable && (
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
            <th style={{ ...th, textAlign: "left" }}>{gran === "day" ? "Day" : gran === "week" ? "Week" : "Month"}</th>
            <th style={th}>Spend</th><th style={th}>Revenue</th><th style={th}>{roasLabel}</th>
            {hasNc && <th style={th}>NC rev</th>}{hasNc && <th style={th}>NCROAS</th>}
            <th style={th}>Orders</th><th style={th}>CVR</th><th style={th}>AOV</th><th style={th}>CPA</th><th style={th}>CTR</th><th style={th}>CPC</th><th style={th}>CPM</th><th style={th}>% New Vis.</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ background: "#FBF5F0", fontWeight: 700 }}>
            <td style={{ ...td, textAlign: "left" }}>Total ({rows.length} days{gran !== "day" ? ` · ${grouped.length} ${gran}s` : ""})</td>
            <td style={td}>{money(tot.spend)}</td><td style={td}>{money(tot.rev)}</td>
            <td style={td}>{x2(tot.spend ? tot.rev / tot.spend : null)}</td>
            {hasNc && <td style={td}>{money(tot.nc_rev)}</td>}{hasNc && <td style={td}>{x2(tot.spend ? tot.nc_rev / tot.spend : null)}</td>}
            <td style={td}>{Math.round(tot.orders).toLocaleString()}</td>
            <td style={td}>{pct(tot.clicks ? (tot.orders / tot.clicks) * 100 : null)}</td>
            <td style={td}>{tot.orders ? money(tot.rev / tot.orders) : "—"}</td>
            <td style={td}>{tot.orders ? money(tot.spend / tot.orders) : "—"}</td>
            <td style={td}>{pct(tot.imps ? (tot.clicks / tot.imps) * 100 : null)}</td>
            <td style={td}>{tot.clicks ? `$${(tot.spend / tot.clicks).toFixed(2)}` : "—"}</td>
            <td style={td}>{tot.imps ? `$${((tot.spend / tot.imps) * 1000).toFixed(2)}` : "—"}</td>
            <td style={td}>—</td>
          </tr>
          {grouped.map((r, i) => (
            <tr key={r.date}>
              <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "#3a2429" }}>{label(r)}</td>
              <td style={{ ...td, fontWeight: 600 }}>{money(r.spend)}{chg(i, "spend")}</td><td style={td}>{money(r.rev)}{chg(i, "rev")}</td>
              <td style={{ ...td, color: "#6B0010", fontWeight: 600 }}>{x2(r.roas)}{chg(i, "roas")}</td>
              {hasNc && <td style={td}>{money(r.nc_rev)}{chg(i, "nc_rev")}</td>}{hasNc && <td style={{ ...td, color: "#0369a1", fontWeight: 600 }}>{x2(r.ncroas)}{chg(i, "ncroas")}</td>}
              <td style={td}>{Math.round(r.orders).toLocaleString()}{chg(i, "orders")}</td><td style={td}>{pct(r.cvr)}{chg(i, "cvr")}</td><td style={td}>{r.aov == null ? "—" : money(r.aov)}{chg(i, "aov")}</td><td style={td}>{r.cpa == null ? "—" : money(r.cpa)}{chg(i, "cpa", true)}</td>
              <td style={td}>{pct(r.ctr)}{chg(i, "ctr")}</td><td style={td}>{r.cpc == null ? "—" : `$${r.cpc.toFixed(2)}`}{chg(i, "cpc", true)}</td>
              <td style={td}>{r.cpm == null ? "—" : `$${r.cpm.toFixed(2)}`}{chg(i, "cpm", true)}</td><td style={td}>{pct(r.nvp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
    </div>
  );
}
