/**
 * src/ui/dashboardHtml.ts
 * OWNER: dashboard agent
 *
 * The full dashboard document as a single exported template string, ported from
 * ../../dashboard-design.html. The look/theme/tabs/CSS-variables are preserved
 * verbatim; the mock SAMPLE_* arrays are replaced with live calls to the API
 * built by the delivery/admin agents:
 *
 *   Feed          GET /api/transactions?since=<cursor>
 *                 EventSource('/api/stream?subscription=<id>')
 *   Review        GET /api/admin/review-queue
 *                 POST /api/admin/review/:docId  {decision}
 *   Subscriptions GET/POST /api/subscriptions
 *   Admin cadence GET/PUT /api/admin/poll-config
 *   Source health GET /api/admin/sources/health
 *
 * Dependency-free vanilla JS. Loading / empty / error states are handled for
 * every panel; the "illustrative sample data" banner is removed the moment real
 * feed data loads.
 */

export const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Congress.Trade — Congress Trade Feed</title>
<script>
  // Admin-controlled, site-wide logo style (injected at serve time).
  window.__LOGO_DISPLAY__ = "%LOGO_DISPLAY%";
  // Apply the persisted theme before first paint to avoid a flash.
  try { if (localStorage.getItem('ui-theme') === 'light') document.documentElement.setAttribute('data-theme', 'light'); } catch (e) {}
