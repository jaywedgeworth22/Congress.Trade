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
 *   Subscriptions GET /api/admin/subscriptions, POST /api/subscriptions
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
  .pill.live::before { content:"●"; margin-right:5px; }
  .pill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .pill.warn::before { content:"●"; margin-right:5px; }
  .pill.off { color: var(--text-dim); }
  .pill.off::before { content:"●"; margin-right:5px; }
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
  .info-tip { color: var(--text-dim); cursor: help; border-bottom: 1px dotted var(--text-dim); }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  th, td { text-align: left; padding: 11px 13px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
  th { color: var(--text-dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  tr:last-child td { border-bottom: none; }
  tr.row:hover td { background: var(--panel-2); }
  th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
  th.sortable:hover { color: var(--text); }
  th.sortable .arr { opacity: .18; font-size: 10px; margin-left: 4px; color:var(--text-dim); }
  th.sortable.active { color: var(--text); }
  th.sortable.active .arr { opacity: 1; color: var(--accent); }
  /* fold-out advanced search */
  .search-panel {
    display: none; gap: 10px; flex-wrap: wrap; align-items: center;
    margin: -4px 0 14px; padding: 12px 14px; background: var(--panel);
    border: 1px solid var(--border); border-radius: var(--radius);
  }
  .search-panel.open { display: flex; position:relative; z-index:44; }
  .search-panel .lbl { font-size: 12px; color: var(--text-dim); margin-right: 2px; }
  .panel-backdrop { display:none; position:fixed; inset:0; z-index:43; background:rgba(2,6,18,.46); }
  .panel-backdrop.open { display:block; }
  .panel-head { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; }
  .panel-title { color:var(--text-dim); font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; }
  .panel-close {
    display:inline-flex; align-items:center; justify-content:center; width:38px; height:38px;
    margin:-8px -8px -8px 0; border-radius:999px; border:1px solid transparent;
    background:transparent; color:var(--text-dim); cursor:pointer; font-size:20px; line-height:1;
  }
  .panel-close:hover { color:var(--text); background:var(--panel-2); border-color:var(--border); }
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
  .member-cell { display: flex; align-items: center; gap: 9px; min-width:0; }
  .member-cell > div { min-width:0; line-height:1.25; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .member-cell .fit-sm { font-size:12px; }
  .member-cell .fit-xs { font-size:11px; }
  .date-short { display:none; }
  #feedTable.narrow-published .c-published .date-full,
  #feedTable.narrow-traded .c-traded .date-full,
  #feedTable.narrow-filed .c-filed .date-full,
  #feedTable.narrow-imported .c-imported .date-full { display:none; }
  #feedTable.narrow-published .c-published .date-short,
  #feedTable.narrow-traded .c-traded .date-short,
  #feedTable.narrow-filed .c-filed .date-short,
  #feedTable.narrow-imported .c-imported .date-short { display:inline; }
  #feedTable.tiny-published .c-published,
  #feedTable.tiny-traded .c-traded,
  #feedTable.tiny-filed .c-filed,
  #feedTable.tiny-imported .c-imported { font-size:12px; }
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
  .mobile-only { display: none; }
  .feed-cards { display: none; gap: 10px; min-width: 0; max-width: 100%; }
  /* Compact 2-row trade card: row1 = asset + side/amount, row2 = one muted meta line. */
  .feed-card { position: relative; display: grid; grid-template-columns: 1fr 16px; align-items: center; gap: 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 11px 12px; cursor: pointer; min-width: 0; max-width: 100%; overflow: hidden; }
  .feed-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .feed-card:active { background: var(--panel-2); }
  .fc-main { grid-column: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .fc-row1 { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .fc-row1 .asset-cell { flex: 1 1 auto; min-width: 0; }
  .fc-amt { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
  .fc-amt-val { font-family: var(--mono); font-size: 13px; font-weight: 700; color: var(--text); }
  .fc-row2 { font-size: 12px; line-height: 1.4; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fc-sep { opacity: .5; margin: 0 1px; }
  .fc-member { color: var(--text); }
  .fc-member.clickable:active { text-decoration: underline; }
  .fc-chevron { grid-column: 2; justify-self: end; color: var(--text-dim); font-size: 22px; line-height: 1; opacity: .55; pointer-events: none; }
  /* Asset-cell ticker→name spacing (the user asked for a clear gap). */
  .tkr-gap { display: inline-block; width: .65em; }
  /* Glyph-based ticker logo (e.g. AAPL ) — themes via currentColor. */
  .tkr-logo.glyph { display: inline-flex; align-items: center; justify-content: center; color: var(--text); font-size: 1.05em; }
  .tkr-logo.glyph.tile { background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; }
  /* Compact company definition grid (kills the right-side whitespace). */
  .def-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px 16px; margin: 0; }
  .def-item { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .def-k { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: .4px; }
  .def-v { color: var(--text); font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
  /* Trade-drawer header — makes a tapped trade read as a TRANSACTION, not a company. */
  .drawer-trade-head { padding: 2px 0 6px; }
  .drawer-kicker { display: inline-block; margin-bottom: 8px; font-size: 11px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; }
  .drawer-trade-headline { margin: 0 0 4px; font-size: 22px; font-weight: 700; color: var(--text); font-family: var(--mono); }
  .drawer-trade-bracket { font-family: var(--sans); font-size: 12px; font-weight: 500; }
  .drawer-trade-in { margin: 0; font-size: 14px; color: var(--text-dim); }
  .drawer-trade-in .tkr { color: var(--accent); font-weight: 700; }
  .drawer-trade-in .company-name { color: var(--text); }
  .drawer-trade-in .dot-sep { margin: 0 6px; opacity: .5; }
  /* Tap-to-reveal tooltip popover (phones/tablets can't hover). */
  .tip-pop { position: fixed; z-index: 80; max-width: min(78vw, 320px); background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; font-size: 12.5px; line-height: 1.4; box-shadow: 0 10px 30px rgba(0,0,0,.32); }
  .feed-card-meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px 10px; min-width: 0; }
  .feed-card-meta > div { min-width: 0; }
  .feed-card-meta .mkey { display: block; color: var(--text-dim); font-size: 10px; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 2px; }
  .feed-card-meta .mval { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .latency { font-family: var(--mono); font-size: 12px; color: var(--text-dim); }
  .btn { background: var(--accent); color: #fff; border: none; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .btn.ghost { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .btn.sm { padding: 5px 10px; font-size: 12px; }
  .btn:disabled { opacity: .5; cursor: default; }
  .section { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; margin-bottom: 18px; }
  .section h3 { margin: 0 0 4px; font-size: 15px; }
  .section p.sub { margin: 0 0 16px; color: var(--text-dim); font-size: 13px; }
  .row-flex { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .pager { margin-top:14px; justify-content:space-between; }
  .pager-controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .pager select { padding:5px 9px; font-size:12px; }
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
  @media (max-width: 760px) { .trend-grid2 { grid-template-columns: 1fr; } }
  /* Roomier side drawer on tablets (mobile bottom-sheet still kicks in at 600px). */
  @media (min-width: 601px) and (max-width: 980px) { .drawer-panel { width: 560px; } }
  /* Let the feed toolbar wrap instead of overflowing on tablet widths. */
  @media (min-width: 721px) and (max-width: 900px) { .toolbar { flex-wrap: wrap; } .toolbar input, .toolbar select { flex: 1 1 160px; } }
  .est, .est-money { color: var(--text-dim); }
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
  .hbar .hval .est-money { font-family: var(--mono); }
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
  .disclaimer-toggle { display:none; }
  .disclaimer.collapsed { padding:0; }
  .disclaimer.collapsed .disclaimer-toggle { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; background:transparent; border:none; color:var(--text-dim); font-size:12px; font-weight:600; padding:9px 14px; cursor:pointer; }
  .disclaimer.collapsed .dt-chevron { transition: transform .15s ease; }
  .disclaimer:not(.collapsed) .disclaimer-toggle { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; background:transparent; border:none; color:var(--text-dim); font-size:12px; font-weight:600; padding:0 0 8px; cursor:pointer; }
  .disclaimer:not(.collapsed) .dt-chevron { transform: rotate(180deg); }
  .disclaimer.collapsed .disclaimer-body { display:none; }
  /* modal */
  /* ---- detail drawer (trade / asset / politician) ---- */
  .drawer { position:fixed; inset:0; z-index:60; display:none; }
  .drawer.open { display:block; }
  .drawer-backdrop { position:absolute; inset:0; background:rgba(2,6,18,.55); }
  .drawer-panel { position:absolute; top:0; right:0; height:100%; width:480px; max-width:92vw; background:var(--panel); border-left:1px solid var(--border); box-shadow:-12px 0 40px rgba(0,0,0,.4); overflow-y:auto; padding:0 22px 20px; }
  .drawer-topbar {
    position:sticky; top:0; z-index:4; display:flex; justify-content:flex-end;
    min-height:54px; margin:0 -10px; padding:8px 0 6px 44px;
    pointer-events:none; background:linear-gradient(var(--panel) 68%, transparent);
  }
  .drawer-close {
    pointer-events:auto; display:inline-flex; align-items:center; justify-content:center;
    width:48px; height:48px; margin:0; cursor:pointer; color:var(--text-dim);
    font-size:20px; border:1px solid transparent; border-radius:999px;
    background:color-mix(in srgb, var(--panel) 92%, transparent); line-height:1; touch-action:manipulation;
  }
  .drawer-close:hover { color:var(--text); background:var(--panel-2); border-color:var(--border); }
  #detailDrawerBody { margin-top:0; padding-top:8px; padding-right:36px; }
  .drawer-title-line { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; padding-right:4px; }
  .drawer-title-line .tkr { color:var(--accent); }
  .drawer-title-line .company-name { min-width:0; overflow-wrap:anywhere; color:var(--text); }
  .drawer h2 { margin:0 0 2px; font-size:19px; color:var(--text); }
  .drawer-member-title { display:flex; align-items:center; gap:11px; min-width:0; }
  .drawer-member-title > div:last-child { min-width:0; }
  .drawer-member-name { margin:0; color:var(--text); overflow-wrap:anywhere; }
  .drawer .dsub { color:var(--text-dim); font-size:13px; margin:0 0 6px; }
  .drawer-section { border-top:1px solid var(--border); padding:14px 0; }
  .drawer-section.first { border-top:none; padding-top:6px; }
  .drawer-section h3 { margin:0 0 10px; font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.6px; }
  .drawer-kv { display:grid; grid-template-columns:auto 1fr; gap:7px 14px; margin:0; font-size:13px; }
  .drawer-kv dt { color:var(--text-dim); white-space:nowrap; }
  .drawer-kv dd { margin:0; text-align:right; word-break:break-word; }
  .tier-gate-note { font-size:12px; color:var(--text-dim); background:var(--panel-2); border:1px dashed var(--border); border-radius:8px; padding:9px 11px; line-height:1.5; }
  .committee-tag { display:inline-block; font-size:11px; background:var(--panel-2); border:1px solid var(--border); border-radius:6px; padding:2px 8px; margin:0 5px 5px 0; }
  .drawer-all-link { display:block; margin-top:9px; font-size:13px; }
  .source-link { display:inline-block; margin-top:9px; font-size:13px; }
  .review-doc-link { display:block; margin-top:5px; font-size:12px; font-family:var(--sans); font-weight:600; white-space:nowrap; }
  .review-doc-link.inline { display:inline-block; margin:0 0 0 10px; }
  .filing-note { background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:9px 11px; font-size:12px; line-height:1.5; color:var(--text-dim); margin:0; }
  .filing-note-kv { background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:9px 11px; font-size:12px; }
  .filing-note-kv dd { text-align:left; }
  .perf-line { font-size:15px; font-weight:700; }
  .mini-tbl td { padding:7px 6px; }
  .mini-date { display:flex; flex-direction:column; gap:2px; line-height:1.25; }
  .mini-date .subline { color:var(--text-dim); font-size:11px; }
  .mini-source-link { display:block; margin-top:2px; font-size:11px; font-weight:600; }
  .colopts { display:flex; flex-wrap:wrap; gap:6px 4px; flex:1; }
  .colopt { font-size:13px; color:var(--text); display:inline-flex; align-items:center; gap:5px; margin-right:12px; white-space:nowrap; cursor:pointer; }
  .clickable { cursor: pointer; }
  .asset-cell.clickable:hover .tkr, .hlabel.clickable:hover .tkr, .drawer-title-line.clickable:hover .tkr, .tkr.clickable:hover { text-decoration: underline; }
  .member-cell.clickable:hover { text-decoration: underline; }
  .subs-msg { flex-basis: 100%; margin-top: 10px; }
  .secret-panel { display:grid; gap:8px; align-items:start; background:var(--panel-2); border:1px solid var(--border); border-radius:10px; padding:12px; color:var(--text); max-width:100%; }
  .secret-panel strong { font-size:13px; }
  .secret-panel code { display:block; overflow:auto; white-space:nowrap; padding:8px; }
  .secret-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .diag-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; margin:10px 0 14px; }
  .diag-card { border:1px solid var(--border); border-radius:10px; background:var(--panel-2); padding:11px 12px; min-width:0; }
  .diag-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:7px; }
  .diag-title { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .diag-status { font-size:10px; font-weight:800; text-transform:uppercase; border-radius:999px; padding:2px 7px; border:1px solid var(--border); }
  .diag-status.ok { color:var(--buy); background:color-mix(in srgb,var(--buy) 13%,transparent); }
  .diag-status.warn, .diag-status.unknown { color:var(--warn); background:color-mix(in srgb,var(--warn) 13%,transparent); }
  .diag-status.error { color:var(--sell); background:color-mix(in srgb,var(--sell) 13%,transparent); }
  .diag-meta { display:grid; grid-template-columns:1fr 1fr; gap:5px 10px; color:var(--text-dim); font-size:11px; }
  .diag-note { margin-top:8px; color:var(--text-dim); font-size:11px; line-height:1.35; overflow-wrap:anywhere; }
  .diag-error { color:var(--sell); font-weight:700; }
  .diag-warning { color:var(--warn); font-weight:700; }
  @media (max-width:600px){ .drawer-panel { width:100%; max-width:100%; } }
  footer { text-align:center; color: var(--text-dim); font-size:11px; padding:26px; }
  /* ---- account control + auth/billing modals ---- */
  .acct { display:flex; align-items:center; gap:8px; }
  .acct .email { font-size:12px; color:var(--text-dim); max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .badge { font-size:10px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; padding:2px 7px; border-radius:999px; border:1px solid var(--border); color:var(--text-dim); }
  .badge.premium { color:var(--good); border-color:color-mix(in srgb,var(--good) 45%,transparent); background:color-mix(in srgb,var(--good) 12%,transparent); }
  .acct .avatar.lg { width:28px; height:28px; cursor:pointer; }
  .menu { position:relative; }
  .menu-pop { position:absolute; right:0; top:38px; background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:6px; min-width:190px; box-shadow:0 12px 32px rgba(0,0,0,.38); display:none; z-index:30; }
  .menu-pop.open { display:block; }
  .menu-pop button { display:block; width:100%; text-align:left; background:transparent; border:none; color:var(--text); padding:8px 10px; border-radius:7px; cursor:pointer; font-size:13px; font-family:var(--sans); }
  .menu-pop button:hover { background:var(--panel-2); }
  .menu-pop .who { padding:6px 10px 8px; font-size:12px; color:var(--text-dim); border-bottom:1px solid var(--border); margin-bottom:5px; word-break:break-all; }
  .overlay { position:fixed; inset:0; background:rgba(4,8,16,.62); backdrop-filter:blur(3px); display:none; align-items:center; justify-content:center; z-index:50; padding:18px; }
  .overlay.open { display:flex; }
  .modal { background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:26px; width:100%; max-width:430px; box-shadow:0 24px 60px rgba(0,0,0,.45); }
  .modal h2 { margin:0 0 6px; font-size:19px; }
  .modal p.sub { margin:0 0 18px; color:var(--text-dim); font-size:13px; }
  .modal .close { float:right; display:inline-flex; align-items:center; justify-content:center; width:40px; height:40px; margin:-10px -10px 0 6px; background:transparent; border:1px solid transparent; border-radius:999px; color:var(--text-dim); font-size:20px; cursor:pointer; line-height:1; }
  .modal .close:hover { color:var(--text); background:var(--panel-2); border-color:var(--border); }
  .gbtn { display:flex; align-items:center; justify-content:center; gap:10px; width:100%; padding:11px; border-radius:10px; border:1px solid var(--border); background:var(--panel-2); color:var(--text); font-weight:600; font-size:14px; cursor:pointer; }
  .gbtn:hover { border-color:var(--accent); }
  .gbtn svg { width:18px; height:18px; }
  .divider { display:flex; align-items:center; gap:10px; color:var(--text-dim); font-size:12px; margin:16px 0; }
  .divider::before, .divider::after { content:""; flex:1; height:1px; background:var(--border); }
  .field { display:flex; gap:8px; margin-top:6px; }
  .field input { flex:1; }
  .plan-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:8px 0; }
  .plan { border:1px solid var(--border); border-radius:12px; padding:16px 14px; cursor:pointer; position:relative; transition:border-color .15s; }
  .plan:hover, .plan.sel { border-color:var(--accent); background:color-mix(in srgb,var(--accent) 7%,transparent); }
  .plan .price { font-size:23px; font-weight:800; }
  .plan .per { font-size:12px; color:var(--text-dim); }
  .plan .cad { font-size:13px; font-weight:600; margin-bottom:6px; }
  .plan .save { position:absolute; top:-9px; right:10px; font-size:10px; font-weight:700; color:#06231a; background:var(--good); padding:2px 7px; border-radius:999px; }
  .trial-note { font-size:12px; color:var(--text-dim); text-align:center; margin:8px 0 2px; }
  .toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:var(--panel-2); border:1px solid var(--border); color:var(--text); padding:11px 16px; border-radius:10px; font-size:13px; z-index:60; box-shadow:0 8px 24px rgba(0,0,0,.35); display:none; max-width:90vw; }
  .toast.show { display:block; }
  .toast.err { border-color:color-mix(in srgb,var(--sell) 55%,transparent); color:var(--sell); }
  .gate-note { font-size:12px; color:var(--warn); display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:center; }
  @media (max-width: 720px), (orientation: landscape) and (max-width: 950px) and (max-height: 520px) {
    html, body { width:100%; max-width:100%; overflow-x:hidden; }
    body { background: var(--bg); font-size: 13px; }
    header.top {
      display: grid; grid-template-columns: 1fr auto auto; gap: 8px;
      padding: 10px 12px; align-items: center; backdrop-filter: none;
    }
    .brand { font-size: 15px; }
    #srcPill { display: none; }
    .pill { padding: 3px 7px; }
    .theme-toggle { display:none; }
    nav.tabs {
      position: fixed; left: 0; right: 0; bottom: 0; margin: 0;
      width: 100%; max-width: 100%;
      display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 4px; padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0px));
      background: var(--panel);
      border-top: 1px solid var(--border); backdrop-filter: none; z-index: 45;
      box-shadow: 0 -8px 24px rgba(0,0,0,.18); transform: translateZ(0);
      overflow: visible;
    }
    nav.tabs::after {
      content:""; position:absolute; left:0; right:0; top:100%;
      height:calc(120px + env(safe-area-inset-bottom));
      background:var(--panel); pointer-events:none;
    }
    html[data-theme="light"] nav.tabs { background:#fff; }
    html[data-theme="light"] nav.tabs::after { background:#fff; }
    nav.tabs button { padding: 6px 4px; min-height: 44px; font-size: 0; min-width: 0; border-radius: 9px; }
    nav.tabs button::before { content: attr(data-icon); display: block; font-size: 16px; line-height: 1; margin-bottom: 3px; }
    nav.tabs button::after { content: attr(data-mobile); display: block; font-size: 10px; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .acct { justify-content: flex-end; }
    .acct .email, .acct .badge { display: none; }
    main { max-width: none; min-width:0; overflow-x:hidden; padding: 12px; padding-bottom: calc(86px + env(safe-area-inset-bottom)); }
    .view, .section, .toolbar, .row-flex, .sched-row { min-width:0; max-width:100%; }
    .section { overflow:hidden; }
    .section p.sub { font-size:12px; line-height:1.45; }
    .note, .section p.sub, .disclaimer, code { overflow-wrap:anywhere; }
    .section > table { display:block; max-width:100%; overflow-x:auto; }
    .table-wrap { max-width:100%; overflow-x:auto; }
    .banner, .disclaimer { margin-bottom: 12px; }
    .disclaimer { font-size:11px; line-height:1.45; padding:10px 11px; }
    input, select, .btn { font-size:16px; }
    #view-feed > .grid-cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; overflow:visible; margin:0 0 10px; padding:0; }
    #view-feed > .grid-cards .card { min-width:0; padding:10px 11px; border-radius:8px; }
    .grid-cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; overflow:visible; margin:0 0 14px; padding:0; }
    .grid-cards .card { min-width:0; padding:11px 12px; border-radius:10px; }
    .card .k { font-size:11px; line-height:1.25; }
    .card .v { font-size:18px; }
    .section { border-radius: 10px; padding: 14px; margin-bottom: 12px; }
    .toolbar { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px; align-items: stretch; }
    .toolbar input, .toolbar select, .toolbar .btn { width: 100%; min-width:0; min-height: 40px; padding:8px 9px; }
    .toolbar #qMember { grid-column: span 2; }
    .toolbar #qTicker { width:100% !important; }
    .search-panel.open {
      position: fixed; left: 10px; right: 10px; bottom: calc(70px + env(safe-area-inset-bottom));
      display: grid; grid-template-columns: 1fr; z-index: 44; max-height: 58vh; overflow:auto;
      box-shadow: 0 18px 44px rgba(0,0,0,.45);
    }
    .panel-close { width:44px; height:44px; margin:-10px -10px -10px 0; }
    #view-feed .table-wrap { display: none; }
    #view-feed .feed-cards { display: grid; grid-template-columns: minmax(0, 1fr); }
    .col-resizer { display: none; }
    .row-flex { align-items: stretch; gap: 9px; }
    .row-flex > input, .row-flex > select, .row-flex > button { width: 100%; min-height: 40px; }
    .sched-row { grid-template-columns: 1fr 1fr; }
    .trend-grid2 { gap: 12px; }
    .cluster-grid { grid-template-columns: 1fr; }
    .drawer-panel { top: auto; bottom: 0; height: 88vh; width: 100%; max-width: 100%; border-left: none; border-top: 1px solid var(--border); border-radius: 16px 16px 0 0; padding: 0 16px calc(18px + env(safe-area-inset-bottom)); }
    .drawer-kv { grid-template-columns: 1fr; gap: 3px; }
    .drawer-kv dd { text-align: left; }
    .plan-grid { grid-template-columns: 1fr; }
    .toast { bottom: calc(78px + env(safe-area-inset-bottom)); width: calc(100vw - 24px); max-width: 420px; }
  }
  @media (max-width: 460px) {
    .feed-card-meta { grid-template-columns: 1fr; }
  }
  @media (max-width: 420px) {
    #view-feed > .grid-cards { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .toolbar { grid-template-columns: repeat(2,minmax(0,1fr)); }
    .toolbar #qMember { grid-column:1 / -1; }
    nav.tabs button::after { font-size: 9px; }
    th, td { padding: 9px 10px; }
  }
  @media (orientation: landscape) and (max-width: 950px) and (max-height: 520px) {
    header.top { padding:8px 10px; }
    main { padding:8px 10px; padding-bottom:calc(72px + env(safe-area-inset-bottom)); }
    .disclaimer { font-size:10px; line-height:1.35; max-height:78px; overflow:auto; padding:8px 10px; }
    .section p.sub { font-size:11px; line-height:1.35; }
    #view-feed > .grid-cards { grid-template-columns:repeat(5,minmax(0,1fr)); }
    #view-feed > .grid-cards .card { padding:8px 9px; }
    .toolbar { grid-template-columns: 1.45fr .65fr 1fr 1fr; }
    .toolbar #qMember { grid-column:auto; }
    .feed-card-meta { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .drawer-panel { height:92vh; }
    nav.tabs { padding-top:6px; padding-bottom:calc(6px + env(safe-area-inset-bottom)); }
  }
</style>
</head>
<body>
<header class="top">
  <div class="brand">Congress<span class="dot">.</span>Trade</div>
  <span class="pill off" id="livePill">Status</span>
  <span class="pill" id="srcPill">House + Senate</span>
  <nav class="tabs">
    <button data-view="trends" data-mobile="Trends" data-icon="⌁" class="active">Trends</button>
    <button data-view="feed" data-mobile="Trades" data-icon="▦">Trades</button>
    <button data-view="review" data-mobile="Review" data-icon="✓">Review Queue <span id="reviewCount"></span></button>
    <button data-view="subs" data-mobile="Alerts" data-icon="↗">Subscriptions</button>
    <button data-view="admin" data-mobile="Admin" data-icon="⚙">Admin · Cadence</button>
  </nav>
  <div id="acct" class="acct"></div>
  <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Toggle light / dark">🌙</button>
</header>

<main>
  <div class="banner" id="banner">Connecting to the live feed…</div>

  <!-- ================= TRADES (LIVE FEED) ================= -->
  <section class="view" id="view-feed">
    <div class="grid-cards">
      <div class="card"><div class="k">Filings Imported Today</div><div class="v" id="kpiToday">—</div></div>
      <div class="card"><div class="k">Trades</div><div class="v" id="kpiTotal">—</div></div>
      <div class="card"><div class="k">Auto-Parsed (No LLM)</div><div class="v" id="kpiAuto">—<small>%</small></div></div>
    </div>
    <div class="toolbar">
      <input id="qMember" placeholder="Filter Member…" oninput="handleFeedTextFilter()" />
      <input id="qTicker" placeholder="Ticker…" oninput="handleFeedTextFilter()" style="width:120px" />
      <select id="qType" onchange="resetFeedPage()">
        <option value="">All Types</option><option value="P">Purchase</option>
        <option value="S">Sale</option><option value="E">Exchange</option>
      </select>
      <select id="qChamber" onchange="resetFeedPage()">
        <option value="">Both Chambers</option><option value="house">House</option><option value="senate">Senate</option>
      </select>
      <button class="btn ghost sm" id="searchToggle" onclick="toggleSearch()">🔍 Search</button>
      <button class="btn ghost sm" onclick="toggleColChooser()" title="Show / Hide Columns">⚙ Columns</button>
      <button class="btn ghost sm" onclick="exportCsv()" title="Download the filtered feed as CSV (premium)">⤓ Export CSV</button>
      <label class="lbl" for="pageSize">Rows</label>
      <select id="pageSize" onchange="setPageSize(this.value)" title="Rows shown per page">
        <option value="25">25</option><option value="50" selected>50</option><option value="100">100</option><option value="250">250</option>
      </select>
    </div>
    <div class="panel-backdrop" id="panelBackdrop" onclick="closePanels()"></div>
    <div class="search-panel" id="colChooser">
      <div class="panel-head"><span class="panel-title">Columns</span><button class="panel-close" onclick="closePanels()" aria-label="Close columns">×</button></div>
      <div id="colChooserBody" class="colopts"></div>
      <button class="btn ghost sm" onclick="resetCols()">Reset</button>
    </div>
    <div class="search-panel" id="searchPanel">
      <div class="panel-head"><span class="panel-title">Search</span><button class="panel-close" onclick="closePanels()" aria-label="Close search">×</button></div>
      <span class="lbl">Search All</span>
      <input id="qAll" placeholder="Member, Asset, Ticker, Source…" style="min-width:240px;flex:1" oninput="renderFeed()" />
      <span class="lbl">Min $</span>
      <input id="qMinAmt" type="number" min="0" placeholder="0" style="width:120px" oninput="renderFeed()" />
      <button class="btn ghost sm" onclick="clearSearch()">Clear</button>
    </div>
    <div class="table-wrap">
    <table id="feedTable">
      <thead><tr id="feedHead"></tr></thead>
      <tbody id="feedBody"></tbody>
    </table>
    </div>
    <div id="feedCards" class="feed-cards mobile-only" aria-live="polite"></div>
    <div class="row-flex pager">
      <span class="note" id="feedCountMsg"></span>
      <div class="pager-controls">
        <button class="btn ghost sm" id="prevPageBtn" onclick="prevFeedPage()" title="Previous page">&lt;</button>
        <span class="note" id="feedPageMsg"></span>
        <button class="btn ghost sm" id="nextPageBtn" onclick="nextFeedPage()" title="Next page">&gt;</button>
      </div>
    </div>
    <div class="row-flex" id="gateRow" style="margin-top:10px;justify-content:center;display:none">
      <span class="gate-note">🔒 Free view shows the last 30 days. Unlock full history, alerts & CSV export.
        <button class="btn sm" onclick="openPricing()">Upgrade</button></span>
    </div>
  </section>

  <!-- ================= TRENDS / ANALYTICS ================= -->
  <section class="view active" id="view-trends">
    <div class="toolbar">
      <select id="trWindow" title="Time window (by trade date)">
        <option value="1d">Past Day</option>
        <option value="7d">Past Week</option>
        <option value="30d">Past Month</option>
        <option value="90d">Past 3 Months</option>
        <option value="180d">Past 6 Months</option>
        <option value="365d">Past Year</option>
        <option value="1825d">Past 5 Years</option>
        <option value="all" selected>All Time</option>
      </select>
      <select id="trChamber"><option value="">Both Chambers</option><option value="house">House</option><option value="senate">Senate</option></select>
      <select id="trParty"><option value="">All Parties</option><option value="D">Democrat</option><option value="R">Republican</option><option value="O">Other / Ind.</option></select>
      <select id="trSource" title="Provenance of the underlying rows">
        <option value="all" selected>All Data</option>
        <option value="primary">Primary Only</option>
        <option value="seed_dataset">Historic (Seed) Only</option>
      </select>
      <button class="btn ghost sm" onclick="loadTrends()">↻ Refresh</button>
    </div>
    <div class="disclaimer collapsed" id="trDisclaimer">
      <button class="disclaimer-toggle" type="button" onclick="toggleDisclaimer()" aria-expanded="false" aria-controls="trDisclaimerBody"><span class="dt-label">Disclaimer</span><span class="dt-chevron" aria-hidden="true">▾</span></button>
      <div class="disclaimer-body" id="trDisclaimerBody">
      <strong>For education, not investment advice.</strong> Congress.Trade is an informational tool for exploring <em>public</em> STOCK Act disclosures. The summaries below are historical, observational views of those filings — they are <strong>not</strong> trading signals, recommendations, or predictions, and nothing here implies any member acted improperly or illegally. Dollar figures are <strong>estimates</strong> from disclosed amount <em>brackets</em> (midpoint; the open “$50M+” tier uses its floor) and may be incomplete or delayed — filings are disclosed weeks after the trade. “All Data” can double-count a trade present in both the live and historic sets; use <em>Live Only</em> for a de-duplicated dollar view. Party is known for only some members. Always do your own research.
      </div>
    </div>

    <!-- KPI strip -->
    <div class="grid-cards" id="trKpis">
      <div class="card"><div class="k">Loading…</div><div class="v">—</div></div>
    </div>

    <!-- What Congress is trading + Heating up -->
    <div class="trend-grid2">
      <div class="section">
        <h3>What Congress Is Trading</h3>
        <p class="sub">Most-traded tickers in the window. Click a row for a deep dive. Bar = buy / sell mix.</p>
        <div class="row-flex" style="margin:-6px 0 12px">
          <label class="lbl">Rank By</label>
          <select id="trTickerSort" title="Estimated volume uses STOCK Act bracket midpoints">
            <option value="trades">Trades</option>
            <option value="members">Distinct Members</option>
	            <option value="volume">Est. Volume</option>
            <option value="netflow">Net $ Flow</option>
          </select>
        </div>
        <div class="table-wrap"><table><tbody id="trTickers"></tbody></table></div>
      </div>
      <div class="section">
        <h3>Rising Activity</h3>
        <p class="sub">Tickers whose disclosed trade count rose most vs the prior equal period. A descriptive view of filing activity — not a forecast.</p>
        <div class="table-wrap"><table><tbody id="trTrending"></tbody></table></div>
      </div>
    </div>

    <!-- Consensus / cluster buys -->
    <div class="section">
      <h3>Consensus Moves <span class="chip" id="trClusterHint"></span></h3>
      <p class="sub">Tickers where several different members happened to trade the <strong>same direction</strong> in the window. Shown as an educational observation of public filings — not a recommendation, and not evidence of coordination.</p>
      <div class="cluster-grid" id="trClusters"></div>
    </div>

    <!-- Buys vs sells over time -->
    <div class="section">
      <h3>Buys vs Sells Over Time</h3>
      <p class="sub">Trade counts bucketed by period. The <em>shape</em> — a surge of buying or selling — is the trend.</p>
      <div class="legend"><span><span class="sw buy"></span>Buys</span><span><span class="sw sell"></span>Sells</span></div>
      <div id="trTime"></div>
    </div>

    <!-- Real GICS sector flow + market-cap size tilt (securities_ref-backed) -->
    <div class="trend-grid2">
      <div class="section">
        <h3>Net Flow by Sector</h3>
        <p class="sub">Real <strong>GICS sectors</strong> (from enriched security reference data), ranked by estimated volume. Bar = volume; chip shows buy/sell mix, breadth, and signed net $ flow.</p>
        <div id="trSectorFlow"></div>
      </div>
      <div class="section">
        <h3>By Market Cap</h3>
        <p class="sub">The size tilt — net flow and activity across market-cap buckets (mega → nano). Cap tracks the daily close, so it stays current as price moves.</p>
        <div id="trCapFlow"></div>
      </div>
    </div>

    <!-- Top performers: realizable excess vs the S&P 500, anchored at filing date -->
    <div class="section">
      <h3>Top Performers <span class="info-tip" tabindex="0" aria-label="Excess return vs the S&P 500 measured from each trade's public FILING date — what a follower could actually have captured, not trade-date hindsight. Buys only, options excluded, members with few scored trades are filtered out." title="Excess return vs the S&P 500 measured from each trade's public FILING date — what a follower could actually have captured, not trade-date hindsight. Buys only, options excluded, members with few scored trades are filtered out.">ⓘ</span></h3>
      <p class="sub">Members whose disclosed <strong>buys</strong> beat the S&amp;P 500 since the trade became <em>public</em> (filing-date anchored — the return a follower could realistically capture). A descriptive, observational track record — <strong>not</strong> a forecast or recommendation.</p>
      <div class="table-wrap"><table><tbody id="trPerformers"></tbody></table></div>
    </div>

    <!-- Members + Party -->
    <div class="trend-grid2">
      <div class="section">
        <h3>Most Active Members</h3>
        <p class="sub">Who is trading the most in the window.</p>
        <div class="table-wrap"><table><tbody id="trMembers"></tbody></table></div>
      </div>
      <div class="section">
        <h3>By Party</h3>
        <p class="sub">Buy / sell mix and estimated net flow per party (where party is known).</p>
        <div id="trParties"></div>
        <h3 style="margin-top:18px">By Asset Type</h3>
        <p class="sub">Share of estimated volume by instrument type.</p>
        <div id="trSectors"></div>
      </div>
    </div>

    <!-- Disclosure timeliness -->
    <div class="section">
      <h3>Disclosure Timeliness</h3>
      <p class="sub">Days from trade to filing. The STOCK Act sets a 45-day deadline; this is a data-quality + accountability lens.</p>
      <div class="grid-cards" id="trLagKpis"></div>
      <div class="trend-grid2" style="margin-top:6px">
        <div><h3 style="font-size:13px">Lag Distribution</h3><div id="trLagDist"></div></div>
        <div><h3 style="font-size:13px">Slowest Filers (Avg Lag)</h3><div class="table-wrap"><table><tbody id="trLateFilers"></tbody></table></div></div>
      </div>
    </div>
  </section>

  <!-- ================= REVIEW QUEUE ================= -->
  <section class="view" id="view-review">
    <div class="section">
      <h3>Document Review &amp; Model Comparison</h3>
      <p class="sub">Scanned / handwritten filings below the confidence threshold are held here until a human acts. Switch to <strong>Reviewed</strong> to see what was published / rejected / modified, and expand <strong>Models</strong> on any row to compare each model's confidence and reading.</p>
      <div style="display:flex;gap:6px;margin:8px 0">
        <button class="btn sm" id="revTabPending" onclick="setReviewTab(0)">Pending</button>
        <button class="btn ghost sm" id="revTabReviewed" onclick="setReviewTab(1)">Reviewed</button>
      </div>
      <table>
        <thead><tr><th>Filed</th><th>Doc</th><th>Status</th><th>Reason</th><th>Payload</th><th></th></tr></thead>
        <tbody id="reviewBody"></tbody>
      </table>
      <p class="note">Confirm promotes the read to the live feed; Manual lets you hand-key the rows (recorded as <code>source=manual</code>) when the automated read is wrong or too low-confidence; Reject discards it. Models / readings come from <code>extraction_runs</code> (populated by <code>POST /api/admin/bakeoff</code>). <code>POST /api/admin/review/:docId {decision}</code></p>
    </div>
  </section>

  <!-- ================= SUBSCRIPTIONS ================= -->
  <section class="view" id="view-subs">
    <div class="section">
      <h3>Delivery Subscriptions</h3>
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
        <div id="subsMsg" class="note subs-msg" aria-live="polite"></div>
      </div>
      <p class="note">API HOOK: GET <code>/api/admin/subscriptions</code>; POST <code>/api/subscriptions</code></p>
    </div>
  </section>

  <!-- ================= ADMIN · CADENCE ================= -->
  <section class="view" id="view-admin">
    <div class="section">
      <h3>Admin Access</h3>
      <p class="sub">The admin endpoints (poll cadence, review queue, backfill) are gated by a bearer token. Paste your <code>ADMIN_TOKEN</code> once — it's kept in this browser only (localStorage) and sent as <code>Authorization: Bearer …</code> on admin requests. Leave blank if the server has no token set. (Tip: if you sign in via Cloudflare Access, you don't need a token here.)</p>
      <div class="row-flex">
        <input id="adminToken" type="password" autocomplete="off" placeholder="ADMIN_TOKEN" style="flex:1;min-width:240px" />
        <button class="btn" onclick="saveAdminToken()">Save Token</button>
        <button class="btn ghost sm" onclick="clearAdminToken()">Clear</button>
        <span id="adminTokenMsg" class="note"></span>
      </div>
    </div>
    <div class="section">
      <h3>Logos</h3>
      <p class="sub">Company-logo style shown on the live feed for <strong>all visitors</strong>. "Plain" shows bare logos; "Tile" frames them; "Off" hides them. When a logo is on but a ticker's image isn't available, a monogram (the ticker's first letters) is shown as a backup.</p>
      <div class="row-flex">
        <label class="lbl">Logo Style</label>
        <select id="adminLogo">
          <option value="transparent">Logos: Plain</option>
          <option value="tile">Logos: Tile</option>
          <option value="off">Logos: Off</option>
        </select>
        <button class="btn" onclick="saveLogoDisplay()">Save for Everyone</button>
        <span id="logoMsg" class="note"></span>
      </div>
    </div>
    <div class="section">
      <h3>Poll Cadence</h3>
      <p class="sub">Filings land almost entirely during US-Eastern business hours on weekdays. Adaptive windows keep latency low when it matters and stay polite to gov servers overnight.</p>
      <div class="row-flex" style="margin-bottom:16px">
        <label class="switch"><input type="checkbox" id="aggToggle" onchange="toggleAggressive()"><span></span></label>
        <div><strong>Aggressive Mode</strong><div class="note" style="margin-top:2px">Drops business-hours interval for front-running edge vs higher-latency trackers.</div></div>
      </div>
      <div class="sched-row"><div class="lbl">Days (0=Sun…6=Sat)</div><div class="lbl">Start ET</div><div class="lbl">End ET</div><div class="lbl">Interval (s)</div></div>
      <div id="schedRows"></div>
      <div class="row-flex" style="margin-top:14px">
        <button class="btn" onclick="saveSchedule()">Save Cadence</button>
        <button class="btn ghost" onclick="loadPollConfig()">Reload</button>
        <span id="saveMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: <code>GET/PUT /api/admin/poll-config</code>. The Worker cron fires every minute and consults this schedule via <code>shouldPollNow()</code> — so changes take effect within ~60s, no redeploy.</p>
    </div>
    <div class="section">
      <h3>Historic Backfill</h3>
      <p class="sub">Bulk-import pre-aggregated public datasets as <code>seed_dataset</code> rows to bootstrap back-history. Idempotent (safe to re-run); these rows are reference-only and never dispatched to subscribers.</p>
      <div class="row-flex">
        <label class="lbl">Since Year</label>
        <input id="bfSince" type="number" placeholder="e.g. 2020" style="width:120px" />
        <label class="lbl">Row Limit</label>
        <input id="bfLimit" type="number" placeholder="(none)" style="width:120px" />
        <select id="bfChambers">
          <option value="">Both Chambers</option><option value="house">House Only</option><option value="senate">Senate Only</option>
        </select>
        <button class="btn ghost sm" onclick="runBackfill(true)">Dry Run</button>
        <button class="btn" onclick="runBackfill(false)">Run Seed Backfill</button>
        <span id="bfMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: <code>POST /api/admin/backfill</code>. Senate defaults to the GitHub mirror (works out of the box). The House community bucket is gated (HTTP 403) — set <code>SEED_HOUSE_URL</code>, or use the official House index backfill below.</p>
      <div class="row-flex" style="margin-top:14px">
        <label class="lbl">House History (Official Index)</label>
        <input id="hiFrom" type="number" placeholder="from year" style="width:120px" />
        <input id="hiTo" type="number" placeholder="to year" style="width:120px" />
        <input id="hiMax" type="number" min="1" max="5000" value="500" title="Maximum filings to enqueue in this run" style="width:120px" />
        <button class="btn ghost sm" onclick="runHouseIndex(true)">Dry Run</button>
        <button class="btn" onclick="runHouseIndex(false)">Backfill House Index</button>
        <span id="hiMsg" class="note"></span>
      </div>
      <p class="note">API HOOK: <code>POST /api/admin/house-backfill</code>. Pulls past-year House bulk ZIPs (official, always reachable) and runs each PTR through the live pipeline — high-fidelity, but heavier than the seed import. Dry Run only counts; Backfill is capped by Max filings.</p>
    </div>
    <div class="section">
      <h3>Source Health</h3>
      <p class="sub">First-seen timestamps are logged per filing so real refresh cadence is measured, not assumed.</p>
      <table>
        <thead><tr><th>Source</th><th>Last Poll</th><th>Last New Filing</th><th>Polls</th><th>Avg Refresh (Observed)</th><th title="Official disclosure date → when our watcher first saw it. Approximate: the disclosure systems publish a date, not an exact release time.">Released→Seen ≈</th><th title="When we first saw the filing → when we wrote its parsed rows. Precise (both are our timestamps).">Seen→Imported</th></tr></thead>
        <tbody id="healthBody"></tbody>
      </table>
    </div>
    <div class="section">
      <h3>Connection Status</h3>
      <p class="sub">Provider and integration status from production data. Secret values are never shown.</p>
      <div id="diagConnections" class="diag-grid" aria-live="polite"></div>
      <h3 style="margin-top:14px">Recent App Errors</h3>
      <table>
        <thead><tr><th>When</th><th>Area</th><th>Subject</th><th>Message</th></tr></thead>
        <tbody id="diagErrors"></tbody>
      </table>
    </div>
  </section>

  <footer>Congress.Trade · an educational tool for exploring public STOCK Act (2012) disclosures · informational only — not financial advice, not trading signals · dollar figures are estimates from disclosed brackets</footer>
</main>

<div class="drawer" id="detailDrawer">
  <div class="drawer-backdrop" onclick="closeDrawer()"></div>
  <div class="drawer-panel"><div class="drawer-topbar"><button class="drawer-close" onclick="closeDrawer()" aria-label="Close">✕</button></div><div id="detailDrawerBody"></div></div>
</div>

<!-- ================= LOGIN MODAL ================= -->
<div class="overlay" id="loginOverlay" onclick="if(event.target===this)closeLogin()">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Sign In">
    <button class="close" onclick="closeLogin()" aria-label="Close">×</button>
    <h2>Sign In to Congress.Trade</h2>
    <p class="sub">Save filters, manage your subscription, and unlock full history.</p>
    <button class="gbtn" onclick="loginGoogle()">
      <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.7 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.5 13.2l7.9 6.1C12.3 13.2 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-3.9 6.8-9.7 6.8-17.4z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.5 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.6 2.3-8.6 2.3-6.4 0-11.7-3.7-13.6-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
      Continue with Google
    </button>
    <div class="divider">or</div>
    <label class="lbl" for="magicEmail">Email me a one-click sign-in link</label>
    <div class="field">
      <input id="magicEmail" type="email" autocomplete="email" placeholder="you@example.com" onkeydown="if(event.key==='Enter')sendMagicLink()" />
      <button class="btn" onclick="sendMagicLink()">Send Link</button>
    </div>
    <p class="note" id="loginMsg"></p>
  </div>
</div>

<!-- ================= PRICING MODAL ================= -->
<div class="overlay" id="pricingOverlay" onclick="if(event.target===this)closePricing()">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Upgrade to Premium">
    <button class="close" onclick="closePricing()" aria-label="Close">×</button>
    <h2>Go Premium</h2>
    <p class="sub">Full trade history, CSV export, and (soon) real-time alerts. Cancel anytime.</p>
    <div class="plan-grid">
      <div class="plan sel" id="planMonthly" onclick="selectPlan('monthly')">
        <div class="cad">Monthly</div>
        <div class="price">$15<span class="per">/mo</span></div>
      </div>
      <div class="plan" id="planAnnual" onclick="selectPlan('annual')">
        <span class="save">SAVE ~22%</span>
        <div class="cad">Annual</div>
        <div class="price">$140<span class="per">/yr</span></div>
      </div>
    </div>
    <p class="trial-note">✨ Starts with a 7-day free trial — you won't be charged today.</p>
    <button class="btn" style="width:100%;padding:11px" id="subscribeBtn" onclick="startCheckout()">Start Free Trial</button>
    <p class="note" id="pricingMsg"></p>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
/* ============================ STATE ============================ */
var TRADES = [];          // live transactions (newest first)
var REVIEW = [];          // review-queue items
var SCHEDULE = [];        // PollWindow[]
var aggressive = false;
var cursor = 0;           // max cursor_seq seen
var totalRows = 0;        // server-reported total matching rows (for "X of N")
var filingsImportedToday = 0;
var feedPage = 0;         // zero-based page in newest-first snapshot mode
var feedPageSize = Number(localStorage.getItem('feed-page-size') || 50);
var loadingPage = false;  // guards against overlapping page fetches
var feedRequestSeq = 0;
var feedAbort = null;
var feedSearchTimer = null;
var realDataLoaded = false;
var feedGated = false;     // server says this visitor sees the limited free window
var es = null;            // EventSource handle
var pollTimer = null;     // setInterval handle for the polling fallback
var POLL_INTERVAL_MS = 30000;  // graceful polling cadence when SSE is unavailable
var sortKey = 'published'; // active feed sort column
var sortDir = -1;         // 1 = ascending, -1 = descending (default: newest first)
var NUMERIC_SORT = { min: 1, conf: 1, refMarketCap: 1 };   // columns compared numerically

/* ============================ HELPERS ============================ */
var fmt = function (n) { return n == null ? '—' : '$' + Number(n).toLocaleString(); };
function fmtBracketAmount(n) {
  if (n == null) return '—';
  n = Number(n);
  if (!Number.isFinite(n)) return '—';
  var abs = Math.abs(n), sign = n < 0 ? '-' : '';
  function clean(v) { return String(v).replace(/\\.0$/, ''); }
  if (abs >= 1e9) return sign + '$' + clean((abs / 1e9).toFixed(abs >= 10e9 ? 0 : 1)).toLowerCase() + 'b';
  if (abs >= 1e6) return sign + '$' + clean((abs / 1e6).toFixed(abs >= 10e6 ? 0 : 1)).toLowerCase() + 'm';
  if (abs >= 1e3) return sign + '$' + clean((abs / 1e3).toFixed(abs >= 10e3 ? 0 : 1)).toLowerCase() + 'k';
  return sign + '$' + Math.round(abs);
}
var confClass = function (c) { return c >= 0.9 ? 'hi' : c >= 0.7 ? 'mid' : 'lo'; };
var typeName = { P: 'Purchase', S: 'Sale', E: 'Exchange' };
/* Capitalize a beneficial-owner code for display (self -> Self, joint -> Joint). */
function ownerLabel(o) { var s = String(o == null ? '' : o); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
/* Format a politician name so a generational suffix sits after a single comma
   with no space on its left, e.g. "Sonny Perdue Jr" -> "Sonny Perdue, Jr". */
var NAME_SUFFIX = { 'jr': 'Jr', 'jr.': 'Jr', 'sr': 'Sr', 'sr.': 'Sr', 'ii': 'II', 'iii': 'III', 'iv': 'IV' };
function fmtName(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  while (s.indexOf('  ') >= 0) s = s.split('  ').join(' ');
  s = s.split(' , ').join(', ');
  var parts = s.split(' ');
  var suf = NAME_SUFFIX[parts[parts.length - 1].toLowerCase()];
  if (!suf) return s;
  var head = parts.slice(0, -1).join(' ');
  while (head.charAt(head.length - 1) === ',' || head.charAt(head.length - 1) === ' ') head = head.slice(0, -1);
  return head ? head + ', ' + suf : suf;
}
/* "House"/"Senate" are proper nouns here — always capitalize the chamber. */
function chamberLabel(c) {
  var s = String(c == null ? '' : c).trim().toLowerCase();
  if (s === 'house' || s === 'h') return 'House';
  if (s === 'senate' || s === 's') return 'Senate';
  return c ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}
/* Spell out a US state/territory from its 2-letter code for the politician drawer. */
var US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands' };
function stateName(abbr) {
  var s = String(abbr == null ? '' : abbr).trim().toUpperCase();
  return US_STATES[s] || (abbr || '');
}
/* Title-case an instrument/asset class but keep common acronyms upper (ETF, REIT…). */
var ASSET_CLASS_UP = { etf: 'ETF', reit: 'REIT', adr: 'ADR', etn: 'ETN', spac: 'SPAC' };
function assetClassLabel(c) {
  var s = String(c == null ? '' : c).trim();
  if (!s) return '';
  return ASSET_CLASS_UP[s.toLowerCase()] || (s.charAt(0).toUpperCase() + s.slice(1));
}
/* Friendlier label for STOCK Act asset-type codes (ST = Stocks, etc.). */
var ASSET_TYPE_LABEL = { ST: 'Stocks', OP: 'Options', GS: 'Govt Securities', CS: 'Corporate Bonds', EF: 'Funds / ETFs', MF: 'Mutual Funds', OT: 'Other', PE: 'Private Equity', RP: 'Real Property', Unknown: 'Unclassified' };
function assetTypeLabel(t) {
  var s = String(t == null ? '' : t).trim();
  if (!s) return 'Unclassified';
  return ASSET_TYPE_LABEL[s] || ASSET_TYPE_LABEL[s.toUpperCase()] || s;
}
/* Normalize a date string to YYYY-MM-DD without timezone drift. Accepts ISO
   ("2026-06-15...") and US ("6/15/2026") forms (Senate filings use the latter). */
function toISODate(s) {
  if (!s) return '';
  s = String(s).trim();
  var iso = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(s);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  var us = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/.exec(s);
  if (us) return us[3] + '-' + ('0' + us[1]).slice(-2) + '-' + ('0' + us[2]).slice(-2);
  return s.slice(0, 10);
}
var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateText(s) {
  var iso = toISODate(s);
  var m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(iso);
  if (!m) return s ? String(s) : '—';
  var mon = MONTH_ABBR[Number(m[2]) - 1];
  return mon ? mon + ' ' + Number(m[3]) + ', ' + m[1] : String(s || '—');
}
function compactDateText(s) {
  var iso = toISODate(s);
  var m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(iso);
  if (!m) return s ? String(s) : '—';
  return Number(m[2]) + '-' + Number(m[3]) + '-' + m[1].slice(2);
}
function timeText(s) {
  var t = /(?:T|\\s)(\\d{2}):(\\d{2})/.exec(String(s || ''));
  if (!t) return '';
  var h = Number(t[1]);
  var ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + (t[2] === '00' ? '' : ':' + t[2]) + ampm;
}
function dateTimeText(s) {
  if (!s) return '—';
  var base = dateText(s);
  var time = timeText(s);
  return time ? base + ' · ' + time : base;
}
function dateCellHtml(s, title) {
  if (!s) return '<span class="muted">Unavailable</span>';
  var attr = title ? ' title="' + esc(title) + '"' : '';
  return '<span' + attr + '><span class="date-full">' + esc(dateText(s)) + '</span><span class="date-short">' + esc(compactDateText(s)) + '</span></span>';
}
function dateTimeCellHtml(s, title) {
  if (!s) return '<span class="muted">Unavailable</span>';
  var attr = title ? ' title="' + esc(title) + '"' : '';
  var t = timeText(s);
  var full = dateTimeText(s);
  var compact = compactDateText(s) + (t ? ' ' + t : '');
  return '<span' + attr + '><span class="date-full">' + esc(full) + '</span><span class="date-short">' + esc(compact) + '</span></span>';
}
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
/* A few well-known tickers get a crisp glyph instead of a fetched image so they
   look right on both dark and light themes (the Apple  glyph scales with text). */
var CUSTOM_GLYPH = { AAPL: '' };
function tickerLogoHtml(ticker, company) {
  var sym = normalizeLogoSymbol(ticker);
  if (!sym || logoDisplay === 'off') return '';
  var title = company ? ' title="' + esc(company) + '"' : '';
  if (CUSTOM_GLYPH[sym]) {
    return '<span class="tkr-logo glyph ' + logoDisplay + '"' + title + '>' + CUSTOM_GLYPH[sym] + '</span>';
  }
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
function stateCards(text) {
  return '<div class="feed-card state">' + esc(text) + '</div>';
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
/* Column registry — single source of truth for the header, body cells, sorting,
   and the column chooser. def:true columns are visible by default; lock:true
   columns can't be hidden. Each cell(r) returns the inner HTML for that td. */
function memberCellHtml(r) {
  var attr = r.filerId
    ? 'class="member-cell clickable" data-member="' + esc(r.filerId) + '"'
    : 'class="member-cell"';
  var nameClass = (r.member || '').length > 28 ? 'fit-xs' : (r.member || '').length > 22 ? 'fit-sm' : '';
  return '<div ' + attr + '>' + memberAvatarHtml(r.member, r.photoUrl) +
    '<div class="' + nameClass + '" title="' + esc(r.member) + '">' + esc(fmtName(r.member)) + (r.st ? ' <span class="muted">· ' + esc(r.st) + '</span>' : '') + '</div></div>';
}
function assetCellHtml(r) {
  // Prefer a real company name when the reported asset text is missing or is just
  // the ticker again (e.g. "FB" with no name) — uses the enriched ref company name.
  var nm = r.asset;
  if ((!nm || nm === r.ticker) && r.refCompanyName) nm = r.refCompanyName;
  var inner = '<div title="' + esc((r.ticker ? r.ticker + ' · ' : '') + (nm || '')) + '">' +
    (r.ticker ? '<span class="tkr">' + esc(r.ticker) + '</span><span class="tkr-gap"></span>' : '') +
    '<span class="muted">' + esc(nm || '') + '</span></div>';
  return r.ticker
    ? '<div class="asset-cell clickable" data-asset="' + esc(r.ticker) + '">' + tickerLogoHtml(r.ticker, nm) + inner + '</div>'
    : '<div class="asset-cell">' + inner + '</div>';
}
function feedCardHtml(r) {
  var amount = (r.min == null && r.max == null) ? '—' : amountText(r.min, r.max);
  var traded = dateText(r.txdate);
  var lag = shortLagText(r);
  var chamber = chamberLabel(r.chamber);
  var member = fmtName(r.member);
  // Member name is its own tappable chip; the rest of row 2 (and the chevron)
  // falls through to the trade drawer via handleFeedOpenEvent's delegation order.
  var memberHtml = r.filerId
    ? '<span class="fc-member clickable" data-member="' + esc(r.filerId) + '">' + esc(member) + (r.st ? ', ' + esc(r.st) : '') + '</span>'
    : esc(member) + (r.st ? ', ' + esc(r.st) : '');
  var bits = [];
  if (member) bits.push(memberHtml);
  if (chamber) bits.push(esc(chamber));
  bits.push('Traded ' + esc(traded));
  if (lag && lag !== 'Unavailable') bits.push('Lag ' + esc(lag));
  return '<article class="feed-card clickable" tabindex="0" role="button" data-txid="' + esc(r.id) + '" aria-label="Open trade details for ' + esc((r.ticker || r.asset) + ' by ' + member) + '">' +
    '<div class="fc-main">' +
      '<div class="fc-row1">' + assetCellHtml(r) +
        '<span class="fc-amt">' + actionBadge(r.type) + '<span class="fc-amt-val">' + esc(amount) + '</span></span>' +
      '</div>' +
      '<div class="fc-row2 muted">' + bits.join(' <span class="fc-sep">·</span> ') + '</div>' +
    '</div>' +
    '<span class="fc-chevron" aria-hidden="true">›</span>' +
  '</article>';
}
function lagBasisDate(r) { return (r && (r.filedDate || r.filed)) || ''; }
function lagDays(r) { return daysBetween(r.txdate, lagBasisDate(r)); }
function missingFiledReason(r) {
  if (r && r.source === 'seed_dataset') return 'Historical seed rows do not include the original official filing date yet. Run the official historical backfill to replace these with primary filing records.';
  return 'Official filing date is not available for this row.';
}
function publishedRaw(r) { return (r && (r.firstSeenAt || r.imported || r.filed || r.filedDate)) || ''; }
function publishedText(r) { var s = publishedRaw(r); return s ? dateText(s) : 'Unavailable'; }
function publishedDetailText(r) { var s = publishedRaw(r); return s ? dateTimeText(s) : 'Unavailable'; }
function filedDetailText(r) { return r && r.filed ? dateText(r.filed) : 'Official Filing Date Unavailable'; }
function shortLagText(r) { return lagDays(r) == null ? 'Unavailable' : lagDays(r) + 'd'; }
function lagDetailText(r) {
  var d = lagDays(r);
  if (d == null) return 'Unavailable until official filing date is collected';
  return d + ' day' + (d === 1 ? '' : 's');
}
function publishedCellHtml(r) {
  var s = publishedRaw(r);
  if (!s) return '<span class="muted">Unavailable</span>';
  var title = r.filed ? 'Official filing date is available in the details drawer.' : missingFiledReason(r);
  return dateCellHtml(s, title);
}
function filedCellHtml(r) {
  if (r.filed) return dateCellHtml(r.filed);
  return '<span class="muted" title="' + esc(missingFiledReason(r)) + '">Unavailable</span>';
}
function lagCellHtml(r) {
  var d = lagDays(r);
  if (d == null) return '<span class="muted" title="' + esc(missingFiledReason(r)) + '">Unavailable</span>';
  var over = d > 45 ? ' style="color:var(--sell)"' : '';
  return '<span' + over + ' title="Days from trade to official filing date (STOCK Act limit: 45)">' + d + '</span>';
}
var FEED_COLS = [
  { id: 'published', label: 'Published', sort: 'published', def: true, cls: 'muted', tip: 'When Congress.Trade first saw or imported the filing. Official filed date appears in details when available.', cell: publishedCellHtml },
  { id: 'member', label: 'Member', sort: 'member', def: true, tip: 'Member who filed the disclosure.', cell: memberCellHtml },
  { id: 'asset', label: 'Asset', sort: 'asset', def: true, tip: 'Asset name as reported; hover truncated names to see the full text.', cell: assetCellHtml },
  { id: 'type', label: 'Type', sort: 'type', def: true, tip: 'Reported transaction type.', cell: function (r) { return actionBadge(r.type); } },
  { id: 'traded', label: 'Traded', sort: 'txdate', def: true, cls: 'muted', tip: 'Date the trade was executed.', cell: function (r) { return dateCellHtml(r.txdate); } },
  { id: 'lag', label: 'Lag', sort: 'lag', def: true, tip: 'Days between the trade and the filing (STOCK Act limit: 45).', cell: lagCellHtml },
  { id: 'amount', label: 'Amount', sort: 'min', def: true, tip: 'STOCK Act bracket - an estimate, not an exact figure.', cell: function (r) { return (r.min == null && r.max == null) ? '<span class="muted">—</span>' : esc(amountText(r.min, r.max)); } },
  { id: 'sector', label: 'Sector', sort: 'refSector', def: false, cls: 'muted', tier: 'premium', tip: 'Cross-referenced sector (FMP / SEC EDGAR). Blank until the ticker is enriched.', cell: function (r) { return r.refSector ? esc(r.refSector) : '<span class="muted">—</span>'; } },
  { id: 'marketcap', label: 'Market Cap', sort: 'refMarketCap', def: false, tier: 'premium', tip: 'Market-cap size tier from enriched reference data.', cell: function (r) { return r.refMarketCapBucket ? esc(ownerLabel(r.refMarketCapBucket)) : '<span class="muted">—</span>'; } },
  { id: 'country', label: 'Country', sort: 'refCountry', def: false, cls: 'muted', tier: 'premium', tip: 'Country of issue from enriched reference data.', cell: function (r) { return r.refCountry ? esc(r.refCountry) : '<span class="muted">—</span>'; } },
  { id: 'owner', label: 'Owner', sort: 'owner', def: false, cls: 'muted', tier: 'premium', tip: 'Beneficial owner code reported on the filing.', cell: function (r) { return esc(ownerLabel(r.owner) || '—'); } },
  { id: 'filed', label: 'Official Filed', sort: 'filed', def: false, cls: 'muted', tier: 'premium', tip: 'Official disclosure/report date. Historical rows may not include it yet.', cell: filedCellHtml },
  { id: 'imported', label: 'Imported', sort: 'imported', def: false, cls: 'muted', tier: 'admin', tip: 'When Congress.Trade imported each filing.', cell: function (r) { return dateTimeCellHtml(r.imported, 'When Congress.Trade imported each filing'); } },
  { id: 'chamber', label: 'Chamber', sort: 'chamber', def: false, cls: 'muted', tip: 'House or Senate source chamber.', cell: function (r) { return esc(ownerLabel(r.chamber) || '—'); } },
  { id: 'conf', label: 'Confidence', sort: 'conf', def: false, tier: 'admin', tip: 'Parser confidence after validation penalties.', cell: function (r) { return '<span class="conf ' + confClass(r.conf) + '">~' + (r.conf * 100).toFixed(0) + '%</span>'; } },
  { id: 'source', label: 'Source', sort: 'source', def: false, tier: 'admin', tip: 'Row provenance: primary official pipeline or historical seed import.', cell: function (r) { return '<span class="muted" title="' + esc(sourceTitle(r.source)) + '">' + esc(sourceLabel(r.source)) + '</span>'; } },
  { id: 'latency', label: 'Latency', sort: null, def: false, cls: 'latency', tier: 'admin', tip: 'Released to seen, then seen to imported for primary rows.', cell: function (r) { return rowLatencyHtml(r); } }
];
var COL_HIDDEN_KEY = 'feed-cols-hidden-v2';
function isAdminView() {
  return /^admin\\./i.test(location.hostname) || !!getAdminToken();
}
function canUseColumn(c) {
  if (c.tier === 'admin') return isAdminView();
  if (c.tier === 'premium') return isAdminView() || (typeof ME !== 'undefined' && isPremium());
  return true;
}
function availableCols() { return FEED_COLS.filter(canUseColumn); }
function defaultHidden() { return availableCols().filter(function (c) { return !c.def; }).map(function (c) { return c.id; }); }
function loadHiddenCols() { try { var v = JSON.parse(localStorage.getItem(COL_HIDDEN_KEY)); return v && v.length !== undefined ? v : defaultHidden(); } catch (e) { return defaultHidden(); } }
function saveHiddenCols(h) { try { localStorage.setItem(COL_HIDDEN_KEY, JSON.stringify(h)); } catch (e) {} }
var hiddenCols = loadHiddenCols();
function isColVisible(id) { return hiddenCols.indexOf(id) < 0; }
function visibleCols() { return availableCols().filter(function (c) { return isColVisible(c.id); }); }

/* Render the header from the registry, (re)attach sort handlers, and reset the
   resize state so widths re-freeze for the now-visible columns. */
function renderFeedHeader() {
  var head = el('feedHead'); if (!head) return;
  head.innerHTML = visibleCols().map(function (c) {
    var cls = (c.sort ? 'sortable ' : '') + 'c-' + c.id;
    var ds = c.sort ? ' data-sort="' + c.sort + '"' : '';
    var tip = c.tip ? ' title="' + esc(c.tip) + '"' : '';
    return '<th class="' + cls + '" data-col="' + c.id + '"' + ds + tip + '>' + esc(c.label) + (c.sort ? '<span class="arr"></span>' : '') + '</th>';
  }).join('');
  var ths = head.querySelectorAll('th.sortable');
  for (var i = 0; i < ths.length; i++) { (function (th) { th.onclick = function () { setSort(th.dataset.sort); }; })(ths[i]); }
  // Re-init the resizable columns for the new header.
  var table = el('feedTable'); if (table) table.classList.remove('resizable');
  colResizeInit = false;
  updateSortIndicators();
}

/* Column chooser (the ⚙ Columns panel). */
function panelIds() { return ['searchPanel', 'colChooser']; }
function anyPanelOpen() {
  return panelIds().some(function (id) { var p = el(id); return !!(p && p.classList.contains('open')); });
}
function syncPanelBackdrop() {
  var b = el('panelBackdrop');
  if (b) b.classList.toggle('open', anyPanelOpen());
}
function closePanels() {
  panelIds().forEach(function (id) { var p = el(id); if (p) p.classList.remove('open'); });
  var st = el('searchToggle'); if (st) st.classList.remove('on');
  syncPanelBackdrop();
}
function setPanelOpen(id, open) {
  panelIds().forEach(function (pid) {
    var p = el(pid); if (p) p.classList.toggle('open', pid === id && open);
  });
  var st = el('searchToggle'); if (st) st.classList.toggle('on', id === 'searchPanel' && open);
  if (id === 'colChooser' && open) renderColChooser();
  syncPanelBackdrop();
}
function renderColChooser() {
  var box = el('colChooserBody'); if (!box) return;
  box.innerHTML = availableCols().filter(function (c) { return !c.lock; }).map(function (c) {
    var tip = c.tip ? ' title="' + esc(c.tip) + '"' : '';
    return '<label class="colopt"' + tip + '><input type="checkbox" data-colid="' + c.id + '"' + (isColVisible(c.id) ? ' checked' : '') + ' /> ' + esc(c.label) + '</label>';
  }).join('');
}
function toggleColChooser() {
  var p = el('colChooser');
  setPanelOpen('colChooser', !(p && p.classList.contains('open')));
}
function onColToggle(id, visible) {
  var i = hiddenCols.indexOf(id);
  if (visible && i >= 0) hiddenCols.splice(i, 1);
  else if (!visible && i < 0) hiddenCols.push(id);
  saveHiddenCols(hiddenCols);
  renderFeedHeader(); renderFeed();
}
function resetCols() { hiddenCols = defaultHidden(); saveHiddenCols(hiddenCols); renderColChooser(); renderFeedHeader(); renderFeed(); }

function renderFeed() {
  var m = el('qMember').value.toLowerCase(), t = el('qTicker').value.toUpperCase(),
      ty = el('qType').value, ch = el('qChamber').value;
  // Fold-out advanced search (panel may be collapsed; inputs still honored).
  var qa = (el('qAll').value || '').toLowerCase().trim();
  var minAmt = parseFloat(el('qMinAmt').value);
  var body = el('feedBody');
  var cards = el('feedCards');
  var cols = visibleCols();
  if (!cols.length) {
    body.innerHTML = stateRow(1, 'No columns are visible. Open Columns and enable at least one column.');
    if (cards) cards.innerHTML = stateCards('No columns are visible. Open Columns and enable at least one column.');
    updateFeedCountMsg(0); return;
  }
  if (!realDataLoaded) {
    body.innerHTML = stateRow(cols.length, 'Loading live feed…');
    if (cards) cards.innerHTML = stateCards('Loading live feed…');
    return;
  }
  var rows = TRADES.filter(function (r) {
    if (qa) {
      var hay = ((r.member || '') + ' ' + (r.asset || '') + ' ' + (r.ticker || '') + ' ' +
                 (r.source || '') + ' ' + (r.owner || '') + ' ' + (r.st || '')).toLowerCase();
      if (hay.indexOf(qa) < 0) return false;
    }
    if (!isNaN(minAmt) && !((r.min != null ? r.min : 0) >= minAmt)) return false;
    return (!m || (r.member || '').toLowerCase().indexOf(m) >= 0) &&
           (!t || (r.ticker || '').indexOf(t) >= 0) &&
           (!ty || r.type === ty) &&
           (!ch || r.chamber === ch);
  });
  rows = sortRows(rows);
  if (rows.length === 0) {
    body.innerHTML = stateRow(cols.length, 'No transactions match these filters.');
    if (cards) cards.innerHTML = stateCards('No transactions match these filters.');
    updateFeedCountMsg(0); maybeInitResize(); return;
  }
  body.innerHTML = rows.map(function (r) {
    var tds = cols.map(function (c) {
      return '<td class="c-' + c.id + (c.cls ? ' ' + c.cls : '') + '">' + c.cell(r) + '</td>';
    }).join('');
    return '<tr class="row clickable" data-txid="' + esc(r.id) + '" title="Open trade details">' + tds + '</tr>';
  }).join('');
  if (cards) cards.innerHTML = rows.map(feedCardHtml).join('');
  updateFeedCountMsg(rows.length);
  maybeInitResize();
}

/* "Showing X-Y of N" + previous/next controls for the bounded table page. */
function updateFeedCountMsg(shown) {
  var msg = el('feedCountMsg');
  var pageMsg = el('feedPageMsg');
  var prev = el('prevPageBtn');
  var next = el('nextPageBtn');
  if (!realDataLoaded) {
    if (msg) msg.textContent = '';
    if (pageMsg) pageMsg.textContent = '';
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    return;
  }
  var total = totalRows || shown;
  var start = total === 0 ? 0 : feedPage * feedPageSize + 1;
  var end = Math.min(feedPage * feedPageSize + shown, total);
  if (msg) msg.textContent = 'Showing ' + start + '-' + end + ' of ' + total + ' trades';
  if (pageMsg) pageMsg.textContent = 'Page ' + (feedPage + 1) + ' of ' + Math.max(1, Math.ceil(total / feedPageSize));
  if (prev) prev.disabled = feedPage <= 0 || loadingPage;
  if (next) next.disabled = end >= total || loadingPage;
}

/* ---- resizable feed columns (drag the right edge of a header) ---- */
var COL_WIDTH_KEY = 'feed-col-widths-v4';
var colResizeInit = false;
function loadColWidths() { try { return JSON.parse(localStorage.getItem(COL_WIDTH_KEY) || '{}') || {}; } catch (e) { return {}; } }
function saveColWidths(w) { try { localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(w)); } catch (e) {} }
function maybeInitResize() { if (!colResizeInit && realDataLoaded) { colResizeInit = true; initColumnResize(); } }
function clampNum(n, min, max) { return Math.max(min, Math.min(max, n)); }
function estimatedColWidth(key, fallback, min, max) {
  var selector = key === 'asset'
    ? '#feedBody .c-asset .asset-cell > div'
    : key === 'member'
      ? '#feedBody .c-member .member-cell > div'
      : '';
  if (!selector) return fallback;
  var nodes = Array.prototype.slice.call(document.querySelectorAll(selector), 0, 80);
  var lens = nodes.map(function (n) { return (n.textContent || '').trim().length; }).filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; });
  if (!lens.length) return fallback;
  var med = lens[Math.floor(lens.length / 2)];
  var px = key === 'asset' ? 42 + Math.ceil(med * 6.4) : 54 + Math.ceil(med * 7.4);
  return clampNum(px, min, max);
}
function minColWidth(key) {
  return key === 'asset' ? 64 : key === 'member' ? 92 : 54;
}
function applyColumnWidthClasses() {
  var table = el('feedTable'); if (!table) return;
  var keys = ['published', 'traded', 'filed', 'imported'];
  for (var i = 0; i < keys.length; i++) {
    table.classList.remove('narrow-' + keys[i], 'tiny-' + keys[i]);
  }
  var ths = document.querySelectorAll('#feedHead th');
  for (var j = 0; j < ths.length; j++) {
    var key = ths[j].dataset.col, w = ths[j].offsetWidth;
    if (keys.indexOf(key) < 0) continue;
    if (w < 132) table.classList.add('narrow-' + key);
    if (w < 92) table.classList.add('tiny-' + key);
  }
}
function initColumnResize() {
  var table = el('feedTable'); if (!table) return;
  var ths = document.querySelectorAll('#feedHead th');
  var saved = loadColWidths();
  // Freeze current auto widths (or restore saved ones) so switching the table to
  // fixed layout doesn't visually jump. Wide auto-sized columns are capped to a
  // compact default (Asset fits the longest name otherwise) — short entries then
  // show in full, long ones clip to an ellipsis, and any column stays draggable.
  var DEFAULT_CAP = {
    asset: 180,
    member: estimatedColWidth('member', 220, 160, 286)
  };
  for (var i = 0; i < ths.length; i++) {
    var k = ths[i].dataset.col;
    var w = (k && saved[k]) ? saved[k] : ths[i].offsetWidth;
    if (!(k && saved[k]) && k && DEFAULT_CAP[k] && w > DEFAULT_CAP[k]) w = DEFAULT_CAP[k];
    ths[i].style.width = w + 'px';
  }
  table.classList.add('resizable');
  for (var j = 0; j < ths.length; j++) addColResizer(ths[j]);
  applyColumnWidthClasses();
}
function addColResizer(th) {
  var grip = document.createElement('span');
  grip.className = 'col-resizer';
  grip.addEventListener('click', function (e) { e.stopPropagation(); }); // don't sort
  grip.addEventListener('mousedown', function (e) {
    e.preventDefault(); e.stopPropagation();
    var startX = e.pageX, startW = th.offsetWidth;
    function move(ev) {
      th.style.width = Math.max(minColWidth(th.dataset.col), startW + (ev.pageX - startX)) + 'px';
      applyColumnWidthClasses();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      var w = loadColWidths(); w[th.dataset.col] = th.offsetWidth; saveColWidths(w);
      applyColumnWidthClasses();
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
  if (key === 'published') return publishedRaw(r);
  if (key === 'lag') { var d = lagDays(r); return d == null ? -Infinity : d; }
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
  else { sortKey = key; sortDir = (key === 'published' || key === 'filed' || key === 'txdate' || key === 'imported' || key === 'lag' || NUMERIC_SORT[key]) ? -1 : 1; }
  updateSortIndicators();
  renderFeed();
}
function updateSortIndicators() {
  var ths = document.querySelectorAll('#feedHead th.sortable');
  for (var i = 0; i < ths.length; i++) {
    var th = ths[i], arr = th.querySelector('.arr');
    if (th.dataset.sort === sortKey) { th.classList.add('active'); arr.textContent = sortDir > 0 ? '▲' : '▼'; }
    else { th.classList.remove('active'); arr.textContent = '↕'; }
  }
}

/* ---- fold-out search ---- */
function toggleSearch() {
  var p = el('searchPanel');
  var open = !(p && p.classList.contains('open'));
  setPanelOpen('searchPanel', open);
  if (open) setTimeout(function () { el('qAll').focus(); }, 0);
}
function clearSearch() {
  el('qAll').value = ''; el('qMinAmt').value = '';
  renderFeed();
}

/* Friendly, human-readable label for a transaction's provenance. The raw value
   ('seed_dataset' | 'primary') rides along as a tooltip via sourceTitle. */
var sourceLabelMap = { seed_dataset: 'Historical', primary: 'Primary' };
function sourceLabel(src) { return sourceLabelMap[src] || (src || ''); }
function sourceTitle(src) {
  if (src === 'primary') return 'Parsed from an official filing by the Congress.Trade ingestion pipeline.';
  if (src === 'seed_dataset') return 'Imported from a historical seed dataset.';
  return src || 'Unknown source';
}

/* Map an API transaction (shared/types Transaction) to a feed row. Member name
   prefers filers.full_name (memberName from the API); falls back to the raw
   filer id when the name is missing. */
function txToRow(tx) {
  return {
    // "Filed" = the official disclosure/report date. Historic seed rows often
    // do not carry it; keep that missing state visible instead of using import
    // time as a stand-in.
    filed: toISODate(tx.filedDate) || '',
    member: tx.fullName || tx.memberName || tx.filerId || 'Unknown',
    photoUrl: tx.photoUrl || '',
    st: tx.state || '',
    chamber: tx.chamber || '',
    asset: cleanAsset(tx.assetName || ''),
    ticker: tx.ticker || '',
    type: tx.txType || 'P',
    min: tx.amountMin, max: tx.amountMax,
    txdate: toISODate(tx.txDate) || '',
    owner: tx.owner || '',
    conf: typeof tx.confidence === 'number' ? tx.confidence : 1,
    source: tx.source || 'primary',
    filedDate: tx.filedDate || '',
    firstSeenAt: tx.firstSeenAt || '',
    imported: tx.createdAt || '',
    cursorSeq: tx.cursorSeq || 0,
    // identifiers for the detail drawers (trade / asset / politician)
    id: tx.id || '',
    docId: tx.docId || '',
    filerId: tx.filerId || '',
    isOption: !!tx.isOption,
    rawText: tx.rawText || '',
    // cross-referenced asset reference data (null until the ticker is enriched)
    refSector: tx.refSector || '',
    refMarketCap: tx.refMarketCap != null ? tx.refMarketCap : null,
    refMarketCapBucket: tx.refMarketCapBucket || '',
    refCountry: tx.refCountry || '',
    refExchangeShort: tx.refExchangeShort || '',
    refAssetClass: tx.refAssetClass || '',
    refCompanyName: tx.refCompanyName || ''
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

function currentPageSize() {
  var n = Number(feedPageSize);
  return [25, 50, 100, 250].indexOf(n) >= 0 ? n : 50;
}
function syncPageSizeControl() {
  feedPageSize = currentPageSize();
  var s = el('pageSize'); if (s) s.value = String(feedPageSize);
}
function feedQueryParams() {
  var p = new URLSearchParams();
  p.set('since', '0');
  p.set('sort', 'published');
  p.set('order', 'desc');
  p.set('limit', String(feedPageSize));
  p.set('offset', String(feedPage * feedPageSize));
  var t = el('qTicker').value.trim(); if (t) p.set('ticker', t);
  var m = el('qMember').value.trim(); if (m) p.set('memberName', m);
  var ty = el('qType').value; if (ty) p.set('type', ty);
  var ch = el('qChamber').value; if (ch) p.set('chamber', ch);
  return p;
}
function setFeedKpis() {
  el('kpiTotal').textContent = totalRows || TRADES.length;
  el('kpiToday').textContent = filingsImportedToday;
  var primary = TRADES.filter(function (r) { return r.source === 'primary'; }).length;
  el('kpiAuto').innerHTML = (TRADES.length ? Math.round(100 * primary / TRADES.length) : 0) + '<small>%</small>';
}
/* Fetch one bounded newest-first feed page. */
function fetchPage() {
  if (loadingPage && feedAbort) feedAbort.abort();
  loadingPage = true;
  var seq = ++feedRequestSeq;
  feedAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
  updateFeedCountMsg(TRADES.length);
  // API HOOK: GET /api/transactions?order=desc&limit=<pageSize>&offset=<pageOffset>
  return fetch('/api/transactions?' + feedQueryParams().toString(), feedAbort ? { signal: feedAbort.signal } : undefined)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      if (seq !== feedRequestSeq) return 0;
      var txs = (data.transactions || []).map(txToRow);
      TRADES = txs;
      if (typeof data.cursor === 'number' && data.cursor > cursor) cursor = data.cursor;
      if (typeof data.total === 'number') totalRows = data.total;
      if (typeof data.filingsImportedToday === 'number') filingsImportedToday = data.filingsImportedToday;
      feedGated = !!data.gated;             // freemium: limited recent window
      updateGateRow();
      realDataLoaded = true;
      setBanner('');                       // drop the illustrative banner
      setFeedKpis();
      renderFeed();
      return txs.length;
    })
    .catch(function (e) {
      if (e && e.name === 'AbortError') return 0;
      if (!realDataLoaded) setBanner('Could not load the live feed: ' + e.message, true);
      return 0;
    })
    .then(function (n) {
      if (seq === feedRequestSeq) {
        loadingPage = false;
        feedAbort = null;
        updateFeedCountMsg(TRADES.length);
      }
      return n;
    });
}

/* Initial / full reload: fetches the first page from the current cursor. */
function loadFeed() { syncPageSizeControl(); return fetchPage(); }

function setPageSize(value) {
  var n = Number(value);
  feedPageSize = [25, 50, 100, 250].indexOf(n) >= 0 ? n : 50;
  try { localStorage.setItem('feed-page-size', String(feedPageSize)); } catch (e) {}
  feedPage = 0;
  return fetchPage();
}

function handleFeedTextFilter() {
  feedPage = 0;
  renderFeed();
  if (feedSearchTimer) clearTimeout(feedSearchTimer);
  feedSearchTimer = setTimeout(function () { fetchPage(); }, 250);
}

function resetFeedPage() { feedPage = 0; return fetchPage(); }
function prevFeedPage() { if (feedPage <= 0) return; feedPage -= 1; fetchPage(); }
function nextFeedPage() {
  if ((feedPage + 1) * feedPageSize >= totalRows) return;
  feedPage += 1;
  fetchPage();
}

/* Incremental poll path: fetch only rows newer than the latest cursor and fold
   them into page 1 without changing the user's current page. */
function fetchUpdates() {
  if (loadingPage || feedPage !== 0) return Promise.resolve(0);
  return fetch('/api/transactions?since=' + cursor + '&limit=' + feedPageSize)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      var txs = (data.transactions || []).map(txToRow);
      if (!txs.length) return 0;
      txs.reverse();
      var today = new Date().toISOString().slice(0, 10);
      var seenDocs = {};
      TRADES.forEach(function (r) { if (r.docId) seenDocs[r.docId] = true; });
      txs.forEach(function (r) {
        if ((r.imported || '').slice(0, 10) === today && r.docId && !seenDocs[r.docId]) {
          filingsImportedToday += 1;
          seenDocs[r.docId] = true;
        }
      });
      TRADES = txs.concat(TRADES).slice(0, feedPageSize);
      if (typeof data.cursor === 'number' && data.cursor > cursor) cursor = data.cursor;
      if (totalRows) totalRows += txs.length;
      setFeedKpis();
      renderFeed();
      return txs.length;
    })
    .catch(function () { return 0; });
}

/* Live updates. We try SSE first, but the public dashboard does NOT hard-depend
   on it: the /api/stream?subscription=dashboard endpoint isn't available on the
   public site (webhooks/SSE are a future paid feature). If the EventSource
   errors or closes we tear it down (no infinite "reconnecting…") and fall back
   to a calm 30s poll of /api/transactions using the cursor. */
function setLivePill(cls, text) { var p = el('livePill'); p.className = 'pill ' + cls; p.textContent = text || 'Status'; }

/* Periodic polling fallback. API HOOK: GET /api/transactions?since=<cursor>. */
function startPolling() {
  if (pollTimer) return;          // already polling
  setLivePill('live', 'Status');  // calm state
  pollTimer = setInterval(function () {
    fetchUpdates().then(function (n) {
      if (n > 0) {
        setLivePill('live', 'Updated');
        setTimeout(function () { if (pollTimer) setLivePill('live', 'Status'); }, 1800);
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
    es.onopen = function () { setLivePill('live', 'Status'); };
    es.addEventListener('trade.new', function (e) {
      try {
        var tx = JSON.parse(e.data);
        if (!tx || !tx.id) return;
        if (feedPage !== 0) return;
        var row = txToRow(tx);
        var today = new Date().toISOString().slice(0, 10);
        var alreadyDoc = TRADES.some(function (r) { return r.docId && r.docId === row.docId; });
        if ((row.imported || '').slice(0, 10) === today && row.docId && !alreadyDoc) filingsImportedToday += 1;
        TRADES.unshift(row);
        TRADES = TRADES.slice(0, feedPageSize);
        if (tx.cursorSeq && tx.cursorSeq > cursor) cursor = tx.cursorSeq;
        if (totalRows) totalRows += 1;
        setFeedKpis();
        renderFeed();
        setLivePill('live', 'Updated');
        setTimeout(function () { if (es && es.readyState === 1) setLivePill('live', 'Status'); }, 1800);
      } catch (err) { /* ignore malformed frame */ }
    });
    es.addEventListener('reconnect', function (e) {
      try {
        var msg = JSON.parse(e.data || '{}');
        if (typeof msg.since === 'number' && msg.since > cursor) cursor = msg.since;
      } catch (err) { /* ignore malformed frame */ }
      stopStream();
      startPolling();
    });
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
var REVIEW_RESOLVED = 0; // 0 = pending tab, 1 = reviewed/history tab
function setReviewTab(resolved) {
  REVIEW_RESOLVED = resolved ? 1 : 0;
  var p = el('revTabPending'), rv = el('revTabReviewed');
  if (p) p.className = 'btn sm' + (REVIEW_RESOLVED ? ' ghost' : '');
  if (rv) rv.className = 'btn sm' + (REVIEW_RESOLVED ? '' : ' ghost');
  loadReview();
}
function loadReview() {
  // API HOOK: GET /api/admin/review-queue?resolved=
  return fetch('/api/admin/review-queue?resolved=' + REVIEW_RESOLVED, { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) { REVIEW = data.items || []; renderReview(); })
    .catch(function (e) {
      el('reviewBody').innerHTML = stateRow(6, isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load review queue: ' + e.message));
    });
}
/* Translate review reason codes + payload into plain English for non-engineers. */
var REASON_LABELS = {
  low_confidence: 'Automated read below publish threshold',
  no_transactions_extracted: 'No transactions could be read from the document',
  unresolved_ticker: 'Ticker symbol could not be matched to a known company',
  invalid_bracket: 'Dollar amount didn’t match a standard disclosure range',
  no_amount: 'No dollar amount could be read',
  invalid_amount: 'Dollar amount looked malformed (couldn’t be read as a range)',
  future_tx_date: 'Trade date is after the filing date',
  bad_tx_type: 'Transaction type was unclear (not buy / sell / exchange)'
};
function parseReviewPayload(payload) {
  if (payload == null) return null;
  try {
    var p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return p && typeof p === 'object' ? p : null;
  } catch (e) {
    return null;
  }
}
function reasonText(reason, payload) {
  if (!reason) return 'Needs a human check';
  var codes = String(reason).split(',').map(function (c) { return c.trim(); }).filter(Boolean);
  var p = parseReviewPayload(payload);
  var extractor = p && p.extractor ? String(p.extractor) : '';
  if (codes.length === 1 && codes[0] === 'low_confidence' && /vision/i.test(extractor)) {
    return 'Vision-read filing held for review';
  }
  return codes.map(function (c) {
    c = c.trim(); return REASON_LABELS[c] || c.replace(/_/g, ' ');
  }).filter(Boolean).join('; ');
}
function payloadText(payload) {
  var p = parseReviewPayload(payload);
  if (p == null) return payload == null ? '' : String(payload);
  if (typeof p !== 'object') return String(payload);
  var bits = [];
  var txs = p.transactions || [];
  if (!txs.length) {
    bits.push('No readable transactions');
  } else if (typeof p.minConfidence === 'number') {
    bits.push('Confidence ' + Math.round(p.minConfidence * 100) + '%');
  }
  if (txs.length) {
    bits.push(txs.length + ' transaction' + (txs.length === 1 ? '' : 's'));
    var t0 = txs[0] || {};
    var label = cleanAsset(t0.ticker || t0.assetName || '');
    if (label) bits.push('e.g. ' + label + (typeName[t0.txType] ? ' (' + typeName[t0.txType] + ')' : ''));
  }
  return bits.join(' · ');
}
function safeDocUrl(url) {
  if (!url) return '';
  try {
    var u = new URL(String(url), window.location.origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch (e) {
    return '';
  }
}
function reviewDocHtml(r) {
  var docId = r.docId || '';
  var url = safeDocUrl(r.sourceUrl);
  var idHtml = '<span class="tkr">' + esc(docId) + '</span>';
  if (!url) return idHtml;
  return '<a class="tkr" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" title="Open source filing">' + esc(docId) + '</a>' +
    '<a class="review-doc-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">View Document</a>';
}
/* Coloured status pill for a review document. */
var STATUS_COLORS = { pending: '#b08900', published: '#1a7f37', rejected: '#c0362c', modified: '#6f42c1', resolved: '#57606a' };
function statusBadge(status) {
  var s = status || 'pending';
  var c = STATUS_COLORS[s] || '#57606a';
  return '<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:' + c + '">' + esc(s) + '</span>';
}
/* One-line per-model confidence chips for the row (full readings load on demand). */
function modelsSummaryHtml(models) {
  if (!models || !models.length) return '<span class="muted">—</span>';
  return models.map(function (m) {
    var conf = (typeof m.avgConfidence === 'number') ? Math.round(m.avgConfidence * 100) + '%' : '—';
    var label = m.provider + ':' + m.model;
    var color = m.ok ? '#1a7f37' : '#c0362c';
    var title = label + ' · ' + (m.ok ? (m.rowCount + ' rows, conf ' + conf + (m.latencyMs ? ', ' + m.latencyMs + 'ms' : '')) : ('ERROR: ' + (m.error || 'failed')));
    return '<span title="' + esc(title) + '" style="display:inline-block;margin:1px 3px 1px 0;padding:0 5px;border-radius:8px;font-size:11px;border:1px solid ' + color + ';color:' + color + '">' +
      esc(m.provider) + ' ' + (m.ok ? esc(conf) : 'ERR') + '</span>';
  }).join('');
}
function renderReview() {
  var body = el('reviewBody');
  el('reviewCount').textContent = REVIEW.length ? '(' + REVIEW.length + ')' : '';
  if (el('kpiReview') && REVIEW_RESOLVED === 0) el('kpiReview').textContent = REVIEW.length;
  if (REVIEW.length === 0) {
    body.innerHTML = stateRow(6, REVIEW_RESOLVED ? 'No reviewed documents yet.' : 'Nothing awaiting review — queue is clear.');
    return;
  }
  body.innerHTML = REVIEW.map(function (r) {
    var payload = payloadText(r.payload);
    var url = safeDocUrl(r.sourceUrl);
    var docAction = url ? '<a class="review-doc-link inline" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Document</a>' : '';
    var nModels = (r.models && r.models.length) || 0;
    var modelsBtn = '<button class="btn ghost sm" onclick="toggleModels(\\'' + esc(r.docId) + '\\')">Models (' + nModels + ')</button>';
    var actions = REVIEW_RESOLVED
      ? (r.status === 'published' || r.status === 'modified'
          ? '<button class="btn ghost sm" onclick="resolveReview(\\'' + esc(r.docId) + '\\',\\'unpublish\\')">Unpublish</button> ' : '') + modelsBtn
      : '<button class="btn sm" onclick="resolveReview(\\'' + esc(r.docId) + '\\',\\'confirm\\')">Confirm</button> ' +
        '<button class="btn ghost sm" onclick="manualEntry(\\'' + esc(r.docId) + '\\')">Manual</button> ' +
        '<button class="btn ghost sm" onclick="resolveReview(\\'' + esc(r.docId) + '\\',\\'reject\\')">Reject</button> ' + modelsBtn;
    return '<tr class="row" id="rv-' + esc(r.docId) + '">' +
      '<td class="muted">' + esc(dateTimeText(r.createdAt)) + '</td>' +
      '<td>' + reviewDocHtml(r) + '</td>' +
      '<td>' + statusBadge(r.status) + '</td>' +
      '<td class="muted">' + esc(reasonText(r.reason, r.payload)) + '<div style="margin-top:3px">' + modelsSummaryHtml(r.models) + '</div></td>' +
      '<td class="muted" style="max-width:320px">' + esc(payload) + docAction + '</td>' +
      '<td>' + actions + '</td>' +
    '</tr>';
  }).join('');
}
/* Expand/collapse a per-document model-comparison panel beneath its row. */
function toggleModels(docId) {
  var existing = el('mdl-' + docId);
  if (existing) { existing.parentNode.removeChild(existing); return; }
  var rowEl = el('rv-' + docId);
  if (!rowEl) return;
  var item = null;
  for (var i = 0; i < REVIEW.length; i++) { if (REVIEW[i].docId === docId) { item = REVIEW[i]; break; } }
  var models = (item && item.models) || [];
  var head = '<tr id="mdl-' + esc(docId) + '"><td colspan="6" style="background:rgba(127,127,127,.06)">' +
    '<div style="padding:6px 4px"><strong>Per-model readings</strong> ' +
    '<button class="btn ghost sm" onclick="viewReadings(\\'' + esc(docId) + '\\')">Load full readings</button>' +
    '<div id="mdlBody-' + esc(docId) + '" style="margin-top:6px">' + modelsTableHtml(models) + '</div></div>' +
    '</td></tr>';
  rowEl.insertAdjacentHTML('afterend', head);
}
function modelsTableHtml(models) {
  if (!models || !models.length) return '<span class="muted">No model runs stored for this document yet. Run a bake-off (POST /api/admin/bakeoff) to populate.</span>';
  var rows = models.map(function (m) {
    var conf = (typeof m.avgConfidence === 'number') ? Math.round(m.avgConfidence * 100) + '%' : '—';
    return '<tr><td>' + esc(m.provider + ':' + m.model) + '</td><td>' + esc(m.kind || '') + '</td>' +
      '<td>' + (m.ok ? 'ok' : '<span style="color:#c0362c">ERR</span>') + '</td>' +
      '<td style="text-align:right">' + (m.ok ? m.rowCount : '—') + '</td>' +
      '<td style="text-align:right">' + (m.ok ? esc(conf) : '—') + '</td>' +
      '<td style="text-align:right">' + (m.latencyMs != null ? m.latencyMs + 'ms' : '—') + '</td>' +
      (m.error ? '<td class="muted">' + esc(String(m.error).slice(0, 80)) + '</td>' : '<td></td>') + '</tr>';
  }).join('');
  return '<table style="font-size:12px;width:100%"><thead><tr><th>Model</th><th>Kind</th><th>OK</th><th style="text-align:right">Rows</th><th style="text-align:right">Conf</th><th style="text-align:right">Latency</th><th>Error</th></tr></thead><tbody>' + rows + '</tbody></table>';
}
/* Fetch + render the full stored readings (extracted rows) for each model. */
function viewReadings(docId) {
  var target = el('mdlBody-' + docId);
  if (target) target.innerHTML = '<span class="muted">Loading readings…</span>';
  fetch('/api/admin/review/' + encodeURIComponent(docId) + '/extractions', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      var runs = data.runs || [];
      if (!runs.length) { if (target) target.innerHTML = '<span class="muted">No stored readings.</span>'; return; }
      if (target) target.innerHTML = runs.map(function (run) {
        var conf = (typeof run.avgConfidence === 'number') ? Math.round(run.avgConfidence * 100) + '%' : '—';
        var header = '<div style="margin:8px 0 2px"><strong>' + esc(run.provider + ':' + run.model) + '</strong> ' +
          '<span class="muted">· ' + (run.ok ? (run.rowCount + ' rows · conf ' + conf + (run.latencyMs ? ' · ' + run.latencyMs + 'ms' : '')) : ('ERROR: ' + esc(String(run.error || 'failed')))) + '</span></div>';
        var rowsHtml = (run.rows && run.rows.length)
          ? '<table style="font-size:12px;width:100%"><thead><tr><th>Ticker</th><th>Asset</th><th>Type</th><th>Date</th><th style="text-align:right">Amt min</th><th style="text-align:right">Amt max</th></tr></thead><tbody>' +
            run.rows.map(function (t) {
              return '<tr><td>' + esc(t.ticker || '—') + '</td><td>' + esc(String(t.assetName || '').slice(0, 50)) + '</td><td>' + esc(t.txType || '') + '</td><td>' + esc(t.txDate || '') + '</td>' +
                '<td style="text-align:right">' + esc(t.amountMin == null ? '—' : t.amountMin) + '</td><td style="text-align:right">' + esc(t.amountMax == null ? '—' : t.amountMax) + '</td></tr>';
            }).join('') + '</tbody></table>'
          : '<span class="muted">No rows.</span>';
        return header + rowsHtml;
      }).join('');
    })
    .catch(function (e) { if (target) target.innerHTML = '<span class="muted">' + (isAuthError(e) ? 'Admin auth required' : ('Could not load readings: ' + esc(e.message))) + '</span>'; });
}
function resolveReview(docId, decision) {
  // API HOOK: POST /api/admin/review/:docId {decision}  (unpublish uses /review/:docId/unpublish)
  var rowEl = el('rv-' + docId);
  if (rowEl) rowEl.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
  var isUnpublish = decision === 'unpublish';
  var url = '/api/admin/review/' + encodeURIComponent(docId) + (isUnpublish ? '/unpublish' : '');
  fetch(url, {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: isUnpublish ? JSON.stringify({ reason: 'admin unpublish from dashboard' }) : JSON.stringify({ decision: decision, edits: [] })
  })
    .then(okOrThrow)
    .then(function () {
      if (isUnpublish) { loadReview(); } // item returns to pending; reload current tab
      else { REVIEW = REVIEW.filter(function (x) { return x.docId !== docId; }); renderReview(); }
      loadFeed();
    })
    .catch(function (e) {
      if (rowEl) rowEl.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      alert(isAuthError(e) ? ADMIN_MOVED_MSG : ('Review action failed: ' + e.message));
    });
}
/* Manual entry: hand-key the rows when the automated read is wrong / too low to
   trust. Submitted with decision:'manual' so they are recorded as source=manual. */
function meRowHtml() {
  return '<div class="me-row" style="margin:4px 0;display:flex;flex-wrap:wrap;gap:4px;align-items:center">' +
    '<input class="me-ticker" placeholder="Ticker" maxlength="12" style="width:80px" /> ' +
    '<select class="me-type"><option value="P">Purchase</option><option value="S">Sale</option><option value="E">Exchange</option></select> ' +
    '<input class="me-min" type="number" placeholder="Amt min" style="width:90px" /> ' +
    '<input class="me-max" type="number" placeholder="Amt max" style="width:90px" /> ' +
    '<input class="me-date" type="date" /> ' +
    '<select class="me-owner"><option value="self">self</option><option value="spouse">spouse</option><option value="joint">joint</option><option value="dependent">dependent</option></select> ' +
    '<input class="me-asset" placeholder="Asset name (optional)" style="width:160px" />' +
    '</div>';
}
function meAddRow(docId) { var c = el('me-rows-' + docId); if (c) c.insertAdjacentHTML('beforeend', meRowHtml()); }
function meCancel(docId) { var tr = el('me-' + docId); if (tr) tr.parentNode.removeChild(tr); }
function manualEntry(docId) {
  if (el('me-' + docId)) return; // already open
  var row = el('rv-' + docId);
  if (!row) return;
  var tr = document.createElement('tr');
  tr.id = 'me-' + docId;
  tr.innerHTML = '<td colspan="5" class="manual-entry" style="background:#f8fafc;padding:8px 12px">' +
    '<div class="me-rows" id="me-rows-' + esc(docId) + '"></div>' +
    '<button class="btn ghost sm" onclick="meAddRow(\\'' + esc(docId) + '\\')">+ Add row</button> ' +
    '<button class="btn sm" onclick="meSubmit(\\'' + esc(docId) + '\\')">Submit manual entry</button> ' +
    '<button class="btn ghost sm" onclick="meCancel(\\'' + esc(docId) + '\\')">Cancel</button>' +
    '<p class="note">Recorded as <code>source=manual</code> (hand-entered by an admin) and promoted to the live feed.</p>' +
    '</td>';
  row.parentNode.insertBefore(tr, row.nextSibling);
  meAddRow(docId);
}
function meSubmit(docId) {
  var c = el('me-rows-' + docId);
  if (!c) return;
  var edits = [];
  c.querySelectorAll('.me-row').forEach(function (g) {
    var t = (g.querySelector('.me-ticker').value || '').trim().toUpperCase();
    var asset = (g.querySelector('.me-asset').value || '').trim();
    if (!t && !asset) return; // skip blank rows
    var min = g.querySelector('.me-min').value, max = g.querySelector('.me-max').value;
    edits.push({
      ticker: t || null,
      assetName: asset || t || '(manual entry)',
      txType: g.querySelector('.me-type').value,
      amountMin: min === '' ? null : Number(min),
      amountMax: max === '' ? null : Number(max),
      txDate: g.querySelector('.me-date').value || null,
      owner: g.querySelector('.me-owner').value,
      rawText: 'manual entry', confidence: 1
    });
  });
  if (edits.length === 0) { alert('Add at least one row (a ticker or asset name).'); return; }
  var tr = el('me-' + docId);
  if (tr) tr.querySelectorAll('button,input,select').forEach(function (b) { b.disabled = true; });
  fetch('/api/admin/review/' + encodeURIComponent(docId), {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ decision: 'manual', edits: edits })
  })
    .then(okOrThrow)
    .then(function () { REVIEW = REVIEW.filter(function (x) { return x.docId !== docId; }); if (tr && tr.parentNode) tr.parentNode.removeChild(tr); renderReview(); loadFeed(); })
    .catch(function (e) {
      if (tr) tr.querySelectorAll('button,input,select').forEach(function (b) { b.disabled = false; });
      alert(isAuthError(e) ? ADMIN_MOVED_MSG : ('Manual entry failed: ' + e.message));
    });
}

/* ============================ SUBSCRIPTIONS ============================ */
function loadSubs() {
  // API HOOK: GET /api/admin/subscriptions
  return fetch('/api/admin/subscriptions', { headers: adminHeaders() })
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
    .then(function (data) {
      if (data && data.secret) {
        var stream = data.streamUrl || '';
        el('subsMsg').innerHTML =
          '<div class="secret-panel">' +
            '<strong>Created. Save this secret now; it will not be shown again.</strong>' +
            '<div><span class="muted">Secret</span><code class="secret-value">' + esc(data.secret) + '</code></div>' +
            (stream ? '<div><span class="muted">SSE URL</span><code class="secret-value">' + esc(stream) + '</code></div>' : '') +
            '<div class="secret-actions">' +
              '<button class="btn ghost sm" data-copy="' + esc(data.secret) + '" onclick="copyFromData(this)">Copy secret</button>' +
              (stream ? '<button class="btn ghost sm" data-copy="' + esc(stream) + '" onclick="copyFromData(this)">Copy SSE URL</button>' : '') +
            '</div>' +
          '</div>';
      } else {
        el('subsMsg').textContent = 'Created.';
      }
      el('newClientId').value = ''; el('newTarget').value = '';
      loadSubs();
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
  renderFeedHeader(); renderColChooser(); renderFeed();
  loadPollConfig(); loadHealth(); loadDiagnostics();
}
function clearAdminToken() {
  try { localStorage.removeItem(ADMIN_TOKEN_KEY); } catch (e) {}
  if (el('adminToken')) el('adminToken').value = '';
  el('adminTokenMsg').textContent = 'Cleared.';
  setTimeout(function () { el('adminTokenMsg').textContent = ''; }, 2500);
  renderFeedHeader(); renderColChooser(); renderFeed();
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
    if (el('kpiMode')) el('kpiMode').innerHTML = aggressive ? 'Aggressive<small> · Fast</small>' : 'Standard';
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
  var max = parseInt(el('hiMax').value, 10);
  if (isNaN(from) || isNaN(to)) { el('hiMsg').textContent = 'Enter a from/to year.'; return; }
  if (isNaN(max) || max < 1) max = 500;
  el('hiMsg').textContent = dryRun ? 'Counting…' : 'Enqueuing (this can take a while)…';
  fetch('/api/admin/house-backfill', {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ fromYear: from, toYear: to, maxFilings: max, dryRun: !!dryRun })
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
          '<td class="muted">' + esc(dateTimeText(s.lastPolledAt)) + '</td>' +
          '<td class="muted">' + esc(dateTimeText(s.lastNewFilingAt)) + '</td>' +
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

function loadDiagnostics() {
  // API HOOK: GET /api/admin/diagnostics
  var cards = el('diagConnections');
  var errors = el('diagErrors');
  if (cards) cards.innerHTML = '<div class="state">Loading connection status…</div>';
  if (errors) errors.innerHTML = stateRow(4, 'Loading recent errors…');
  return fetch('/api/admin/diagnostics', { headers: adminHeaders() })
    .then(okOrThrow)
    .then(function (data) {
      var connections = data.connections || [];
      if (cards) {
        if (connections.length === 0) {
          cards.innerHTML = '<div class="state">No connection status available yet.</div>';
        } else {
          cards.innerHTML = connections.map(function (c) {
            var st = c.status || 'unknown';
            var configured = c.configured == null ? '—' : (c.configured ? 'Yes' : 'No');
            return '<div class="diag-card">' +
              '<div class="diag-head"><div class="diag-title">' + esc(c.label || c.id || 'Connection') + '</div>' +
                '<span class="diag-status ' + esc(st) + '">' + esc(st) + '</span></div>' +
              '<div class="diag-meta">' +
                '<span>Configured</span><strong>' + esc(configured) + '</strong>' +
                '<span>Last Used</span><strong>' + esc(dateTimeText(c.lastUsedAt)) + '</strong>' +
                '<span>Total</span><strong>' + esc(c.callsTotal != null ? c.callsTotal : 0) + '</strong>' +
                '<span>24h / Today</span><strong>' + esc((c.callsLast24h || 0) + ' / ' + (c.callsToday || 0)) + '</strong>' +
                '<span>Errors 24h</span><strong class="' + (c.errorsLast24h ? 'diag-error' : '') + '">' + esc(c.errorsLast24h || 0) + '</strong>' +
              '</div>' +
              (c.note ? '<div class="diag-note">' + esc(c.note) + '</div>' : '') +
            '</div>';
          }).join('');
        }
      }
      var rows = data.errors || [];
      if (errors) {
        if (rows.length === 0) {
          errors.innerHTML = stateRow(4, 'No recent app errors found.');
        } else {
          errors.innerHTML = rows.map(function (e) {
            var sev = e.severity === 'warning' ? 'diag-warning' : 'diag-error';
            return '<tr class="row">' +
              '<td class="muted">' + esc(dateTimeText(e.at)) + '</td>' +
              '<td class="' + sev + '">' + esc(e.area || 'App') + '</td>' +
              '<td class="muted">' + esc(e.subject || '—') + '</td>' +
              '<td>' + esc(e.message || '—') + '</td>' +
            '</tr>';
          }).join('');
        }
      }
    })
    .catch(function (e) {
      if (cards) cards.innerHTML = '<div class="state">' + esc(isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load diagnostics: ' + e.message)) + '</div>';
      if (errors) errors.innerHTML = stateRow(4, isAuthError(e) ? ADMIN_MOVED_MSG : ('Could not load diagnostics: ' + e.message));
    });
}

/* ============================ TRENDS / ANALYTICS ============================ */
/* All views read /api/analytics/* — read-only aggregates over the corpus. Dollar
	   values are ESTIMATES from STOCK Act bracket midpoints (labelled with ~). */
	var EST_VOLUME_TIP = 'Approximate, from STOCK Act amount ranges: closed ranges use the midpoint; the open $50M+ range uses its $50,000,001 floor. Treat as a rough order of magnitude, not an exact figure.';
	var BUY_PRESSURE_TIP = 'Share of buys among buy+sell trades in the window (buy count / (buys + sells)). A simple trade-count tilt, not dollar-weighted.';
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
/* Compact USD: 1234567 -> $1.2M, 3.2e12 -> $3.2T. */
function usdC(n) {
  n = Number(n || 0); var s = n < 0 ? '-' : ''; n = Math.abs(n); var o;
  if (n >= 1e12) o = (n / 1e12).toFixed(1) + 'T';
  else if (n >= 1e9) o = (n / 1e9).toFixed(1) + 'B';
  else if (n >= 1e6) o = (n / 1e6).toFixed(1) + 'M';
  else if (n >= 1e3) o = (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  else o = String(Math.round(n));
  return s + '$' + o;
}
	function estUsd(n) {
	  return '<span class="est-money" title="' + esc(EST_VOLUME_TIP) + '">~' + usdC(n) + '</span>';
	}
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
function pdot(b) { return b ? '<span class="pdot ' + esc(b) + '"></span>' : ''; }
	function kpi(k, v) { return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>'; }
	function infoLabel(text, tip) {
	  return esc(text) + ' <span class="info-tip" tabindex="0" aria-label="' + esc(tip) + '" title="' + esc(tip) + '">ⓘ</span>';
	}
	function kpiInfo(k, v, tip) {
	  return '<div class="card"><div class="k">' + infoLabel(k, tip) + '</div><div class="v">' + v + '</div></div>';
	}
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
  loadTrTime(); loadTrSectorFlow(); loadTrCapFlow(); loadTrPerformers();
  loadTrMembers(); loadTrParties(); loadTrSectors(); loadTrLag();
}

/* Volume bar + buy/sell/breadth/net chip — shared by the sector & cap views. */
function flowRowHtml(label, r, maxVol, title) {
  var w = Math.round(100 * Number(r.estVolumeUsd || 0) / (maxVol || 1));
  var breadth = (r.uniqueMembers || 0) + ' mbr · ' + (r.uniqueTickers || 0) + ' tkr';
  return '<div class="hbar"><div class="hlabel" title="' + esc(title || label) + '">' + esc(label) + '</div>' +
    '<div class="htrack"><div class="hfill" style="width:' + w + '%"></div></div>' +
    '<div class="hval">' + estUsd(r.estVolumeUsd) + '</div></div>' +
    '<div class="chip" style="margin:-3px 0 9px 130px">' + (r.buyCount || 0) + 'B / ' + (r.sellCount || 0) +
      'S · ' + esc(breadth) + ' · net ' + netHtml(r.estNetFlowUsd) + '</div>';
}

function loadTrSectorFlow() {
  var box = el('trSectorFlow');
  box.innerHTML = '<div class="note">Loading…</div>';
  aGet('sector-flow?' + trParams() + '&limit=12').then(function (d) {
    var rows = (d.sectors || []).filter(function (r) { return r.sector && r.sector !== 'Unknown'; });
    if (!rows.length) { box.innerHTML = '<div class="note">No sector-classified trades in this window yet (security reference data fills in as enrichment runs).</div>'; return; }
    var max = 1; rows.forEach(function (r) { max = Math.max(max, r.estVolumeUsd); });
    box.innerHTML = rows.map(function (r) { return flowRowHtml(r.sector, r, max); }).join('');
  }).catch(function (e) { box.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>'; });
}

var CAP_NAMES = { mega: 'Mega Cap', large: 'Large Cap', mid: 'Mid Cap', small: 'Small Cap', micro: 'Micro Cap', nano: 'Nano Cap', unknown: 'Unclassified' };
var CAP_ORDER = ['mega', 'large', 'mid', 'small', 'micro', 'nano', 'unknown'];
function loadTrCapFlow() {
  var box = el('trCapFlow');
  box.innerHTML = '<div class="note">Loading…</div>';
  aGet('market-cap-breakdown?' + trParams()).then(function (d) {
    var rows = (d.buckets || []).filter(function (r) { return (r.buyCount + r.sellCount) > 0; });
    if (!rows.length) { box.innerHTML = '<div class="note">No market-cap-classified trades in this window yet.</div>'; return; }
    rows.sort(function (a, b) { return CAP_ORDER.indexOf(a.bucket) - CAP_ORDER.indexOf(b.bucket); });
    var max = 1; rows.forEach(function (r) { max = Math.max(max, r.estVolumeUsd); });
    box.innerHTML = rows.map(function (r) { return flowRowHtml(CAP_NAMES[r.bucket] || r.bucket, r, max); }).join('');
  }).catch(function (e) { box.innerHTML = '<div class="note">Could not load: ' + esc(e.message) + '</div>'; });
}

/* Signed percent: 0.0532 -> +5.3%, -0.12 -> -12.0%. */
function pctSigned(n) {
  if (n == null || isNaN(n)) return '—';
  var v = Number(n) * 100, cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  return '<span class="net ' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
}
function loadTrPerformers() {
  var body = el('trPerformers');
  body.innerHTML = stateRow(5, 'Loading…');
  aGet('member-performance?' + trParams() + '&limit=15').then(function (d) {
    var rows = d.members || [];
    if (!rows.length) { body.innerHTML = stateRow(5, 'Not enough priced, filing-anchored buys to rank yet — this fills in as the price cache backfills.'); return; }
    body.innerHTML = rows.map(function (r, i) {
      var name = fmtName(r.fullName || r.filerId || 'Unknown');
      var memberAttr = r.filerId ? ' class="member-cell clickable" data-member="' + esc(r.filerId) + '"' : ' class="member-cell"';
      return '<tr class="row"><td class="rank">' + (i + 1) + '</td>' +
        '<td><div' + memberAttr + '>' + memberAvatarHtml(name, r.photoUrl) + '<div>' + pdot(r.party) +
          esc(name) + '</div></div></td>' +
        '<td class="muted">' + r.tradeCount + ' buys</td>' +
        '<td class="muted">' + Math.round(100 * (r.winRate || 0)) + '% win</td>' +
        '<td>' + pctSigned(r.avgExcessReturn) + '</td></tr>';
    }).join('');
  }).catch(function (e) { body.innerHTML = stateRow(5, 'Could not load: ' + e.message); });
}

function loadTrSummary() {
  var box = el('trKpis');
  box.innerHTML = kpi('Loading…', '—');
  aGet('summary?' + trParams()).then(function (d) {
    var sent = d.netSentiment == null ? '—' : Math.round(d.netSentiment * 100) + '<small>% buys</small>';
    box.innerHTML =
      kpi('Trades', d.totalTrades) + kpi('Politicians', d.uniqueMembers) + kpi('Assets', d.uniqueTickers) +
	      kpiInfo('Approx. Volume', estUsd(d.estimatedVolumeUsd), EST_VOLUME_TIP) + kpi('Net Flow', netHtml(d.estimatedNetFlowUsd)) +
      kpiInfo('Buy Pressure', sent, BUY_PRESSURE_TIP);
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
    if (!cs.length) { box.innerHTML = '<div class="chip">No multi-member consensus in this window — try a longer window or “All Data”.</div>'; return; }
    box.innerHTML = cs.map(function (c) {
      var faces = (c.topMembers || []).slice(0, 5).map(function (m) { return memberAvatarHtml(m.fullName, m.photoUrl); }).join('');
      var dir = c.txType === 'P' ? 'BOUGHT' : 'SOLD';
      var parties = 'D ' + c.parties.D + ' · R ' + c.parties.R + (c.parties.O ? ' · O ' + c.parties.O : '');
      var bip = (c.parties.D > 0 && c.parties.R > 0) ? ' <span class="chip" title="Both parties traded">· bipartisan</span>' : '';
      var range = dateText(c.firstSeen) + (c.lastSeen && c.lastSeen !== c.firstSeen ? ' → ' + dateText(c.lastSeen) : '');
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
      var name = fmtName(r.fullName || r.filerId || 'Unknown');
      var metaBits = [chamberLabel(r.chamber), r.state].filter(Boolean).join(' · ');
      var memberAttr = r.filerId ? ' class="member-cell clickable" data-member="' + esc(r.filerId) + '"' : ' class="member-cell"';
      return '<tr class="row"><td class="rank">' + (i + 1) + '</td>' +
        '<td><div' + memberAttr + '>' + memberAvatarHtml(name, r.photoUrl) + '<div>' + pdot(r.partyBucket) +
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
      return '<div class="hbar"><div class="hlabel" title="' + esc(r.assetType) + '">' + esc(assetTypeLabel(r.assetType)) + '</div>' +
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
      kpi('Median Lag', (s.medianLagDays == null ? '—' : s.medianLagDays + '<small> days</small>')) +
      kpi('90th Pct', (s.p90LagDays == null ? '—' : s.p90LagDays + '<small> days</small>')) +
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
      var name = fmtName(m.fullName || m.filerId || 'Unknown');
      var memberAttr = m.filerId ? ' class="member-cell clickable" data-member="' + esc(m.filerId) + '"' : ' class="member-cell"';
      return '<tr class="row"><td><div' + memberAttr + '>' + memberAvatarHtml(name, m.photoUrl) + '<div>' +
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

/* ============================ DETAIL DRAWERS ============================ */
/* One reusable right-side drawer, filled per type: trade / asset / politician.
   Tier-1/2 (company profile, price, performance) are KEY-GATED and shown as a
   quiet note until a market-data key is configured. */
function openDrawer(html) {
  closePanels();
  el('detailDrawerBody').innerHTML = html;
  el('detailDrawer').classList.add('open');
  var p = document.querySelector('#detailDrawer .drawer-panel');
  if (p) p.scrollTop = 0;
}
function closeDrawer() { el('detailDrawer').classList.remove('open'); }
var PERF_GATE = '<div class="tier-gate-note">📈 Price &amp; performance vs the S&amp;P 500 will appear here once a market-data API key is configured.</div>';
var PROFILE_GATE = '<div class="tier-gate-note">🏢 Company details (sector, market cap, country, exchange) will appear here once a market-data API key is configured.</div>';
var OPTION_PERF_NOTE = '<div class="tier-gate-note">Performance isn\\'t shown for options — the return depends on strike, expiry, and exercise, which the filing doesn\\'t disclose.</div>';
/* Render the performance line from /api/analytics/performance. Frames a sale as
   "since sold" (a price observation, not profit/loss). */
function perfPct(x) { return x == null ? '—' : (x > 0 ? '▲ ' : x < 0 ? '▼ ' : '') + (x * 100).toFixed(1) + '%'; }
function perfLineHtml(d, txType) {
  if (!d || !d.available) return (d && d.isOption) ? OPTION_PERF_NOTE : PERF_GATE;
  var verb = txType === 'S' ? 'since sold' : 'since traded';
  function perfBlock(label, perf, anchorPrice) {
    if (!perf) return '';
    var cls = perf.assetReturn > 0 ? 'pos' : perf.assetReturn < 0 ? 'neg' : '';
    var excess = perf.excessReturn == null ? '—' : (perf.excessReturn > 0 ? '+' : '') + (perf.excessReturn * 100).toFixed(1) + '% vs S&amp;P';
    var prices = (anchorPrice != null && d.currentPrice != null)
      ? '<div class="chip muted">$' + Number(anchorPrice).toFixed(2) + ' → $' + Number(d.currentPrice).toFixed(2) + (d.currentPriceDate ? ' (' + esc(d.currentPriceDate) + ')' : '') + '</div>'
      : '';
    return '<div class="perf-line net ' + cls + '">' + perfPct(perf.assetReturn) + ' ' + label + '</div>' +
      '<div class="chip">S&amp;P 500 ' + perfPct(perf.spxReturn) + ' · ' + excess + '</div>' + prices;
  }
  var tradePerf = d.tradeDatePerformance || d;
  var tradeHtml = perfBlock(verb, tradePerf, d.priceAtTrade);
  var filingHtml = d.filingDatePerformance
    ? '<div style="height:10px"></div>' + perfBlock(txType === 'S' ? 'since reported' : 'since filing', d.filingDatePerformance, d.filingDatePerformance.priceAt)
    : '';
  return tradeHtml + filingHtml;
}
function kvRow(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>'; }
function actionBadge(type) { return '<span class="tag ' + esc(type) + '">' + esc(typeName[type] || type) + '</span>'; }
function amountText(min, max) {
  if (min == null && max == null) return '—';
  return fmtBracketAmount(min) + ' - ' + (max == null ? '+' : fmtBracketAmount(max));
}
function daysBetween(aIso, bIso) {
  var a = Date.parse(aIso), b = Date.parse(bIso);
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}
var PARTY_NAME = { D: 'Democrat', R: 'Republican', O: 'Independent / Other' };
function partyLabel(b) { return PARTY_NAME[b] || ''; }
function friendlyKey(k) {
  return String(k || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, function (ch) { return ch.toUpperCase(); });
}
function cleanNoteValue(v) {
  if (v == null || v === '') return '';
  return String(v).replace(/\s+/g, ' ').trim();
}
function filingNotesHtml(raw) {
  if (!raw) return '';
  var text = cleanNoteValue(raw);
  var parsed = null;
  if (text && (text[0] === '{' || text[0] === '[')) {
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  }
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    var member = cleanNoteValue(parsed.member);
    var type = cleanNoteValue(parsed.type);
    var amount = cleanNoteValue(parsed.amount);
    if (member || type || amount) {
      var who = member ? member + ' reported ' : 'Reported ';
      var what = type || 'a transaction';
      var amt = amount ? ' in the ' + amount + ' amount bracket' : '';
      return '<p class="filing-note">Historical source note: ' + esc(who + what + amt + '.') + '</p>';
    }
    var rows = Object.keys(parsed).filter(function (k) { return cleanNoteValue(parsed[k]); }).map(function (k) {
      return kvRow(friendlyKey(k), esc(cleanNoteValue(parsed[k])));
    }).join('');
    if (rows) return '<dl class="drawer-kv filing-note-kv">' + rows + '</dl>';
  }
  return '<p class="filing-note">' + esc(text) + '</p>';
}

/* Company section for a drawer: real cross-referenced data when present, else the
   key-gated placeholder. Accepts a ref object with any subset of the fields. */
function companySectionHtml(ref) {
  if (!ref || (!ref.sector && ref.marketCap == null && !ref.marketCapBucket && !ref.country && !ref.exchangeShort && !ref.assetClass)) {
    return PROFILE_GATE;
  }
  function item(label, val) {
    if (!val && val !== 0) return '';
    return '<div class="def-item"><span class="def-k">' + esc(label) + '</span><span class="def-v">' + val + '</span></div>';
  }
  var mcap = (ref.marketCapBucket ? esc(ownerLabel(ref.marketCapBucket)) : '') +
    (ref.marketCap != null ? (ref.marketCapBucket ? ' · ' : '') + estUsd(ref.marketCap) : '');
  var html =
    item('Sector', ref.sector ? esc(ref.sector) : '') +
    item('Industry', ref.industry ? esc(ref.industry) : '') +
    item('Class', ref.assetClass ? esc(assetClassLabel(ref.assetClass)) : '') +
    item('Market Cap', mcap) +
    item('Exchange', ref.exchangeShort ? esc(ref.exchangeShort) : '') +
    item('Country', ref.country ? esc(ref.country) : '') +
    item('Currency', ref.currency ? esc(ref.currency) : '') +
    item('IPO', ref.ipoDate ? esc(dateText(ref.ipoDate)) : '');
  return '<div class="def-grid">' + html + '</div>';
}
function drawerCompanyTitle(ticker, name) {
  var label = name || ticker || 'Company';
  var attr = ticker ? ' data-asset="' + esc(ticker) + '"' : '';
  var cls = ticker ? 'drawer-title-line clickable' : 'drawer-title-line';
  return '<h2 class="' + cls + '"' + attr + '>' +
    (ticker ? '<span class="tkr">' + esc(ticker) + '</span>' : '') +
    '<span class="company-name">' + esc(label) + '</span></h2>';
}
function miniTradeDateHtml(t) {
  var traded = dateText(t.txDate);
  var pub = t.filedDate || t.firstSeenAt || t.createdAt || '';
  var sub = pub ? 'Published ' + dateText(pub) : 'Published unavailable';
  return '<div class="mini-date"><span>' + esc(traded) + '</span><span class="subline">' + esc(sub) + '</span></div>';
}
function miniSourceLinkHtml(url) {
  var safe = safeDocUrl(url);
  return safe ? '<a class="mini-source-link" href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer">Source</a>' : '';
}

/* ---- asset drawer (reuses /api/analytics/ticker/:ticker) ---- */
function openAsset(ticker) {
  if (!ticker) return;
  openDrawer('<div class="note">Loading ' + esc(ticker) + '…</div>');
  aGet('ticker/' + encodeURIComponent(ticker) + '?window=all').then(function (d) {
    var s = d.summary || {};
    var companyName = (d.ref && d.ref.companyName) || d.name || '';
    var sent = s.netSentiment == null ? '—' : Math.round(s.netSentiment * 100) + '% buys';
    var ser = d.series || [];
    var chart = ser.length ? timeChartHtml(ser) : '<div class="note">No dated trades.</div>';
    function traderList(arr, label) {
      if (!arr || !arr.length) return '<div class="note">No ' + label + '.</div>';
      return arr.map(function (m) {
        var name = fmtName(m.fullName || m.filerId || 'Unknown');
        var memberAttr = m.filerId ? ' data-member="' + esc(m.filerId) + '"' : '';
        var labelCls = m.filerId ? 'hlabel clickable' : 'hlabel';
        return '<div class="hbar" style="margin:5px 0"><div class="' + labelCls + '"' + memberAttr + ' style="width:auto;flex:1">' +
          memberAvatarHtml(name, m.photoUrl) + ' ' + pdot(m.partyBucket) + esc(name) + '</div>' +
          '<div class="hval">' + estUsd(m.estVolumeUsd) + '</div></div>';
      }).join('');
    }
    var recent = (d.recentTrades || []).map(function (t) {
      var name = fmtName(t.fullName || 'Unknown');
      var member = t.filerId
        ? '<span class="member-cell clickable" data-member="' + esc(t.filerId) + '">' + pdot(t.partyBucket) + esc(name) + '</span>'
        : pdot(t.partyBucket) + esc(name);
      return '<tr class="row"><td class="muted">' + miniTradeDateHtml(t) + '</td>' +
        '<td>' + actionBadge(t.txType) + '</td>' +
        '<td>' + member + '</td>' +
        '<td class="est">' + estUsd(t.estValueUsd) + miniSourceLinkHtml(t.sourceUrl) + '</td></tr>';
    }).join('');
    openDrawer(
      drawerCompanyTitle(d.ticker, companyName || d.ticker) +
	      '<p class="dsub">' + (s.totalTrades || 0) + ' trades · ' + (s.memberCount || 0) + ' politicians · ' + estUsd(s.estVolumeUsd) + ' approx. volume</p>' +
      '<div class="drawer-section first"><h3>Company</h3>' + companySectionHtml(d.ref) + '</div>' +
      '<div class="drawer-section"><h3>Congressional Activity (All Time)</h3><div class="grid-cards">' +
	        kpi('Trades', s.totalTrades || 0) + kpi('Politicians', s.memberCount || 0) + kpiInfo('Approx. Volume', estUsd(s.estVolumeUsd), EST_VOLUME_TIP) +
        kpi('Net Flow', netHtml(s.estNetFlowUsd)) + kpiInfo('Buy Pressure', sent, BUY_PRESSURE_TIP) + '</div>' +
        '<div class="legend" style="margin-top:8px"><span><span class="sw buy"></span>Buys</span><span><span class="sw sell"></span>Sells</span></div>' + chart + '</div>' +
      '<div class="drawer-section"><h3>Performance Since Trades</h3>' + PERF_GATE + '</div>' +
      '<div class="trend-grid2"><div class="drawer-section"><h3>Top Buyers</h3>' + traderList(d.topBuyers, 'buyers') + '</div>' +
        '<div class="drawer-section"><h3>Top Sellers</h3>' + traderList(d.topSellers, 'sellers') + '</div></div>' +
      '<div class="drawer-section"><h3>Recent Trades</h3><div class="table-wrap"><table class="mini-tbl"><tbody>' +
        (recent || '<tr><td class="state" colspan="4">No recent trades.</td></tr>') + '</tbody></table></div></div>'
    );
  }).catch(function (e) { openDrawer('<div class="note">Could not load ' + esc(ticker) + ': ' + esc(e.message) + '</div>'); });
}

/* ---- politician drawer (/api/analytics/member/:filerId) ---- */
function openMember(filerId) {
  if (!filerId) return;
  openDrawer('<div class="note">Loading member…</div>');
  aGet('member/' + encodeURIComponent(filerId) + '?window=all').then(function (d) {
    var p = d.profile || {}, st = d.stats || {};
    var name = fmtName(p.fullName || filerId);
    var partyName = partyLabel(p.partyBucket);
    var meta = [chamberLabel(p.chamber), stateName(p.state)].filter(Boolean).join(' · ');
    var subBits = [];
    if (meta) subBits.push(esc(meta));
    if (p.district) subBits.push('District ' + esc(p.district));
    var partyHtml = partyName ? pdot(p.partyBucket) + esc(partyName) : '';
    var subline = partyHtml + (subBits.length ? (partyHtml ? ' · ' : '') + subBits.join(' · ') : '');
    var committees = p.committees || [];
    var commHtml = committees.length
      ? committees.map(function (c) { return '<span class="committee-tag">' + esc(c) + '</span>'; }).join('')
      : '<span class="muted">Not recorded</span>';
    var top = (d.topTickers || []).map(function (t) {
      return '<div class="hbar" style="margin:5px 0"><div class="hlabel clickable" data-asset="' + esc(t.ticker) + '" style="width:auto;flex:1">' +
        '<span class="tkr">' + esc(t.ticker) + '</span>' + (t.name ? ' <span class="muted">' + esc(t.name) + '</span>' : '') +
        '</div><div class="hval">' + t.tradeCount + ' · ' + estUsd(t.estVolumeUsd) + '</div></div>';
    }).join('') || '<div class="note">—</div>';
    var recent = (d.recentTrades || []).map(function (t) {
      var assetCell = t.ticker
        ? '<span class="tkr clickable" data-asset="' + esc(t.ticker) + '">' + esc(t.ticker) + '</span>'
        : '<span class="muted">' + esc((t.assetName || '').slice(0, 30)) + '</span>';
      return '<tr class="row"><td class="muted">' + miniTradeDateHtml(t) + '</td>' +
        '<td>' + actionBadge(t.txType) + '</td><td>' + assetCell + '</td>' +
        '<td class="est">' + estUsd(t.estValueUsd) + miniSourceLinkHtml(t.sourceUrl) + '</td></tr>';
    }).join('');
    openDrawer(
      '<div class="drawer-member-title">' + memberAvatarHtml(name, p.photoUrl) +
        '<div><h2 class="drawer-member-name">' + esc(name) + '</h2><p class="dsub" style="margin:0">' + subline + '</p></div></div>' +
      '<div class="drawer-section"><h3>Trade Stats</h3><dl class="drawer-kv">' +
        kvRow('Total Trades', st.totalTrades || 0) + kvRow('Buys / Sells', (st.buyCount || 0) + ' / ' + (st.sellCount || 0)) +
	        kvRow('Distinct Assets', st.uniqueTickers || 0) + kvRow('Approx. Volume', estUsd(st.estVolumeUsd)) +
        kvRow('Avg. Disclosure Lag', st.avgLagDays == null ? '—' : (Math.round(st.avgLagDays) + ' days')) + '</dl></div>' +
      '<div class="drawer-section"><h3>Committees</h3>' + commHtml + '</div>' +
      '<div class="drawer-section"><h3>Performance vs S&amp;P 500</h3>' + PERF_GATE + '</div>' +
      '<div class="drawer-section"><h3>Most-Traded</h3>' + top + '</div>' +
      '<div class="drawer-section"><h3>Recent Trades</h3><div class="table-wrap"><table class="mini-tbl"><tbody>' +
        (recent || '<tr><td class="state" colspan="4">No trades.</td></tr>') + '</tbody></table></div></div>'
    );
  }).catch(function (e) { openDrawer('<div class="note">Could not load member: ' + esc(e.message) + '</div>'); });
}

/* ---- trade drawer (from the in-memory feed row + lazy source link) ---- */
function openTrade(row) {
  if (!row) return;
  var memberVal = row.filerId
    ? '<span class="clickable" data-member="' + esc(row.filerId) + '">' + esc(fmtName(row.member)) + '</span>'
    : esc(fmtName(row.member));
  var sideWord = row.type === 'P' ? 'Bought' : row.type === 'S' ? 'Sold' : 'Exchanged';
  // A trade drawer leads with the TRANSACTION (kicker + amount), not the company —
  // the ticker/company is demoted to a non-clickable "in …" line so it can't be
  // mistaken for the company drawer (the ticker is intentionally NOT clickable here).
  var inName = (row.ticker || row.asset)
    ? '<p class="drawer-trade-in">in ' +
        (row.ticker ? '<span class="tkr">' + esc(row.ticker) + '</span>' : '') +
        (row.ticker && row.asset ? '<span class="dot-sep">·</span>' : '') +
        (row.asset ? '<span class="company-name">' + esc(row.asset) + '</span>' : '') + '</p>'
    : '';
  var head =
    '<div class="drawer-trade-head">' +
      '<span class="drawer-kicker tag ' + esc(row.type) + '">' + sideWord + '</span>' +
      '<h2 class="drawer-trade-headline">' + esc(amountText(row.min, row.max)) +
        ' <span class="drawer-trade-bracket muted">est. bracket</span></h2>' + inName +
    '</div>';
  var summary =
    '<div class="drawer-section first"><h3>Trade Details</h3><dl class="drawer-kv">' +
      kvRow('Politician', memberVal) +
      kvRow('Traded', esc(dateText(row.txdate))) +
      kvRow('Published', '<em>' + esc(publishedDetailText(row)) + '</em>') +
      kvRow('Official Filed', esc(filedDetailText(row))) +
      kvRow('Disclosure Lag', esc(lagDetailText(row))) +
      kvRow('Owner', esc(ownerLabel(row.owner) || '—')) +
      kvRow('Instrument', row.isOption ? 'Option' : 'Equity / Other') +
      kvRow('Imported', esc(dateTimeText(row.imported))) +
      '</dl><div id="tradeSource"></div></div>';
  var perfInit = row.isOption ? OPTION_PERF_NOTE : PERF_GATE;
  var perf = '<div class="drawer-section"><h3>Performance Since ' + (row.type === 'S' ? 'Sale' : 'Trade') + '</h3><div id="tradePerf">' + perfInit + '</div></div>';
  var rowRef = { sector: row.refSector, marketCap: row.refMarketCap, marketCapBucket: row.refMarketCapBucket, country: row.refCountry, exchangeShort: row.refExchangeShort, assetClass: row.refAssetClass };
  var profile = row.ticker ? '<div class="drawer-section"><h3>Company</h3>' + companySectionHtml(rowRef) + '</div>' : '';
  var notes = row.rawText ? '<div class="drawer-section"><h3>Filing Notes</h3>' + filingNotesHtml(row.rawText) + '</div>' : '';
  var links = '<div class="drawer-section">' +
    (row.ticker ? '<a class="drawer-all-link clickable" data-asset="' + esc(row.ticker) + '">View All Trades of ' + esc(row.ticker) + ' →</a>' : '') +
    (row.filerId ? '<a class="drawer-all-link clickable" data-member="' + esc(row.filerId) + '">View All Trades by ' + esc(fmtName(row.member)) + ' →</a>' : '') +
    '</div>';
  openDrawer(head + summary + perf + profile + notes + links);
  // Lazy-load the performance line (FMP-gated; "—"/note when unavailable).
  if (row.id && !row.isOption) {
    aGet('performance/' + encodeURIComponent(row.id)).then(function (d) {
      var pEl = el('tradePerf'); if (pEl) pEl.innerHTML = perfLineHtml(d, row.type);
    }).catch(function () {});
  }
  // Lazy-load the source-filing link (live rows have one; seed rows usually don't).
  if (row.docId) {
    fetch('/api/filings/' + encodeURIComponent(row.docId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var sEl = el('tradeSource'); if (!sEl) return;
        var url = (d && d.filing && d.filing.sourceUrl) || reconstructFilingUrl(row.docId);
        sEl.innerHTML = url
          ? '<a class="source-link" href="' + esc(url) + '" target="_blank" rel="noopener">🔗 View source filing</a>'
          : '<div class="tier-gate-note" style="margin-top:9px">Source document not stored for this row (historic import).</div>';
      })
      .catch(function () {
        var sEl = el('tradeSource'); if (!sEl) return;
        var url = reconstructFilingUrl(row.docId);
        if (url) sEl.innerHTML = '<a class="source-link" href="' + esc(url) + '" target="_blank" rel="noopener">🔗 View source filing</a>';
      });
  }
}
/* Rebuild a House PTR PDF link from its docId (H-YYYY-NNNN) when the stored
   source_url is missing — covers historic/seed House rows that predate URL capture.
   House PTRs live at disclosures-clerk.house.gov/public_disc/ptr-pdfs/YYYY/NNNN.pdf. */
function reconstructFilingUrl(docId) {
  var m = /^H-(\\d{4})-(\\d+)$/.exec(String(docId || ''));
  if (!m) return '';
  return 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/' + m[1] + '/' + m[2] + '.pdf';
}

/* ============================ ACCOUNT (auth + billing) ============================ */
var ME = { user: null, entitlement: { premium: false, status: null, plan: null, trialing: false } };
var selectedPlan = 'monthly';

function isPremium() { return !!(ME.entitlement && ME.entitlement.premium); }

/* Bootstrap identity + entitlement in one call (GET /auth/me). */
function loadMe() {
  return fetch('/auth/me', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : { user: null, entitlement: { premium: false } }; })
    .then(function (d) {
      ME.user = d.user || null;
      ME.entitlement = d.entitlement || { premium: false };
      renderAccount();
      hiddenCols = hiddenCols.filter(function (id) {
        return availableCols().some(function (c) { return c.id === id; });
      });
      renderFeedHeader();
      renderColChooser();
      renderFeed();
    })
    .catch(function () { renderAccount(); });
}

function renderAccount() {
  var box = el('acct'); if (!box) return;
  if (!ME.user) {
    box.innerHTML = '<button class="btn ghost sm" onclick="openLogin()">Sign In</button>' +
      '<button class="btn sm" onclick="openPricing()">Upgrade</button>';
    return;
  }
  var ent = ME.entitlement || {};
  var badge = ent.premium ? '<span class="badge premium">' + (ent.trialing ? 'Trial' : 'Premium') + '</span>' : '';
  var upgrade = ent.premium ? '' : '<button class="btn sm" onclick="openPricing()">Upgrade</button>';
  var label = ME.user.name || ME.user.email || 'Account';
  box.innerHTML = badge + upgrade +
    '<div class="menu">' +
      '<span class="avatar lg" id="acctAvatar" title="' + esc(label) + '" onclick="toggleAcctMenu()">' + esc(initials(label)) +
        (ME.user.picture ? '<img src="' + esc(ME.user.picture) + '" alt="" onerror="this.remove()"/>' : '') +
      '</span>' +
      '<div class="menu-pop" id="acctMenu">' +
        '<div class="who">' + esc(ME.user.email || '') + '</div>' +
        (ent.premium
          ? '<button onclick="manageBilling()">Manage Subscription</button>'
          : '<button onclick="closeAcctMenu();openPricing()">Upgrade to Premium</button>') +
        '<button onclick="logout()">Sign Out</button>' +
      '</div>' +
    '</div>';
}
function toggleAcctMenu() { var m = el('acctMenu'); if (m) m.classList.toggle('open'); }
function closeAcctMenu() { var m = el('acctMenu'); if (m) m.classList.remove('open'); }
document.addEventListener('click', function (e) {
  var menu = el('acctMenu'), av = el('acctAvatar');
  if (menu && menu.classList.contains('open') && !menu.contains(e.target) && e.target !== av) {
    menu.classList.remove('open');
  }
});

/* ---- login modal ---- */
function openLogin() { el('loginOverlay').classList.add('open'); el('loginMsg').textContent = ''; var i = el('magicEmail'); if (i) setTimeout(function () { i.focus(); }, 50); }
function closeLogin() { el('loginOverlay').classList.remove('open'); }
function loginGoogle() { window.location.href = '/auth/google/start'; }
function sendMagicLink() {
  var email = (el('magicEmail').value || '').trim();
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) { el('loginMsg').textContent = 'Enter a valid email.'; return; }
  el('loginMsg').textContent = 'Sending…';
  fetch('/auth/magic/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email }) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok) { el('loginMsg').textContent = (res.j && res.j.error) || 'Could not send link.'; return; }
      el('loginMsg').textContent = (res.j && res.j.sent === false)
        ? 'Email isn’t configured yet — try Google sign-in.'
        : 'Check your inbox for a sign-in link (expires in 15 min).';
    })
    .catch(function () { el('loginMsg').textContent = 'Network error — try again.'; });
}
function logout() {
  fetch('/auth/logout', { method: 'POST' })
    .then(function () { window.location.reload(); })
    .catch(function () { window.location.reload(); });
}

/* ---- pricing / checkout ---- */
function openPricing() { closeAcctMenu(); selectPlan(selectedPlan); el('pricingMsg').textContent = ''; el('pricingOverlay').classList.add('open'); }
function closePricing() { el('pricingOverlay').classList.remove('open'); }
function selectPlan(p) {
  selectedPlan = (p === 'annual') ? 'annual' : 'monthly';
  var m = el('planMonthly'), a = el('planAnnual');
  if (m) m.classList.toggle('sel', selectedPlan === 'monthly');
  if (a) a.classList.toggle('sel', selectedPlan === 'annual');
}
function startCheckout() {
  if (!ME.user) { closePricing(); openLogin(); el('loginMsg').textContent = 'Sign in first, then we’ll start your trial.'; return; }
  var btn = el('subscribeBtn'); if (btn) btn.disabled = true;
  el('pricingMsg').textContent = 'Starting secure checkout…';
  fetch('/billing/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: selectedPlan }) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
    .then(function (res) {
      if (res.ok && res.j && res.j.url) { window.location.href = res.j.url; return; }
      if (res.status === 401) { closePricing(); openLogin(); return; }
      el('pricingMsg').textContent = (res.j && res.j.error) || 'Could not start checkout.';
      if (btn) btn.disabled = false;
    })
    .catch(function () { el('pricingMsg').textContent = 'Network error — try again.'; if (btn) btn.disabled = false; });
}
function manageBilling() {
  closeAcctMenu();
  showToast('Opening billing portal…');
  fetch('/billing/portal', { method: 'POST' })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (res.ok && res.j && res.j.url) { window.location.href = res.j.url; }
      else { showToast((res.j && res.j.error) || 'Could not open billing portal.', true); }
    })
    .catch(function () { showToast('Network error — try again.', true); });
}

/* ---- CSV export (premium) ---- */
function exportCsv() {
  if (!isPremium()) { openPricing(); return; }
  var p = new URLSearchParams();
  var t = el('qTicker').value.trim(); if (t) p.set('ticker', t);
  var ty = el('qType').value; if (ty) p.set('type', ty);
  var ch = el('qChamber').value; if (ch) p.set('chamber', ch);
  var qs = p.toString();
  window.location.href = '/api/export/transactions.csv' + (qs ? ('?' + qs) : '');
}

/* ---- gated feed CTA + post-redirect toasts ---- */
function updateGateRow() { var g = el('gateRow'); if (g) g.style.display = feedGated ? '' : 'none'; }
var TOAST_TIMER = null;
function showToast(text, isErr) {
  var t = el('toast'); if (!t) return;
  t.textContent = text; t.className = 'toast show' + (isErr ? ' err' : '');
  if (TOAST_TIMER) clearTimeout(TOAST_TIMER);
  TOAST_TIMER = setTimeout(function () { t.className = 'toast'; }, 4200);
}
function copyText(text) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      showToast('Copied.');
    }).catch(function () {
      showToast('Copy failed. Select and copy the value manually.', true);
    });
  } else {
    showToast('Clipboard unavailable. Select and copy the value manually.', true);
  }
}
function copyFromData(btn) {
  copyText(btn && btn.getAttribute ? (btn.getAttribute('data-copy') || '') : '');
}
/* Surface ?login= / ?checkout= / ?billing= outcomes after a hosted redirect,
   then scrub them from the URL so a refresh doesn't re-toast. */
function handleAuthQueryParams() {
  var p = new URLSearchParams(window.location.search);
  var login = p.get('login'), checkout = p.get('checkout');
  if (login === 'ok') showToast('Signed in.');
  else if (login === 'error') showToast('Sign-in failed — please try again.', true);
  else if (login === 'expired') showToast('That sign-in link expired — request a new one.', true);
  if (checkout === 'success') showToast('🎉 You’re in! Your premium trial is active.');
  else if (checkout === 'cancel') showToast('Checkout canceled — no charge was made.');
  if (login || checkout || p.get('billing')) {
    p.delete('login'); p.delete('checkout'); p.delete('billing');
    var qs = p.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? ('?' + qs) : ''));
  }
}

/* Collapse / expand the Trends disclaimer to reclaim screen space. */
function toggleDisclaimer() {
  var d = el('trDisclaimer'); if (!d) return;
  var collapsed = d.classList.toggle('collapsed');
  var btn = d.querySelector('.disclaimer-toggle');
  if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  try { localStorage.setItem('tr-disclaimer-collapsed', collapsed ? '1' : '0'); } catch (e) {}
}
(function () {
  // Default collapsed; honor the saved preference.
  try { if (localStorage.getItem('tr-disclaimer-collapsed') === '0') { var d = el('trDisclaimer'); if (d) { d.classList.remove('collapsed'); var b = d.querySelector('.disclaimer-toggle'); if (b) b.setAttribute('aria-expanded', 'true'); } } } catch (e) {}
})();

/* Tap-to-reveal tooltips: phones/tablets can't hover, so tapping any element that
   carries an info tooltip (title or .info-tip / .est-money etc.) pops the same text. */
(function () {
  var pop = null;
  function closeTip() { if (pop) { pop.remove(); pop = null; } }
  function tipTextFor(t) {
    var node = t.closest('[data-tip],[title],.info-tip,.est-money');
    if (!node) return null;
    return node.getAttribute('data-tip') || node.getAttribute('title') || (node.getAttribute('aria-label') || '');
  }
  document.addEventListener('click', function (e) {
    // Only act as a tap-tooltip on coarse pointers (touch); desktop keeps native hover.
    if (window.matchMedia && !window.matchMedia('(hover: none)').matches) return;
    if (!e.target || !e.target.closest) return;
    if (pop && pop.contains(e.target)) { closeTip(); return; }
    var node = e.target.closest('[data-tip],.info-tip,.est-money');
    if (!node) { closeTip(); return; }
    var text = node.getAttribute('data-tip') || node.getAttribute('title') || node.getAttribute('aria-label') || '';
    if (!text) return;
    e.preventDefault(); e.stopPropagation();
    closeTip();
    pop = document.createElement('div');
    pop.className = 'tip-pop';
    pop.textContent = text;
    document.body.appendChild(pop);
    var r = node.getBoundingClientRect();
    var pw = Math.min(pop.offsetWidth, window.innerWidth * 0.78);
    var left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
    var top = r.bottom + 8;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 8);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }, true);
  window.addEventListener('scroll', closeTip, true);
}());

/* ============================ TABS + BOOT ============================ */
document.querySelectorAll('nav.tabs button').forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll('nav.tabs button').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    b.classList.add('active');
    el('view-' + b.dataset.view).classList.add('active');
    if (b.dataset.view === 'feed') window.scrollTo({ top: 0, behavior: 'auto' });
    if (b.dataset.view === 'trends') loadTrends();
    if (b.dataset.view === 'review') loadReview();
    if (b.dataset.view === 'subs') loadSubs();
    if (b.dataset.view === 'admin') { initAdminToken(); loadLogoSetting(); loadPollConfig(); loadHealth(); loadDiagnostics(); }
  };
});

/* Trends controls: re-run on change; ticker rows/cards open the asset drawer. */
['trWindow', 'trChamber', 'trParty', 'trSource'].forEach(function (id) {
  var e = el(id); if (e) e.addEventListener('change', loadTrends);
});
(function () { var ts = el('trTickerSort'); if (ts) ts.addEventListener('change', loadTrTickers); })();
(function () {
  var v = el('view-trends');
  if (v) v.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var m = e.target.closest('[data-member]');
    if (m && m.getAttribute('data-member')) { openMember(m.getAttribute('data-member')); return; }
    var t = e.target.closest('[data-ticker]');
    if (t && t.getAttribute('data-ticker')) openAsset(t.getAttribute('data-ticker'));
  });
})();

/* Feed rows open the trade drawer; the asset chip and member open their drawers. */
function openTradeById(id) {
  for (var i = 0; i < TRADES.length; i++) {
    if (TRADES[i].id === id) { openTrade(TRADES[i]); return; }
  }
}
function handleFeedOpenEvent(e) {
  if (!e.target.closest) return;
  var a = e.target.closest('[data-asset]'); if (a) { openAsset(a.getAttribute('data-asset')); return; }
  var m = e.target.closest('[data-member]'); if (m) { openMember(m.getAttribute('data-member')); return; }
  var row = e.target.closest('[data-txid]'); if (!row) return;
  openTradeById(row.getAttribute('data-txid'));
}
(function () {
  var fb = el('feedBody');
  if (fb) fb.addEventListener('click', function (e) {
    handleFeedOpenEvent(e);
  });
  var fc = el('feedCards');
  if (fc) {
    fc.addEventListener('click', handleFeedOpenEvent);
    fc.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      handleFeedOpenEvent(e);
    });
  }
})();

/* Inside a drawer, asset/member links drill into the next drawer. */
(function () {
  var db = el('detailDrawerBody');
  if (db) db.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var a = e.target.closest('[data-asset]'); if (a) { openAsset(a.getAttribute('data-asset')); return; }
    var m = e.target.closest('[data-member]'); if (m) { openMember(m.getAttribute('data-member')); return; }
  });
})();

/* Escape closes transient overlays. */
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { closePanels(); closeDrawer(); closeLogin(); closePricing(); }
});

// Build the feed header from the column registry (also attaches sort handlers).
renderFeedHeader();

// Column chooser: toggle a column's visibility when its checkbox changes.
(function () {
  var box = el('colChooserBody');
  if (box) box.addEventListener('change', function (e) {
    var cb = e.target;
    if (cb && cb.getAttribute && cb.getAttribute('data-colid')) {
      onColToggle(cb.getAttribute('data-colid'), cb.checked);
    }
  });
})();

// Reflect the persisted theme on the toggle button.
applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

// Initial loading states + boot.
el('feedBody').innerHTML = stateRow(visibleCols().length, 'Loading live feed…');
el('reviewBody').innerHTML = stateRow(5, 'Loading…');
el('subsBody').innerHTML = stateRow(5, 'Loading…');
el('healthBody').innerHTML = stateRow(7, 'Loading…');
el('diagConnections').innerHTML = '<div class="state">Loading connection status…</div>';
el('diagErrors').innerHTML = stateRow(4, 'Loading…');

loadMe();              // account state (Sign in / avatar / premium badge)
handleAuthQueryParams(); // toast + scrub ?login= / ?checkout= after redirects
loadTrends();      // Trends is the default landing view
loadFeed().then(function () { startStream(); }); // warm the Trades feed + live SSE pill
loadReview();      // for the tab badge / KPI
loadPollConfig();  // for the poll-mode KPI
</script>
</body>
</html>`;
