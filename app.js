"use strict";

/* ============================================================
 * Skyblock Bazaar Flip Finder
 * Live data from the public Hypixel API.
 * Three flip modes:
 *   - bazaar: order-flip the spread (buy order -> sell offer) + tax
 *   - npc:    buy on bazaar (buy order) -> sell to NPC (no tax)
 *   - craft:  buy ingredients on bazaar -> craft -> best exit (bazaar/NPC)
 * Plus: risk flags, order-book depth, budget projection, watchlist,
 *       click-to-copy, profit alerts, CSV export, tax tiers, sparklines, PWA.
 * ============================================================ */

const BAZAAR_URL = "https://api.hypixel.net/v2/skyblock/bazaar";
const ITEMS_URL = "https://api.hypixel.net/v2/resources/skyblock/items";
const HOURS_PER_WEEK = 168;
const REFRESH_SECONDS = 30;
const TREND_WINDOW_MS = 60 * 60 * 1000; // sparkline covers the last hour
const HISTORY_MAX_SAMPLES = 240; // ~2h of 30s samples before pruning

const TAX_TIERS = { none: 1.25, t1: 1.125, t2: 1.0 };

const DEFAULTS = {
  mode: "bazaar",
  search: "",
  minVolume: 50000,
  taxPct: 1.25,
  taxPerk: "none",
  sharePct: 10,
  buyBump: false,
  bumpAmount: 0.1,
  budget: 0,
  topN: 100,
  alertThreshold: 0,
  autoRefresh: true,
  onlyWatch: false,
  watchSidebarOpen: true,
  sortKey: "profitPerHour",
  sortDir: "desc",
  showFullNumbers: false,
};

const state = {
  settings: loadSettings(),
  products: null,
  names: {},
  npc: {}, // id -> npc_sell_price
  lastUpdated: null,
  countdown: REFRESH_SECONDS,
  watch: loadWatch(),
  watchAlerts: loadWatchAlerts(),
  notifiedLow: new Set(),
  watchFilter: "",
  history: new Map(), // "mode:id" -> [{t, m}]
  alerted: new Set(),
  lastShown: [],
  unfiltered: null,
};

const el = {
  status: document.getElementById("status-line"),
  error: document.getElementById("error-banner"),
  refresh: document.getElementById("refresh-btn"),
  reset: document.getElementById("reset-btn"),
  csv: document.getElementById("csv-btn"),
  body: document.getElementById("flip-body"),
  count: document.getElementById("result-count"),
  toast: document.getElementById("toast"),
  mode: document.getElementById("mode"),
  search: document.getElementById("search"),
  minVolume: document.getElementById("min-volume"),
  tax: document.getElementById("tax"),
  taxPerk: document.getElementById("tax-perk"),
  share: document.getElementById("share"),
  buyBump: document.getElementById("buy-bump"),
  bumpAmount: document.getElementById("bump-amount"),
  budget: document.getElementById("budget"),
  topN: document.getElementById("top-n"),
  alertThreshold: document.getElementById("alert-threshold"),
  autoRefresh: document.getElementById("auto-refresh"),
  onlyWatch: document.getElementById("only-watch"),
  fullNumbers: document.getElementById("full-numbers"),
  sidebar: document.getElementById("watch-sidebar"),
  watchList: document.getElementById("watch-list"),
  watchToggle: document.getElementById("watch-toggle"),
  watchCollapse: document.getElementById("watch-collapse"),
  watchFilter: document.getElementById("watch-filter"),
  exportBtn: document.getElementById("export-btn"),
  importBtn: document.getElementById("import-btn"),
  importFile: document.getElementById("import-file"),
  headers: document.querySelectorAll("th[data-sort]"),
};

/* ---------------- Persistence ---------------- */
function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("bazaarFlipSettings") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(
      "bazaarFlipSettings",
      JSON.stringify(state.settings)
    );
  } catch {}
}
function loadWatch() {
  try {
    return new Set(JSON.parse(localStorage.getItem("bazaarFlipWatch") || "[]"));
  } catch {
    return new Set();
  }
}
function saveWatch() {
  try {
    localStorage.setItem(
      "bazaarFlipWatch",
      JSON.stringify([...state.watch])
    );
  } catch {}
}
function loadWatchAlerts() {
  try {
    const raw = JSON.parse(localStorage.getItem("bazaarFlipWatchAlerts") || "{}");
    const out = new Map();
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === "number") out.set(id, { sell: v, buy: 0 });
      else out.set(id, { sell: Number(v.sell || 0), buy: Number(v.buy || 0) });
    }
    return out;
  } catch {
    return new Map();
  }
}
function saveWatchAlerts() {
  try {
    localStorage.setItem("bazaarFlipWatchAlerts", JSON.stringify(Object.fromEntries(state.watchAlerts)));
  } catch {}
}