</script>
<style>
  :root {
    /* ---- THEME ---- */
    --bg:        #0b1120;
    --bg-2:      #111a2e;
    --panel:     #15203a;
    --panel-2:   #1b2747;
    --border:    #243154;
    --text:      #e6edf6;
    --text-dim:  #8da2c0;
    --accent:    #4f8cff;
    --buy:       #22c55e;
    --sell:      #ef4444;
    --exch:      #eab308;
    --warn:      #f59e0b;
    --good:      #34d399;
    --radius:    12px;
    --mono:      ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --sans:      system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  }
  /* ---- light theme (toggled via html[data-theme="light"]) ---- */
  html[data-theme="light"] {
    --bg:        #f4f7fb;
    --bg-2:      #e9eef6;
    --panel:     #ffffff;
    --panel-2:   #eef3fa;
    --border:    #d3dced;
    --text:      #142036;
    --text-dim:  #5a6b86;
    --accent:    #2563eb;
    --buy:       #15803d;
    --sell:      #dc2626;
    --exch:      #b45309;
    --warn:      #b45309;
    --good:      #15803d;
  }
  html[data-theme="light"] header.top { background: rgba(255,255,255,.72); }
  /* ---- theme toggle ---- */
  .theme-toggle { background: transparent; border: 1px solid var(--border); color: var(--text-dim); border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 13px; line-height: 1; }
  .theme-toggle:hover { color: var(--text); background: var(--panel); }
  /* ---- resizable feed columns ---- */
  .table-wrap { overflow-x: auto; }
  #feedTable.resizable { table-layout: fixed; width: max-content; min-width: 100%; }
  #feedTable.resizable td { overflow: hidden; }
  #feedHead th { position: relative; }
  .col-resizer { position: absolute; top: 0; right: 0; width: 7px; height: 100%; cursor: col-resize; user-select: none; touch-action: none; }
  .col-resizer:hover { background: color-mix(in srgb, var(--accent) 45%, transparent); }
  /* ---- monogram backup logo (shown when a ticker's real logo is missing) ---- */
  .tkr-logo.mono img { display: none; }
  .tkr-logo.mono { font-family: var(--mono); font-size: 9px; font-weight: 700; color: var(--text-dim); background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; }
  .tkr-logo.mono::after { content: attr(data-mono); }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: radial-gradient(1200px 600px at 70% -10%, var(--bg-2), var(--bg));
    color: var(--text); font-family: var(--sans); font-size: 14px; min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  header.top {
    display: flex; align-items: center; gap: 16px; padding: 14px 22px;
    border-bottom: 1px solid var(--border); background: rgba(10,16,30,.6);
    backdrop-filter: blur(8px); position: sticky; top: 0; z-index: 10;
  }
  .brand { font-weight: 700; letter-spacing: .3px; font-size: 16px; }
  .brand .dot { color: var(--accent); }
  .pill { font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-dim); }
  .pill.live { color: var(--good); border-color: color-mix(in srgb, var(--good) 40%, transparent); }
  .pill.live::before { content:"●"; margin-right:5px; animation: pulse 1.6s infinite; }
  .pill.off { color: var(--text-dim); }
  .pill.off::before { content:"○"; margin-right:5px; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  nav.tabs { display: flex; gap: 4px; margin-left: auto; flex-wrap: wrap; }
  nav.tabs button {
    background: transparent; color: var(--text-dim); border: 1px solid transparent;
    padding: 7px 13px; border-radius: 8px; cursor: pointer; font-size: 13px; font-family: var(--sans);
  }
  nav.tabs button:hover { color: var(--text); background: var(--panel); }
  nav.tabs button.active { color: var(--text); background: var(--panel-2); border-color: var(--border); }
  main { padding: 22px; max-width: 1180px; margin: 0 auto; }
  .banner {
    font-size: 12px; color: var(--warn); border: 1px dashed color-mix(in srgb, var(--warn) 45%, transparent);
    background: color-mix(in srgb, var(--warn) 8%, transparent); padding: 8px 12px; border-radius: 8px; margin-bottom: 18px;
  }
  .banner.err { color: var(--sell); border-color: color-mix(in srgb, var(--sell) 45%, transparent); background: color-mix(in srgb, var(--sell) 8%, transparent); }
  .view { display: none; }
  .view.active { display: block; }
  .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
  input, select {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    padding: 8px 11px; border-radius: 8px; font-size: 13px; font-family: var(--sans);
  }
  input::placeholder { color: var(--text-dim); }
  .grid-cards { display: grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .card .k { color: var(--text-dim); font-size: 12px; }
  .card .v { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .card .v small { font-size: 12px; font-weight: 500; color: var(--text-dim); }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  th, td { text-align: left; padding: 11px 13px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
  th { color: var(--text-dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  tr:last-child td { border-bottom: none; }
  tr.row:hover td { background: var(--panel-2); }
  th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
  th.sortable:hover { color: var(--text); }
  th.sortable .arr { opacity: .4; font-size: 10px; margin-left: 4px; }
  th.sortable.active { color: var(--text); }
  th.sortable.active .arr { opacity: 1; color: var(--accent); }
  /* fold-out advanced search */
  .search-panel {
    display: none; gap: 10px; flex-wrap: wrap; align-items: center;
    margin: -4px 0 14px; padding: 12px 14px; background: var(--panel);
    border: 1px solid var(--border); border-radius: var(--radius);
  }
  .search-panel.open { display: flex; }
  .search-panel .lbl { font-size: 12px; color: var(--text-dim); margin-right: 2px; }
  .btn.ghost.sm.on { color: var(--accent); border-color: var(--accent); }
  td.state { text-align: center; color: var(--text-dim); padding: 22px 13px; }
  .tkr { font-family: var(--mono); font-weight: 700; }
  /* ---- ticker logos (ported from agentic-trading) ---- */
  .asset-cell { display: flex; align-items: center; gap: 9px; min-width: 0; }
  /* let the text shrink inside the (resizable, fixed-layout) cell and clip with
     an ellipsis instead of wrapping or hard-clipping mid-word */
  .asset-cell > div { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tkr-logo { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; overflow: hidden; }
  .tkr-logo img { width: 100%; height: 100%; object-fit: contain; display: block; }
  /* "tile" = frosted-glass box; "transparent" = bare logo on the row surface. */
  .tkr-logo.tile { border: 1px solid var(--border); background: color-mix(in srgb, var(--panel-2) 80%, transparent); border-radius: 6px; padding: 2px; }
  .tkr-logo.transparent { border-radius: 4px; }
  /* ---- member headshots (mirrors the ticker-logo image+fallback pattern) ---- */
  .member-cell { display: flex; align-items: center; gap: 9px; }
  /* The avatar shows initials by default; a successful headshot <img> overlays
     them, and onerror="this.remove()" drops the <img> to reveal initials. */
  .avatar { position: relative; flex: 0 0 auto; width: 24px; height: 24px; border-radius: 50%; overflow: hidden; display: inline-flex; align-items: center; justify-content: center; background: var(--panel-2); border: 1px solid var(--border); font-size: 10px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: var(--panel-2); }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 6px; font-weight: 600; display:inline-block; }
  .tag.P { color: var(--buy); background: color-mix(in srgb, var(--buy) 14%, transparent); }
  .tag.S { color: var(--sell); background: color-mix(in srgb, var(--sell) 14%, transparent); }
  .tag.E { color: var(--exch); background: color-mix(in srgb, var(--exch) 14%, transparent); }
  .conf { font-family: var(--mono); font-size: 12px; }
  .conf.hi { color: var(--good); } .conf.mid { color: var(--warn); } .conf.lo { color: var(--sell); }
  .muted { color: var(--text-dim); }
  .latency { font-family: var(--mono); font-size: 12px; color: var(--text-dim); }
  .btn { background: var(--accent); color: #fff; border: none; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .btn.ghost { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .btn.sm { padding: 5px 10px; font-size: 12px; }
  .btn:disabled { opacity: .5; cursor: default; }
  .section { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; margin-bottom: 18px; }
  .section h3 { margin: 0 0 4px; font-size: 15px; }
  .section p.sub { margin: 0 0 16px; color: var(--text-dim); font-size: 13px; }
  .row-flex { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .switch { position: relative; width: 46px; height: 26px; }
  .switch input { display: none; }
  .switch span { position:absolute; inset:0; background: var(--panel-2); border:1px solid var(--border); border-radius:999px; cursor:pointer; transition:.2s; }
  .switch span::after { content:""; position:absolute; width:18px; height:18px; left:3px; top:3px; background: var(--text-dim); border-radius:50%; transition:.2s; }
  .switch input:checked + span { background: color-mix(in srgb, var(--accent) 35%, transparent); border-color: var(--accent); }
  .switch input:checked + span::after { left:24px; background: var(--accent); }
  .sched-row { display:grid; grid-template-columns: 1.3fr 1fr 1fr .6fr; gap:10px; align-items:center; margin-bottom:8px; }
  .sched-row .lbl { font-size:12px; color: var(--text-dim); }
  .note { font-size:12px; color: var(--text-dim); margin-top:8px; line-height:1.5; }
  code { font-family: var(--mono); background: var(--bg); padding:1px 6px; border-radius:5px; font-size:12px; color: var(--accent); }
  /* ================= TRENDS / ANALYTICS ================= */
  .trend-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 860px) { .trend-grid2 { grid-template-columns: 1fr; } }
  .est { color: var(--text-dim); }
  .pdot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:middle; background: var(--text-dim); }
  .pdot.D { background:#3b82f6; } .pdot.R { background:#ef4444; } .pdot.O { background:#a78bfa; }
  .rank { color: var(--text-dim); font-family: var(--mono); font-size:12px; width:22px; text-align:right; }
  .net.pos { color: var(--buy); } .net.neg { color: var(--sell); }
  /* buy/sell split bar */
  .split { display:inline-flex; width:120px; height:9px; border-radius:5px; overflow:hidden; background: var(--panel-2); border:1px solid var(--border); vertical-align:middle; }
  .split .seg { height:100%; } .split .seg.buy { background: var(--buy); } .split .seg.sell { background: var(--sell); }
  .split-wrap { display:flex; align-items:center; gap:8px; }
  .split-wrap small { color: var(--text-dim); font-family: var(--mono); font-size:11px; white-space:nowrap; }
  tr.clickable { cursor: pointer; }
  /* horizontal proportion bar (sectors / lag / party) */
  .hbar { display:flex; align-items:center; gap:10px; margin:7px 0; }
  .hbar .hlabel { width:130px; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .hbar .htrack { flex:1; height:14px; background: var(--panel-2); border:1px solid var(--border); border-radius:7px; overflow:hidden; }
  .hbar .hfill { height:100%; background: color-mix(in srgb, var(--accent) 70%, transparent); }
  .hbar .hfill.buy { background: var(--buy); } .hbar .hfill.warn { background: var(--warn); } .hbar .hfill.sell { background: var(--sell); }
  .hbar .hval { width:120px; text-align:right; font-family: var(--mono); font-size:12px; color: var(--text-dim); }
  /* time chart (CSS columns, no chart lib) */
  .tchart { display:flex; align-items:flex-end; gap:3px; height:180px; overflow-x:auto; padding-top:6px; }
  .tcol { display:flex; flex-direction:column; align-items:center; gap:4px; flex:0 0 auto; }
  .tbars { display:flex; align-items:flex-end; gap:2px; height:150px; }
  .tbars i { display:block; width:7px; border-radius:2px 2px 0 0; min-height:0; }
  .tbars i.buy { background: var(--buy); } .tbars i.sell { background: var(--sell); }
  .tlbl { font-size:9px; color: var(--text-dim); font-family: var(--mono); white-space:nowrap; }
  .legend { display:flex; gap:14px; font-size:12px; color: var(--text-dim); margin-bottom:6px; }
  .legend .sw { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  .legend .sw.buy { background: var(--buy); } .legend .sw.sell { background: var(--sell); }
  /* cluster cards */
  .cluster-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap:12px; }
  .ccard { background: var(--panel-2); border:1px solid var(--border); border-radius:10px; padding:13px 14px; }
  .ccard .chead { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .ccard .big { font-size:18px; font-weight:700; }
  .ccard .faces { display:flex; margin-top:9px; }
  .ccard .faces .avatar { margin-right:-7px; box-shadow:0 0 0 2px var(--panel-2); }
  .dirpill { font-size:10px; font-weight:700; padding:2px 7px; border-radius:6px; letter-spacing:.4px; }
  .dirpill.P { color: var(--buy); background: color-mix(in srgb, var(--buy) 16%, transparent); }
  .dirpill.S { color: var(--sell); background: color-mix(in srgb, var(--sell) 16%, transparent); }
  .chip { font-size:11px; color: var(--text-dim); }
  .disclaimer { font-size:12px; color: var(--text-dim); line-height:1.6; border:1px solid var(--border); background: var(--panel); border-radius: var(--radius); padding:12px 15px; margin-bottom:16px; }
  .disclaimer strong { color: var(--text); }
  /* modal */
  .modal { position:fixed; inset:0; background:rgba(2,6,18,.6); display:none; align-items:flex-start; justify-content:center; z-index:50; padding:40px 16px; overflow-y:auto; }
  .modal.open { display:flex; }
  .modal-card { background: var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:20px; width:100%; max-width:720px; }
  .modal-card .x { float:right; cursor:pointer; color: var(--text-dim); font-size:18px; border:none; background:none; }
  footer { text-align:center; color: var(--text-dim); font-size:11px; padding:26px; }
</style>
</head>
<body>
<header class="top">
  <div class="brand">Congress<span class="dot">.</span>Trade</div>
  <span class="pill off" id="livePill">connecting…</span>
  <span class="pill" id="srcPill">House + Senate</span>
  <nav class="tabs">
    <button data-view="feed" class="active">Live Feed</button>
    <button data-view="trends">Trends</button>
    <button data-view="review">Review Queue <span id="reviewCount"></span></button>
    <button data-view="subs">Subscriptions</button>
    <button data-view="admin">Admin · Cadence</button>
  </nav>
  <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Toggle light / dark">🌙</button>
</header>

<main>
  <div class="banner" id="banner">Connecting to the live feed…</div>

  <!-- ================= LIVE FEED ================= -->
  <section class="view active" id="view-feed">
    <div class="grid-cards">
      <div class="card"><div class="k">New filings today</div><div class="v" id="kpiToday">—</div></div>
      <div class="card"><div class="k">Total in feed</div><div class="v" id="kpiTotal">—</div></div>
      <div class="card"><div class="k">Auto-parsed (no LLM)</div><div class="v" id="kpiAuto">—<small>%</small></div></div>
      <div class="card"><div class="k">Needs review</div><div class="v" id="kpiReview">—</div></div>
      <div class="card"><div class="k">Poll mode</div><div class="v" id="kpiMode">—</div></div>
    </div>
    <div class="toolbar">
      <input id="qMember" placeholder="Filter member…" oninput="renderFeed()" />
      <input id="qTicker" placeholder="Ticker…" oninput="renderFeed()" style="width:120px" />
      <select id="qType" onchange="renderFeed()">
        <option value="">All types</option><option value="P">Purchase</option>
        <option value="S">Sale</option><option value="E">Exchange</option>
      </select>
      <select id="qChamber" onchange="renderFeed()">
        <option value="">Both Chambers</option><option value="house">House</option><option value="senate">Senate</option>
      </select>
      <button class="btn ghost sm" id="searchToggle" onclick="toggleSearch()">🔍 Search</button>
      <button class="btn ghost sm" onclick="refreshFeed()">↻ Refresh</button>
    </div>
    <div class="search-panel" id="searchPanel">
      <span class="lbl">Search all</span>
      <input id="qAll" placeholder="member, asset, ticker, source…" style="min-width:240px;flex:1" oninput="renderFeed()" />
      <span class="lbl">Min $</span>
      <input id="qMinAmt" type="number" min="0" placeholder="0" style="width:120px" oninput="renderFeed()" />
      <span class="lbl">Source</span>
      <select id="qSource" onchange="renderFeed()">
        <option value="">Any</option><option value="primary">Live (primary)</option><option value="seed_dataset">Historic (seed)</option>
      </select>
      <button class="btn ghost sm" onclick="clearSearch()">Clear</button>
    </div>
    <div class="table-wrap">
    <table id="feedTable">
      <thead><tr id="feedHead">
        <th class="sortable" data-sort="filed">Filed<span class="arr"></span></th>
        <th class="sortable" data-sort="member">Member<span class="arr"></span></th>
        <th class="sortable" data-sort="asset">Asset<span class="arr"></span></th>
        <th class="sortable" data-sort="type">Type<span class="arr"></span></th>
        <th class="sortable" data-sort="min">Amount (STOCK Act bracket)<span class="arr"></span></th>
        <th class="sortable" data-sort="txdate">Tx date<span class="arr"></span></th>
        <th class="sortable" data-sort="owner">Owner<span class="arr"></span></th>
        <th class="sortable" data-sort="conf">Conf.<span class="arr"></span></th>
        <th class="sortable" data-sort="source">Source<span class="arr"></span></th>
        <th data-sort="latency" title="Released→Seen (approx, disclosure date → our watcher) · Seen→Imported (precise, our watcher → parsed rows). Live rows only.">Latency</th>
      </tr></thead>
      <tbody id="feedBody"></tbody>
    </table>
    </div>
    <div class="row-flex" style="margin-top:14px;justify-content:center">
      <button class="btn ghost sm" id="loadMoreBtn" onclick="loadMore()" style="display:none">Load more</button>
      <span class="note" id="feedCountMsg"></span>
    </div>
  </section>

  <!-- ================= TRENDS / ANALYTICS ================= -->
  <section class="view" id="view-trends">
    <div class="toolbar">
      <select id="trWindow" title="Time window (by trade date)">
        <option value="1d">Past day</option>
        <option value="7d">Past week</option>
        <option value="30d" selected>Past month</option>
        <option value="90d">Past 3 months</option>
        <option value="180d">Past 6 months</option>
        <option value="365d">Past year</option>
        <option value="1825d">Past 5 years</option>
        <option value="all">All time</option>
      </select>
      <select id="trChamber"><option value="">Both chambers</option><option value="house">House</option><option value="senate">Senate</option></select>
      <select id="trParty"><option value="">All parties</option><option value="D">Democrat</option><option value="R">Republican</option><option value="O">Other / Ind.</option></select>
      <select id="trSource" title="Provenance of the underlying rows">
        <option value="all" selected>All data</option>
        <option value="primary">Live (primary) only</option>
        <option value="seed_dataset">Historic (seed) only</option>
      </select>
      <button class="btn ghost sm" onclick="loadTrends()">↻ Refresh</button>
    </div>
    <div class="disclaimer">
      <strong>For education, not investment advice.</strong> Congress.Trade is an informational tool for exploring <em>public</em> STOCK Act disclosures. The summaries below are historical, observational views of those filings — they are <strong>not</strong> trading signals, recommendations, or predictions, and nothing here implies any member acted improperly or illegally. Dollar figures are <strong>estimates</strong> from disclosed amount <em>brackets</em> (midpoint; the open “$50M+” tier uses its floor) and may be incomplete or delayed — filings are disclosed weeks after the trade. “All data” can double-count a trade present in both the live and historic sets; use <em>Live only</em> for a de-duplicated dollar view. Party is known for only some members. Always do your own research.
    </div>

    <!-- KPI strip -->
    <div class="grid-cards" id="trKpis">
      <div class="card"><div class="k">Loading…</div><div class="v">—</div></div>
    </div>

    <!-- What Congress is trading + Heating up -->
    <div class="trend-grid2">
      <div class="section">
        <h3>What Congress is trading</h3>
        <p class="sub">Most-traded tickers in the window. Click a row for a deep dive. Bar = buy / sell mix.</p>
        <div class="row-flex" style="margin:-6px 0 12px">
          <label class="lbl">Rank by</label>
          <select id="trTickerSort">
            <option value="trades">Trades</option>
            <option value="members">Distinct members</option>
            <option value="volume">Est. volume</option>
            <option value="netflow">Net $ flow</option>
          </select>
        </div>
        <div class="table-wrap"><table><tbody id="trTickers"></tbody></table></div>
      </div>
      <div class="section">
        <h3>Rising activity</h3>
        <p class="sub">Tickers whose disclosed trade count rose most vs the prior equal period. A descriptive view of filing activity — not a forecast.</p>
        <div class="table-wrap"><table><tbody id="trTrending"></tbody></table></div>
      </div>
    </div>

    <!-- Consensus / cluster buys -->
    <div class="section">
      <h3>Consensus moves <span class="chip" id="trClusterHint"></span></h3>
      <p class="sub">Tickers where several different members happened to trade the <strong>same direction</strong> in the window. Shown as an educational observation of public filings — not a recommendation, and not evidence of coordination.</p>
      <div class="cluster-grid" id="trClusters"></div>
    </div>

    <!-- Buys vs sells over time -->
    <div class="section">
      <h3>Buys vs sells over time</h3>
      <p class="sub">Trade counts bucketed by period. The <em>shape</em> — a surge of buying or selling — is the trend.</p>
      <div class="legend"><span><span class="sw buy"></span>Buys</span><span><span class="sw sell"></span>Sells</span></div>
      <div id="trTime"></div>
    </div>

    <!-- Members + Party -->
    <div class="trend-grid2">
      <div class="section">
        <h3>Most active members</h3>
        <p class="sub">Who is trading the most in the window.</p>
        <div class="table-wrap"><table><tbody id="trMembers"></tbody></table></div>
      </div>
      <div class="section">
        <h3>By party</h3>
        <p class="sub">Buy / sell mix and estimated net flow per party (where party is known).</p>
        <div id="trParties"></div>
        <h3 style="margin-top:18px">By asset type</h3>
        <p class="sub">Share of estimated volume by instrument type.</p>
        <div id="trSectors"></div>
      </div>
    </div>

    <!-- Disclosure timeliness -->
    <div class="section">
      <h3>Disclosure timeliness</h3>
      <p class="sub">Days from trade to filing. The STOCK Act sets a 45-day deadline; this is a data-quality + accountability lens.</p>
      <div class="grid-cards" id="trLagKpis"></div>
      <div class="trend-grid2" style="margin-top:6px">
        <div><h3 style="font-size:13px">Lag distribution</h3><div id="trLagDist"></div></div>
        <div><h3 style="font-size:13px">Slowest filers (avg lag)</h3><div class="table-wrap"><table><tbody id="trLateFilers"></tbody></table></div></div>
      </div>
    </div>
  </section>

  <!-- ================= REVIEW QUEUE ================= -->
  <section class="view" id="view-review">
    <div class="section">
      <h3>Low-confidence parses</h3>
      <p class="sub">Scanned / handwritten filings below the confidence threshold are held here and never hit the live webhook until a human confirms.</p>
      <table>
        <thead><tr><th>Filed</th><th>Doc</th><th>Reason</th><th>Payload</th><th></th></tr></thead>
        <tbody id="reviewBody"></tbody>
      </table>
      <p class="note">Confirming a row promotes it to the live feed and dispatches it to subscribers. <code>POST /api/admin/review/:docId {decision}</code></p>
    </div>
  </section>

  <!-- ================= SUBSCRIPTIONS ================= -->
  <section class="view" id="view-subs">
    <div class="section">
      <h3>Delivery subscriptions</h3>
      <p class="sub">Push new trades to your trading app (webhook) or a browser (SSE). All webhook payloads are HMAC-signed; consumers dedupe on <code>docId</code>.</p>
      <table>
        <thead><tr><th>Client</th><th>Channel</th><th>Target</th><th>Filters</th><th>Status</th></tr></thead>
        <tbody id="subsBody"></tbody>
      </table>
      <div class="row-flex" style="margin-top:14px">
        <input id="newClientId" placeholder="clientId" style="width:160px" />
        <select id="newDelivery">
          <option value="sse">SSE</option><option value="webhook">webhook</option>
        </select>
        <input id="newTarget" placeholder="target URL (webhook only)" style="width:240px" />
        <button class="btn sm" onclick="createSubscription()">+ New subscription</button>
        <span id="subsMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: GET/POST <code>/api/subscriptions</code></p>
    </div>
  </section>

  <!-- ================= ADMIN · CADENCE ================= -->
  <section class="view" id="view-admin">
    <div class="section">
      <h3>Admin access</h3>
      <p class="sub">The admin endpoints (poll cadence, review queue, backfill) are gated by a bearer token. Paste your <code>ADMIN_TOKEN</code> once — it's kept in this browser only (localStorage) and sent as <code>Authorization: Bearer …</code> on admin requests. Leave blank if the server has no token set. (Tip: if you sign in via Cloudflare Access, you don't need a token here.)</p>
      <div class="row-flex">
        <input id="adminToken" type="password" autocomplete="off" placeholder="ADMIN_TOKEN" style="flex:1;min-width:240px" />
        <button class="btn" onclick="saveAdminToken()">Save token</button>
        <button class="btn ghost sm" onclick="clearAdminToken()">Clear</button>
        <span id="adminTokenMsg" class="note"></span>
      </div>
    </div>
    <div class="section">
      <h3>Logos</h3>
      <p class="sub">Company-logo style shown on the live feed for <strong>all visitors</strong>. "Plain" shows bare logos; "Tile" frames them; "Off" hides them. When a logo is on but a ticker's image isn't available, a monogram (the ticker's first letters) is shown as a backup.</p>
      <div class="row-flex">
        <label class="lbl">Logo style</label>
        <select id="adminLogo">
          <option value="transparent">Logos: Plain</option>
          <option value="tile">Logos: Tile</option>
          <option value="off">Logos: Off</option>
        </select>
        <button class="btn" onclick="saveLogoDisplay()">Save for everyone</button>
        <span id="logoMsg" class="note"></span>
      </div>
    </div>
    <div class="section">
      <h3>Poll cadence</h3>
      <p class="sub">Filings land almost entirely during US-Eastern business hours on weekdays. Adaptive windows keep latency low when it matters and stay polite to gov servers overnight.</p>
      <div class="row-flex" style="margin-bottom:16px">
        <label class="switch"><input type="checkbox" id="aggToggle" onchange="toggleAggressive()"><span></span></label>
        <div><strong>Aggressive mode</strong><div class="note" style="margin-top:2px">Drops business-hours interval for front-running edge vs higher-latency trackers.</div></div>
      </div>
      <div class="sched-row"><div class="lbl">Days (0=Sun…6=Sat)</div><div class="lbl">Start ET</div><div class="lbl">End ET</div><div class="lbl">Interval (s)</div></div>
      <div id="schedRows"></div>
      <div class="row-flex" style="margin-top:14px">
        <button class="btn" onclick="saveSchedule()">Save cadence</button>
        <button class="btn ghost" onclick="loadPollConfig()">Reload</button>
        <span id="saveMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: <code>GET/PUT /api/admin/poll-config</code>. The Worker cron fires every minute and consults this schedule via <code>shouldPollNow()</code> — so changes take effect within ~60s, no redeploy.</p>
    </div>
    <div class="section">
      <h3>Historic backfill</h3>
      <p class="sub">Bulk-import pre-aggregated public datasets as <code>seed_dataset</code> rows to bootstrap back-history. Idempotent (safe to re-run); these rows are reference-only and never dispatched to subscribers.</p>
      <div class="row-flex">
        <label class="lbl">Since year</label>
        <input id="bfSince" type="number" placeholder="e.g. 2020" style="width:120px" />
        <label class="lbl">Row limit</label>
        <input id="bfLimit" type="number" placeholder="(none)" style="width:120px" />
        <select id="bfChambers">
          <option value="">Both chambers</option><option value="house">House only</option><option value="senate">Senate only</option>
        </select>
        <button class="btn ghost sm" onclick="runBackfill(true)">Dry run</button>
        <button class="btn" onclick="runBackfill(false)">Run seed backfill</button>
        <span id="bfMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: <code>POST /api/admin/backfill</code>. Senate defaults to the GitHub mirror (works out of the box). The House community bucket is gated (HTTP 403) — set <code>SEED_HOUSE_URL</code>, or use the official House index backfill below.</p>
      <div class="row-flex" style="margin-top:14px">
        <label class="lbl">House history (official index)</label>
        <input id="hiFrom" type="number" placeholder="from year" style="width:120px" />
        <input id="hiTo" type="number" placeholder="to year" style="width:120px" />
        <button class="btn ghost sm" onclick="runHouseIndex(true)">Dry run</button>
        <button class="btn" onclick="runHouseIndex(false)">Backfill House index</button>
        <span id="hiMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: <code>POST /api/admin/house-backfill</code>. Pulls past-year House bulk ZIPs (official, always reachable) and runs each PTR through the live pipeline — high-fidelity, but heavier than the seed import.</p>
    </div>
    <div class="section">
      <h3>Source health</h3>
      <p class="sub">First-seen timestamps are logged per filing so real refresh cadence is measured, not assumed.</p>
      <table>
        <thead><tr><th>Source</th><th>Last poll</th><th>Last new filing</th><th>Polls</th><th>Avg refresh (observed)</th><th title="Official disclosure date → when our watcher first saw it. Approximate: the disclosure systems publish a date, not an exact release time.">Released→Seen ≈</th><th title="When we first saw the filing → when we wrote its parsed rows. Precise (both are our timestamps).">Seen→Imported</th></tr></thead>
        <tbody id="healthBody"></tbody>
      </table>
    </div>
  </section>

  <footer>Congress.Trade · an educational tool for exploring public STOCK Act (2012) disclosures · informational only — not financial advice, not trading signals · dollar figures are estimates from disclosed brackets</footer>
</main>

<div class="modal" id="tickerModal" onclick="if(event.target===this)closeTicker()">
  <div class="modal-card"><button class="x" onclick="closeTicker()">✕</button><div id="tickerModalBody"></div></div>
</div>

<script>
/* ============================ STATE ============================ */
var TRADES = [];          // live transactions (newest first)
var REVIEW = [];          // review-queue items
var SCHEDULE = [];        // PollWindow[]
var aggressive = false;
var cursor = 0;           // max cursor_seq seen
var totalRows = 0;        // server-reported total matching rows (for "X of N")
var loadingPage = false;  // guards against overlapping page fetches
var realDataLoaded = false;
var es = null;            // EventSource handle
var pollTimer = null;     // setInterval handle for the polling fallback
var POLL_LIMIT = 500;     // matches MAX_TX_LIMIT in delivery/rows.ts
var POLL_INTERVAL_MS = 30000;  // graceful polling cadence when SSE is unavailable
var sortKey = 'filed';    // active feed sort column
var sortDir = -1;         // 1 = ascending, -1 = descending (default: newest first)
var NUMERIC_SORT = { min: 1, conf: 1 };   // columns compared numerically

/* ============================ HELPERS ============================ */
var fmt = function (n) { return n == null ? '—' : '$' + Number(n).toLocaleString(); };
var confClass = function (c) { return c >= 0.9 ? 'hi' : c >= 0.7 ? 'mid' : 'lo'; };
var typeName = { P: 'Purchase', S: 'Sale', E: 'Exchange' };
/* Capitalize a beneficial-owner code for display (self -> Self, joint -> Joint). */
function ownerLabel(o) { var s = String(o == null ? '' : o); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}
function el(id) { return document.getElementById(id); }

/* Strip stray HTML/entities some upstream datasets embed in asset descriptions
   (e.g. "<div class=text-muted><em>Rate/Coupon:</em> 3.875%<br>…</div>"). */
function cleanAsset(s) {
  if (s == null) return '';
  var t = String(s).replace(/<[^>]*>/g, ' ');
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&#0*39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
  return t.replace(/\\s+/g, ' ').trim();
}

/* Human duration: 45s, 3m 12s, 2h 5m, 1d 4h. */
function fmtDuration(sec) {
  if (sec == null) return '—';
  sec = Math.round(sec);
  if (sec < 60) return sec + 's';
  var m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return m + 'm ' + s + 's';
  var h = Math.floor(m / 60); m = m % 60;
  if (h < 24) return h + 'h ' + m + 'm';
  var d = Math.floor(h / 24); h = h % 24;
  return d + 'd ' + h + 'h';
}

/* ---- light / dark theme (per-visitor preference) ---- */
function applyTheme(t) {
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  var btn = el('themeToggle'); if (btn) btn.textContent = (t === 'light') ? '☀️' : '🌙';
}
function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  var next = cur === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('ui-theme', next); } catch (e) {}
  applyTheme(next);
}

/* ---- ticker logos (ported from agentic-trading) ---- */
/* logoDisplay is a SITE-WIDE setting the admin controls; the value is injected
   server-side as window.__LOGO_DISPLAY__ so every visitor gets the same style. */
var LOGO_DISPLAYS = ['tile', 'transparent', 'off'];
var SYMBOL_PATTERN = /^[A-Z0-9._-]{1,20}$/;
function normalizeLogoDisplay(v) { return LOGO_DISPLAYS.indexOf(v) >= 0 ? v : 'transparent'; }
var logoDisplay = normalizeLogoDisplay(window.__LOGO_DISPLAY__);
function normalizeLogoSymbol(v) {
  var s = (v == null ? '' : String(v)).trim().replace(/^\\$/, '').toUpperCase();
  return s && SYMBOL_PATTERN.test(s) ? s : null;
}
/* Backup logo: when a real logo image 404s, swap the frame to a monogram of the
   ticker's first letters instead of dropping it (CSS hides the <img>). */
function logoFallback(img, mono) {
  var span = img.parentNode; if (!span) return;
  span.classList.add('mono');
  span.setAttribute('data-mono', mono);
}
/* Build the logo <span><img></span>. Framing follows the site-wide display mode;
   the company name rides along as a hover title; a missing logo falls back to a
   monogram via logoFallback(). */
function tickerLogoHtml(ticker, company) {
  var sym = normalizeLogoSymbol(ticker);
  if (!sym || logoDisplay === 'off') return '';
  var title = company ? ' title="' + esc(company) + '"' : '';
  var mono = esc(sym.slice(0, 2));
  return '<span class="tkr-logo ' + logoDisplay + '"' + title + '>' +
    '<img src="/api/logos/ticker?symbol=' + encodeURIComponent(sym) + '" alt="" ' +
    'loading="lazy" decoding="async" onerror="logoFallback(this,\\'' + mono + '\\')" />' +
  '</span>';
}
/* Two-letter initials from a member name, for the avatar fallback. */
function initials(name) {
  var parts = String(name || '').trim().split(' ').filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0].charAt(0) + parts[parts.length - 1].charAt(0);
}
/* Build the member avatar: an initials chip with the headshot overlaid when a
   photoUrl is present. A broken/missing image removes itself (this.remove()),
   revealing the initials underneath — mirrors the ticker-logo onerror pattern. */
function memberAvatarHtml(name, photoUrl) {
  var img = photoUrl
    ? '<img src="' + esc(photoUrl) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()" />'
    : '';
  return '<span class="avatar">' + esc(initials(name)) + img + '</span>';
}
function setBanner(text, isErr) {
  var b = el('banner');
  if (!text) { b.style.display = 'none'; return; }
  b.style.display = 'block';
  b.className = 'banner' + (isErr ? ' err' : '');
  b.textContent = text;
}
function stateRow(cols, text) {
  return '<tr><td class="state" colspan="' + cols + '">' + esc(text) + '</td></tr>';
}

/* Admin surfaces (Review Queue / Subscriptions / Admin · Cadence) call
   /api/admin/* which returns 401 on the public site. Detect that cleanly and
   show a friendly notice instead of a scary "HTTP 401". */
var ADMIN_MOVED_MSG = 'Admin tools have moved to admin.congress.trade (sign-in required).';
/* Throw a tagged error when a response is an auth failure so callers can
   distinguish it from generic network/HTTP errors. */
function okOrThrow(r) {
  if (r.status === 401 || r.status === 403) { var e = new Error(ADMIN_MOVED_MSG); e.isAuth = true; throw e; }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function isAuthError(e) { return !!(e && e.isAuth); }

/* ============================ FEED ============================ */
function renderFeed() {
  var m = el('qMember').value.toLowerCase(), t = el('qTicker').value.toUpperCase(),
      ty = el('qType').value, ch = el('qChamber').value;
  // Fold-out advanced search (panel may be collapsed; inputs still honored).
  var qa = (el('qAll').value || '').toLowerCase().trim();
  var minAmt = parseFloat(el('qMinAmt').value);
  var src = el('qSource').value;
  var body = el('feedBody');
  if (!realDataLoaded) { body.innerHTML = stateRow(10, 'Loading live feed…'); return; }
  var rows = TRADES.filter(function (r) {
    if (qa) {
      var hay = ((r.member || '') + ' ' + (r.asset || '') + ' ' + (r.ticker || '') + ' ' +
                 (r.source || '') + ' ' + (r.owner || '') + ' ' + (r.st || '')).toLowerCase();
      if (hay.indexOf(qa) < 0) return false;
    }
    if (!isNaN(minAmt) && !((r.min != null ? r.min : 0) >= minAmt)) return false;
    if (src && r.source !== src) return false;
    return (!m || (r.member || '').toLowerCase().indexOf(m) >= 0) &&
           (!t || (r.ticker || '').indexOf(t) >= 0) &&
           (!ty || r.type === ty) &&
           (!ch || r.chamber === ch);
  });
  rows = sortRows(rows);
  if (rows.length === 0) { body.innerHTML = stateRow(10, 'No transactions match these filters.'); updateFeedCountMsg(0); maybeInitResize(); return; }
  body.innerHTML = rows.map(function (r) {
    return '<tr class="row">' +
      '<td class="muted">' + esc(r.filed) + '</td>' +
      '<td><div class="member-cell">' + memberAvatarHtml(r.member, r.photoUrl) +
        '<div>' + esc(r.member) + (r.st ? ' <span class="muted">· ' + esc(r.st) + '</span>' : '') + '</div></div></td>' +
      '<td><div class="asset-cell">' + tickerLogoHtml(r.ticker, r.asset) +
        '<div title="' + esc((r.ticker ? r.ticker + ' · ' : '') + r.asset) + '">' +
        (r.ticker ? '<span class="tkr">' + esc(r.ticker) + '</span> ' : '') +
        '<span class="muted">' + esc(r.asset) + '</span></div></div></td>' +
      '<td><span class="tag ' + esc(r.type) + '">' + esc(typeName[r.type] || r.type) + '</span></td>' +
      '<td>' + (r.min == null && r.max == null ? '<span class="muted">—</span>' : fmt(r.min) + ' – ' + (r.max == null ? '+' : fmt(r.max))) + '</td>' +
      '<td class="muted">' + esc(r.txdate || '—') + '</td>' +
      '<td class="muted">' + esc(ownerLabel(r.owner) || '—') + '</td>' +
      '<td><span class="conf ' + confClass(r.conf) + '">' + (r.conf * 100).toFixed(0) + '%</span></td>' +
      '<td class="muted" title="' + esc(r.source) + '">' + esc(sourceLabel(r.source)) + '</td>' +
      '<td class="latency">' + rowLatencyHtml(r) + '</td>' +
    '</tr>';
  }).join('');
  updateFeedCountMsg(rows.length);
  maybeInitResize();
}

/* "Showing X of N" + Load-more visibility. X = rows currently displayed (after
   client-side filters); N = server total. The button shows only while more
   rows remain to be fetched from the server (loaded < total). */
function updateFeedCountMsg(shown) {
  var msg = el('feedCountMsg');
  var more = el('loadMoreBtn');
  if (!realDataLoaded) { if (msg) msg.textContent = ''; if (more) more.style.display = 'none'; return; }
  var loaded = TRADES.length;
  var total = totalRows || loaded;
  if (msg) msg.textContent = 'Showing ' + shown + ' of ' + total + (loaded < total ? ' (' + loaded + ' loaded)' : '');
  if (more) more.style.display = (loaded < total) ? '' : 'none';
}

/* ---- resizable feed columns (drag the right edge of a header) ---- */
var COL_WIDTH_KEY = 'feed-col-widths';
var colResizeInit = false;
function loadColWidths() { try { return JSON.parse(localStorage.getItem(COL_WIDTH_KEY) || '{}') || {}; } catch (e) { return {}; } }
function saveColWidths(w) { try { localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(w)); } catch (e) {} }
function maybeInitResize() { if (!colResizeInit && realDataLoaded) { colResizeInit = true; initColumnResize(); } }
function initColumnResize() {
  var table = el('feedTable'); if (!table) return;
  var ths = document.querySelectorAll('#feedHead th');
  var saved = loadColWidths();
  // Freeze current auto widths (or restore saved ones) so switching the table to
  // fixed layout doesn't visually jump. Wide auto-sized columns are capped to a
  // compact default (Asset fits the longest name otherwise) — short entries then
  // show in full, long ones clip to an ellipsis, and any column stays draggable.
  var DEFAULT_CAP = { asset: 200 };
  for (var i = 0; i < ths.length; i++) {
    var k = ths[i].dataset.sort;
    var w = (k && saved[k]) ? saved[k] : ths[i].offsetWidth;
    if (!(k && saved[k]) && k && DEFAULT_CAP[k] && w > DEFAULT_CAP[k]) w = DEFAULT_CAP[k];
    ths[i].style.width = w + 'px';
  }
  table.classList.add('resizable');
  for (var j = 0; j < ths.length; j++) addColResizer(ths[j]);
}
function addColResizer(th) {
  var grip = document.createElement('span');
  grip.className = 'col-resizer';
  grip.addEventListener('click', function (e) { e.stopPropagation(); }); // don't sort
  grip.addEventListener('mousedown', function (e) {
    e.preventDefault(); e.stopPropagation();
    var startX = e.pageX, startW = th.offsetWidth;
    function move(ev) { th.style.width = Math.max(56, startW + (ev.pageX - startX)) + 'px'; }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      var w = loadColWidths(); w[th.dataset.sort] = th.offsetWidth; saveColWidths(w);
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.userSelect = 'none';
  });
  th.appendChild(grip);
}

/* ---- sorting ---- */
function sortVal(r, key) {
  if (key === 'asset') return (r.ticker || r.asset || '');
  var v = r[key];
  if (NUMERIC_SORT[key]) return (v == null ? -Infinity : Number(v));
  return (v == null ? '' : String(v)).toLowerCase();
}
function sortRows(rows) {
  var copy = rows.slice();
  copy.sort(function (a, b) {
    var av = sortVal(a, sortKey), bv = sortVal(b, sortKey);
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return 0;
  });
  return copy;
}
function setSort(key) {
  if (sortKey === key) { sortDir = -sortDir; }   // same column -> flip direction
  else { sortKey = key; sortDir = (key === 'filed' || NUMERIC_SORT[key]) ? -1 : 1; }
  updateSortIndicators();
  renderFeed();
}
function updateSortIndicators() {
  var ths = document.querySelectorAll('#feedHead th.sortable');
  for (var i = 0; i < ths.length; i++) {
    var th = ths[i], arr = th.querySelector('.arr');
    if (th.dataset.sort === sortKey) { th.classList.add('active'); arr.textContent = sortDir > 0 ? '▲' : '▼'; }
    else { th.classList.remove('active'); arr.textContent = ''; }
  }
}

/* ---- fold-out search ---- */
function toggleSearch() {
  var open = el('searchPanel').classList.toggle('open');
  el('searchToggle').classList.toggle('on', open);
  if (open) el('qAll').focus();
}
function clearSearch() {
  el('qAll').value = ''; el('qMinAmt').value = ''; el('qSource').value = '';
  renderFeed();
}

/* Friendly, human-readable label for a transaction's provenance. The raw value
   ('seed_dataset' | 'primary') rides along as a tooltip via sourceTitle. */
var sourceLabelMap = { seed_dataset: 'Historical', primary: 'Live' };
function sourceLabel(src) { return sourceLabelMap[src] || (src || ''); }

/* Map an API transaction (shared/types Transaction) to a feed row. Member name
   prefers filers.full_name (memberName from the API); falls back to the raw
   filer id when the name is missing. */
function txToRow(tx) {
  return {
    filed: (tx.createdAt || '').replace('T', ' ').slice(0, 16),
    member: tx.fullName || tx.memberName || tx.filerId || 'Unknown',
    photoUrl: tx.photoUrl || '',
    st: tx.state || '',
    chamber: tx.chamber || '',
    asset: cleanAsset(tx.assetName || ''),
    ticker: tx.ticker || '',
    type: tx.txType || 'P',
    min: tx.amountMin, max: tx.amountMax,
    txdate: tx.txDate || '',
    owner: tx.owner || '',
    conf: typeof tx.confidence === 'number' ? tx.confidence : 1,
    source: tx.source || 'primary',
    filedDate: tx.filedDate || '',
    firstSeenAt: tx.firstSeenAt || '',
    imported: tx.createdAt || '',
    cursorSeq: tx.cursorSeq || 0
  };
}

/* Per-row ingestion latency: "Released→Seen (approx) · Seen→Imported (precise)".
   Only meaningful for live-pipeline (primary) rows. */
function diffSec(aIso, bIso) {
  var a = Date.parse(aIso), b = Date.parse(bIso);
  if (!isFinite(a) || !isFinite(b)) return null;
  return (a - b) / 1000;
}
function rowLatencyHtml(r) {
  if (r.source !== 'primary') return '<span class="muted">—</span>';
  var rts = null, sti = null, d;
  if (r.filedDate && r.firstSeenAt) { d = diffSec(r.firstSeenAt, r.filedDate); if (d != null && d >= 0) rts = d; }
  if (r.firstSeenAt && r.imported) { d = diffSec(r.imported, r.firstSeenAt); if (d != null && d >= 0) sti = d; }
  var a = rts == null ? '—' : '≈' + fmtDuration(rts);
  var b = sti == null ? '—' : fmtDuration(sti);
  return '<span class="muted" title="Released→Seen (approx) · Seen→Imported (precise)">' + esc(a + ' · ' + b) + '</span>';
}

/* Fetch one page of transactions from the cursor and merge it newest-first.
   The API orders by cursor_seq ASC and pages via since=<max cursor>; we reverse
   each page so the UI keeps its newest-first display ordering. Returns the
   number of rows appended (0 when there is nothing new). */
function fetchPage() {
  if (loadingPage) return Promise.resolve(0);
  loadingPage = true;
  // API HOOK: GET /api/transactions?since=<cursor>&limit=<MAX_TX_LIMIT>
  return fetch('/api/transactions?since=' + cursor + '&limit=' + POLL_LIMIT)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      var txs = (data.transactions || []).map(txToRow);
      // newest first; merge ahead of existing
      txs.reverse();
      TRADES = txs.concat(TRADES);
      if (typeof data.cursor === 'number' && data.cursor > cursor) cursor = data.cursor;
      if (typeof data.total === 'number') totalRows = data.total;
      realDataLoaded = true;
      setBanner('');                       // drop the illustrative banner
      el('kpiTotal').textContent = totalRows || TRADES.length;
      var today = new Date().toISOString().slice(0, 10);
      el('kpiToday').textContent = TRADES.filter(function (r) { return (r.filed || '').slice(0, 10) === today; }).length;
      var primary = TRADES.filter(function (r) { return r.source === 'primary'; }).length;
      el('kpiAuto').innerHTML = (TRADES.length ? Math.round(100 * primary / TRADES.length) : 0) + '<small>%</small>';
      renderFeed();
      return txs.length;
    })
    .catch(function (e) {
      if (!realDataLoaded) setBanner('Could not load the live feed: ' + e.message, true);
      return 0;
    })
    .then(function (n) { loadingPage = false; return n; });
}

/* Initial / full reload: fetches the first page from the current cursor. */
function loadFeed() { return fetchPage(); }

/* "Load more": pull the next page using the returned cursor and append it. */
function loadMore() {
  var more = el('loadMoreBtn');
  if (more) more.disabled = true;
  return fetchPage().then(function () { if (more) more.disabled = false; });
}

function refreshFeed() { loadFeed(); }

/* Live updates. We try SSE first, but the public dashboard does NOT hard-depend
   on it: the /api/stream?subscription=dashboard endpoint isn't available on the
   public site (webhooks/SSE are a future paid feature). If the EventSource
   errors or closes we tear it down (no infinite "reconnecting…") and fall back
   to a calm 30s poll of /api/transactions using the cursor. */
function setLivePill(cls, text) { var p = el('livePill'); p.className = 'pill ' + cls; p.textContent = text; }

/* Periodic polling fallback. API HOOK: GET /api/transactions?since=<cursor>. */
function startPolling() {
  if (pollTimer) return;          // already polling
  setLivePill('live', 'live');    // calm state — not "reconnecting…"
  pollTimer = setInterval(function () {
    fetchPage().then(function (n) {
      if (n > 0) {
        setLivePill('live', 'updated');
        setTimeout(function () { if (pollTimer) setLivePill('live', 'live'); }, 1800);
      }
    });
  }, POLL_INTERVAL_MS);
}

function stopStream() {
  if (es) { try { es.close(); } catch (e) {} es = null; }
}

function startStream() {
  // EventSource is optional; if unavailable, poll immediately.
  if (typeof EventSource === 'undefined') { startPolling(); return; }
  try {
    es = new EventSource('/api/stream?subscription=dashboard');
    es.onopen = function () { setLivePill('live', 'live feed'); };
    es.onmessage = function (e) {
      try {
        var tx = JSON.parse(e.data);
        if (!tx || !tx.id) return;
        TRADES.unshift(txToRow(tx));
        if (tx.cursorSeq && tx.cursorSeq > cursor) cursor = tx.cursorSeq;
        if (totalRows) totalRows += 1;
        el('kpiTotal').textContent = totalRows || TRADES.length;
        renderFeed();
        setLivePill('live', 'new filing ↑');
        setTimeout(function () { if (es && es.readyState === 1) setLivePill('live', 'live feed'); }, 1800);
      } catch (err) { /* ignore malformed frame */ }
    };
    es.onerror = function () {
      // SSE is unavailable (e.g. 404 on the public site). Stop reconnecting and
      // fall back to gentle polling rather than sticking on "reconnecting…".
      stopStream();
      startPolling();
    };
  } catch (err) {
    startPolling();
  }
}

/* ============================ REVIEW ============================ */
function loadReview() {
  // API HOOK: GET /api/admin/review-queue
  return fetch('/api/admin/review-queue', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) { REVIEW = data.items || []; renderReview(); })
    .catch(function (e) {
      el('reviewBody').innerHTML = stateRow(5, isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load review queue: ' + e.message));
    });
}
/* Translate review reason codes + payload into plain English for non-engineers. */
var REASON_LABELS = {
  low_confidence: 'Low confidence in the automated read',
  no_transactions_extracted: 'No transactions could be read from the document',
  unresolved_ticker: 'Ticker symbol could not be matched to a known company',
  invalid_bracket: 'Dollar amount didn’t match a standard disclosure range',
  no_amount: 'No dollar amount could be read',
  invalid_amount: 'Dollar amount looked malformed (couldn’t be read as a range)',
  future_tx_date: 'Trade date is after the filing date',
  bad_tx_type: 'Transaction type was unclear (not buy / sell / exchange)'
};
function reasonText(reason) {
  if (!reason) return 'Needs a human check';
  return String(reason).split(',').map(function (c) {
    c = c.trim(); return REASON_LABELS[c] || c.replace(/_/g, ' ');
  }).filter(Boolean).join('; ');
}
function payloadText(payload) {
  var p = payload;
  if (p == null) return '';
  try { if (typeof p === 'string') p = JSON.parse(p); } catch (e) { return String(payload); }
  if (typeof p !== 'object') return String(payload);
  var bits = [];
  if (typeof p.minConfidence === 'number') bits.push('Confidence ' + Math.round(p.minConfidence * 100) + '%');
  var txs = p.transactions || [];
  if (txs.length) {
    bits.push(txs.length + ' transaction' + (txs.length === 1 ? '' : 's'));
    var t0 = txs[0] || {};
    var label = cleanAsset(t0.ticker || t0.assetName || '');
    if (label) bits.push('e.g. ' + label + (typeName[t0.txType] ? ' (' + typeName[t0.txType] + ')' : ''));
  }
  return bits.join(' · ');
}
function renderReview() {
  var body = el('reviewBody');
  el('reviewCount').textContent = REVIEW.length ? '(' + REVIEW.length + ')' : '';
  el('kpiReview').textContent = REVIEW.length;
  if (REVIEW.length === 0) { body.innerHTML = stateRow(5, 'Nothing awaiting review — queue is clear.'); return; }
  body.innerHTML = REVIEW.map(function (r) {
    var payload = payloadText(r.payload);
    return '<tr class="row" id="rv-' + esc(r.docId) + '">' +
      '<td class="muted">' + esc((r.createdAt || '').replace('T', ' ').slice(0, 16)) + '</td>' +
      '<td class="tkr">' + esc(r.docId) + '</td>' +
      '<td class="muted">' + esc(reasonText(r.reason)) + '</td>' +
      '<td class="muted" style="max-width:360px">' + esc(payload) + '</td>' +
      '<td>' +
        '<button class="btn sm" onclick="resolveReview(\\'' + esc(r.docId) + '\\',\\'confirm\\')">Confirm</button> ' +
        '<button class="btn ghost sm" onclick="resolveReview(\\'' + esc(r.docId) + '\\',\\'reject\\')">Reject</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}
function resolveReview(docId, decision) {
  // API HOOK: POST /api/admin/review/:docId {decision}
  var rowEl = el('rv-' + docId);
  if (rowEl) rowEl.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
  fetch('/api/admin/review/' + encodeURIComponent(docId), {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ decision: decision, edits: [] })
  })
    .then(okOrThrow)
    .then(function () { REVIEW = REVIEW.filter(function (x) { return x.docId !== docId; }); renderReview(); loadFeed(); })
    .catch(function (e) {
      if (rowEl) rowEl.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      alert(isAuthError(e) ? ADMIN_MOVED_MSG : ('Review action failed: ' + e.message));
    });
}

/* ============================ SUBSCRIPTIONS ============================ */
function loadSubs() {
  // API HOOK: GET /api/subscriptions
  return fetch('/api/subscriptions')
    .then(okOrThrow)
    .then(function (data) { renderSubs(data.subscriptions || []); })
    .catch(function (e) {
      el('subsBody').innerHTML = stateRow(5, isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load subscriptions: ' + e.message));
    });
}
function renderSubs(subs) {
  var body = el('subsBody');
  if (subs.length === 0) { body.innerHTML = stateRow(5, 'No subscriptions yet. Create one below.'); return; }
  body.innerHTML = subs.map(function (s) {
    var f = s.filters || {};
    var parts = [];
    if (f.chambers && f.chambers.length) parts.push(f.chambers.join('+')); else parts.push('all chambers');
    if (f.minAmount) parts.push('≥ ' + fmt(f.minAmount));
    if (f.tickers && f.tickers.length) parts.push(f.tickers.join(','));
    return '<tr class="row">' +
      '<td>' + esc(s.clientId) + '</td>' +
      '<td>' + esc(s.delivery) + '</td>' +
      '<td class="muted">' + esc(s.targetUrl || (s.delivery === 'sse' ? '/api/stream' : '—')) + '</td>' +
      '<td class="muted">' + esc(parts.join(' · ')) + '</td>' +
      '<td><span class="conf ' + (s.active ? 'hi' : 'mid') + '">' + (s.active ? 'active' : 'paused') + '</span></td>' +
    '</tr>';
  }).join('');
}
function createSubscription() {
  // API HOOK: POST /api/subscriptions
  var clientId = el('newClientId').value.trim();
  var delivery = el('newDelivery').value;
  var targetUrl = el('newTarget').value.trim();
  if (!clientId) { el('subsMsg').textContent = 'clientId is required.'; return; }
  if (delivery === 'webhook' && !targetUrl) { el('subsMsg').textContent = 'webhook needs a target URL.'; return; }
  el('subsMsg').textContent = 'Creating…';
  fetch('/api/subscriptions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: clientId, delivery: delivery, targetUrl: targetUrl || null, filters: {} })
  })
    .then(function (r) {
      if (r.status === 401 || r.status === 403) { var ae = new Error(ADMIN_MOVED_MSG); ae.isAuth = true; throw ae; }
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
      return r.json();
    })
    .then(function () {
      el('subsMsg').textContent = 'Created.';
      el('newClientId').value = ''; el('newTarget').value = '';
      loadSubs(); setTimeout(function () { el('subsMsg').textContent = ''; }, 2500);
    })
    .catch(function (e) { el('subsMsg').textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Failed: ' + e.message); });
}

/* ============================ ADMIN AUTH ============================ */
var ADMIN_TOKEN_KEY = 'congresstrade.adminToken';
function getAdminToken() {
  try { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch (e) { return ''; }
}
// Build request headers for /api/admin/* calls, attaching the bearer token if set.
function adminHeaders(extra) {
  var h = extra || {};
  var t = getAdminToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}
// Turn a 401 into an actionable message instead of a bare "HTTP 401".
function adminOk(r) {
  if (r.status === 401) throw new Error('Unauthorized — paste your admin token in the Admin access box above.');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}
// Like adminOk but only intercepts 401 — lets the caller parse a JSON {error} body for other statuses.
function admin401(r) {
  if (r.status === 401) throw new Error('Unauthorized — paste your admin token in the Admin access box above.');
  return r;
}
function saveAdminToken() {
  var v = el('adminToken').value.trim();
  try { if (v) localStorage.setItem(ADMIN_TOKEN_KEY, v); else localStorage.removeItem(ADMIN_TOKEN_KEY); } catch (e) {}
  el('adminTokenMsg').textContent = v ? 'Saved in this browser.' : 'Cleared.';
  setTimeout(function () { el('adminTokenMsg').textContent = ''; }, 2500);
  loadPollConfig(); loadHealth();
}
function clearAdminToken() {
  try { localStorage.removeItem(ADMIN_TOKEN_KEY); } catch (e) {}
  if (el('adminToken')) el('adminToken').value = '';
  el('adminTokenMsg').textContent = 'Cleared.';
  setTimeout(function () { el('adminTokenMsg').textContent = ''; }, 2500);
}
// Populate the field from storage when the Admin tab opens.
function initAdminToken() {
  var t = getAdminToken();
  if (t && el('adminToken')) el('adminToken').value = t;
}

/* ============================ ADMIN · LOGOS (site-wide) ============================ */
function loadLogoSetting() {
  // API HOOK: GET /api/admin/ui-settings
  return fetch('/api/admin/ui-settings', { headers: adminHeaders() })
    .then(adminOk).then(function (r) { return r.json(); })
    .then(function (j) {
      logoDisplay = normalizeLogoDisplay(j.logoDisplay);
      if (el('adminLogo')) el('adminLogo').value = logoDisplay;
      renderFeed();
    })
    .catch(function (e) { if (el('logoMsg')) el('logoMsg').textContent = 'Could not load: ' + e.message; });
}
function saveLogoDisplay() {
  // API HOOK: PUT /api/admin/ui-settings
  var v = el('adminLogo').value;
  el('logoMsg').textContent = 'Saving…';
  fetch('/api/admin/ui-settings', {
    method: 'PUT', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ logoDisplay: v })
  })
    .then(admin401).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
    .then(function (j) {
      logoDisplay = normalizeLogoDisplay(j.logoDisplay);
      renderFeed();
      el('logoMsg').textContent = 'Saved — applies to all visitors.';
      setTimeout(function () { el('logoMsg').textContent = ''; }, 3000);
    })
    .catch(function (e) { el('logoMsg').textContent = 'Failed: ' + e.message; });
}

/* ============================ ADMIN · CADENCE ============================ */
function loadPollConfig() {
  // API HOOK: GET /api/admin/poll-config
  return fetch('/api/admin/poll-config', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (cfg) {
      SCHEDULE = Array.isArray(cfg.schedule) ? cfg.schedule : [];
      aggressive = !!cfg.aggressiveMode;
      el('aggToggle').checked = aggressive;
      renderSchedule();
    })
    .catch(function (e) {
      el('schedRows').innerHTML = '<div class="note">' + esc(isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load poll config: ' + e.message)) + '</div>';
    });
}
function renderSchedule() {
  el('schedRows').innerHTML = SCHEDULE.map(function (w, i) {
    return '<div class="sched-row">' +
      '<input value="' + esc((w.daysOfWeek || []).join(',')) + '" onchange="SCHEDULE[' + i + '].daysOfWeek=this.value.split(\\',\\').map(Number).filter(function(n){return !isNaN(n)})" />' +
      '<input type="number" value="' + esc(w.startHourET) + '" onchange="SCHEDULE[' + i + '].startHourET=+this.value" />' +
      '<input type="number" value="' + esc(w.endHourET) + '" onchange="SCHEDULE[' + i + '].endHourET=+this.value" />' +
      '<input type="number" value="' + esc(w.intervalSec) + '" onchange="SCHEDULE[' + i + '].intervalSec=+this.value" />' +
    '</div>';
  }).join('');
  el('kpiMode').innerHTML = aggressive ? 'Aggressive<small> · fast</small>' : 'Standard';
}
function toggleAggressive() { aggressive = el('aggToggle').checked; renderSchedule(); }
function saveSchedule() {
  // API HOOK: PUT /api/admin/poll-config
  el('saveMsg').textContent = 'Saving…';
  fetch('/api/admin/poll-config', {
    method: 'PUT', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ schedule: SCHEDULE, aggressiveMode: aggressive })
  })
    .then(okOrThrow)
    .then(function () { el('saveMsg').textContent = 'Saved — effective within ~60s.'; setTimeout(function () { el('saveMsg').textContent = ''; }, 2500); })
    .catch(function (e) { el('saveMsg').textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Failed: ' + e.message); });
}

/* ============================ HISTORIC BACKFILL ============================ */
function runBackfill(dryRun) {
  // API HOOK: POST /api/admin/backfill
  var payload = { dryRun: !!dryRun };
  var since = parseInt(el('bfSince').value, 10);
  if (!isNaN(since)) payload.sinceYear = since;
  var limit = parseInt(el('bfLimit').value, 10);
  if (!isNaN(limit) && limit > 0) payload.limit = limit;
  var ch = el('bfChambers').value;
  if (ch) payload.chambers = [ch];
  el('bfMsg').textContent = dryRun ? 'Counting…' : 'Running backfill…';
  fetch('/api/admin/backfill', {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload)
  })
    .then(function (r) {
      if (r.status === 401 || r.status === 403) { var ae = new Error(ADMIN_MOVED_MSG); ae.isAuth = true; throw ae; }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    })
    .then(function (j) {
      var verb = dryRun ? 'Would import' : 'Imported';
      var msg = verb + ' ' + j.inserted + ', skipped ' + j.skipped + '.';
      if (j.errors && j.errors.length) msg += ' Errors: ' + j.errors.join('; ');
      el('bfMsg').textContent = msg;
      if (!dryRun && j.inserted > 0) { cursor = 0; TRADES = []; totalRows = 0; realDataLoaded = false; loadFeed(); }
    })
    .catch(function (e) { el('bfMsg').textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Failed: ' + e.message); });
}

function runHouseIndex(dryRun) {
  // API HOOK: POST /api/admin/house-backfill
  var from = parseInt(el('hiFrom').value, 10);
  var to = parseInt(el('hiTo').value, 10);
  if (isNaN(from) || isNaN(to)) { el('hiMsg').textContent = 'Enter a from/to year.'; return; }
  el('hiMsg').textContent = dryRun ? 'Counting…' : 'Enqueuing (this can take a while)…';
  fetch('/api/admin/house-backfill', {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ fromYear: from, toYear: to, dryRun: !!dryRun })
  })
    .then(function (r) {
      if (r.status === 401 || r.status === 403) { var ae = new Error(ADMIN_MOVED_MSG); ae.isAuth = true; throw ae; }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    })
    .then(function (j) {
      var years = Object.keys(j.byYear || {}).length;
      el('hiMsg').textContent = dryRun
        ? ('Found ' + (j.discovered || 0) + ' PTRs across ' + years + ' year(s).')
        : ('Enqueued ' + (j.enqueued || 0) + ' new filing(s) from ' + (j.discovered || 0) + ' PTRs.' + (j.errors && j.errors.length ? ' Errors: ' + j.errors.join('; ') : ''));
    })
    .catch(function (e) { el('hiMsg').textContent = isAuthError(e) ? ADMIN_MOVED_MSG : ('Failed: ' + e.message); });
}

/* ============================ SOURCE HEALTH ============================ */
function loadHealth() {
  // API HOOK: GET /api/admin/sources/health
  return fetch('/api/admin/sources/health', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      var sources = data.sources || [];
      var body = el('healthBody');
      if (sources.length === 0) { body.innerHTML = stateRow(7, 'No poll activity logged yet.'); return; }
      body.innerHTML = sources.map(function (s) {
        var avg = s.avgIntervalSec == null ? '—' : '~' + fmtDuration(s.avgIntervalSec);
        var rts = s.avgReleasedToSeenSec == null ? '—' : '~' + fmtDuration(s.avgReleasedToSeenSec);
        var sti = s.avgSeenToImportedSec == null ? '—' : fmtDuration(s.avgSeenToImportedSec);
        return '<tr class="row">' +
          '<td>' + esc(s.source) + '</td>' +
          '<td class="muted">' + esc((s.lastPolledAt || '').replace('T', ' ').slice(0, 19) || '—') + '</td>' +
          '<td class="muted">' + esc((s.lastNewFilingAt || '').replace('T', ' ').slice(0, 19) || '—') + '</td>' +
          '<td class="muted">' + esc(s.pollCount != null ? s.pollCount : '—') + '</td>' +
          '<td class="latency">' + esc(avg) + '</td>' +
          '<td class="latency">' + esc(rts) + '</td>' +
          '<td class="latency">' + esc(sti) + '</td>' +
        '</tr>';
      }).join('');
    })
    .catch(function (e) {
      el('healthBody').innerHTML = stateRow(7, isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load source health: ' + e.message));
    });
}

/* ============================ TRENDS / ANALYTICS ============================ */
/* All views read /api/analytics/* — read-only aggregates over the corpus. Dollar
   values are ESTIMATES from STOCK Act bracket midpoints (labelled with ~). */
function trParams() {
  var p = 'window=' + encodeURIComponent(el('trWindow').value);
  var ch = el('trChamber').value; if (ch) p += '&chamber=' + ch;
  var pa = el('trParty').value; if (pa) p += '&party=' + pa;
  var src = el('trSource').value; if (src && src !== 'all') p += '&source=' + src;
  return p;
}
function aGet(path) {
  return fetch('/api/analytics/' + path).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
  });
}
/* Compact USD: 1234567 -> $1.2M. */
function usdC(n) {
  n = Number(n || 0); var s = n < 0 ? '-' : ''; n = Math.abs(n); var o;
  if (n >= 1e9) o = (n / 1e9).toFixed(1) + 'B';
  else if (n >= 1e6) o = (n / 1e6).toFixed(1) + 'M';
  else if (n >= 1e3) o = (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  else o = String(Math.round(n));
  return s + '$' + o;
}
function estUsd(n) { return '~' + usdC(n); }
function netHtml(n) {
  n = Number(n || 0);
  var cls = n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  return '<span class="net ' + cls + '">' + (n > 0 ? '+' : '') + usdC(n) + '</span>';
}
function splitBar(buys, sells) {
  buys = Number(buys || 0); sells = Number(sells || 0);
  var tot = buys + sells, bp = tot ? Math.round(100 * buys / tot) : 0, sp = tot ? 100 - bp : 0;
  return '<span class="split-wrap"><span class="split">' +
    '<span class="seg buy" style="width:' + bp + '%"></span>' +
    '<span class="seg sell" style="width:' + sp + '%"></span></span>' +
    '<small>' + buys + 'B / ' + sells + 'S</small></span>';
}
function pdot(b) { return '<span class="pdot ' + esc(b || 'O') + '"></span>'; }
function kpi(k, v) { return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>'; }
/* Mini CSS-column time chart of buys vs sells (no chart library). */
function timeChartHtml(series, labelStep) {
  var max = 1; series.forEach(function (p) { max = Math.max(max, p.buys, p.sells); });
  var step = labelStep || Math.max(1, Math.ceil(series.length / 14));
  return '<div class="tchart">' + series.map(function (p, i) {
    var bh = p.buys > 0 ? Math.max(3, Math.round(100 * p.buys / max)) : 0;
    var sh = p.sells > 0 ? Math.max(3, Math.round(100 * p.sells / max)) : 0;
    var lbl = (i % step === 0) ? esc(p.period || '') : '';
    var title = esc((p.period || '') + ': ' + p.buys + ' buys / ' + p.sells + ' sells');
    return '<div class="tcol" title="' + title + '"><div class="tbars">' +
      '<i class="buy" style="height:' + bh + '%"></i><i class="sell" style="height:' + sh + '%"></i>' +
      '</div><span class="tlbl">' + lbl + '</span></div>';
  }).join('') + '</div>';
}

function loadTrends() {
  loadTrSummary(); loadTrTickers(); loadTrTrending(); loadTrClusters();
  loadTrTime(); loadTrMembers(); loadTrParties(); loadTrSectors(); loadTrLag();
}

function loadTrSummary() {
  var box = el('trKpis');
  box.innerHTML = kpi('Loading…', '—');
  aGet('summary?' + trParams()).then(function (d) {
    var sent = d.netSentiment == null ? '—' : Math.round(d.netSentiment * 100) + '<small>% buys</small>';
    box.innerHTML =
      kpi('Trades', d.totalTrades) + kpi('Members', d.uniqueMembers) + kpi('Tickers', d.uniqueTickers) +
      kpi('Est. volume', estUsd(d.estimatedVolumeUsd)) + kpi('Net flow', netHtml(d.estimatedNetFlowUsd)) +
      kpi('Buy pressure', sent);
  }).catch(function (e) { box.innerHTML = kpi('Summary', '<span style="font-size:13px">' + esc(e.message) + '</span>'); });
}

function loadTrTickers() {
  var body = el('trTickers');
  body.innerHTML = stateRow(6, 'Loading…');
  aGet('ticker-leaderboard?' + trParams() + '&sort=' + el('trTickerSort').value + '&limit=15').then(function (d) {
    var rows = d.tickers || [];
    if (!rows.length) { body.innerHTML = stateRow(6, 'No trades in this window.'); return; }
    body.innerHTML = rows.map(function (r, i) {
      return '<tr class="row clickable" data-ticker="' + esc(r.ticker) + '">' +
        '<td class="rank">' + (i + 1) + '</td>' +
        '<td><div class="asset-cell">' + tickerLogoHtml(r.ticker, r.name) + '<div><span class="tkr">' +
          esc(r.ticker) + '</span>' + (r.name ? ' <span class="muted">' + esc(r.name) + '</span>' : '') + '</div></div></td>' +
        '<td>' + splitBar(r.buyCount, r.sellCount) + '</td>' +
        '<td class="muted">' + r.memberCount + ' mbr</td>' +
        '<td class="est">' + estUsd(r.estVolumeUsd) + '</td>' +
        '<td>' + netHtml(r.estNetFlowUsd) + '</td></tr>';
    }).join('');
  }).catch(function (e) { body.innerHTML = stateRow(6, 'Could not load: ' + e.message); });
}

function loadTrTrending() {
  var body = el('trTrending');
  body.innerHTML = stateRow(4, 'Loading…');
  aGet('trending?' + trParams() + '&limit=12').then(function (d) {
    var rows = (d.trending || []).filter(function (r) { return r.deltaCount > 0; });
    if (!rows.length) { body.innerHTML = stateRow(4, 'Not enough history to rank momentum.'); return; }
    body.innerHTML = rows.map(function (r) {
      return '<tr class="row clickable" data-ticker="' + esc(r.ticker) + '">' +
        '<td><div class="asset-cell">' + tickerLogoHtml(r.ticker, r.name) + '<div><span class="tkr">' + esc(r.ticker) + '</span></div></div></td>' +
        '<td class="muted">' + r.priorCount + ' → ' + r.recentCount + '</td>' +
        '<td class="net pos">▲ ' + r.deltaCount + '</td>' +
        '<td class="muted">' + r.recentMembers + ' mbr</td></tr>';
    }).join('');
  }).catch(function (e) { body.innerHTML = stateRow(4, 'Could not load: ' + e.message); });
}

function loadTrClusters() {
  var box = el('trClusters');
  box.innerHTML = '<div class="chip">Loading…</div>';
  aGet('cluster-buys?' + trParams() + '&limit=12&minMembers=2').then(function (d) {
    var cs = d.clusters || [];
    el('trClusterHint').textContent = '· ' + cs.length + ' found';
    if (!cs.length) { box.innerHTML = '<div class="chip">No multi-member consensus in this window — try a longer window or “All data”.</div>'; return; }
    box.innerHTML = cs.map(function (c) {
      var faces = (c.topMembers || []).slice(0, 5).map(function (m) { return memberAvatarHtml(m.fullName, m.photoUrl); }).join('');
      var dir = c.txType === 'P' ? 'BOUGHT' : 'SOLD';
      var parties = 'D ' + c.parties.D + ' · R ' + c.parties.R + (c.parties.O ? ' · O ' + c.parties.O : '');
      var bip = (c.parties.D > 0 && c.parties.R > 0) ? ' <span class="chip" title="Both parties traded">· bipartisan</span>' : '';
      var range = (c.firstSeen || '').slice(0, 10) + (c.lastSeen && c.lastSeen !== c.firstSeen ? ' → ' + (c.lastSeen || '').slice(0, 10) : '');
      return '<div class="ccard clickable" data-ticker="' + esc(c.ticker) + '">' +
        '<div class="chead">' + tickerLogoHtml(c.ticker, c.name) + '<span class="big">' + esc(c.ticker) +
          '</span><span class="dirpill ' + esc(c.txType) + '">' + dir + '</span></div>' +
        '<div><strong>' + c.memberCount + '</strong> members · ' + c.tradeCount + ' trades' + bip + '</div>' +
        '<div class="chip">' + esc(parties) + '</div>' +
        '<div class="chip">' + esc(range) + ' · ' + estUsd(c.estVolumeUsd) + '</div>' +
        '<div class="faces">' + faces + '</div></div>';
    }).join('');
  }).catch(function (e) { box.innerHTML = '<div class="chip">Could not load: ' + esc(e.message) + '</div>'; });
}

function loadTrTime() {
  var box = el('trTime');
  box.innerHTML = '<div class="note">Loading…</div>';
  aGet('volume-over-time?' + trParams()).then(function (d) {
    var s = d.series || [];
    if (!s.length) { box.innerHTML = '<div class="note">No dated trades in this window.</div>'; return; }
    box.innerHTML = timeChartHtml(s);
  }).catch(function (e) { box.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>'; });
}

function loadTrMembers() {
  var body = el('trMembers');
  body.innerHTML = stateRow(5, 'Loading…');
  aGet('member-leaderboard?' + trParams() + '&limit=15').then(function (d) {
    var rows = d.members || [];
    if (!rows.length) { body.innerHTML = stateRow(5, 'No member activity in this window.'); return; }
    body.innerHTML = rows.map(function (r, i) {
      var name = r.fullName || r.filerId || 'Unknown';
      var metaBits = [r.chamber, r.state].filter(Boolean).join(' · ');
      return '<tr class="row"><td class="rank">' + (i + 1) + '</td>' +
        '<td><div class="member-cell">' + memberAvatarHtml(name, r.photoUrl) + '<div>' + pdot(r.partyBucket) +
          esc(name) + (metaBits ? ' <span class="muted">· ' + esc(metaBits) + '</span>' : '') + '</div></div></td>' +
        '<td class="muted">' + r.tradeCount + '</td>' +
        '<td>' + splitBar(r.buyCount, r.sellCount) + '</td>' +
        '<td class="est">' + estUsd(r.estVolumeUsd) + '</td></tr>';
    }).join('');
  }).catch(function (e) { body.innerHTML = stateRow(5, 'Could not load: ' + e.message); });
}

function loadTrParties() {
  var box = el('trParties');
  box.innerHTML = '<div class="note">Loading…</div>';
  aGet('party-split?' + trParams()).then(function (d) {
    var o = d.overall || {}, names = { D: 'Democrat', R: 'Republican', O: 'Other / Ind.' }, keys = ['D', 'R', 'O'];
    var maxVol = 1, any = false;
    keys.forEach(function (k) { if (o[k]) { maxVol = Math.max(maxVol, o[k].estVolumeUsd); if (o[k].buys + o[k].sells > 0) any = true; } });
    if (!any) { box.innerHTML = '<div class="note">No party-attributed trades in this window.</div>'; return; }
    box.innerHTML = keys.map(function (k) {
      var v = o[k] || { buys: 0, sells: 0, estVolumeUsd: 0, estNetFlowUsd: 0, members: 0 };
      var w = Math.round(100 * v.estVolumeUsd / maxVol);
      return '<div class="hbar"><div class="hlabel">' + pdot(k) + esc(names[k]) + '</div>' +
        '<div class="htrack"><div class="hfill" style="width:' + w + '%"></div></div>' +
        '<div class="hval">' + estUsd(v.estVolumeUsd) + '</div></div>' +
        '<div class="chip" style="margin:-3px 0 9px 130px">' + v.buys + 'B / ' + v.sells + 'S · ' + v.members + ' mbr · net ' + netHtml(v.estNetFlowUsd) + '</div>';
    }).join('');
  }).catch(function (e) { box.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>'; });
}

function loadTrSectors() {
  var box = el('trSectors');
  box.innerHTML = '<div class="note">Loading…</div>';
  aGet('sector-breakdown?' + trParams() + '&limit=8').then(function (d) {
    var rows = d.sectors || [];
    if (!rows.length) { box.innerHTML = '<div class="note">No data in this window.</div>'; return; }
    var max = 1; rows.forEach(function (r) { max = Math.max(max, r.estVolumeUsd); });
    box.innerHTML = rows.map(function (r) {
      var w = Math.round(100 * r.estVolumeUsd / max);
      return '<div class="hbar"><div class="hlabel" title="' + esc(r.assetType) + '">' + esc(r.assetType) + '</div>' +
        '<div class="htrack"><div class="hfill" style="width:' + w + '%"></div></div>' +
        '<div class="hval">' + estUsd(r.estVolumeUsd) + '</div></div>';
    }).join('');
  }).catch(function (e) { box.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>'; });
}

function loadTrLag() {
  var kbox = el('trLagKpis'), dbox = el('trLagDist'), lbox = el('trLateFilers');
  kbox.innerHTML = ''; dbox.innerHTML = '<div class="note">Loading…</div>'; lbox.innerHTML = stateRow(4, 'Loading…');
  aGet('filing-lag?' + trParams()).then(function (d) {
    var s = d.summary || {};
    kbox.innerHTML =
      kpi('Median lag', (s.medianLagDays == null ? '—' : s.medianLagDays + '<small> days</small>')) +
      kpi('90th pct', (s.p90LagDays == null ? '—' : s.p90LagDays + '<small> days</small>')) +
      kpi('Filed >45d', (s.overFortyFivePct == null ? '—' : Math.round(s.overFortyFivePct * 100) + '<small>%</small>')) +
      kpi('Disclosures', s.count || 0);
    var dist = s.distribution || [], max = 1; dist.forEach(function (b) { max = Math.max(max, b.count); });
    if (!dist.length || !s.count) { dbox.innerHTML = '<div class="note">No dated filings in this window.</div>'; }
    else dbox.innerHTML = dist.map(function (b) {
      var w = Math.round(100 * b.count / max);
      var cls = (b.bucket === '46–60d' || b.bucket === '60d+') ? ' warn' : ' buy';
      return '<div class="hbar"><div class="hlabel">' + esc(b.bucket) + '</div>' +
        '<div class="htrack"><div class="hfill' + cls + '" style="width:' + w + '%"></div></div>' +
        '<div class="hval">' + b.count + '</div></div>';
    }).join('');
    var lf = d.topLateFilers || [];
    if (!lf.length) { lbox.innerHTML = stateRow(4, 'Not enough dated filings.'); }
    else lbox.innerHTML = lf.slice(0, 10).map(function (m) {
      var name = m.fullName || m.filerId || 'Unknown';
      return '<tr class="row"><td><div class="member-cell">' + memberAvatarHtml(name, m.photoUrl) + '<div>' +
        pdot(m.partyBucket) + esc(name) + '</div></div></td>' +
        '<td class="muted">' + Math.round(m.avgLagDays) + 'd avg</td>' +
        '<td class="muted">' + m.maxLagDays + 'd max</td>' +
        '<td class="muted">' + m.lateCount + ' late</td></tr>';
    }).join('');
  }).catch(function (e) {
    dbox.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>';
    lbox.innerHTML = stateRow(4, 'Could not load.');
  });
}

/* ---- ticker deep-dive modal ---- */
function openTicker(ticker) {
  if (!ticker) return;
  var modal = el('tickerModal'), body = el('tickerModalBody');
  body.innerHTML = '<div class="note">Loading ' + esc(ticker) + '…</div>';
  modal.classList.add('open');
  aGet('ticker/' + encodeURIComponent(ticker) + '?' + trParams()).then(function (d) {
    var s = d.summary || {};
    var sent = s.netSentiment == null ? '—' : Math.round(s.netSentiment * 100) + '% buys';
    var ser = d.series || [];
    var chart = ser.length ? timeChartHtml(ser) : '<div class="note">No dated trades.</div>';
    function traderList(arr, label) {
      if (!arr || !arr.length) return '<div class="note">No ' + label + '.</div>';
      return arr.map(function (m) {
        var name = m.fullName || m.filerId || 'Unknown';
        return '<div class="hbar" style="margin:5px 0"><div class="hlabel" style="width:auto;flex:1">' +
          memberAvatarHtml(name, m.photoUrl) + ' ' + pdot(m.partyBucket) + esc(name) + '</div>' +
          '<div class="hval">' + estUsd(m.estVolumeUsd) + '</div></div>';
      }).join('');
    }
    var recent = (d.recentTrades || []).map(function (t) {
      var name = t.fullName || 'Unknown';
      return '<tr class="row"><td class="muted">' + esc((t.txDate || '').slice(0, 10)) + '</td>' +
        '<td><span class="tag ' + esc(t.txType) + '">' + esc(typeName[t.txType] || t.txType) + '</span></td>' +
        '<td>' + pdot(t.partyBucket) + esc(name) + '</td>' +
        '<td class="muted">' + esc(ownerLabel(t.owner)) + (t.isOption ? ' · option' : '') + '</td>' +
        '<td class="est">' + estUsd(t.estValueUsd) + '</td></tr>';
    }).join('');
    body.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' + tickerLogoHtml(d.ticker, '') +
        '<h3 style="margin:0;font-size:20px">' + esc(d.ticker) + '</h3></div>' +
      '<div class="grid-cards">' + kpi('Trades', s.totalTrades || 0) + kpi('Members', s.memberCount || 0) +
        kpi('Est. volume', estUsd(s.estVolumeUsd)) + kpi('Net flow', netHtml(s.estNetFlowUsd)) + kpi('Buy pressure', sent) + '</div>' +
      '<div class="legend" style="margin-top:6px"><span><span class="sw buy"></span>Buys</span><span><span class="sw sell"></span>Sells</span></div>' + chart +
      '<div class="trend-grid2" style="margin-top:14px"><div><h3 style="font-size:13px">Top buyers</h3>' + traderList(d.topBuyers, 'buyers') + '</div>' +
        '<div><h3 style="font-size:13px">Top sellers</h3>' + traderList(d.topSellers, 'sellers') + '</div></div>' +
      '<h3 style="font-size:13px;margin-top:14px">Recent trades</h3><div class="table-wrap"><table><tbody>' +
        (recent || '<tr><td class="state" colspan="5">No recent trades.</td></tr>') + '</tbody></table></div>';
  }).catch(function (e) { body.innerHTML = '<div class="note">Could not load ' + esc(ticker) + ': ' + esc(e.message) + '</div>'; });
}
function closeTicker() { el('tickerModal').classList.remove('open'); }

/* ============================ TABS + BOOT ============================ */
document.querySelectorAll('nav.tabs button').forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll('nav.tabs button').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    b.classList.add('active');
    el('view-' + b.dataset.view).classList.add('active');
    if (b.dataset.view === 'trends') loadTrends();
    if (b.dataset.view === 'review') loadReview();
    if (b.dataset.view === 'subs') loadSubs();
    if (b.dataset.view === 'admin') { initAdminToken(); loadLogoSetting(); loadPollConfig(); loadHealth(); }
  };
});

/* Trends controls: re-run on change; ticker rows/cards open the deep-dive modal. */
['trWindow', 'trChamber', 'trParty', 'trSource'].forEach(function (id) {
  var e = el(id); if (e) e.addEventListener('change', loadTrends);
});
(function () { var ts = el('trTickerSort'); if (ts) ts.addEventListener('change', loadTrTickers); })();
(function () {
  var v = el('view-trends');
  if (v) v.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-ticker]') : null;
    if (t && t.getAttribute('data-ticker')) openTicker(t.getAttribute('data-ticker'));
  });
})();

// Sortable feed headers: click a column to sort, click again to flip direction.
document.querySelectorAll('#feedHead th.sortable').forEach(function (th) {
  th.onclick = function () { setSort(th.dataset.sort); };
});
updateSortIndicators();

// Reflect the persisted theme on the toggle button.
applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

// Initial loading states + boot.
el('feedBody').innerHTML = stateRow(10, 'Loading live feed…');
el('reviewBody').innerHTML = stateRow(5, 'Loading…');
el('subsBody').innerHTML = stateRow(5, 'Loading…');
el('healthBody').innerHTML = stateRow(7, 'Loading…');

loadFeed().then(function () { startStream(); });
loadReview();      // for the tab badge / KPI
loadPollConfig();  // for the poll-mode KPI
</script>
</body>
</html>`;
