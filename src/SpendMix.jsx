import { useEffect, useMemo, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";

// Visual companion to the Analysis tree. It renders straight from the same
// tree the Breakdown table uses, so every rule, value pick, exclusion, min
// spend, top-N and date-range change redraws it.
//
//  • Mix bars: one 100% bar per top-level group, split by the next dimension
//    — where each group's spend goes.
//  • Focus: click a bar (or a slice) to see that group's split as a donut +
//    ranked table; keep clicking slices to walk down the stacked dimensions.

const PALETTE = ["#6B0010", "#D97706", "#0284C7", "#16A34A", "#9333EA", "#DB2777", "#0D9488",
  "#CA8A04", "#4F46E5", "#EA580C", "#65A30D", "#475569"];
const OTHER = "#CBBFB6";
const UNTAGGED = "#8F8A86";
const MAX_SEGS = 10;

const money = v => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
const pct = v => `${v.toFixed(1)}%`;
const x2 = v => (v == null ? "—" : `${v.toFixed(2)}x`);

// Top MAX_SEGS children by spend, the rest folded into "Other".
function segments(node) {
  const kids = [...(node.children || [])].sort((a, b) => b.agg.spend - a.agg.spend);
  const total = node.agg.spend || 1;
  const head = kids.slice(0, MAX_SEGS).map(k => ({ name: String(k.value), node: k, spend: k.agg.spend, share: (k.agg.spend / total) * 100 }));
  const rest = kids.slice(MAX_SEGS);
  if (rest.length) {
    const s = rest.reduce((t, k) => t + k.agg.spend, 0);
    const nc = rest.reduce((t, k) => t + (k.agg.nc_rev || 0), 0);
    const rv = rest.reduce((t, k) => t + (k.agg.rev || 0), 0);
    head.push({ name: `Other (${rest.length})`, other: true, spend: s, share: (s / total) * 100,
      node: { agg: { spend: s, ncroas: s ? nc / s : null, roas: s ? rv / s : null, count: rest.reduce((t, k) => t + k.agg.count, 0) } } });
  }
  return head;
}

export default function SpendMix({ tree, dims, labels, baselineNc, onAds }) {
  const [focus, setFocus] = useState([]); // path of values from the top level
  // Reset the drill path when the analysis setup changes underneath it.
  const sig = dims.join("|") + "::" + tree.map(n => n.value).join("|");
  useEffect(() => setFocus([]), [sig]);

  // Consistent colour per second-level value across all bars.
  const colorOf = useMemo(() => {
    const tot = new Map();
    for (const n of tree) for (const k of n.children || []) tot.set(String(k.value), (tot.get(String(k.value)) || 0) + k.agg.spend);
    const order = [...tot.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).filter(k => k !== "(untagged)");
    const m = new Map(order.map((k, i) => [k, PALETTE[i % PALETTE.length]]));
    return name => (name === "(untagged)" ? UNTAGGED : name.startsWith("Other (") ? OTHER : m.get(name) || OTHER);
  }, [tree]);

  if (!tree.length) return null;
  const twoLevel = dims.length > 1;

  // Resolve the focused node by walking the path.
  let fnode = null, level = 0;
  if (focus.length) {
    let pool = tree;
    for (const v of focus) {
      fnode = pool.find(n => String(n.value) === v);
      if (!fnode) break;
      pool = fnode.children || [];
      level++;
    }
    if (!fnode) fnode = null;
  }
  // Single dimension: show the top-level split itself.
  const root = { value: "All", agg: { spend: tree.reduce((t, n) => t + n.agg.spend, 0) }, children: tree };
  const donutNode = fnode || (!twoLevel ? root : null);
  const donutSegs = donutNode && donutNode.children ? segments(donutNode) : [];
  const childDim = fnode ? dims[level] : dims[0];

  const card = { background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", marginBottom: 16 };
  const ncColor = v => (v == null ? "#b0978f" : v >= baselineNc ? "#15803d" : "#b91c1c");

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "#3a2429" }}>Spend mix</h3>
        <span style={{ fontSize: 11, color: "#b0978f" }}>
          {twoLevel
            ? `How each ${labels[dims[0]] || dims[0]}'s spend splits across ${labels[dims[1]] || dims[1]} · click a bar to focus`
            : `Share of spend by ${labels[dims[0]] || dims[0]} · add a second dimension to see each one's split`}
        </span>
      </div>

      {twoLevel && (
        <div style={{ marginTop: 12 }}>
          {tree.map(n => {
            const segs = segments(n);
            const on = focus[0] === String(n.value);
            return (
              <div key={String(n.value)} onClick={() => setFocus(on ? [] : [String(n.value)])}
                style={{ display: "grid", gridTemplateColumns: "minmax(120px, 220px) 1fr 70px", alignItems: "center", gap: 10, padding: "4px 6px", borderRadius: 6, cursor: "pointer", background: on ? "#FDF3E7" : "transparent" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#3a2429", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={String(n.value)}>{String(n.value)}</div>
                <div style={{ display: "flex", height: 22, borderRadius: 4, overflow: "hidden", background: "#F5EDE5" }}>
                  {segs.map(s => (
                    <div key={s.name} title={`${s.name}: ${money(s.spend)} (${pct(s.share)}) · NCROAS ${x2(s.node.agg.ncroas)}`}
                      style={{ width: `${s.share}%`, background: colorOf(s.name), color: "#fff", fontSize: 10, lineHeight: "22px", paddingLeft: 4, overflow: "hidden", whiteSpace: "nowrap", borderRight: "1px solid #fff" }}>
                      {s.share >= 9 ? `${s.name.length > 18 ? s.name.slice(0, 17) + "…" : s.name} ${Math.round(s.share)}%` : ""}
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 12, textAlign: "right", color: "#8a6f68" }}>{money(n.agg.spend)}</div>
              </div>
            );
          })}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginTop: 10 }}>
            {[...new Set(tree.flatMap(n => segments(n).map(s => s.name)))].slice(0, 16).map(name => (
              <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "#5a4046" }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: colorOf(name) }} />{name}
              </span>
            ))}
          </div>
        </div>
      )}

      {donutNode && donutSegs.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: twoLevel ? "1px solid #E8DCD0" : "none" }}>
          {fnode && (
            <div style={{ fontSize: 12, marginBottom: 8, color: "#8a6f68" }}>
              <span style={{ cursor: "pointer", color: "#6B0010", fontWeight: 600 }} onClick={() => setFocus([])}>All</span>
              {focus.map((v, i) => (
                <span key={i}> › <span style={{ cursor: "pointer", color: i === focus.length - 1 ? "#3a2429" : "#6B0010", fontWeight: 600 }}
                  onClick={() => setFocus(focus.slice(0, i + 1))}>{v}</span></span>
              ))}
              <span> · split by <b>{labels[childDim] || childDim}</b> · {money(donutNode.agg.spend)}</span>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 300px) 1fr", gap: 16, alignItems: "center" }}>
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={donutSegs} dataKey="spend" nameKey="name" innerRadius="55%" outerRadius="95%" paddingAngle={1}
                    onClick={s => { if (s?.node?.children && !s.other) setFocus([...(fnode ? focus : []), s.name]); else if (s?.node?.ads) onAds(s.name, s.node.ads); }}>
                    {donutSegs.map(s => <Cell key={s.name} fill={colorOf(s.name)} cursor="pointer" />)}
                  </Pie>
                  <Tooltip formatter={(v, n, p) => [`${money(v)} (${pct(p.payload.share)})`, n]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #E8DCD0", color: "#8a6f68", fontSize: 10, textTransform: "uppercase" }}>
                  <th style={{ textAlign: "left", padding: 6 }}>{labels[childDim] || childDim}</th>
                  <th style={{ textAlign: "right", padding: 6 }}>Spend</th>
                  <th style={{ textAlign: "right", padding: 6 }}>Share</th>
                  <th style={{ textAlign: "right", padding: 6 }}>ROAS</th>
                  <th style={{ textAlign: "right", padding: 6 }}>NCROAS</th>
                  <th style={{ textAlign: "right", padding: 6 }}>Ads</th>
                </tr>
              </thead>
              <tbody>
                {donutSegs.map(s => (
                  <tr key={s.name} style={{ borderBottom: "1px solid #F5EDE5", cursor: s.other ? "default" : "pointer" }}
                    onClick={() => { if (s.other) return; if (s.node.children) setFocus([...(fnode ? focus : []), s.name]); else onAds(s.name, s.node.ads); }}>
                    <td style={{ padding: 6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: colorOf(s.name), marginRight: 6 }} />{s.name}</td>
                    <td style={{ padding: 6, textAlign: "right", fontWeight: 600 }}>{money(s.spend)}</td>
                    <td style={{ padding: 6, textAlign: "right" }}>{pct(s.share)}</td>
                    <td style={{ padding: 6, textAlign: "right", color: "#8a6f68" }}>{x2(s.node.agg.roas)}</td>
                    <td style={{ padding: 6, textAlign: "right", fontWeight: 600, color: ncColor(s.node.agg.ncroas) }}>{x2(s.node.agg.ncroas)}</td>
                    <td style={{ padding: 6, textAlign: "right", color: "#8a6f68" }}>{s.node.agg.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 10, color: "#b0978f", margin: "6px 0 0" }}>
            Click a slice or row to go one dimension deeper{donutNode.children?.[0]?.children ? "" : " (last level: opens the ads)"}. NCROAS green = at/above account baseline ({x2(baselineNc)}).
          </p>
        </div>
      )}
    </div>
  );
}
