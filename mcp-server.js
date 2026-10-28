"use strict";

/* Bazaar Flip Finder MCP server (stdio, JSON-RPC, zero dependencies).
 * Read-only view of live Hypixel Bazaar data. Run: node mcp-server.js
 * Requires Node >= 18 (global fetch). */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const BAZAAR_URL = "https://api.hypixel.net/v2/skyblock/bazaar";
const ITEMS_URL = "https://api.hypixel.net/v2/resources/skyblock/items";
const HOURS_PER_WEEK = 168;
const CACHE_MS = 25000;

const recipesSrc = fs.readFileSync(path.join(__dirname, "recipes.js"), "utf8");
const recipesWindow = {};
new Function("window", recipesSrc)(recipesWindow);
const RECIPES = recipesWindow.BAZAAR_RECIPES || [];

const cache = { t: 0, products: null, npc: {}, names: {} };

async function loadData() {
  if (cache.products && Date.now() - cache.t < CACHE_MS) return;
  const [bazaarRes, itemsRes] = await Promise.all([
    fetch(BAZAAR_URL, { cache: "no-store" }),
    fetch(ITEMS_URL, { cache: "force-cache" }).catch(() => null),
  ]);
  const bazaar = await bazaarRes.json();
  if (!bazaar.success) throw new Error("Bazaar API reported success=false");
  cache.products = bazaar.products;
  cache.t = Date.now();
  if (itemsRes && itemsRes.ok) {
    try {
      const items = await itemsRes.json();
      if (items.success && Array.isArray(items.items)) {
        for (const item of items.items) {
          if (!item.id) continue;
          if (item.name) cache.names[item.id] = item.name;
          if (typeof item.npc_sell_price === "number") cache.npc[item.id] = item.npc_sell_price;
        }
      }
    } catch {}
  }
}

const prod = (id) => cache.products[id];
const buyOrderFill = (q) => q.sellPrice;
const sellOfferFill = (q) => q.buyPrice;

