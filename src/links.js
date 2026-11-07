// Shared Meta link helpers (ad list modal + Attribution tab).

// Opens Meta links in a new tab ourselves: a plain target="_blank" click was being
// swallowed in some browsers (nothing happened). If the new tab is blocked, open here.
export function openExternal(e, url) {
  if (!url || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  const w = window.open(url, "_blank");
  if (w) { try { w.opener = null; } catch {} } else window.location.assign(url);
}

// Ads Manager link that opens the ad inside its own ad account (and business), so
// people with several accounts don't land in their personal one.
export const AD_ACCOUNT_BUSINESS = {
  "2138674693666259": "1041179378721075", // SLD Ad Acc 1 · SLD Ecommerce LLC
};
export function adsManagerUrl(account, adIds) {
  const ids = (adIds || []).filter(Boolean);
  if (!ids.length) return null;
  const act = String(account || "").replace(/^act_/, "");
  if (!act) return `https://adsmanager.facebook.com/adsmanager/manage/ads?selected_ad_ids=${ids[0]}`;
  const biz = AD_ACCOUNT_BUSINESS[act];
  // The ad's edit view shows its preview and also opens archived/deleted ads.
  const q = [`act=${act}`, biz && `business_id=${biz}`, biz && `global_scope_id=${biz}`,
    `selected_ad_ids=${ids[0]}`].filter(Boolean).join("&");
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit/standalone?${q}`;
}