/* ---------------- Data fetching ---------------- */
async function fetchBazaar() {
  const res = await fetch(BAZAAR_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Bazaar API returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error("Bazaar API reported success=false");
  state.products = data.products;
  state.lastUpdated = data.lastUpdated;
}

// Names + NPC sell prices are static-ish; fetch once and reuse.
async function fetchItemMeta() {
  if (Object.keys(state.names).length) return;
  try {
    const res = await fetch(ITEMS_URL, { cache: "force-cache" });
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && Array.isArray(data.items)) {
      for (const item of data.items) {
        if (!item.id) continue;
        if (item.name) state.names[item.id] = item.name;
        if (typeof item.npc_sell_price === "number") state.npc[item.id] = item.npc_sell_price;
      }
    }
  } catch {
    /* meta is non-critical; fall back to prettified IDs */
  }
}

/* ---------------- Price / book helpers ---------------- */
const prod = (id) => state.products[id];
const buyOrderFill = (q) => q.sellPrice; // our buy order fills at the top buy order
const sellOfferFill = (q) => q.buyPrice; // our sell offer fills at the lowest sell offer
const bumpAdd = (opts) => (opts.buyBump ? (opts.bumpAmount || 0) : 0);

function sumAmounts(summary) {
  let t = 0;
  for (const e of summary) t += e.amount;
  return t;
}
function depthNearBest(summary, side) {
  if (!summary || !summary.length) return 0;
  const best = summary[0].pricePerUnit;
  let units = 0;
  for (const e of summary) {
    if (side === "buy") {
      if (e.pricePerUnit >= best * 0.99) units += e.amount;
      else break;
    } else {
      if (e.pricePerUnit <= best * 1.01) units += e.amount;
      else break;
    }
  }
  return units;
}
function computeRisk(p, q, marginPct) {
  const reasons = [];
  let score = 0;
  const buyTotal = sumAmounts(p.buy_summary);
  const sellTotal = sumAmounts(p.sell_summary);
  const topBuyShare = buyTotal ? p.buy_summary[0].amount / buyTotal : 1;
  const topSellShare = sellTotal ? p.sell_summary[0].amount / sellTotal : 1;
  if (topBuyShare > 0.6 || topSellShare > 0.6) {
    score += 2;
    reasons.push("One order dominates the book (possible whale/manipulation)");
  } else if (topBuyShare > 0.4 || topSellShare > 0.4) {
    score += 1;
    reasons.push("Order book is concentrated in few orders");
  }
  if (q.buyOrders < 5 || q.sellOrders < 5) {
    score += 2;
    reasons.push("Very few orders — price is easily moved");
  } else if (q.buyOrders < 15 || q.sellOrders < 15) {
    score += 1;
    reasons.push("Shallow order book");
  }
  if (marginPct > 100) {
    score += 3;
    reasons.push("Extreme spread — almost certainly a thin/manipulated price");
  } else if (marginPct > 30) {
    score += 2;
    reasons.push("Unusually high spread — verify before committing");
  } else if (marginPct > 15) {
    score += 1;
    reasons.push("High spread");
  }
  const level = score >= 3 ? 2 : score >= 1 ? 1 : 0;
  return { level, reasons, score };
}
const nameOf = (id) => state.names[id] || prettifyId(id);
function prettifyId(id) {
  return id
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/* ---------------- Mode: BAZAAR ---------------- */
function computeBazaarFlips(opts) {
  const tax = opts.taxPct / 100;
  const share = opts.sharePct / 100;
  const flips = [];
  for (const id in state.products) {
    const p = state.products[id];
    const q = p.quick_status;
    if (!q || !p.buy_summary?.length || !p.sell_summary?.length) continue;
    const cost = buyOrderFill(q) + bumpAdd(opts);
    const exit = sellOfferFill(q);
    if (!(cost > 0) || !(exit > 0)) continue;
    const marginPerUnit = exit * (1 - tax) - cost;
    if (marginPerUnit <= 0) continue;

    const buyMovingWeek = q.buyMovingWeek || 0;
    const sellMovingWeek = q.sellMovingWeek || 0;
    const limitingWeekly = Math.min(buyMovingWeek, sellMovingWeek);
    if (limitingWeekly < opts.minVolume) continue;

    const depth = Math.min(depthNearBest(p.buy_summary, "buy"), depthNearBest(p.sell_summary, "sell"));
    const marginPct = (marginPerUnit / cost) * 100;
    const risk = computeRisk(p, q, marginPct);
    flips.push(
      buildFlip({
        mode: "bazaar", id, name: nameOf(id), sub: id,
        cost, exit, marginPerUnit, marginPct, depth,
        limitingWeekly, buyMovingWeek, sellMovingWeek, share, opts, risk,
        exitLabel: "Bazaar",
      })
    );
  }
  return flips;
}

/* ---------------- Mode: NPC ---------------- */
function computeNpcFlips(opts) {
  const share = opts.sharePct / 100;
  const flips = [];
  for (const id in state.products) {
    const npcPrice = state.npc[id];
    if (!(npcPrice > 0)) continue;
    const p = state.products[id];
    const q = p.quick_status;
    if (!q || !p.sell_summary?.length) continue;
    const cost = buyOrderFill(q) + bumpAdd(opts); // acquire via buy order
    if (!(cost > 0)) continue;
    const marginPerUnit = npcPrice - cost; // NPC sales are untaxed
    if (marginPerUnit <= 0) continue;

    const buyMovingWeek = q.buyMovingWeek || 0;
    // Throughput is limited by how fast we can ACQUIRE (NPC selling is unlimited).
    const limitingWeekly = buyMovingWeek;
    if (limitingWeekly < opts.minVolume) continue;

    const depth = depthNearBest(p.sell_summary, "sell"); // offers available to fill our buys
    const marginPct = (marginPerUnit / cost) * 100;
    const risk = computeRisk(p, q, marginPct);
    flips.push(
      buildFlip({
        mode: "npc", id, name: nameOf(id), sub: `Bazaar → NPC @ ${formatCoins(npcPrice)}`,
        cost, exit: npcPrice, marginPerUnit, marginPct, depth,
        limitingWeekly, buyMovingWeek, sellMovingWeek: Infinity, share, opts, risk,
        exitLabel: "NPC",
      })
    );
  }
  return flips;
}

/* ---------------- Mode: CRAFT ---------------- */
function computeCraftFlips(opts) {
  const tax = opts.taxPct / 100;
  const share = opts.sharePct / 100;
  const recipes = window.BAZAAR_RECIPES || [];
  const flips = [];

  for (const recipe of recipes) {
    const out = prod(recipe.output);
    if (!out || !out.quick_status || !out.buy_summary?.length) continue;

    // Sum ingredient acquisition cost (buy orders) and the limiting inputs.
    let ingredientCost = 0;
    let acquisitionWeekly = Infinity;
    let inputDepth = Infinity;
    let ok = true;
    for (const inp of recipe.inputs) {
      const ip = prod(inp.id);
      if (!ip || !ip.quick_status || !ip.sell_summary?.length) { ok = false; break; }
      const unitCost = buyOrderFill(ip.quick_status) + bumpAdd(opts);
      if (!(unitCost > 0)) { ok = false; break; }
      ingredientCost += unitCost * inp.qty;
      acquisitionWeekly = Math.min(acquisitionWeekly, (ip.quick_status.buyMovingWeek || 0) / inp.qty);
      inputDepth = Math.min(inputDepth, depthNearBest(ip.sell_summary, "sell") / inp.qty);
    }
    if (!ok || ingredientCost <= 0) continue;

    // Best exit: sell crafted on bazaar (taxed) vs. sell to NPC (untaxed).
    const oq = out.quick_status;
    const bazaarNet = sellOfferFill(oq) * (1 - tax);
    const npcNet = state.npc[recipe.output] || 0;
    const useNpc = npcNet > bazaarNet;
    const exitGross = useNpc ? npcNet : sellOfferFill(oq);
    const exitNet = useNpc ? npcNet : bazaarNet;

    const marginPerUnit = exitNet - ingredientCost;
    if (marginPerUnit <= 0) continue;

    const sellWeekly = useNpc ? Infinity : oq.sellMovingWeek || 0;
    const limitingWeekly = Math.min(acquisitionWeekly, sellWeekly);
    if (limitingWeekly < opts.minVolume) continue;

    const depth = Math.min(inputDepth, useNpc ? Infinity : depthNearBest(out.buy_summary, "buy"));
    const marginPct = (marginPerUnit / ingredientCost) * 100;
    const risk = computeRisk(out, oq, marginPct);
    const recipeText = recipe.inputs.map((i) => `${formatInt(i.qty)}× ${nameOf(i.id)}`).join(" + ");

    flips.push(
      buildFlip({
        mode: "craft", id: recipe.output, name: nameOf(recipe.output),
        sub: `Craft: ${recipeText}`,
        cost: ingredientCost, exit: exitGross, marginPerUnit, marginPct, depth,
        limitingWeekly, buyMovingWeek: acquisitionWeekly, sellMovingWeek: sellWeekly,
        share, opts, risk, exitLabel: useNpc ? "NPC" : "Bazaar",
      })
    );
  }
  return flips;
}

// Shared assembly of a flip row (throughput, budget projection).
function buildFlip(a) {
  const flipsPerHour = (a.limitingWeekly / HOURS_PER_WEEK) * a.share;
  const profitPerHour = a.marginPerUnit * flipsPerHour;
  const unitsAffordable = a.opts.budget > 0 ? Math.floor(a.opts.budget / a.cost) : Infinity;
  const effUnits = Math.max(
    0,
    Math.floor(Math.min(unitsAffordable, a.depth))
  );
  const budgetProfit = a.opts.budget > 0 ? a.marginPerUnit * effUnits : 0;
  return {
    mode: a.mode, id: a.id, name: a.name, sub: a.sub,
    buyOrderPrice: a.cost, sellOfferPrice: a.exit,
    marginPerUnit: a.marginPerUnit, marginPct: a.marginPct,
    depth: a.depth, limitingWeekly: a.limitingWeekly,
    buyMovingWeek: a.buyMovingWeek, sellMovingWeek: a.sellMovingWeek,
    profitPerHour, budgetProfit, effUnits, unitsAffordable,
    riskLevel: a.risk.level, riskScore: a.risk.score, riskReasons: a.risk.reasons,
    exitLabel: a.exitLabel,
  };
}

function computeForMode(mode, opts) {
  if (mode === "npc") return computeNpcFlips(opts);
  if (mode === "craft") return computeCraftFlips(opts);
  return computeBazaarFlips(opts);
}

/* ---------------- Formatting ---------------- */
function parseCompactNumber(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(/[,\s_]/g, "");

  if (raw === "") return 0;

  const match = raw.match(
    /^([+-]?(?:\d+\.?\d*|\.\d+))([kmbt]?)$/i
  );

  if (!match) return null;

  const multipliers = {
    "": 1,
    k: 1e3,
    m: 1e6,
    b: 1e9,
    t: 1e12
  };

  const result =
    Number(match[1]) * multipliers[match[2].toLowerCase()];

  return Number.isFinite(result) ? result : null;
}
function formatCoins(n) {
  if (!Number.isFinite(n)) return "∞";

  if (state.settings.showFullNumbers) {
    return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }

  const abs = Math.abs(n);

  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";

  return n.toFixed(abs < 10 ? 1 : 0);
}
function formatInt(n) {
  if (!isFinite(n)) return "∞";
  return Math.round(n).toLocaleString("en-US");
}
function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

const RISK_BADGE = {
  0: { txt: "Safe", cls: "risk-safe" },
  1: { txt: "Caution", cls: "risk-caution" },
  2: { txt: "Risky", cls: "risk-risky" },
};

function sparkline(values) {
  if (!values || values.length < 2) return '<span class="spark-empty">—</span>';
  const w = 36, h = 16;
  const ms = values.map((s) => s.m);
  const min = Math.min(...ms), max = Math.max(...ms), range = max - min || 1;
  const pts = values
    .map((s, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((s.m - min) / range) * h).toFixed(1)}`)
    .join(" ");
  const first = ms[0], last = ms[ms.length - 1];
  const dir = Math.abs(last - first) < range * 0.05 ? "spark-flat" : last > first ? "spark-up" : "spark-down";
  return `<svg width="${w}" height="${h}" class="spark"><polyline points="${pts}" fill="none" class="${dir}" stroke-width="1.5" /></svg>`;
}

/* ---------------- Mode-aware column labels ---------------- */
const MODE_COL = {
  bazaar: { buyOrderPrice: "Buy order", sellOfferPrice: "Sell offer" },
  npc: { buyOrderPrice: "Bazaar cost", sellOfferPrice: "NPC price" },
  craft: { buyOrderPrice: "Craft cost", sellOfferPrice: "Exit price" },
};
const STATIC_COL = {
  marginPerUnit: "Margin",
  marginPct: "Margin %",
  depth: "Depth",
  limitingWeekly: "Wk vol",
  profitPerHour: "Profit/hr",
  effUnits: "Buy qty",
  budgetProfit: "Profit (budget)",
  riskScore: "Risk",
};
function columnLabel(key) {
  return (MODE_COL[state.settings.mode] && MODE_COL[state.settings.mode][key]) || STATIC_COL[key] || "";
}

/* ---------------- Rendering ---------------- */
function getFilteredSorted() {
  const s = state.settings;
  let flips = computeForMode(s.mode, {
    taxPct: s.taxPct, sharePct: s.sharePct, minVolume: s.minVolume, budget: s.budget,
    buyBump: s.buyBump, bumpAmount: s.bumpAmount,
  });
  const query = s.search.trim().toLowerCase();
  if (query) {
    flips = flips.filter((f) => f.name.toLowerCase().includes(query) || f.id.toLowerCase().includes(query));
  }
  if (s.onlyWatch) flips = flips.filter((f) => state.watch.has(f.id));

  const dir = s.sortDir === "asc" ? 1 : -1;
  flips.sort((a, b) => {
    const av = a[s.sortKey], bv = b[s.sortKey];
    if (typeof av === "string") return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
  return flips;
}

function applyFiltersAndRender() {
  if (!state.products) return;
  const all = getFilteredSorted();
  const shown = all.slice(0, state.settings.topN);
  renderRows(shown);
  renderWatchSidebar();
  const s = state.settings;
  const modeName = { bazaar: "bazaar", npc: "NPC", craft: "craft" }[s.mode];
  el.count.textContent = all.length
    ? `Showing ${shown.length} of ${all.length} ${modeName} flips · ${s.taxPct}% tax · min ${formatInt(
        s.minVolume
      )} wk vol · ${s.sharePct}% share` + (s.budget > 0 ? ` · budget ${formatCoins(s.budget)}` : "")
    : `No ${modeName} flips match the current filters.`;
  updateSortHeaders();
  state.lastShown = shown;
}

function watchFlipById() {
  if (!state.unfiltered) {
    const s = state.settings;
    state.unfiltered = computeForMode(s.mode, {
      taxPct: s.taxPct, sharePct: s.sharePct, minVolume: 0, budget: s.budget,
    });
  }
  return new Map(state.unfiltered.map((f) => [f.id, f]));
}

function renderWatchSidebar() {
  const open = state.settings.watchSidebarOpen && state.watch.size > 0;
  el.sidebar.classList.toggle("hidden", !open);
  if (!open) return;

  const q = state.watchFilter.trim().toLowerCase();
  const byId = watchFlipById();
  let entries = [...state.watch].map((id) => byId.get(id)).filter(Boolean);
  if (q) entries = entries.filter((f) => f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q));
  const stale = [...state.watch].filter((id) => !byId.has(id));

  const active = document.activeElement;
  if (active && el.sidebar.contains(active) && active.classList.contains("watch-alert")) return;

  const alertCell = (id) => {
    const t = state.watchAlerts.get(id) || {};
    const sell = Number(t.sell || 0), buy = Number(t.buy || 0);
    return `<span class="watch-alert-row">
      <label>sell ≤</label><input class="watch-alert" data-alert-id="${escapeHtml(id)}" data-alert-kind="sell" inputmode="decimal" placeholder="off" value="${sell > 0 ? escapeHtml(String(sell)) : ""}" />
      <label>buy ≥</label><input class="watch-alert" data-alert-id="${escapeHtml(id)}" data-alert-kind="buy" inputmode="decimal" placeholder="off" value="${buy > 0 ? escapeHtml(String(buy)) : ""}" />
    </span>`;
  };

  el.watchList.innerHTML =
    entries.map((f) => `<li>
      <button class="watch-unstar" data-watch="${escapeHtml(f.id)}" title="Remove from watchlist">★</button>
      <span class="watch-item-main">
        <span class="watch-item-row">
          <span class="watch-item-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
          <span class="watch-item-profit">${formatCoins(f.profitPerHour)}/hr</span>
        </span>
        <span class="watch-item-sub" title="${escapeHtml(f.sub)}">${escapeHtml(f.sub)}</span>
        <span class="watch-meta">
          <span>buy ${formatCoins(f.buyOrderPrice)}</span>
          <span>sell ${formatCoins(f.sellOfferPrice)}</span>
          <span>margin ${formatCoins(f.marginPerUnit)} (${f.marginPct.toFixed(1)}%)</span>
          <span>depth ${formatInt(f.depth)}</span>
        </span>
        ${alertCell(f.id)}
      </span>
    </li>`).join("") +
    (q ? "" : stale.map((id) => `<li>
      <button class="watch-unstar" data-watch="${escapeHtml(id)}" title="Remove from watchlist">★</button>
      <span class="watch-item-main">
        <span class="watch-item-row">
          <span class="watch-item-name">${escapeHtml(nameOf(id))}</span>
        </span>
        <span class="watch-item-sub">no flip in current mode</span>
        ${alertCell(id)}
      </span>
    </li>`).join(""));
}

function checkWatchAlerts() {
  if (!state.unfiltered) return;
  const byId = new Map(state.unfiltered.map((f) => [f.id, f]));
  const notify = (key, icon, name, actual, target, dirWord) => {
    if (state.notifiedLow.has(key)) return;
    state.notifiedLow.add(key);
    beep();
    showToast(`${icon} ${name} ${dirWord} ${formatCoins(actual)} ${icon === "⬇" ? "≤" : "≥"} ${formatCoins(target)}`);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Watchlist price alert", {
        body: `${name} ${dirWord} ${formatCoins(actual)} (${icon === "⬇" ? "≤" : "≥"} ${formatCoins(target)})`,
      });
    }
  };
  for (const id of state.watch) {
    const t = state.watchAlerts.get(id) || {};
    const f = byId.get(id);
    if (!f) continue;
    const sellT = Number(t.sell || 0), buyT = Number(t.buy || 0);
    if (sellT > 0) {
      const key = id + ":sell";
      if (f.sellOfferPrice <= sellT) notify(key, "⬇", nameOf(id), f.sellOfferPrice, sellT, "sell offer");
      else if (f.sellOfferPrice > sellT) state.notifiedLow.delete(key);
    }
    if (buyT > 0) {
      const key = id + ":buy";
      if (f.buyOrderPrice >= buyT) notify(key, "⬆", nameOf(id), f.buyOrderPrice, buyT, "buy order");
      else if (f.buyOrderPrice < buyT) state.notifiedLow.delete(key);
    }
  }
}

function renderRows(flips) {
  if (!flips.length) {
    el.body.innerHTML =
      `<tr><td colspan="13" class="empty">No flips match the current filters.</td></tr>`;
    return;
  }

  const budgetOn = state.settings.budget > 0;

  el.body.innerHTML = flips
    .map((f) => {
      const cls = f.marginPerUnit >= 0 ? "pos" : "neg";
      const badge = RISK_BADGE[f.riskLevel];
      const watched = state.watch.has(f.id);

      const reasons = f.riskReasons.length
        ? escapeHtml(f.riskReasons.join(" • "))
        : "No risk flags";

      const exitTag = f.exitLabel === "NPC"
        ? ` <span class="exit-npc">NPC</span>`
        : "";

      const quantityCell = budgetOn
        ? `<td title="Affordable: ${formatInt(f.unitsAffordable)}; capped by order-book depth">${formatInt(f.effUnits)}</td>`
        : `<td class="muted">—</td>`;

      const budgetCell = budgetOn
        ? `<td class="profit ${f.budgetProfit > 0 ? "pos" : ""}" title="${formatInt(f.effUnits)} units (affordable: ${formatInt(f.unitsAffordable)})">${formatCoins(f.budgetProfit)}</td>`
        : `<td class="muted">—</td>`;

      return `<tr>
        <td class="left star-cell">
          <button class="star ${watched ? "on" : ""}" data-watch="${escapeHtml(f.id)}" title="Toggle watchlist">${watched ? "★" : "☆"}</button>
        </td>
        <td class="left">
          <button class="item-name copy-name" data-copy="${escapeHtml(f.name)}" title="Click to copy">${escapeHtml(f.name)}</button>
          <span class="item-sub">${escapeHtml(f.sub)}</span>
        </td>
        <td>${formatCoins(f.buyOrderPrice)}</td>
        <td>${formatCoins(f.sellOfferPrice)}${exitTag}</td>
        <td class="${cls}">${formatCoins(f.marginPerUnit)}</td>
        <td class="${cls}">${f.marginPct.toFixed(1)}%</td>
        <td title="Units available within ~1% of the spread">${formatInt(f.depth)}</td>
        <td title="Buy ${formatInt(f.buyMovingWeek)} / Sell ${formatInt(f.sellMovingWeek)} per week">${formatInt(f.limitingWeekly)}</td>
        <td class="profit pos">${formatCoins(f.profitPerHour)}</td>
        ${quantityCell}
        ${budgetCell}
        <td><span class="risk ${badge.cls}" title="${reasons}">${badge.txt}</span></td>
        <td class="spark-cell">${sparkline(state.history.get(f.mode + ":" + f.id))}</td>
      </tr>`;
    })
    .join("");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function updateSortHeaders() {
  el.headers.forEach((th) => {
    const key = th.dataset.sort;
    const label = columnLabel(key);
    if (!label) return;
    const isActive = key === state.settings.sortKey;
    th.classList.toggle("active", isActive);
    const arrow = isActive ? (state.settings.sortDir === "asc" ? "\u00A0▲" : "\u00A0▼") : "";
    th.textContent = label + arrow;
  });
}

/* ---------------- History + alerts ---------------- */
function loadTrendHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem("bazaarTrendHistory") || "{}");
    const now = Date.now();
    for (const key of Object.keys(raw)) {
      const cut = now - TREND_WINDOW_MS;
      raw[key] = raw[key].filter((s) => s.t > cut);
      if (!raw[key].length) delete raw[key];
    }
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}
function saveTrendHistory() {
  try {
    const obj = {};
    for (const [k, v] of state.history) obj[k] = v;
    localStorage.setItem("bazaarTrendHistory", JSON.stringify(obj));
  } catch {}
}
function recordHistory(flips) {
  const now = Date.now();
  const cut = now - TREND_WINDOW_MS;
  for (const f of flips) {
    const key = f.mode + ":" + f.id;
    const arr = state.history.get(key) || [];
    arr.push({ t: now, m: f.marginPerUnit });
    while (arr.length && arr[0].t < cut) arr.shift();
    if (arr.length > HISTORY_MAX_SAMPLES) arr.splice(0, arr.length - HISTORY_MAX_SAMPLES);
    state.history.set(key, arr);
  }
  saveTrendHistory();
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.04;
    o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, 140);
  } catch {}
}
function checkAlerts(flips) {
  const threshold = state.settings.alertThreshold;
  if (!threshold || threshold <= 0) return;
  const newly = [];
  const stillAbove = new Set();
  for (const f of flips) {
    if (f.profitPerHour >= threshold) {
      stillAbove.add(f.id);
      if (!state.alerted.has(f.id)) newly.push(f);
    }
  }
  state.alerted = stillAbove;
  if (!newly.length) return;
  beep();
  const top = newly.sort((a, b) => b.profitPerHour - a.profitPerHour).slice(0, 3);
  const lines = top.map((f) => `${f.name}: ${formatCoins(f.profitPerHour)}/hr`).join("\n");
  showToast(`🔔 ${newly.length} flip(s) above ${formatCoins(threshold)}/hr`);
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Bazaar flip alert", { body: lines });
  }
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 1800);
}

/* ---------------- CSV export ---------------- */
function exportCsv() {
  const flips = state.lastShown || [];
  if (!flips.length) return showToast("Nothing to export");
  const cols = [
    "mode", "id", "name", "buyOrderPrice", "sellOfferPrice", "marginPerUnit",
    "marginPct", "depth", "limitingWeekly", "profitPerHour",
    "effUnits", "budgetProfit", "riskLevel", "exitLabel",
  ];
  const rows = [cols.join(",")];
  for (const f of flips) {
    rows.push(
      cols
        .map((c) => {
          const v = f[c];
          if (typeof v === "string") return `"${v.replace(/"/g, '""')}"`;
          return isFinite(v) ? Math.round(v * 100) / 100 : "";
        })
        .join(",")
    );
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bazaar-${state.settings.mode}-flips-${new Date().toISOString().slice(0, 16).replace(":", "")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Exported CSV");
}