function prettifyId(id) {
  return id.toLowerCase().split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
const nameOf = (id) => cache.names[id] || prettifyId(id);

function computeRisk(p, q, marginPct) {
  const reasons = [];
  let score = 0;
  const sum = (s) => (s || []).reduce((t, e) => t + e.amount, 0);
  const buyTotal = sum(p.buy_summary);
  const sellTotal = sum(p.sell_summary);
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

function depthNearBest(summary, side) {
  if (!summary || !summary.length) return 0;
  const best = summary[0].pricePerUnit;
  let units = 0;
  for (const e of summary) {
    if (side === "buy") {
      if (e.pricePerUnit >= best * 0.99) units += e.amount;
      else break;
    } else if (e.pricePerUnit <= best * 1.01) units += e.amount;
    else break;
  }
  return units;
}

function buildFlip(a) {
  const flipsPerHour = (a.limitingWeekly / HOURS_PER_WEEK) * a.share;
  const profitPerHour = a.marginPerUnit * flipsPerHour;
  const unitsAffordable = a.opts.budget > 0 ? Math.floor(a.opts.budget / a.cost) : null;
  const effUnits = unitsAffordable === null ? null : Math.max(0, Math.floor(Math.min(unitsAffordable, a.depth)));
  const budgetProfit = effUnits === null ? null : a.marginPerUnit * effUnits;
  return {
    mode: a.mode, id: a.id, name: a.name, sub: a.sub,
    buyOrderPrice: a.cost, sellOfferPrice: a.exit,
    marginPerUnit: a.marginPerUnit, marginPct: a.marginPct,
    depth: a.depth, limitingWeekly: a.limitingWeekly,
    buyMovingWeek: a.buyMovingWeek, sellMovingWeek: a.sellMovingWeek,
    profitPerHour, budgetProfit, effUnits,
    riskLevel: a.risk.level, riskScore: a.risk.score, riskReasons: a.risk.reasons,
    exitLabel: a.exitLabel,
  };
}

function computeFlips(opts) {
  const tax = opts.taxPct / 100;
  const share = opts.sharePct / 100;
  const flips = [];
  if (opts.mode === "bazaar") {
    for (const id in cache.products) {
      const p = cache.products[id];
      const q = p.quick_status;
      if (!q || !p.buy_summary?.length || !p.sell_summary?.length) continue;
      const cost = buyOrderFill(q);
      const exit = sellOfferFill(q);
      if (!(cost > 0) || !(exit > 0)) continue;
      const marginPerUnit = exit * (1 - tax) - cost;
      if (marginPerUnit <= 0) continue;
      const limitingWeekly = Math.min(q.buyMovingWeek || 0, q.sellMovingWeek || 0);
      if (limitingWeekly < opts.minVolume) continue;
      flips.push(buildFlip({
        mode: "bazaar", id, name: nameOf(id), sub: id,
        cost, exit, marginPerUnit, marginPct: (marginPerUnit / cost) * 100,
        depth: Math.min(depthNearBest(p.buy_summary, "buy"), depthNearBest(p.sell_summary, "sell")),
        limitingWeekly, buyMovingWeek: q.buyMovingWeek || 0, sellMovingWeek: q.sellMovingWeek || 0,
        share, opts, risk: computeRisk(p, q, (marginPerUnit / cost) * 100), exitLabel: "Bazaar",
      }));
    }
  } else if (opts.mode === "npc") {
    for (const id in cache.products) {
      const npcPrice = cache.npc[id];
      if (!(npcPrice > 0)) continue;
      const p = cache.products[id];
      const q = p.quick_status;
      if (!q || !p.sell_summary?.length) continue;
      const cost = buyOrderFill(q);
      if (!(cost > 0)) continue;
      const marginPerUnit = npcPrice - cost;
      if (marginPerUnit <= 0) continue;
      const limitingWeekly = q.buyMovingWeek || 0;
      if (limitingWeekly < opts.minVolume) continue;
      flips.push(buildFlip({
        mode: "npc", id, name: nameOf(id), sub: `Bazaar -> NPC @ ${npcPrice}`,
        cost, exit: npcPrice, marginPerUnit, marginPct: (marginPerUnit / cost) * 100,
        depth: depthNearBest(p.sell_summary, "sell"),
        limitingWeekly, buyMovingWeek: q.buyMovingWeek || 0, sellMovingWeek: null,
        share, opts, risk: computeRisk(p, q, (marginPerUnit / cost) * 100), exitLabel: "NPC",
      }));
    }
  } else {
    for (const recipe of RECIPES) {
      const out = prod(recipe.output);
      if (!out || !out.quick_status || !out.buy_summary?.length) continue;
      let ingredientCost = 0;
      let acquisitionWeekly = Infinity;
      let inputDepth = Infinity;
      let ok = true;
      for (const inp of recipe.inputs) {
        const ip = prod(inp.id);
        if (!ip || !ip.quick_status || !ip.sell_summary?.length) { ok = false; break; }
        const unitCost = buyOrderFill(ip.quick_status);
        if (!(unitCost > 0)) { ok = false; break; }
        ingredientCost += unitCost * inp.qty;
        acquisitionWeekly = Math.min(acquisitionWeekly, (ip.quick_status.buyMovingWeek || 0) / inp.qty);
        inputDepth = Math.min(inputDepth, depthNearBest(ip.sell_summary, "sell") / inp.qty);
      }
      if (!ok || ingredientCost <= 0) continue;
      const oq = out.quick_status;
      const bazaarNet = sellOfferFill(oq) * (1 - tax);
      const npcNet = cache.npc[recipe.output] || 0;
      const useNpc = npcNet > bazaarNet;
      const exitNet = useNpc ? npcNet : bazaarNet;
      const marginPerUnit = exitNet - ingredientCost;
      if (marginPerUnit <= 0) continue;
      const sellWeekly = useNpc ? Infinity : oq.sellMovingWeek || 0;
      const limitingWeekly = Math.min(acquisitionWeekly, sellWeekly);
      if (limitingWeekly < opts.minVolume) continue;
      flips.push(buildFlip({
        mode: "craft", id: recipe.output, name: nameOf(recipe.output),
        sub: "Craft: " + recipe.inputs.map((i) => `${i.qty}x ${nameOf(i.id)}`).join(" + "),
        cost: ingredientCost, exit: useNpc ? npcNet : sellOfferFill(oq), marginPerUnit,
        marginPct: (marginPerUnit / ingredientCost) * 100,
        depth: Math.min(inputDepth, useNpc ? Infinity : depthNearBest(out.buy_summary, "buy")),
        limitingWeekly, buyMovingWeek: acquisitionWeekly, sellMovingWeek: sellWeekly,
        share, opts, risk: computeRisk(out, oq, (marginPerUnit / ingredientCost) * 100),
        exitLabel: useNpc ? "NPC" : "Bazaar",
      }));
    }
  }
  return flips;
}

function pickSortKey(key) {
  const allowed = new Set(["buyOrderPrice", "sellOfferPrice", "marginPerUnit", "marginPct", "depth", "limitingWeekly", "profitPerHour", "budgetProfit", "riskScore"]);
  return allowed.has(key) ? key : "profitPerHour";
}

function summarize(f) {
  return {
    id: f.id, name: f.name, sub: f.sub, mode: f.mode,
    buy: f.buyOrderPrice, sell: f.sellOfferPrice,
    marginPerUnit: f.marginPerUnit, marginPct: f.marginPct,
    depth: f.depth, weeklyVolume: f.limitingWeekly,
    buyMovingWeek: f.buyMovingWeek, sellMovingWeek: f.sellMovingWeek,
    profitPerHour: f.profitPerHour,
    budgetUnits: f.effUnits, budgetProfit: f.budgetProfit,
    riskLevel: ["safe", "caution", "risky"][f.riskLevel],
    riskScore: f.riskScore, riskReasons: f.riskReasons,
    exit: f.exitLabel,
  };
}

const TOOLS = [
  {
    name: "get_flip_summary",
    description: "Top profitable flips ranked by estimated profit/hour, computed live from the Hypixel Bazaar. Matches what the web UI shows (buy/sell cost, margin, margin %, depth, weekly volume, risk, profit/hr).",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["bazaar", "npc", "craft"], description: "Flip type. Default bazaar." },
        minVolume: { type: "number", description: "Minimum weekly volume. Default 50000." },
        topN: { type: "number", description: "Max flips to return. Default 20." },
        budget: { type: "number", description: "Coin budget for qty/profit projection. 0 disables. Default 0." },
        taxPct: { type: "number", description: "Bazaar sales tax percent. Default 1.25." },
        sharePct: { type: "number", description: "Assumed share of weekly volume you can capture. Default 10." },
        sortKey: { type: "string", enum: ["profitPerHour", "marginPerUnit", "marginPct", "depth", "riskScore"], description: "Default profitPerHour." },
        sortDir: { type: "string", enum: ["asc", "desc"], description: "Default desc." },
      },
    },
  },
  {
    name: "get_item_detail",
    description: "Full flip detail for one bazaar product in a given mode: buy/sell, margin, %, depth, weekly volumes, risk assessment with reasons. Use list_products to find exact IDs.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Exact bazaar product ID, e.g. ENCHANTED_GOLDEN_CARROT." },
        mode: { type: "string", enum: ["bazaar", "npc", "craft"], description: "Default bazaar." },
        taxPct: { type: "number", description: "Default 1.25." },
        sharePct: { type: "number", description: "Default 10." },
        budget: { type: "number", description: "Default 0." },
      },
      required: ["id"],
    },
  },
  {
    name: "get_watchlist_view",
    description: "Compute current flip metrics for a list of item IDs (the user's watchlist). Returns one entry per ID; entries not producing a profitable flip still return book data.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Bazaar product IDs." },
        mode: { type: "string", enum: ["bazaar", "npc", "craft"], description: "Default bazaar." },
        taxPct: { type: "number", description: "Default 1.25." },
        sharePct: { type: "number", description: "Default 10." },
      },
      required: ["ids"],
    },
  },
  {
    name: "list_products",
    description: "Search bazaar products by ID or display-name substring. Returns ID, name, buy/sell top-of-book, order counts and weekly volumes.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive substring of ID or name. Empty lists everything." },
        limit: { type: "number", description: "Max results. Default 50." },
      },
    },
  },
];

