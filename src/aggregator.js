// Aggregates ad-level Triple Whale rows into the shapes the dashboard tabs
// need. The raw data ships as one row per unique creative with parsed
// dimensions + metrics. Every view derives from aggregating across the ad
// array rather than storing pre-aggregated tables.

const THRESHOLDS = [
  { key: "$1K", min: 1000 },
  { key: "$5K", min: 5000 },
  { key: "$15K", min: 15000 },
  { key: "$25K", min: 25000 },
  { key: "$50K", min: 50000 },
  { key: "$100K", min: 100000 },
  { key: "$150K+", min: 150000 },
];

// Ads that never spent anything are launch artefacts — duplicates, drafts,
// creatives that never left review. IM8's dashboard counted them in win-rate
// denominators, which silently depressed every rate. Here they are excluded
// from rate denominators (and the excluded count is surfaced in the UI).
const hasSpend = (a) => (a.metrics.spend || 0) > 0;

// Launch win rates only make sense for creatives launched inside the reporting
// window and old enough to have had a chance to scale. Carry-over ads (already
// live before the window) and too-new ads are excluded. Older manifests carry
// neither flag, so everything stays eligible there.
const launchEligible = (a) => hasSpend(a) && !a.carry_over && a.mature !== false;

// Account-level ROAS / NCROAS, used as the bar for "efficient" wins and for
// colouring ROAS badges relative to the account rather than to fixed cut-offs.
export const BASELINE = { roas: 1, ncroas: 1 };
export function setBaseline(b) {
  if (b && b.roas) BASELINE.roas = b.roas;
  if (b && b.ncroas) BASELINE.ncroas = b.ncroas;
}
// A creative that scaled past $1K AND beat the account's NCROAS.
const isEfficientWin = (a) =>
  (a.metrics.spend || 0) >= 1000 && (a.metrics.ncroas ?? 0) >= BASELINE.ncroas;

// Translate YYMMDD launch dates into YYYY-MM buckets.
function yymmddToMonth(s) {
  if (!s || s.length !== 6 || !/^\d{6}$/.test(s)) return null;
  return `20${s.slice(0, 2)}-${s.slice(2, 4)}`;
}

// Aggregate a filtered list of ad records into summary metrics.
export function aggregate(ads) {
  const tot = ads.reduce(
    (a, r) => {
      const m = r.metrics || {};
      a.spend += m.spend || 0;
      a.rev += m.rev || 0;
      a.txns += m.txns || 0;
      a.impressions += m.impressions || 0;
      a.clicks += m.clicks || 0;
      a.pixel_rev += m.pixel_rev || 0;
      a.pixel_txns += m.pixel_txns || 0;
      a.nc_txns += m.nc_txns || 0;
      a.nc_rev += m.nc_rev || 0;
      a.new_visitors += m.new_visitors || 0;
      a.visitors += m.visitors || 0;
      a.count += 1;
      return a;
    },
    { spend: 0, rev: 0, txns: 0, impressions: 0, clicks: 0,
      pixel_rev: 0, pixel_txns: 0, nc_txns: 0, nc_rev: 0,
      new_visitors: 0, visitors: 0, count: 0 }
  );
  return {
    ...tot,
    roas: tot.spend ? tot.rev / tot.spend : 0,
    pixel_roas: tot.spend ? tot.pixel_rev / tot.spend : 0,
    ncroas: tot.spend ? tot.nc_rev / tot.spend : 0,
    nccpa: tot.nc_txns ? tot.spend / tot.nc_txns : null,
    cpm: tot.impressions ? (tot.spend / tot.impressions) * 1000 : 0,
    cpc: tot.clicks ? tot.spend / tot.clicks : null,
    ctr: tot.impressions ? (tot.clicks / tot.impressions) * 100 : null,
    cpa: tot.txns ? tot.spend / tot.txns : null,
    aov: tot.txns ? tot.rev / tot.txns : null,
    // Share of pixel-attributed purchases that came from new customers.
    pct_new: tot.pixel_txns ? (tot.nc_txns / tot.pixel_txns) * 100 : null,
    // Share of Triple Whale-tracked visitors who were new to the site.
    pct_new_visitors: tot.visitors ? (tot.new_visitors / tot.visitors) * 100 : null,
  };
}

