/**
 * src/ui/dashboard.html.ts
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
  td.state { text-align: center; color: var(--text-dim); padding: 22px 13px; }
  .tkr { font-family: var(--mono); font-weight: 700; }
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
    <button data-view="review">Review Queue <span id="reviewCount"></span></button>
    <button data-view="subs">Subscriptions</button>
    <button data-view="admin">Admin · Cadence</button>
  </nav>
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
        <option value="">Both chambers</option><option value="house">House</option><option value="senate">Senate</option>
      </select>
      <button class="btn ghost sm" onclick="refreshFeed()">↻ Refresh</button>
    </div>
    <table>
      <thead><tr>
        <th>Filed</th><th>Member</th><th>Asset</th><th>Type</th><th>Amount (STOCK Act bracket)</th>
        <th>Tx date</th><th>Owner</th><th>Conf.</th><th>Source</th>
      </tr></thead>
      <tbody id="feedBody"></tbody>
    </table>
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
      <h3>Source health</h3>
      <p class="sub">First-seen timestamps are logged per filing so real refresh cadence is measured, not assumed.</p>
      <table>
        <thead><tr><th>Source</th><th>Last poll</th><th>Last new filing</th><th>Polls</th><th>Avg refresh (observed)</th></tr></thead>
        <tbody id="healthBody"></tbody>
      </table>
    </div>
  </section>

  <footer>Congress.Trade · live feed · data sourced from public STOCK Act (2012) disclosures · not financial advice</footer>
</main>

<script>
/* ============================ STATE ============================ */
var TRADES = [];          // live transactions (newest first)
var REVIEW = [];          // review-queue items
var SCHEDULE = [];        // PollWindow[]
var aggressive = false;
var cursor = 0;           // max cursor_seq seen
var realDataLoaded = false;
var es = null;            // EventSource handle

/* ============================ HELPERS ============================ */
var fmt = function (n) { return n == null ? '—' : '$' + Number(n).toLocaleString(); };
var confClass = function (c) { return c >= 0.9 ? 'hi' : c >= 0.7 ? 'mid' : 'lo'; };
var typeName = { P: 'Purchase', S: 'Sale', E: 'Exchange' };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}
function el(id) { return document.getElementById(id); }
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

/* ============================ FEED ============================ */
function renderFeed() {
  var m = el('qMember').value.toLowerCase(), t = el('qTicker').value.toUpperCase(),
      ty = el('qType').value, ch = el('qChamber').value;
  var body = el('feedBody');
  if (!realDataLoaded) { body.innerHTML = stateRow(9, 'Loading live feed…'); return; }
  var rows = TRADES.filter(function (r) {
    return (!m || (r.member || '').toLowerCase().indexOf(m) >= 0) &&
           (!t || (r.ticker || '').indexOf(t) >= 0) &&
           (!ty || r.type === ty) &&
           (!ch || r.chamber === ch);
  });
  if (rows.length === 0) { body.innerHTML = stateRow(9, 'No transactions match these filters.'); return; }
  body.innerHTML = rows.map(function (r) {
    return '<tr class="row">' +
      '<td class="muted">' + esc(r.filed) + '</td>' +
      '<td>' + esc(r.member) + (r.st ? ' <span class="muted">· ' + esc(r.st) + '</span>' : '') + '</td>' +
      '<td>' + (r.ticker ? '<span class="tkr">' + esc(r.ticker) + '</span> ' : '') + '<span class="muted">' + esc(r.asset) + '</span></td>' +
      '<td><span class="tag ' + esc(r.type) + '">' + esc(typeName[r.type] || r.type) + '</span></td>' +
      '<td>' + (r.min == null && r.max == null ? '<span class="muted">—</span>' : fmt(r.min) + ' – ' + (r.max == null ? '+' : fmt(r.max))) + '</td>' +
      '<td class="muted">' + esc(r.txdate || '—') + '</td>' +
      '<td class="muted">' + esc(r.owner || '—') + '</td>' +
      '<td><span class="conf ' + confClass(r.conf) + '">' + (r.conf * 100).toFixed(0) + '%</span></td>' +
      '<td class="muted">' + esc(r.source) + '</td>' +
    '</tr>';
  }).join('');
}

