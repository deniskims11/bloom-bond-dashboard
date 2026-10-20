import { useMemo, useState } from "react";

// NVP Bucket Ledger: every creative's spend in each period (day or week) is
// bucketed by its New Visitor % in that period — NVP = new visitors ÷ unique
// visitors — so you can see how much spend goes to ads that bring in fresh
// people vs. ads re-reaching existing visitors, and what each bucket returns.
//
// Reads the per-ad daily rows (a.dd) the build writes:
//   [dayIdx, spend, rev, orders, nc_rev, nc_orders, new_visitors, visitors, impressions, clicks, ...]

const BUCKETS = [
  { key: "b60", label: "NVP 60%+", min: 60, color: "#16a34a", bg: "#EAF6EE" },
  { key: "b50", label: "NVP 50–59%", min: 50, color: "#0284c7", bg: "#E8F3FA" },
  { key: "b40", label: "NVP 40–49%", min: 40, color: "#d97706", bg: "#FBF1E3" },
  { key: "b0", label: "NVP <40%", min: -1, color: "#dc2626", bg: "#FBEAEA" },
];
const bucketOf = (pct) => BUCKETS.find(b => pct >= b.min).key;

const money = (v) => (v == null ? "—" : `$${Math.round(v).toLocaleString()}`);
const x2 = (v) => (v == null ? "—" : `${v.toFixed(2)}x`);
const pct1 = (v) => (v == null ? "—" : `${v.toFixed(1)}%`);
const cpc = (v) => (v == null ? "—" : `$${v.toFixed(2)}`);

const mondayOf = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const plus6 = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
};

const empty = () => ({ spend: 0, rev: 0, nc_rev: 0, clicks: 0, nv: 0, vis: 0, n: 0 });
const add = (t, s) => { t.spend += s.spend; t.rev += s.rev; t.nc_rev += s.nc_rev; t.clicks += s.clicks; t.nv += s.nv; t.vis += s.vis; t.n += 1; };
const derive = (t, total) => ({
  ...t,
  share: total ? (t.spend / total) * 100 : null,
  ncroas: t.spend ? t.nc_rev / t.spend : null,
  roas: t.spend ? t.rev / t.spend : null,
  cpc: t.clicks ? t.spend / t.clicks : null,
  nvp: t.vis ? (t.nv / t.vis) * 100 : null,
});