// Group ads by a dimension and aggregate each bucket.
export function groupBy(ads, dim) {
  const buckets = new Map();
  for (const ad of ads) {
    const key = ad[dim] ?? "(untagged)";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(ad);
  }
  return Array.from(buckets.entries())
    .map(([name, rows]) => ({ name, ads: rows, ...aggregate(rows) }))
    .sort((a, b) => b.spend - a.spend);
}

// Monthly breakdown indexed by the creative's launch month (first day it
// recorded spend, falling back to a date parsed out of the campaign name).
export function monthly(ads) {
  const buckets = new Map();
  for (const ad of ads) {
    // Carry-over creatives launched before the window — their in-window spend
    // would land in old, mostly-empty months, so they are left out here.
    if (ad.carry_over) continue;
    const m = yymmddToMonth(ad.date);
    if (!m) continue;
    if (!buckets.has(m)) buckets.set(m, { month: m, video: 0, image: 0, ads: [] });
    const b = buckets.get(m);
    b.ads.push(ad);
    // Format here is a presentation style ("Broll + VO", "Creator UGC"),
    // not video-vs-image — and statics are excluded from this dataset — so a
    // video/image split is not meaningful. Count launches instead.
  }
  return Array.from(buckets.values())
    .map((b) => {
      const agg = aggregate(b.ads);
      return {
        month: b.month,
        total: b.ads.length,
        spend: agg.spend,
        revenue: agg.rev,
        purchases: agg.txns,
        roas: agg.roas,
        ncroas: agg.ncroas,
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month));
}

// Win rate: for each launch month, count creatives by spend threshold.
// Denominators exclude never-spent creatives.
export function winRate(ads, formatFilter = "blended", strategistFilter = "all") {
  let filtered = ads.filter(launchEligible);
  if (formatFilter !== "blended") {
    filtered = filtered.filter((a) => a.format === formatFilter);
  }
  if (strategistFilter !== "all") {
    filtered = filtered.filter((a) => (a.strategist ?? "(untagged)") === strategistFilter);
  }

  const byMonth = new Map();
  for (const ad of filtered) {
    const m = yymmddToMonth(ad.date);
    if (!m) continue;
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(ad);
  }

  const rows = Array.from(byMonth.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, monthAds]) => {
      const thresholds = {};
      for (const t of THRESHOLDS) {
        const n = monthAds.filter((a) => (a.metrics.spend || 0) >= t.min).length;
        thresholds[t.key] = {
          n,
          rate: monthAds.length ? (n / monthAds.length) * 100 : 0,
        };
      }
      const eff = monthAds.filter(isEfficientWin).length;
      thresholds["Efficient"] = { n: eff, rate: monthAds.length ? (eff / monthAds.length) * 100 : 0 };
      return { month, total: monthAds.length, thresholds };
    });

  const totalThresholds = {};
  for (const t of THRESHOLDS) {
    const n = filtered.filter((a) => (a.metrics.spend || 0) >= t.min).length;
    totalThresholds[t.key] = {
      n,
      rate: filtered.length ? (n / filtered.length) * 100 : 0,
    };
  }
  const effTot = filtered.filter(isEfficientWin).length;
  totalThresholds["Efficient"] = { n: effTot, rate: filtered.length ? (effTot / filtered.length) * 100 : 0 };
  rows.push({ month: "TOTAL", total: filtered.length, thresholds: totalThresholds });
  return rows;
}

// Convert a groupBy result into the breakdown-table row shape.
export function toBreakdownRows(groups) {
  return groups.map((g) => {
    const spenders = g.ads.filter(launchEligible);
    const wr = (min) =>
      spenders.length
        ? (spenders.filter((a) => (a.metrics.spend || 0) >= min).length /
           spenders.length) * 100
        : 0;
    return {
      name: g.name,
      creatives: g.count,
      launched: spenders.length,
      ads: g.ads,
      spend: g.spend,
      revenue: g.rev,
      roas: g.roas,
      ncroas: g.ncroas,
      nc_revenue: g.nc_rev,
      nccpa: g.nccpa,
      pct_new: g.pct_new,
      purchases: g.txns,
      aov: g.aov,
      ctr: g.ctr,
      cpm: g.cpm,
      cpc: g.cpc,
      winRate1k: wr(1000),
      winRate15k: wr(15000),
      winRate50k: wr(50000),
      effRate: spenders.length ? (spenders.filter(isEfficientWin).length / spenders.length) * 100 : 0,
      eligible: spenders.length,
      pct_new_visitors: g.pct_new_visitors,
    };
  });
}