/* Map an API transaction (shared/types Transaction) to a feed row. */
function txToRow(tx) {
  return {
    filed: (tx.createdAt || '').replace('T', ' ').slice(0, 16),
    member: tx.filerId || 'Unknown',
    st: '',
    chamber: tx.chamber || '',
    asset: tx.assetName || '',
    ticker: tx.ticker || '',
    type: tx.txType || 'P',
    min: tx.amountMin, max: tx.amountMax,
    txdate: tx.txDate || '',
    owner: tx.owner || '',
    conf: typeof tx.confidence === 'number' ? tx.confidence : 1,
    source: tx.source || 'primary',
    cursorSeq: tx.cursorSeq || 0
  };
}

function loadFeed() {
  // API HOOK: GET /api/transactions?since=<cursor>
  return fetch('/api/transactions?since=' + cursor + '&limit=200')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      var txs = (data.transactions || []).map(txToRow);
      // newest first; merge ahead of existing
      txs.reverse();
      TRADES = txs.concat(TRADES);
      if (typeof data.cursor === 'number' && data.cursor > cursor) cursor = data.cursor;
      realDataLoaded = true;
      setBanner('');                       // drop the illustrative banner
      el('kpiTotal').textContent = TRADES.length;
      var today = new Date().toISOString().slice(0, 10);
      el('kpiToday').textContent = TRADES.filter(function (r) { return (r.filed || '').slice(0, 10) === today; }).length;
      var primary = TRADES.filter(function (r) { return r.source === 'primary'; }).length;
      el('kpiAuto').innerHTML = (TRADES.length ? Math.round(100 * primary / TRADES.length) : 0) + '<small>%</small>';
      renderFeed();
    })
    .catch(function (e) {
      if (!realDataLoaded) setBanner('Could not load the live feed: ' + e.message, true);
    });
}
function refreshFeed() { loadFeed(); }

/* SSE live push. API HOOK: EventSource('/api/stream?subscription=<id>'). */
function startStream() {
  try {
    es = new EventSource('/api/stream?subscription=dashboard');
    es.onopen = function () { var p = el('livePill'); p.className = 'pill live'; p.textContent = 'live feed'; };
    es.onmessage = function (e) {
      try {
        var tx = JSON.parse(e.data);
        if (!tx || !tx.id) return;
        TRADES.unshift(txToRow(tx));
        if (tx.cursorSeq && tx.cursorSeq > cursor) cursor = tx.cursorSeq;
        el('kpiTotal').textContent = TRADES.length;
        renderFeed();
        var p = el('livePill'); p.textContent = 'new filing ↑';
        setTimeout(function () { if (es && es.readyState === 1) p.textContent = 'live feed'; }, 1800);
      } catch (err) { /* ignore malformed frame */ }
    };
    es.onerror = function () {
      var p = el('livePill'); p.className = 'pill off'; p.textContent = 'reconnecting…';
      // EventSource auto-reconnects; nothing else to do.
    };
  } catch (err) {
    var p = el('livePill'); p.className = 'pill off'; p.textContent = 'no stream';
  }
}

/* ============================ REVIEW ============================ */
function loadReview() {
  // API HOOK: GET /api/admin/review-queue
  return fetch('/api/admin/review-queue')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) { REVIEW = data.items || []; renderReview(); })
    .catch(function (e) { el('reviewBody').innerHTML = stateRow(5, 'Could not load review queue: ' + e.message); });
}
function renderReview() {
  var body = el('reviewBody');
  el('reviewCount').textContent = REVIEW.length ? '(' + REVIEW.length + ')' : '';
  el('kpiReview').textContent = REVIEW.length;
  if (REVIEW.length === 0) { body.innerHTML = stateRow(5, 'Nothing awaiting review — queue is clear.'); return; }
  body.innerHTML = REVIEW.map(function (r) {
    var payload = r.payload ? JSON.stringify(r.payload) : '';
    return '<tr class="row" id="rv-' + esc(r.docId) + '">' +
      '<td class="muted">' + esc((r.createdAt || '').replace('T', ' ').slice(0, 16)) + '</td>' +
      '<td class="tkr">' + esc(r.docId) + '</td>' +
      '<td class="muted">' + esc(r.reason) + '</td>' +
      '<td class="muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(payload) + '</td>' +
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
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: decision, edits: [] })
  })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function () { REVIEW = REVIEW.filter(function (x) { return x.docId !== docId; }); renderReview(); loadFeed(); })
    .catch(function (e) {
      if (rowEl) rowEl.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      alert('Review action failed: ' + e.message);
    });
}