export default function NvpLedger({ ads, days, baselineNc = 0, roasLabel = "ROAS" }) {
  const products = useMemo(() => {
    const s = new Map();
    for (const a of ads) if (a.product) s.set(a.product, (s.get(a.product) || 0) + (a.metrics?.spend || 0));
    const all = [...s.values()].reduce((x, y) => x + y, 0);
    return [...s.entries()].filter(([, v]) => v >= all * 0.01).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 8);
  }, [ads]);
  const last = days[days.length - 1];
  const firstDefault = days[Math.max(0, days.length - 30)];
  const [product, setProduct] = useState("All");
  const [start, setStart] = useState(firstDefault);
  const [end, setEnd] = useState(last);
  const [rows, setRows] = useState("Week");

  const { periods, totals } = useMemo(() => {
    const lo = days.findIndex(d => d >= start);
    const hiRev = [...days].reverse().findIndex(d => d <= end);
    const hi = hiRev < 0 ? -1 : days.length - 1 - hiRev;
    const per = new Map(); // period -> { all, b60.., noData }
    if (lo < 0 || hi < lo) return { periods: [], totals: null };
    const pool = product === "All" ? ads : ads.filter(a => a.product === product);
    for (const a of pool) {
      // Sum this creative's rows per period first; the bucket is the creative's NVP for that period.
      const own = new Map();
      for (const r of a.dd || []) {
        if (r[0] < lo || r[0] > hi) continue;
        const day = days[r[0]];
        const p = rows === "Week" ? mondayOf(day) : day;
        const t = own.get(p) || { spend: 0, rev: 0, nc_rev: 0, clicks: 0, nv: 0, vis: 0 };
        t.spend += r[1]; t.rev += r[2]; t.nc_rev += r[4]; t.nv += r[6]; t.vis += r[7]; t.clicks += r[9];
        own.set(p, t);
      }
      for (const [p, t] of own) {
        if (!per.has(p)) per.set(p, { all: empty(), noData: empty(), ...Object.fromEntries(BUCKETS.map(b => [b.key, empty()])) });
        const P = per.get(p);
        add(P.all, t);
        if (t.vis > 0) add(P[bucketOf((t.nv / t.vis) * 100)], t); else add(P.noData, t);
      }
    }
    const tot = { all: empty(), noData: empty(), ...Object.fromEntries(BUCKETS.map(b => [b.key, empty()])) };
    const list = [...per.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([p, P]) => {
      for (const k of Object.keys(tot)) {
        tot[k].spend += P[k].spend; tot[k].rev += P[k].rev; tot[k].nc_rev += P[k].nc_rev;
        tot[k].clicks += P[k].clicks; tot[k].nv += P[k].nv; tot[k].vis += P[k].vis; tot[k].n += P[k].n;
      }
      const out = { period: p, label: rows === "Week" ? `${p} to ${plus6(p) > last ? last : plus6(p)}` : p };
      for (const k of Object.keys(P)) out[k] = derive(P[k], P.all.spend);
      return out;
    });
    const T = {};
    for (const k of Object.keys(tot)) T[k] = derive(tot[k], tot.all.spend);
    return { periods: list, totals: T };
  }, [ads, days, product, start, end, rows, last]);

  const ncColor = (v) => (v == null ? "#b0978f" : v >= baselineNc ? "#15803d" : "#b91c1c");
  const btn = (on) => ({
    padding: "5px 12px", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: 600,
    background: on ? "#50000B" : "transparent", color: on ? "#fff" : "#8a6f68",
  });
  const th = { padding: "6px 8px", fontSize: 10, fontWeight: 700, color: "#8a6f68", textTransform: "uppercase", letterSpacing: 0.4, textAlign: "right", whiteSpace: "nowrap" };
  const td = { padding: "7px 8px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap" };

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", background: "#fff", border: "1px solid #E8DCD0", borderRadius: 10, padding: "10px 14px", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#8a6f68", marginRight: 4 }}>PRODUCT</span>
          {["All", ...products].map(p => <button key={p} onClick={() => setProduct(p)} style={btn(product === p)}>{p}</button>)}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#8a6f68" }}>RANGE</span>
          <input type="date" value={start} min={days[0]} max={last} onChange={e => setStart(e.target.value)} style={{ padding: "4px 6px", border: "1px solid #D8C8BC", borderRadius: 6, fontSize: 12 }} />
          <span style={{ color: "#b0978f" }}>→</span>
          <input type="date" value={end} min={days[0]} max={last} onChange={e => setEnd(e.target.value)} style={{ padding: "4px 6px", border: "1px solid #D8C8BC", borderRadius: 6, fontSize: 12 }} />
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#8a6f68", marginRight: 4 }}>ROWS</span>
          {["Day", "Week"].map(r => <button key={r} onClick={() => setRows(r)} style={btn(rows === r)}>{r}</button>)}
        </div>
      </div>

      {!totals ? <p style={{ color: "#8a6f68" }}>No data in this range.</p> : (<>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "#3a2429" }}>
          Totals <span style={{ fontWeight: 400, color: "#b0978f", fontSize: 12 }}>· {product} · {periods.length} {rows === "Week" ? "weeks" : "days"} in range</span>
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
          <div style={{ background: "#fff", border: "1px solid #E8DCD0", borderTop: "3px solid #8a6f68", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#8a6f68", letterSpacing: 0.4 }}>ALL CREATIVES</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#3a2429", margin: "4px 0" }}>{money(totals.all.spend)}</div>
            <div style={{ fontSize: 12, color: "#8a6f68" }}>NC ROAS <b style={{ color: "#3a2429" }}>{x2(totals.all.ncroas)}</b> · CPC {cpc(totals.all.cpc)}</div>
            <div style={{ fontSize: 12, color: "#8a6f68" }}>NVP <b style={{ color: "#3a2429" }}>{pct1(totals.all.nvp)}</b>{totals.noData.spend > 0 && ` · ${money(totals.noData.spend)} no visitor data`}</div>
          </div>
          {BUCKETS.map(b => {
            const t = totals[b.key];
            return (
              <div key={b.key} style={{ background: "#fff", border: "1px solid #E8DCD0", borderTop: `3px solid ${b.color}`, borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: b.color, letterSpacing: 0.4 }}>{b.label.toUpperCase()}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "#3a2429", margin: "4px 0" }}>{money(t.spend)}</div>
                <div style={{ fontSize: 12, color: "#8a6f68" }}>{pct1(t.share)} of spend · CPC {cpc(t.cpc)}</div>
                <div style={{ fontSize: 12, color: "#8a6f68" }}>NC ROAS <b style={{ color: ncColor(t.ncroas) }}>{x2(t.ncroas)}</b> · {roasLabel} {x2(t.roas)}</div>
              </div>
            );
          })}
        </div>

        <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px", color: "#3a2429" }}>{rows === "Week" ? "Weekly" : "Daily"} evolution</h3>
        <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 10px" }}>
          NVP = new visitors ÷ unique visitors (Triple Whale pixel), worked out per creative per {rows === "Week" ? "week" : "day"}; the creative's spend that {rows === "Week" ? "week" : "day"} lands in its bucket.
          NC ROAS is green at or above the account baseline ({x2(baselineNc)}), red below. "% tot" = share of that period's spend (incl. creatives with no visitor data).
        </p>
        <div style={{ background: "#fff", border: "1px solid #E8DCD0", borderRadius: 10, overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left" }} rowSpan={2}>{rows}</th>
                <th style={{ ...th, borderLeft: "1px solid #E8DCD0" }} colSpan={2}>Total</th>
                {BUCKETS.map(b => (
                  <th key={b.key} colSpan={4} style={{ ...th, textAlign: "center", background: b.color, color: "#fff", borderLeft: "2px solid #fff" }}>{b.label}</th>
                ))}
              </tr>
              <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
                <th style={{ ...th, borderLeft: "1px solid #E8DCD0" }}>Spend</th>
                <th style={th}>NC ROAS</th>
                {BUCKETS.map(b => ["Spend", "% tot", "NC ROAS", "CPC"].map((h, i) => (
                  <th key={b.key + h} style={{ ...th, background: b.bg, borderLeft: i === 0 ? "2px solid #fff" : undefined }}>{h}</th>
                )))}
              </tr>
            </thead>
            <tbody>
              {periods.map(p => (
                <tr key={p.period} style={{ borderBottom: "1px solid #F5EDE5" }}>
                  <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "#3a2429" }}>{p.label}</td>
                  <td style={{ ...td, borderLeft: "1px solid #E8DCD0", fontWeight: 600 }}>{money(p.all.spend)}</td>
                  <td style={{ ...td, color: ncColor(p.all.ncroas), fontWeight: 600 }}>{x2(p.all.ncroas)}</td>
                  {BUCKETS.map(b => {
                    const t = p[b.key];
                    const has = t.spend > 0;
                    return [
                      <td key={b.key + "s"} style={{ ...td, background: b.bg, borderLeft: "2px solid #fff", fontWeight: 600 }}>{has ? money(t.spend) : "—"}</td>,
                      <td key={b.key + "p"} style={{ ...td, background: b.bg, color: "#8a6f68" }}>{has ? pct1(t.share) : "—"}</td>,
                      <td key={b.key + "n"} style={{ ...td, background: b.bg, color: ncColor(t.ncroas), fontWeight: 600 }}>{has ? x2(t.ncroas) : "—"}</td>,
                      <td key={b.key + "c"} style={{ ...td, background: b.bg, color: "#8a6f68" }}>{has ? cpc(t.cpc) : "—"}</td>,
                    ];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>)}
    </div>
  );
}
