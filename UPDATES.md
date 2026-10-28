# UPDATES

All changes made to this repository since the original commit (`Skyblock Bazaar Flip Finder: live bazaar/NPC/craft flips`).

## Bug fixes

- **Fatal startup crash** — the app referenced a `#full-numbers` toggle that did not exist in `index.html`. The app crashed during init and stayed on "Loading live bazaar data…" forever with all controls dead. The checkbox was added back (the feature logic already existed in `app.js`).
- **Dead font import** — `@import` for the Inter webfont was placed after `@font-face`, which is invalid CSS and silently ignored. Moved to the top of `styles.css`.
- **Duplicate event handler** — the "Alert profit/hr" input was bound twice, causing every keystroke to be processed twice. Removed the redundant binding.
- **Sticky table header never worked** — the table container did not scroll vertically, so `position: sticky` on `thead th` did nothing. The container now has a max-height with vertical scrolling and the header stays pinned.
- **Full-numbers mode lost decimals** — comma-formatted values were rounded to integers. Restored up to 2 decimal places.
- **Service-worker staleness** — the app shell is served cache-first, so fixes never reached returning users. Cache version bumped (`bazaar-shell-v4` → `v10`) each time shell files changed. One hard refresh (Ctrl+Shift+R) picks up each version.

## Layout / UI

- **All 13 table columns fit on desktop with no horizontal scrollbar** — headers wrap at word boundaries, cell padding tightened, sparklines slimmed, long craft-recipe text wraps in the Item cell. Verified by measurement at 1280–1400px viewports with full numbers enabled.
- **Wider GUI** — the panel grew from 1280px to 1440px with more padding so information is less cramped.
- **Readable item cells** — item names are never truncated (they wrap); item IDs sit on a compact second line.
- **Mobile layout kept compact** — fixed-width controls retained at small viewports; table scrolls horizontally there (necessary).

## New features

- **Watchlist sidebar** — starred items appear in a dedicated sidebar instead of being pinned to the top of the table. Shows name, profit/hr, item ID, buy price, sell price, margin (+%), depth per entry. Search still finds watched items in the normal table. Sidebar is collapsible (✕) and toggled with the ★ Watch button; state persists.
- **Watchlist filter** — text filter inside the sidebar.
- **Dual price alerts** — per watchlist item: `sell ≤ X` (alert when sell offer drops to/below X) and `buy ≥ X` (alert when buy order rises to/above X). Either or both can be set; alerts fire as beep + toast + browser notification and re-arm when price recovers. Values accept `k`/`m` shorthand.
- **Sort reset** — clicking the same column header a third consecutive time resets sorting to the default (Profit/hr ▼).
- **1-hour trend** — sparklines now cover a rolling hour of margin history, persisted in localStorage across reloads (previously ~15 min, session-only). Line color indicates up/flat/down.
- **Outbid top buy order** — optional toggle that adds a configurable amount (default 0.1 coins) to every buy-order acquisition cost in all three modes, modeling what you would actually pay to place your order one tick above the current top order. Affects margins, buy qty, and budget profit.
- **Settings export/import** — ⤓ Save downloads a JSON file with all settings, the watchlist, and alert thresholds; ⤒ Load restores them (survives clearing site data, transfers between devices).
- **Expanded recipe database** — rewritten from 48 to 88 entries after verification against the NotEnoughUpdates item database and the community wiki (both sources agree). Key corrections:
  - `ENDER_PEARL` is **20:1** (was wrongly 160:1), `GHAST_TEAR` is **5:1**, `INK_SACK` and `PRISMARINE_SHARD` are **80:1** — the old flat 160:1 assumption produced badly wrong margins.
  - Fixed wrong output IDs: `SULPHUR → ENCHANTED_GUNPOWDER`, `RAW_BEEF → ENCHANTED_RAW_BEEF`, `RAW_CHICKEN → ENCHANTED_RAW_CHICKEN`.
  - Added: wheat/mushroom/hay chains (`ENCHANTED_HAY_BALE`, `ENCHANTED_HUGE_MUSHROOM_1/2`, `ENCHANTED_BONE_BLOCK`, `ENCHANTED_MELON_BLOCK`), blocks (glowstone, slime, clay, mycelium cube, packed ice, red sand cube, sulphur cube), foods (golden carrot, cookie, cooked mutton/grilled pork/cooked fish/cooked rabbit), and more tier-1s (rabbit, snow block, endstone, blaze powder, wool, honeycomb, dandelion, oak log).
  - Non-160 ratios added correctly: `ENCHANTED_EGG` 144:1, `ENCHANTED_PAPER` 192:1, `ENCHANTED_BREAD` 60:1, `ENCHANTED_PRISMARINE_CRYSTALS` 80:1.

## MCP server

- **`mcp-server.js`** — a read-only Model Context Protocol server (stdio JSON-RPC, zero dependencies, Node ≥ 18) exposing live bazaar data to AI tools:
  - `get_flip_summary` — top flips with buy/sell cost, margin, margin %, depth, weekly volume, risk score + reasons, profit/hr
  - `get_item_detail` — full flip detail for one product
  - `get_watchlist_view` — current metrics for a list of item IDs
  - `list_products` — search all bazaar products
- Data is fetched live from the Hypixel API and cached 25 s between calls; recipes are loaded from `recipes.js` so craft flips match the web UI.
- **HTTP sidecar mode** — `node mcp-server.js --http 8790` serves the same tools on `http://127.0.0.1:8790/rpc` (CORS-enabled) with a `/health` endpoint, for clients that cannot spawn stdio processes.
- **`package.json`** added with scripts: `npm start` (npx serve .), `npm run mcp`, `npm run mcp:http`, `npm run start:all` (site + MCP together).