/* ============================ SUBSCRIPTIONS ============================ */
function loadSubs() {
  // API HOOK: GET /api/subscriptions
  return fetch('/api/subscriptions')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) { renderSubs(data.subscriptions || []); })
    .catch(function (e) { el('subsBody').innerHTML = stateRow(5, 'Could not load subscriptions: ' + e.message); });
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
    .then(function (r) { if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); }); return r.json(); })
    .then(function () {
      el('subsMsg').textContent = 'Created.';
      el('newClientId').value = ''; el('newTarget').value = '';
      loadSubs(); setTimeout(function () { el('subsMsg').textContent = ''; }, 2500);
    })
    .catch(function (e) { el('subsMsg').textContent = 'Failed: ' + e.message; });
}

/* ============================ ADMIN · CADENCE ============================ */
function loadPollConfig() {
  // API HOOK: GET /api/admin/poll-config
  return fetch('/api/admin/poll-config')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (cfg) {
      SCHEDULE = Array.isArray(cfg.schedule) ? cfg.schedule : [];
      aggressive = !!cfg.aggressiveMode;
      el('aggToggle').checked = aggressive;
      renderSchedule();
    })
    .catch(function (e) { el('schedRows').innerHTML = '<div class="note">Could not load poll config: ' + esc(e.message) + '</div>'; });
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
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schedule: SCHEDULE, aggressiveMode: aggressive })
  })
    .then(function (r) { if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); }); return r.json(); })
    .then(function () { el('saveMsg').textContent = 'Saved — effective within ~60s.'; setTimeout(function () { el('saveMsg').textContent = ''; }, 2500); })
    .catch(function (e) { el('saveMsg').textContent = 'Failed: ' + e.message; });
}

/* ============================ SOURCE HEALTH ============================ */
function loadHealth() {
  // API HOOK: GET /api/admin/sources/health
  return fetch('/api/admin/sources/health')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      var sources = data.sources || [];
      var body = el('healthBody');
      if (sources.length === 0) { body.innerHTML = stateRow(5, 'No poll activity logged yet.'); return; }
      body.innerHTML = sources.map(function (s) {
        var avg = s.avgIntervalSec == null ? '—' : '~' + Math.round(s.avgIntervalSec) + 's';
        return '<tr class="row">' +
          '<td>' + esc(s.source) + '</td>' +
          '<td class="muted">' + esc((s.lastPolledAt || '').replace('T', ' ').slice(0, 19) || '—') + '</td>' +
          '<td class="muted">' + esc((s.lastNewFilingAt || '').replace('T', ' ').slice(0, 19) || '—') + '</td>' +
          '<td class="muted">' + esc(s.pollCount != null ? s.pollCount : '—') + '</td>' +
          '<td class="latency">' + esc(avg) + '</td>' +
        '</tr>';
      }).join('');
    })
    .catch(function (e) { el('healthBody').innerHTML = stateRow(5, 'Could not load source health: ' + e.message); });
}

/* ============================ TABS + BOOT ============================ */
document.querySelectorAll('nav.tabs button').forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll('nav.tabs button').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    b.classList.add('active');
    el('view-' + b.dataset.view).classList.add('active');
    if (b.dataset.view === 'review') loadReview();
    if (b.dataset.view === 'subs') loadSubs();
    if (b.dataset.view === 'admin') { loadPollConfig(); loadHealth(); }
  };
});

// Initial loading states + boot.
el('feedBody').innerHTML = stateRow(9, 'Loading live feed…');
el('reviewBody').innerHTML = stateRow(5, 'Loading…');
el('subsBody').innerHTML = stateRow(5, 'Loading…');
el('healthBody').innerHTML = stateRow(5, 'Loading…');

loadFeed().then(function () { startStream(); });
loadReview();      // for the tab badge / KPI
loadPollConfig();  // for the poll-mode KPI
</script>
</body>
</html>`;