// Calendar-week series (from each creative's "wk" rows: [weekIdx, spend, rev,
// nc_rev, nc_orders]). With a dim, also splits weekly spend across the top-N
// values of that dimension (everything else lands in "Other").
// Daily-based variant: when the manifest carries per-day rows ("dd" + days),
// weeks are built from the days inside [startIso, endIso], so the chart always
// matches the selected period.
export function weeklyFromDaily(ads, days, startIso, endIso, dim = null, topN = 6) {
  const monday = (iso) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const inRange = (iso) => (!startIso || iso >= startIso) && (!endIso || iso <= endIso);
  const wkOf = days.map((d) => (inRange(d) ? monday(d) : null));
  const weeks = [...new Set(wkOf.filter(Boolean))].sort();
  const widx = new Map(weeks.map((w, i) => [w, i]));
  const conv = ads.map((a) => {
    const acc = new Map();
    for (const r of a.dd || []) {
      const w = wkOf[r[0]];
      if (!w) continue;
      const i = widx.get(w);
      const v = acc.get(i) || [i, 0, 0, 0, 0];
      v[1] += r[1]; v[2] += r[2]; v[3] += r[4]; v[4] += r[5];
      acc.set(i, v);
    }
    return { ...a, wk: [...acc.values()] };
  });
  return weekly(conv, weeks, dim, topN);
}

export function weekly(ads, weeks, dim = null, topN = 6) {
  if (!weeks || !weeks.length) return { rows: [], keys: [] };
  let keys = [];
  if (dim) {
    const tot = new Map();
    for (const a of ads) {
      const k = a[dim] ?? "(untagged)";
      tot.set(k, (tot.get(k) || 0) + (a.metrics.spend || 0));
    }
    keys = [...tot.entries()].sort((x, y) => y[1] - x[1]).slice(0, topN).map((e) => e[0]);
  }
  const rows = weeks.map((w) => ({ week: w.slice(5), spend: 0, rev: 0, nc_rev: 0, nc_orders: 0 }));
  for (const a of ads) {
    const k = dim ? (keys.includes(a[dim] ?? "(untagged)") ? (a[dim] ?? "(untagged)") : "Other") : null;
    for (const [i, s, r, nc, nco] of a.wk || []) {
      const row = rows[i];
      if (!row) continue;
      row.spend += s; row.rev += r; row.nc_rev += nc; row.nc_orders += nco;
      if (k) row[k] = (row[k] || 0) + s;
    }
  }
  for (const r of rows) {
    r.roas = r.spend ? r.rev / r.spend : null;
    r.ncroas = r.spend ? r.nc_rev / r.spend : null;
  }
  if (dim && rows.some((r) => r.Other)) keys = [...keys, "Other"];
  return { rows, keys };
}

// Dimensions available for pivoting and for the Data Clean Up tab.
export const DIMENSIONS = [
  "angle",
  "sub_angle",
  "concept",
  "icp",
  "script",
  "format",
  "awareness_stage",
  "product",
  "creative_no",
  "buying_type",
  "batch",
  "attribution_window",
  "geo",
  "naming_status",
  "convention",
  "strategist",
  "launch_status",
  "funnel",
  "reason",
  "origin",
  "type",
  "length",
  "persuasion",
  "editor",
  "writer",
  "creator",
  "landing_page",
];

export function dimensionValues(ads, dim) {
  const counts = new Map();
  const spendByValue = new Map();
  for (const ad of ads) {
    const v = ad[dim] ?? "(untagged)";
    counts.set(v, (counts.get(v) || 0) + 1);
    spendByValue.set(v, (spendByValue.get(v) || 0) + (ad.metrics.spend || 0));
  }
  return Array.from(counts.entries())
    .map(([value, n]) => ({ value, n, spend: spendByValue.get(value) || 0 }))
    .sort((a, b) => b.spend - a.spend);
}