async function callTool(name, args) {
  await loadData();
  if (name === "get_flip_summary") {
    const opts = {
      mode: args.mode || "bazaar",
      minVolume: typeof args.minVolume === "number" ? args.minVolume : 50000,
      taxPct: typeof args.taxPct === "number" ? args.taxPct : 1.25,
      sharePct: typeof args.sharePct === "number" ? args.sharePct : 10,
      budget: typeof args.budget === "number" ? args.budget : 0,
    };
    const key = pickSortKey(args.sortKey);
    const dir = args.sortDir === "asc" ? 1 : -1;
    let flips = computeFlips(opts).sort((a, b) => (a[key] - b[key]) * dir);
    const topN = typeof args.topN === "number" ? Math.max(1, Math.min(500, args.topN)) : 20;
    return { count: flips.length, flips: flips.slice(0, topN).map(summarize) };
  }
  if (name === "get_item_detail") {
    const opts = {
      mode: args.mode || "bazaar",
      minVolume: 0,
      taxPct: typeof args.taxPct === "number" ? args.taxPct : 1.25,
      sharePct: typeof args.sharePct === "number" ? args.sharePct : 10,
      budget: typeof args.budget === "number" ? args.budget : 0,
    };
    const flip = computeFlips(opts).find((f) => f.id === args.id);
    if (flip) return { found: true, item: summarize(flip) };
    const p = prod(args.id);
    if (!p) return { found: false, reason: "unknown bazaar product ID" };
    const q = p.quick_status || {};
    return {
      found: false,
      reason: "no profitable flip in this mode with current settings",
      book: {
        id: args.id, name: nameOf(args.id),
        topBuyOrder: q.buyPrice, topSellOffer: q.sellPrice,
        buyOrders: q.buyOrders, sellOrders: q.sellOrders,
        buyMovingWeek: q.buyMovingWeek, sellMovingWeek: q.sellMovingWeek,
      },
    };
  }
  if (name === "get_watchlist_view") {
    const opts = {
      mode: args.mode || "bazaar",
      minVolume: 0,
      taxPct: typeof args.taxPct === "number" ? args.taxPct : 1.25,
      sharePct: typeof args.sharePct === "number" ? args.sharePct : 10,
      budget: 0,
    };
    const byId = new Map(computeFlips(opts).map((f) => [f.id, f]));
    const results = (args.ids || []).map((id) => {
      const flip = byId.get(id);
      if (flip) return { id, watched: true, item: summarize(flip) };
      const p = prod(id);
      if (!p) return { id, watched: true, error: "unknown bazaar product ID" };
      const q = p.quick_status || {};
      return { id, watched: true, item: { id, name: nameOf(id), buy: q.buyPrice, sell: q.sellPrice, marginPerUnit: null, profitPerHour: null } };
    });
    return { count: results.length, items: results };
  }
  if (name === "list_products") {
    const q = String(args.search || "").trim().toLowerCase();
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(500, args.limit)) : 50;
    const out = [];
    for (const id in cache.products) {
      const qs = cache.products[id].quick_status || {};
      const name = nameOf(id);
      if (q && !id.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue;
      out.push({ id, name, buy: qs.buyPrice, sell: qs.sellPrice, buyOrders: qs.buyOrders, sellOrders: qs.sellOrders, buyMovingWeek: qs.buyMovingWeek, sellMovingWeek: qs.sellMovingWeek });
      if (out.length >= limit) break;
    }
    return { count: out.length, products: out };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function processMessage(msg) {
  if (!msg || typeof msg.method !== "string") return null;
  if (msg.method.startsWith("notifications/")) return null;
  if (msg.method === "initialize") {
    return Promise.resolve({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bazaar-flipper-mcp", version: "1.1.0" },
      },
    });
  }
  if (msg.method === "tools/list") {
    return Promise.resolve({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  }
  if (msg.method === "tools/call") {
    const params = msg.params || {};
    return callTool(params.name, params.arguments || {})
      .then((data) => ({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] },
      }))
      .catch((err) => ({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: "Error: " + err.message }], isError: true },
      }));
  }
  return Promise.resolve({
    jsonrpc: "2.0", id: msg.id,
    error: { code: -32601, message: "Method not found: " + msg.method },
  });
}

function startStdio() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    processMessage(msg).then((res) => res && send(res));
  });
}

function startHttp(port) {
  const http = require("http");
  http.createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { ...cors, "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "POST" && req.url === "/rpc") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          res.writeHead(400, cors);
          res.end("bad json");
          return;
        }
        processMessage(msg).then((r) => {
          res.writeHead(200, { ...cors, "Content-Type": "application/json" });
          res.end(JSON.stringify(r || { jsonrpc: "2.0", result: {} }));
        });
      });
      return;
    }
    res.writeHead(404, cors);
    res.end("not found");
  }).listen(port, "127.0.0.1", () => {
    console.error(`bazaar-flipper MCP listening on http://127.0.0.1:${port}/rpc`);
  });
}

const httpIdx = process.argv.indexOf("--http");
if (httpIdx !== -1) {
  startHttp(Number(process.argv[httpIdx + 1]) || 8790);
} else {
  startStdio();
}