/* ---------------- Status / refresh ---------------- */
function updateStatus() {
  if (!state.lastUpdated) return;
  const countdownTxt = state.settings.autoRefresh
    ? ` · next in <span class="countdown">${state.countdown}s</span>`
    : "";
  el.status.innerHTML = `<span class="ok">●</span> Updated ${timeAgo(state.lastUpdated)}${countdownTxt}`;
}
function showError(msg) {
  el.error.textContent = "⚠ " + msg + " — showing last known data if available.";
  el.error.classList.remove("hidden");
}
function clearError() {
  el.error.classList.add("hidden");
}

async function refresh() {
  el.refresh.classList.add("spinning");
  try {
    await Promise.all([fetchBazaar(), fetchItemMeta()]);
    clearError();
    const flips = getFilteredSorted();
    // Full (min-volume-ignored) flip list drives the trend history, sidebar and alerts.
    const unfiltered = computeForMode(state.settings.mode, {
      taxPct: state.settings.taxPct, sharePct: state.settings.sharePct, minVolume: 0, budget: state.settings.budget,
      buyBump: state.settings.buyBump, bumpAmount: state.settings.bumpAmount,
    });
    state.unfiltered = unfiltered;
    recordHistory(unfiltered);
    checkWatchAlerts();
    checkAlerts(flips);
    applyFiltersAndRender();
  } catch (err) {
    showError(err.message || "Failed to load bazaar data");
  } finally {
    el.refresh.classList.remove("spinning");
    state.countdown = REFRESH_SECONDS;
    updateStatus();
  }
}

