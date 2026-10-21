import { useMemo } from "react";
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
      date: days[i], spend, rev, orders, nc_rev, nc_orders, imps, clicks,
      roas: spend ? rev / spend : null, ncroas: spend ? nc_rev / spend : null,
      cpa: orders ? spend / orders : null, cpc: clicks ? spend / clicks : null,
      ctr: imps ? (clicks / imps) * 100 : null, cpm: imps ? (spend / imps) * 1000 : null,
      nvp: vis ? (nv / vis) * 100 : null,
    });
  }
  return out; // newest first
}

export default function DailyView({ ads, days, start, end, roasLabel = "ROAS", hasNc = true }) {
  const rows = useMemo(() => dailyRows(ads, days || [], start, end), [ads, days, start, end]);
  if (!days || !days.length) return <p style={{ fontSize: 12, color: "#8a6f68" }}>Daily data is not available in this build.</p>;
  if (!rows.length) return <p style={{ fontSize: 12, color: "#8a6f68" }}>No days in the selected range.</p>;
  const tot = rows.reduce((t, r) => { for (const k of ["spend", "rev", "orders", "nc_rev", "imps", "clicks"]) t[k] += r[k]; return t; },
    { spend: 0, rev: 0, orders: 0, nc_rev: 0, imps: 0, clicks: 0 });
  const chart = [...rows].reverse().map(r => ({ ...r, day: r.date.slice(5) }));
  const th = { padding: "6px 8px", fontSize: 10, fontWeight: 700, color: "#8a6f68", textTransform: "uppercase", textAlign: "right", position: "sticky", top: 0, background: "#fff" };
  const td = { padding: "6px 8px", fontSize: 11, textAlign: "right", borderBottom: "1px solid #F5EDE5" };
  return (
    <div>
      <div style={{ height: 230, marginBottom: 10 }}>
        <ResponsiveContainer>
          <ComposedChart data={chart} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#F0E6DD" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 10 }} />
            <YAxis yAxisId="l" tick={{ fontSize: 10 }} tickFormatter={v => `$${v >= 1000 ? Math.round(v / 1000) + "K" : v}`} />
            <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10 }} tickFormatter={v => `${v.toFixed(1)}x`} />
            <Tooltip formatter={(v, n) => (n === "Spend" ? money(v) : x2(v))} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="l" dataKey="spend" name="Spend" fill="#D8C8BC" radius={[3, 3, 0, 0]} />
            <Line yAxisId="r" dataKey="roas" name={roasLabel} stroke="#6B0010" strokeWidth={2} dot={{ r: 2 }} connectNulls />
            {hasNc && <Line yAxisId="r" dataKey="ncroas" name="NCROAS" stroke="#0ea5e9" strokeWidth={2} dot={{ r: 2 }} connectNulls />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
            <th style={{ ...th, textAlign: "left" }}>Day</th>
            <th style={th}>Spend</th><th style={th}>Revenue</th><th style={th}>{roasLabel}</th>
            {hasNc && <th style={th}>NC rev</th>}{hasNc && <th style={th}>NCROAS</th>}
            <th style={th}>Orders</th><th style={th}>CPA</th><th style={th}>CTR</th><th style={th}>CPC</th><th style={th}>CPM</th><th style={th}>% New Vis.</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ background: "#FBF7F4", fontWeight: 700 }}>
            <td style={{ ...td, textAlign: "left" }}>Total ({rows.length} days)</td>
            <td style={td}>{money(tot.spend)}</td><td style={td}>{money(tot.rev)}</td>
            <td style={td}>{x2(tot.spend ? tot.rev / tot.spend : null)}</td>
            {hasNc && <td style={td}>{money(tot.nc_rev)}</td>}{hasNc && <td style={td}>{x2(tot.spend ? tot.nc_rev / tot.spend : null)}</td>}
            <td style={td}>{Math.round(tot.orders).toLocaleString()}</td>
            <td style={td}>{tot.orders ? money(tot.spend / tot.orders) : "—"}</td>
            <td style={td}>{pct(tot.imps ? (tot.clicks / tot.imps) * 100 : null)}</td>
            <td style={td}>{tot.clicks ? `$${(tot.spend / tot.clicks).toFixed(2)}` : "—"}</td>
            <td style={td}>{tot.imps ? `$${((tot.spend / tot.imps) * 1000).toFixed(2)}` : "—"}</td>
            <td style={td}>—</td>
          </tr>
          {rows.map(r => (
            <tr key={r.date}>
              <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "#3a2429" }}>{r.date}</td>
              <td style={{ ...td, fontWeight: 600 }}>{money(r.spend)}</td><td style={td}>{money(r.rev)}</td>
              <td style={{ ...td, color: "#6B0010", fontWeight: 600 }}>{x2(r.roas)}</td>
              {hasNc && <td style={td}>{money(r.nc_rev)}</td>}{hasNc && <td style={{ ...td, color: "#0369a1", fontWeight: 600 }}>{x2(r.ncroas)}</td>}
              <td style={td}>{Math.round(r.orders).toLocaleString()}</td><td style={td}>{r.cpa == null ? "—" : money(r.cpa)}</td>
              <td style={td}>{pct(r.ctr)}</td><td style={td}>{r.cpc == null ? "—" : `$${r.cpc.toFixed(2)}`}</td>
              <td style={td}>{r.cpm == null ? "—" : `$${r.cpm.toFixed(2)}`}</td><td style={td}>{pct(r.nvp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