setInterval(() => {
  updateStatus();
  if (!state.settings.autoRefresh || document.hidden) return;
  state.countdown -= 1;
  if (state.countdown <= 0) refresh();
}, 1000);

/* ---------------- Controls ---------------- */
function syncInputsFromSettings() {
  const s = state.settings;
  el.mode.value = s.mode;
  el.search.value = s.search;
  el.minVolume.value = s.minVolume;
  el.tax.value = s.taxPct;
  el.taxPerk.value = s.taxPerk;
  el.share.value = s.sharePct;
  el.buyBump.checked = Boolean(s.buyBump);
  el.bumpAmount.value = s.bumpAmount;
  el.budget.value = s.budget;
  el.topN.value = s.topN;
  el.alertThreshold.value = s.alertThreshold;
  el.autoRefresh.checked = s.autoRefresh;
  el.onlyWatch.checked = s.onlyWatch;
  el.fullNumbers.checked = Boolean(s.showFullNumbers);
}

function bindCompactNumberInput(input, settingKey) {
  const commit = (normalize, requestNotification = false) => {
    const parsed = parseCompactNumber(input.value);
    if (parsed === null) return;

    const value = Math.max(0, parsed);
    state.settings[settingKey] = value;

    if (normalize) {
      input.value = String(value);
    }

    if (settingKey === "alertThreshold") {
      state.alerted.clear();

      if (
        requestNotification &&
        value > 0 &&
        "Notification" in window &&
        Notification.permission === "default"
      ) {
        Notification.requestPermission();
      }
    }

    saveSettings();
    applyFiltersAndRender();
  };

  input.addEventListener("input", () => commit(false));
  input.addEventListener("change", () => commit(true, true));
}

function bindControls() {
  const num = (v) => (v === "" ? null : Number(v));
  const onChange = (key, parse) => (e) => {
    const v = parse(e.target.value);
    if (v === null || Number.isNaN(v)) return;
    state.settings[key] = v;
    saveSettings();
    applyFiltersAndRender();
  };

  el.mode.addEventListener("change", (e) => {
    state.settings.mode = e.target.value;
    state.alerted.clear();
    saveSettings();
    applyFiltersAndRender();
  });
  el.search.addEventListener("input", onChange("search", (v) => v));
  bindCompactNumberInput(el.minVolume, "minVolume");
  bindCompactNumberInput(el.budget, "budget");
  bindCompactNumberInput(el.alertThreshold, "alertThreshold");
  el.share.addEventListener("input", onChange("sharePct", num));
  el.buyBump.addEventListener("change", (e) => {
    state.settings.buyBump = e.target.checked;
    saveSettings();
    applyFiltersAndRender();
  });
  el.bumpAmount.addEventListener("input", onChange("bumpAmount", num));
  el.topN.addEventListener("input", onChange("topN", num));

  el.tax.addEventListener("input", (e) => {
    const v = num(e.target.value);
    if (v === null || Number.isNaN(v)) return;
    state.settings.taxPct = v;
    state.settings.taxPerk = "custom";
    el.taxPerk.value = "custom";
    saveSettings();
    applyFiltersAndRender();
  });
  el.taxPerk.addEventListener("change", (e) => {
    const perk = e.target.value;
    state.settings.taxPerk = perk;
    if (TAX_TIERS[perk] !== undefined) {
      state.settings.taxPct = TAX_TIERS[perk];
      el.tax.value = state.settings.taxPct;
    }
    saveSettings();
    applyFiltersAndRender();
  });
  el.autoRefresh.addEventListener("change", (e) => {
    state.settings.autoRefresh = e.target.checked;
    state.countdown = REFRESH_SECONDS;
    saveSettings();
    updateStatus();
  });
  el.onlyWatch.addEventListener("change", (e) => {
    state.settings.onlyWatch = e.target.checked;
    saveSettings();
    applyFiltersAndRender();
  });
  el.fullNumbers.addEventListener("change", (event) => {
    state.settings.showFullNumbers = event.target.checked;
    saveSettings();
    applyFiltersAndRender();
  });

  el.refresh.addEventListener("click", refresh);
  el.csv.addEventListener("click", exportCsv);
  el.watchToggle.addEventListener("click", () => {
    state.settings.watchSidebarOpen = !state.settings.watchSidebarOpen;
    saveSettings();
    renderWatchSidebar();
  });
  el.watchCollapse.addEventListener("click", () => {
    state.settings.watchSidebarOpen = false;
    saveSettings();
    renderWatchSidebar();
  });
  el.watchFilter.addEventListener("input", (e) => {
    state.watchFilter = e.target.value;
    renderWatchSidebar();
  });
  el.watchList.addEventListener("change", (e) => {
    const input = e.target.closest("[data-alert-id]");
    if (!input) return;
    const id = input.dataset.alertId;
    const kind = input.dataset.alertKind === "buy" ? "buy" : "sell";
    const v = parseCompactNumber(input.value);
    const t = { ...(state.watchAlerts.get(id) || { sell: 0, buy: 0 }) };
    if (v === null) {
      input.value = "";
      t[kind] = 0;
    } else {
      const val = Math.max(0, v);
      t[kind] = val;
      input.value = String(val);
      if (val > 0 && "Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    }
    if (!t.sell && !t.buy) state.watchAlerts.delete(id);
    else state.watchAlerts.set(id, t);
    state.notifiedLow.delete(id + ":sell");
    state.notifiedLow.delete(id + ":buy");
    saveWatchAlerts();
  });
  el.exportBtn.addEventListener("click", () => {
    const payload = JSON.stringify({
      app: "bazaar-flipper",
      version: 1,
      settings: state.settings,
      watchlist: [...state.watch],
      watchAlerts: Object.fromEntries(state.watchAlerts),
    }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bazaar-flipper-settings.json";
    a.click();
    URL.revokeObjectURL(url);
    showToast("Settings exported");
  });
  el.importBtn.addEventListener("click", () => el.importFile.click());
  el.importFile.addEventListener("change", () => {
    const file = el.importFile.files && el.importFile.files[0];
    el.importFile.value = "";
    if (!file) return;
    file.text().then((text) => {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || !data.settings) throw new Error("not a settings file");
      state.settings = { ...DEFAULTS, ...data.settings };
      state.watch = new Set(Array.isArray(data.watchlist) ? data.watchlist : []);
      state.watchAlerts = new Map(Object.entries(data.watchAlerts || {}));
      state.notifiedLow.clear();
      state.alerted.clear();
      saveSettings();
      saveWatch();
      saveWatchAlerts();
      syncInputsFromSettings();
      renderWatchSidebar();
      applyFiltersAndRender();
      showToast("Settings imported");
    }).catch((e) => showToast("Import failed: " + e.message));
  });
  el.reset.addEventListener("click", () => {
    state.settings = { ...DEFAULTS };
    saveSettings();
    syncInputsFromSettings();
    applyFiltersAndRender();
  });

  el.body.addEventListener("click", (e) => {
    const star = e.target.closest("[data-watch]");
    if (star) {
      const id = star.dataset.watch;
      if (state.watch.has(id)) state.watch.delete(id);
      else state.watch.add(id);
      saveWatch();
      applyFiltersAndRender();
      return;
    }
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      const text = copy.dataset.copy;
      navigator.clipboard?.writeText(text).then(
        () => showToast(`Copied "${text}"`),
        () => showToast("Copy failed")
      );
    }
  });

  let sortClickKey = null;
  let sortClickCount = 0;
  el.headers.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.settings.sortKey === key) {
        sortClickCount += 1;
        if (sortClickCount >= 3) {
          state.settings.sortKey = DEFAULTS.sortKey;
          state.settings.sortDir = DEFAULTS.sortDir;
          sortClickKey = null;
          sortClickCount = 0;
          showToast("Sort reset to default");
        } else {
          state.settings.sortDir = state.settings.sortDir === "asc" ? "desc" : "asc";
        }
      } else {
        state.settings.sortKey = key;
        state.settings.sortDir = "desc";
        sortClickKey = key;
        sortClickCount = 1;
      }
      saveSettings();
      applyFiltersAndRender();
    });
  });
}

/* ---------------- PWA ---------------- */
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

/* ---------------- Init ---------------- */
syncInputsFromSettings();
bindControls();
refresh();