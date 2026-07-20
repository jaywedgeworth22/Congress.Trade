/**
 * src/ui/__tests__/dashboardHtml.test.ts
 *
 * The dashboard ships as one big TypeScript template literal, so `tsc` only
 * type-checks it as a STRING — it never parses the embedded browser JS. These
 * tests close that gap: they extract every <script> block from DASHBOARD_HTML
 * and assert it parses (via `new Function`, which compiles without executing),
 * catching template-literal / syntax breakage that the type-checker can't see.
 * They also assert the Trends tab + its API wiring are present.
 */

import { describe, it, expect, vi } from 'vitest';
import { parse } from 'node-html-parser';
import { DASHBOARD_HTML } from '../dashboardHtml';

function scriptBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks;
}

function loadBenchmarkPresentationHelpers() {
  const match = DASHBOARD_HTML.match(
    /function benchmarkResultIsComplete\(result\) \{[\s\S]*?\n\}\n\nfunction normalizedBenchmarkLineup/,
  );
  if (!match) throw new Error('Benchmark presentation helpers were not found');
  const source = match[0].replace(/\n\nfunction normalizedBenchmarkLineup$/, '');
  return new Function(
    source + '\nreturn { benchmarkRunCellProgress, benchmarkModelPresentation, benchmarkModelEligibleForSimulation, benchmarkCompletionFeedback };',
  )() as {
    benchmarkRunCellProgress: (run: Record<string, unknown>) => Record<string, number | boolean | null>;
    benchmarkModelPresentation: (
      run: Record<string, unknown>,
      model: { provider: string; model: string },
      persisted?: Record<string, unknown>,
    ) => Record<string, unknown>;
    benchmarkModelEligibleForSimulation: (model: Record<string, unknown>) => boolean;
    benchmarkCompletionFeedback: (
      label: string,
      run: Record<string, unknown>,
      browserFailureCount: number,
      skippedModelCount?: number,
    ) => { warning: boolean; message: string };
  };
}

describe('DASHBOARD_HTML', () => {
  it('uses the concise product name as the document title', () => {
    expect(DASHBOARD_HTML).toContain('<title>Congress.Trade</title>');
    expect(DASHBOARD_HTML).not.toContain('<title>Congress.Trade — Congress Trade Feed</title>');
  });

  it('self-hosts the Zilla Slab wordmark face as an inline data-URI subset', () => {
    expect(DASHBOARD_HTML).toContain('data:font/woff2;base64,');
    expect(DASHBOARD_HTML).toContain("'Zilla Slab'");
  });

  it('contains at least the boot + main script blocks', () => {
    expect(scriptBlocks(DASHBOARD_HTML).length).toBeGreaterThanOrEqual(2);
  });

  it('every embedded <script> parses as valid JavaScript', () => {
    for (const js of scriptBlocks(DASHBOARD_HTML)) {
      // new Function compiles (parses) the body without running it — DOM refs OK.
      expect(() => new Function(js)).not.toThrow();
    }
  });

  it('keeps every primary view as a direct child of main', () => {
    const document = parse(DASHBOARD_HTML);
    const main = document.querySelector('main');
    expect(main).not.toBeNull();

    const viewIds = ['view-feed', 'view-trends', 'view-review', 'view-subs', 'view-admin'];
    expect(document.querySelectorAll('section.view').map((view) => view.id)).toEqual(viewIds);

    for (const id of viewIds) {
      const view = document.querySelector('#' + id);
      if (!view) throw new Error(id + ' should exist');
      expect(view.parentNode, id + ' must not be nested inside another hidden view').toBe(main);
    }
  });

  it('cleanAsset normalizes whitespace/suffixes without deleting letters (regex escaping)', () => {
    // The regexes live inside the template literal, so a single "\s" would be
    // cooked to "s" and cleanAsset would delete the letter s. Extract the real
    // emitted function body and exercise it.
    const m = DASHBOARD_HTML.match(/function cleanAsset\(s\) \{[\s\S]*?return t;\s*\}/);
    expect(m).not.toBeNull();
    // isScannedPdfPlaceholder is called by cleanAsset — stub it for isolation.
    const cleanAsset = new Function(
      'function isScannedPdfPlaceholder() { return false; }\n' +
        m![0] +
        '\nreturn cleanAsset;',
    )() as (s: string) => string;
    expect(cleanAsset('TESLA INC')).toBe('Tesla Inc.'); // 's' survives, suffix normalized
    expect(cleanAsset('Microsoft   Corporation')).toBe('Microsoft Corporation'); // ws collapsed, not deleted
    expect(cleanAsset('Apple Inc (NASDAQ: AAPL)')).toBe('Apple Inc.'); // exchange suffix stripped
  });

  it('keeps the What-Congress-Is-Trading header aligned to loadTrTickers row cells', () => {
    const thead = DASHBOARD_HTML.match(/<table id="tableTrTickers">\s*<thead>\s*<tr>([\s\S]*?)<\/tr>/);
    expect(thead).not.toBeNull();
    const headerCells = (thead![1].match(/<th/g) || []).length;
    expect(headerCells).toBe(6); // rank + Asset + Trades + Politicians + Est. Volume + Net $ Flow
  });

  it('wires the Trends tab, its containers, and the analytics API', () => {
    expect(DASHBOARD_HTML).toContain('data-view="trends"');
    expect(DASHBOARD_HTML).toContain('id="view-trends"');
    expect(DASHBOARD_HTML).toContain('/api/analytics/');
    expect(DASHBOARD_HTML).toContain('function loadTrends(');
    // key section containers the loaders target
    for (const id of ['trKpis', 'trTickers', 'trClusters', 'trTime', 'trMembers', 'trLateFilers']) {
      expect(DASHBOARD_HTML).toContain('id="' + id + '"');
    }
  });

  it('makes Trends the first, default-active view and renames Live Feed to Trades', () => {
    // Trends nav button comes before the feed (Trades) button and is the active one.
    const trendsIdx = DASHBOARD_HTML.indexOf('data-view="trends"');
    const feedIdx = DASHBOARD_HTML.indexOf('data-view="feed"');
    expect(trendsIdx).toBeGreaterThan(0);
    expect(trendsIdx).toBeLessThan(feedIdx);
    expect(DASHBOARD_HTML).toContain('data-view="trends" data-mobile="Trends" data-icon="⌁" class="active"');
    expect(DASHBOARD_HTML).toContain('<nav class="tabs" role="tablist" aria-label="Primary views">');
    expect(DASHBOARD_HTML).toContain('role="tab" aria-selected="true" aria-controls="view-trends"');
    expect(DASHBOARD_HTML).toContain('role="tabpanel" aria-labelledby="tab-trends" aria-hidden="false"');
    expect(DASHBOARD_HTML).toContain("x.setAttribute('aria-selected', 'false')");
    expect(DASHBOARD_HTML).toContain("view.setAttribute('aria-hidden', 'false')");
    // The Trends section is the default-active view; the feed section is not.
    expect(DASHBOARD_HTML).toContain('<section class="view active" id="view-trends" role="tabpanel"');
    expect(DASHBOARD_HTML).toContain('<section class="view" id="view-feed" role="tabpanel"');
    // The former "Live Feed" tab is now labelled "Trades".
    expect(DASHBOARD_HTML).toContain('data-view="feed" data-mobile="Trades" data-icon="▦"');
    expect(DASHBOARD_HTML).toContain('aria-controls="view-feed">Trades</button>');
    // Trends is warmed on boot since it is the landing view.
    expect(DASHBOARD_HTML).toContain('loadTrends(); // Trends is the default landing view');
  });

  it('exposes a public Alerts tab while keeping delivery MANAGEMENT admin-only', () => {
    // The Alerts tab is public nav (education for signed-out visitors)…
    expect(DASHBOARD_HTML).toMatch(/<button[^>]+data-view="subs"[^>]*>Alerts<\/button>/);
    expect(DASHBOARD_HTML).not.toMatch(/<button[^>]+data-view="subs"[^>]+data-admin-tab/);
    // The management section inside it is now visible to all.
    // Anon sees the table structure but gets a premium placeholder instead of data.
    expect(DASHBOARD_HTML).toContain('id="subsManage"');
    expect(DASHBOARD_HTML).toContain("document.querySelectorAll('[data-admin-only]')");
    expect(DASHBOARD_HTML).toContain('if (canUseAdmin()) loadSubs();');
    expect(DASHBOARD_HTML).toMatch(/<button[^>]+data-view="admin"[^>]+data-admin-tab="true"[^>]+hidden[^>]*>Admin · Cadence<\/button>/);
    expect(DASHBOARD_HTML).toContain('Developer Alert Delivery');
    expect(DASHBOARD_HTML).toContain('No alert deliveries yet. Create one below.');
    expect(DASHBOARD_HTML).not.toContain('>Subscriptions</button>');
    expect(DASHBOARD_HTML).not.toContain('<h3>Delivery Subscriptions</h3>');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/subscriptions', {");
    expect(DASHBOARD_HTML).toContain("headers: adminHeaders({ 'content-type': 'application/json' })");
  });

  it('teaches the two paid delivery methods to signed-out visitors', () => {
    expect(DASHBOARD_HTML).toContain('id="subsMarketing"');
    expect(DASHBOARD_HTML).toContain('Get the Filing First');
    expect(DASHBOARD_HTML).toContain('Signed Webhooks');
    expect(DASHBOARD_HTML).toContain('HMAC-SHA256');
    expect(DASHBOARD_HTML).toContain('Live Stream (SSE)');
    expect(DASHBOARD_HTML).toContain('EventSource');
    expect(DASHBOARD_HTML).toContain('openPricing(\'alerts\')');
    // CTA hides for premium/admin via the existing premium-cue mechanism.
    expect(DASHBOARD_HTML).toContain('data-premium-cue="alerts"');
    // Pricing modal now sells the delivery methods.
    expect(DASHBOARD_HTML).toContain("intent === 'alerts'");
    expect(DASHBOARD_HTML).toContain('signed webhooks (HMAC-verified) to any URL');
    expect(DASHBOARD_HTML).toContain('Live SSE stream of every new filing');
  });

  it('filters by branch via the segmented H·S·P strip, congressional by default', () => {
    // The strip replaces the old two-option chamber selects in BOTH views
    // (the admin seed-backfill selector stays congressional by design).
    expect(DASHBOARD_HTML).not.toContain('>Both Chambers</option><option value="house">House</option>');
    expect(DASHBOARD_HTML).toContain('class="branch-filters" id="qChamber"');
    expect(DASHBOARD_HTML).toContain('class="branch-filters" id="trChamber"');
    expect(DASHBOARD_HTML).toMatch(/data-ch="executive"[^>]*aria-pressed="false"/);
    expect(DASHBOARD_HTML).toMatch(/data-ch="house"[^>]*aria-pressed="true"/);
    // The executive toggle reads P (President), analogous to H and S — and each
    // letter carries the owner-specified hover text.
    expect(DASHBOARD_HTML).toMatch(/data-ch="executive"[^>]*title="Executive Branch trades — OGE Form 278-T">P</);
    expect(DASHBOARD_HTML).toMatch(/data-ch="house"[^>]*title="House trades — House Clerk PTR filings">H</);
    expect(DASHBOARD_HTML).toMatch(/data-ch="senate"[^>]*title="Senate trades — Senate eFD PTR filings">S</);
    // One grouped tap-friendly explainer per strip (mobile can't hover),
    // wired for hover-open on pointer devices and click-toggle everywhere.
    expect(DASHBOARD_HTML).toContain('class="branch-info" aria-expanded="false" aria-controls="qChamberInfo"');
    expect(DASHBOARD_HTML).toContain('class="branch-info" aria-expanded="false" aria-controls="trChamberInfo"');
    expect(DASHBOARD_HTML).toContain("initBranchInfo('qChamber')");
    expect(DASHBOARD_HTML).toContain("initBranchInfo('trChamber')");
    expect(DASHBOARD_HTML).toContain("window.matchMedia('(hover: hover)').matches");
    // Default (House+Senate) sends NO chamber param; selections send a CSV.
    expect(DASHBOARD_HTML).toContain("var CHAMBER_DEFAULT = ['house', 'senate']");
    expect(DASHBOARD_HTML).toContain('function chamberParam(');
    expect(DASHBOARD_HTML).toContain("initChamberChips('qChamber', 'feed-chambers-v1'");
    expect(DASHBOARD_HTML).toContain("initChamberChips('trChamber', 'trends-chambers-v1'");
    // At least one branch always stays selected.
    expect(DASHBOARD_HTML).toContain('chipSel(groupId).length <= 1) return');
  });

  it('renders the honest speed-vs-providers scoreboard on Trends', () => {
    expect(DASHBOARD_HTML).toContain('id="trLatencySection"');
    expect(DASHBOARD_HTML).toContain("fetch('/api/analytics/latency-summary')");
    // Filter-independent: not stamped with the Trends window chip and not in loadTrends.
    expect(DASHBOARD_HTML).not.toMatch(/Speed vs\. Data Providers[^<]*<\/h3[^>]*class="tf-h"/);
    expect(DASHBOARD_HTML).toContain('function renderSpeedProof(');
    // Honesty guard rails: lane threshold, empty-state copy,
    // losses always displayed, sample sizes visible, trademark fine print.
    expect(DASHBOARD_HTML).toContain('var SPEED_LANE_MIN_MATCHED = 5');
    expect(DASHBOARD_HTML).toContain("Probes haven't found overlapping disclosures yet.");
    expect(DASHBOARD_HTML).toContain('<span class="sp-wlt-key">Losses</span>');
    expect(DASHBOARD_HTML).toContain('matched so far');
    expect(DASHBOARD_HTML).toContain('A live measurement, not a promise');
    expect(DASHBOARD_HTML).toContain('trademarks of their respective owners');
    // Every comparable provider rides the same honesty rails — no name-based
    // exclusions (Quiver/Unusual Whales were once hidden here; owner restored).
    expect(DASHBOARD_HTML).not.toContain("p.label === 'Quiver Quantitative'");
    expect(DASHBOARD_HTML).not.toContain("p.label !== 'Quiver Quantitative'");
    // Accessible table twin + never buy/sell colors for the race.
    expect(DASHBOARD_HTML).toContain('id="speedTableBody"');
    expect(DASHBOARD_HTML).toContain('--rival');
    // The public pager mirrors the server's anti-scrape offset cap.
    expect(DASHBOARD_HTML).toContain('var MAX_PUBLIC_FEED_OFFSET = 10000');
  });

  it('requires explicit review type/date and preserves an unknown owner', () => {
    expect(DASHBOARD_HTML).toContain('>Transaction type</option>');
    expect(DASHBOARD_HTML).toContain('>Owner unknown</option>');
    expect(DASHBOARD_HTML).not.toContain("t.txType || t.type || 'P'");
    expect(DASHBOARD_HTML).not.toContain("t.owner || 'self'");
    expect(DASHBOARD_HTML).toContain("needs an explicit transaction type and date");
  });

  it('surfaces durable human holds with an explicit Retry Auto action', () => {
    expect(DASHBOARD_HTML).toContain('agreementSuppressedAt');
    expect(DASHBOARD_HTML).toContain('>Retry Auto</button>');
    expect(DASHBOARD_HTML).toContain('/retry-auto');
    expect(DASHBOARD_HTML).toContain('body: JSON.stringify({ reviewRevision: item && item.reviewRevision })');
  });

  it('surfaces the GICS sector flow, market-cap, and performer analytics in Trends', () => {
    for (const id of ['trSectorFlow', 'trCapFlow', 'trPerformers']) {
      expect(DASHBOARD_HTML).toContain('id="' + id + '"');
    }
    for (const fn of ['function loadTrSectorFlow(', 'function loadTrCapFlow(', 'function loadTrPerformers(']) {
      expect(DASHBOARD_HTML).toContain(fn);
    }
    expect(DASHBOARD_HTML).toContain("aGet('sector-flow?'");
    expect(DASHBOARD_HTML).toContain("aGet('market-cap-breakdown?'");
    expect(DASHBOARD_HTML).toContain("aGet('member-performance?'");
  });

  it('wires the configurable column registry + chooser', () => {
    expect(DASHBOARD_HTML).toContain('var FEED_COLS');
    expect(DASHBOARD_HTML).toContain('function renderFeedHeader(');
    expect(DASHBOARD_HTML).toContain('id="colChooser"');
    expect(DASHBOARD_HTML).toContain('id="colChooserBody"');
    expect(DASHBOARD_HTML).toContain('function resetCols(');
    expect(DASHBOARD_HTML).toContain("var COL_ORDER_KEY = 'feed-cols-order-v3'");
    expect(DASHBOARD_HTML).toContain('function moveColumn(');
    expect(DASHBOARD_HTML).toContain('Drag columns here to reorder the Trades table.');
    expect(DASHBOARD_HTML).toContain('draggable="true" data-colid');
    // the new date/lag columns the user asked for
    expect(DASHBOARD_HTML).toContain("id: 'traded'");
    expect(DASHBOARD_HTML).toContain("id: 'lag'");
    expect(DASHBOARD_HTML).toContain("id: 'published'");
    expect(DASHBOARD_HTML).toContain("id: 'filed'");
    expect(DASHBOARD_HTML).toContain("id: 'imported'");
  });

  it('gives mobile a compact sort control and hides the dead Columns chooser', () => {
    // The mobile-only sort select/direction toggle sits near the other feed filter
    // controls and shares sortKey/sortDir + the setSort() refetch path.
    expect(DASHBOARD_HTML).toContain('id="feedSortMobile"');
    expect(DASHBOARD_HTML).toContain('id="mobileSortKey"');
    expect(DASHBOARD_HTML).toContain('onchange="handleMobileSortKeyChange()"');
    expect(DASHBOARD_HTML).toContain('id="mobileSortDirBtn"');
    expect(DASHBOARD_HTML).toContain('onclick="toggleMobileSortDir()"');
    expect(DASHBOARD_HTML).toContain('function mobileSortableCols(');
    expect(DASHBOARD_HTML).toContain('function syncMobileSortControl(');
    expect(DASHBOARD_HTML).toContain('function handleMobileSortKeyChange(');
    expect(DASHBOARD_HTML).toContain('function toggleMobileSortDir(');
    expect(DASHBOARD_HTML).toContain('setSort(sel.value)');
    expect(DASHBOARD_HTML).toContain('setSort(sortKey); // same key -> setSort() flips sortDir');
    // updateSortIndicators() is the single hook both setSort() and renderFeedHeader()
    // already call, so the mobile control resyncs from state restored/changed elsewhere.
    expect(DASHBOARD_HTML).toContain('syncMobileSortControl();\n}');
    expect(DASHBOARD_HTML).toContain('.feed-sort-mobile { display: none;');
    expect(DASHBOARD_HTML).toContain('#view-feed .feed-sort-mobile { display: flex; }');
    // Columns chooser stays wired for desktop but is CSS-hidden on mobile — feedCardHtml()
    // renders a fixed field set, so the chooser has no visible effect on phones.
    expect(DASHBOARD_HTML).toContain('id="colsBtn"');
    expect(DASHBOARD_HTML).toContain('#colsBtn { display: none; }');
  });

  it('uses subtle Premium cues without implying the public feed is paywalled', () => {
    // Columns and CSV export are never Premium-gated: Premium is
    // delivery (webhooks/SSE) only.
    expect(DASHBOARD_HTML).not.toContain('data-premium-col');
    expect(DASHBOARD_HTML).not.toContain('Premium enrichment');
    expect(DASHBOARD_HTML).not.toContain("tier: 'premium'");
    expect(DASHBOARD_HTML).not.toContain('Premium Enrichment Columns');
    expect(DASHBOARD_HTML).not.toContain('CSV Export Requires Premium');
    expect(DASHBOARD_HTML).not.toContain('CSV export is Premium');
    expect(DASHBOARD_HTML).not.toContain('Full-history CSV exports');
    expect(DASHBOARD_HTML).not.toContain('Free view shows the last 30 days');
    expect(DASHBOARD_HTML).not.toContain('soon) real-time alerts');
    expect(DASHBOARD_HTML).not.toContain('Go Premium');
  });

  it('gates Premium checkout copy and actions on server billing availability', () => {
    expect(DASHBOARD_HTML).toContain('billing: { checkoutConfigured: false, portalConfigured: false, hasCustomer: false }');
    expect(DASHBOARD_HTML).toContain('function checkoutConfigured()');
    expect(DASHBOARD_HTML).toContain("ME.billing = d.billing || { checkoutConfigured: false, portalConfigured: false, hasCustomer: false }");
    expect(DASHBOARD_HTML).toContain('Premium checkout is not available yet.');
    expect(DASHBOARD_HTML).toContain("el('subscribeBtn').disabled = !available");
    expect(DASHBOARD_HTML).toContain('checkoutConfigured() ? \'<button class="btn sm" onclick="openPricing()">Premium</button>\' : \'\'');
    expect(DASHBOARD_HTML).not.toContain('function billingConfigured()');
  });

  it('keeps Billing Portal management independent from checkout readiness', () => {
    expect(DASHBOARD_HTML).toContain('function portalConfigured()');
    expect(DASHBOARD_HTML).toContain('function hasBillingAccount()');
    expect(DASHBOARD_HTML).toContain('hasBillingAccount() && portalConfigured()');
    expect(DASHBOARD_HTML).toContain('if (!portalConfigured() || !hasBillingAccount())');
    expect(DASHBOARD_HTML).toContain('Manage Subscription');
  });

  it('sends stable per-operation idempotency keys for Stripe writes', () => {
    expect(DASHBOARD_HTML).toContain('function newBillingRequestId()');
    expect(DASHBOARD_HTML).toContain("'Idempotency-Key': checkoutRequestId");
    expect(DASHBOARD_HTML).toContain("'Idempotency-Key': portalRequestId");
    expect(DASHBOARD_HTML.match(/checkoutRequestId = null/g)).toHaveLength(2); // declaration + plan change
    expect(DASHBOARD_HTML.match(/portalRequestId = null/g)).toHaveLength(1); // declaration only
  });

  it('keeps account sign-out discoverable from the account menu', () => {
    expect(DASHBOARD_HTML).toContain('id="acctMenuBtn"');
    expect(DASHBOARD_HTML).toContain('<span class="acct-label">Account</span>');
    expect(DASHBOARD_HTML).toContain('themeMenuLabel');
    expect(DASHBOARD_HTML).not.toContain('id="themeToggle"');
    expect(DASHBOARD_HTML).toContain('white-space:nowrap; overflow:hidden; text-overflow:ellipsis;');
    expect(DASHBOARD_HTML).toContain('Sign Out');
    expect(DASHBOARD_HTML).toContain('function logout()');
  });

  it('contains mobile-first feed and navigation hooks', () => {
    expect(DASHBOARD_HTML).toContain('data-mobile="Trades"');
    expect(DASHBOARD_HTML).toContain('id="feedCards"');
    expect(DASHBOARD_HTML).toContain('function feedCardHtml(');
    expect(DASHBOARD_HTML).toContain('function handleFeedOpenEvent(');
    expect(DASHBOARD_HTML).toContain('@media (max-width: 720px)');
    expect(DASHBOARD_HTML).toContain('(orientation: landscape) and (max-width: 950px)');
    expect(DASHBOARD_HTML).toContain('env(safe-area-inset-bottom)');
    expect(DASHBOARD_HTML).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(DASHBOARD_HTML).toContain('nav.tabs::after');
    expect(DASHBOARD_HTML).toContain('height:calc(120px + env(safe-area-inset-bottom))');
  });

  it('renders a dedicated one-time subscription secret panel', () => {
    expect(DASHBOARD_HTML).toContain('class="secret-panel"');
    expect(DASHBOARD_HTML).toContain('Save this secret now');
    expect(DASHBOARD_HTML).toContain('function copyFromData(');
    expect(DASHBOARD_HTML).toContain('Copy SSE URL');
  });

  it('wires the detail drawer (trade / asset / politician)', () => {
    expect(DASHBOARD_HTML).toContain('id="detailDrawer"');
    expect(DASHBOARD_HTML).toContain('id="detailDrawerBody"');
    expect(DASHBOARD_HTML).toContain('class="drawer-topbar"');
    expect(DASHBOARD_HTML).toContain('function openDrawer(');
    expect(DASHBOARD_HTML).toContain('function openTrade(');
    expect(DASHBOARD_HTML).toContain('function openAsset(');
    expect(DASHBOARD_HTML).toContain('function openMember(');
    // politician drawer hits the per-politician analytics endpoint
    expect(DASHBOARD_HTML).toContain("aGet('member/");
    // the old centered ticker modal is fully replaced by the drawer
    expect(DASHBOARD_HTML).not.toContain('tickerModal');
  });

  it('keeps mobile overlay controls dismissible and tap-safe', () => {
    expect(DASHBOARD_HTML).toContain('<dialog class="search-panel"');
    expect(DASHBOARD_HTML).toContain('function closePanels(');
    expect(DASHBOARD_HTML).toContain('function setPanelOpen(');
    expect(DASHBOARD_HTML).toContain('font-size:16px');
    expect(DASHBOARD_HTML).toContain('width:44px; height:44px');
  });

  it('formats dates and does not default unknown party to Independent', () => {
    expect(DASHBOARD_HTML).toContain('function dateText(');
    expect(DASHBOARD_HTML).toContain('function dateTimeText(');
    expect(DASHBOARD_HTML).toContain('function filedDetailText(');
    expect(DASHBOARD_HTML).toContain('Official Filing Date Unavailable');
    expect(DASHBOARD_HTML).toContain('function partyLabel(');
    expect(DASHBOARD_HTML).toContain("PARTY_NAME = { D: 'Democrat', R: 'Republican', O: 'Independent / Other' }");
    expect(DASHBOARD_HTML).not.toContain("p.partyBucket || 'O'");
    expect(DASHBOARD_HTML).not.toContain("esc(b || 'O')");
  });

  it('wires the per-trade performance line (price vs S&P)', () => {
    expect(DASHBOARD_HTML).toContain('function perfLineHtml(');
    expect(DASHBOARD_HTML).toContain("aGet('performance/");
    expect(DASHBOARD_HTML).toContain('tradeDatePerformance');
    expect(DASHBOARD_HTML).toContain('filingDatePerformance');
    expect(DASHBOARD_HTML).toContain('id="tradePerf"');
    expect(DASHBOARD_HTML).toContain('function companySectionHtml(');
  });

  it('renders plain-English filing notes and clickable drawer entities', () => {
    expect(DASHBOARD_HTML).toContain('function filingNotesHtml(');
    expect(DASHBOARD_HTML).toContain('function looksLikeRawExtractionPayload(');
    expect(DASHBOARD_HTML).toContain('function looksLikeRawTransactionLine(');
    expect(DASHBOARD_HTML).toContain('function isExtractionNoteKey(');
    expect(DASHBOARD_HTML).toContain('Historical source note:');
    expect(DASHBOARD_HTML).toContain("if (looksLikeRawExtractionPayload(text)) return '';");
    expect(DASHBOARD_HTML).toContain("if (looksLikeRawTransactionLine(text)) return '';");
    expect(DASHBOARD_HTML).toContain("e.target.closest('[data-member]')");
    expect(DASHBOARD_HTML).toContain("e.target.closest('[data-txid]')");
    // The company-drawer title is NOT clickable (it would just reopen the same drawer);
    // clickable entities are the politician/asset links inside the drawer body instead.
    expect(DASHBOARD_HTML).not.toContain('drawer-title-line clickable');
    expect(DASHBOARD_HTML).toContain('drawer-member-title');
    expect(DASHBOARD_HTML).toContain('color:var(--text)');
    expect(DASHBOARD_HTML).not.toContain('<pre class="raw-notes">');
  });

  it('uses published timing, tighter asset defaults, and source links in drawers', () => {
    expect(DASHBOARD_HTML).toContain("var sortKey = 'txdate'");
    expect(DASHBOARD_HTML).toContain("var COL_HIDDEN_KEY = 'feed-cols-hidden-v3'");
    expect(DASHBOARD_HTML).toContain("var COL_ORDER_KEY = 'feed-cols-order-v3'");
    expect(DASHBOARD_HTML).toContain("asset: estimatedColWidth('asset', 48, 40, 54)");
    expect(DASHBOARD_HTML).not.toContain('width: max-content');
    expect(DASHBOARD_HTML).not.toContain('feed-col-widths-v7');
    expect(DASHBOARD_HTML).toContain('function dateTimeCellHtml(');
    expect(DASHBOARD_HTML).toContain('date-time-cell');
    expect(DASHBOARD_HTML).toContain('#feedTable.resizable th { text-align: center;');
    expect(DASHBOARD_HTML).toContain('minColWidth(key)');
    expect(DASHBOARD_HTML).toContain("p.set('sort', apiSort)");
    expect(DASHBOARD_HTML).toContain("p.set('memberName', m)");
    expect(DASHBOARD_HTML).toContain('function handleFeedTextFilter(');
    expect(DASHBOARD_HTML).toContain('feedRequestSeq');
    expect(DASHBOARD_HTML).toContain("arr.textContent = '↕'");
    expect(DASHBOARD_HTML).toContain('function publishedDetailText(');
    expect(DASHBOARD_HTML).toContain('function miniSourceLinkHtml(');
    expect(DASHBOARD_HTML).toContain('function analyticsTradeRow(');
    expect(DASHBOARD_HTML).toContain('TRADE_BY_ID');
    expect(DASHBOARD_HTML).toContain("e.target.closest('a[href]')");
    expect(DASHBOARD_HTML).toContain('Official Filed');
  });

  it('keeps the polished table, drawer, and trends layout hooks', () => {
    expect(DASHBOARD_HTML).toContain('#feedHead th { position: sticky');
    expect(DASHBOARD_HTML).toContain('border-right: 1px solid color-mix');
    expect(DASHBOARD_HTML).toContain('#feedTable .c-member');
    expect(DASHBOARD_HTML).toContain('#feedTable .c-asset');
    expect(DASHBOARD_HTML).toContain('<colgroup id="feedCols"></colgroup>');
    expect(DASHBOARD_HTML).toContain('function syncFeedTableWidth(');
    expect(DASHBOARD_HTML).toContain('.clip-text { display:block;');
    expect(DASHBOARD_HTML).toContain('drawer-company-title');
    expect(DASHBOARD_HTML).toContain('drawer-stack-grid');
    expect(DASHBOARD_HTML).toContain('trend-members-grid');
    expect(DASHBOARD_HTML).toContain('.trend-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(DASHBOARD_HTML).toContain('.trend-members-grid { display:grid; grid-template-columns:minmax(0, 1.6fr) minmax(0, .85fr);');
    expect(DASHBOARD_HTML).not.toContain('minmax(260px, .72fr)');
    expect(DASHBOARD_HTML).toContain('buySellText(');
    expect(DASHBOARD_HTML).toContain('0% means matched the S&P');
    expect(DASHBOARD_HTML).toContain('Unparsed Historical Filing');
  });

  it('makes review documents linkable without showing false confidence for empty reads', () => {
    expect(DASHBOARD_HTML).toContain('function safeDocUrl(');
    expect(DASHBOARD_HTML).toContain('function reviewDocHtml(');
    expect(DASHBOARD_HTML).toContain('View Document');
    expect(DASHBOARD_HTML).toContain('No readable transactions');
    expect(DASHBOARD_HTML).toContain('Vision-read filing held for review');
    expect(DASHBOARD_HTML).toContain('Automated read below publish threshold');
    expect(DASHBOARD_HTML).toContain('rel="noopener noreferrer"');
  });

  it('pre-fills editable review rows from queued payloads or selected model readings', () => {
    expect(DASHBOARD_HTML).toContain('var REVIEW_RUNS');
    expect(DASHBOARD_HTML).toContain('function openQueuedReviewEditor(');
    expect(DASHBOARD_HTML).toContain('function useModelRows(');
    expect(DASHBOARD_HTML).toContain('function openReviewEditor(');
    expect(DASHBOARD_HTML).toContain('Review / Confirm');
    expect(DASHBOARD_HTML).toContain('Resolved Reviews');
    expect(DASHBOARD_HTML).toContain('All Filing Decisions');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/ingestion-decisions?limit=200'");
    expect(DASHBOARD_HTML).toContain('function hasAdminToken()');
    expect(DASHBOARD_HTML).toContain('function renderDecisionHistory(');
    expect(DASHBOARD_HTML).toContain('var DECISIONS');
    expect(DASHBOARD_HTML).toContain('Use This Model');
    expect(DASHBOARD_HTML).toContain('Bake-Off Runs (');
    expect(DASHBOARD_HTML).toContain('Queued Extracted Rows');
    expect(DASHBOARD_HTML).toContain('Prefilled Rows');
    expect(DASHBOARD_HTML).toContain('REVIEW_AMOUNT_BRACKETS');
    expect(DASHBOARD_HTML).toContain('class="me-bracket"');
    expect(DASHBOARD_HTML).toContain('class="me-asset-type"');
    expect(DASHBOARD_HTML).toContain('HOUSE_REVIEW_ASSET_TYPES');
    expect(DASHBOARD_HTML).toContain('SENATE_REVIEW_ASSET_TYPES');
    expect(DASHBOARD_HTML).toContain('function reviewAssetTypeDatalistId(');
    expect(DASHBOARD_HTML).toContain('function reviewNormalizeAssetTypeValue(');
    expect(DASHBOARD_HTML).toContain('list="');
    expect(DASHBOARD_HTML).toContain('5P');
    expect(DASHBOARD_HTML).toContain('Municipal Security');
    expect(DASHBOARD_HTML).toContain('Stock Option');
    expect(DASHBOARD_HTML).toContain("assetTypeName: reviewAssetTypeName(assetType) || (g.querySelector('.me-asset-type-name').value || '').trim() || null");
    expect(DASHBOARD_HTML).toContain("tr.setAttribute('data-chamber', chamber || '')");
    expect(DASHBOARD_HTML).toContain('class="me-option"');
    expect(DASHBOARD_HTML).toContain('Option Contract');
    expect(DASHBOARD_HTML).toContain('class="me-cap"');
    expect(DASHBOARD_HTML).toContain('class="me-filing-status"');
    expect(DASHBOARD_HTML).toContain('class="me-subholding"');
    expect(DASHBOARD_HTML).toContain('class="me-location"');
    expect(DASHBOARD_HTML).toContain('class="me-description"');
    expect(DASHBOARD_HTML).toContain('class="me-supplemental"');
    expect(DASHBOARD_HTML).toContain("filingStatus: (g.querySelector('.me-filing-status').value || '').trim() || null");
    expect(DASHBOARD_HTML).not.toContain('class="me-min"');
    expect(DASHBOARD_HTML).not.toContain('class="me-max"');
    expect(DASHBOARD_HTML).toContain("tr.setAttribute('data-review-revision'");
    expect(DASHBOARD_HTML).toContain("reviewRevision: Number(tr && tr.getAttribute('data-review-revision'))");
    expect(DASHBOARD_HTML).not.toContain('JSON.stringify({ decision: decision, edits: [] })');
  });

  it('uses review totals for queue KPIs and reloads them after review actions', () => {
    expect(DASHBOARD_HTML).toContain('var REVIEW_TOTALS = null;');
    expect(DASHBOARD_HTML).toContain('REVIEW_TOTALS = data.totals || null');
    expect(DASHBOARD_HTML).toContain('typeof REVIEW_TOTALS.unresolved === \'number\'');
    expect(DASHBOARD_HTML).toContain("else { loadReview(); }");
    expect(DASHBOARD_HTML).toContain('.then(function () { loadReview(); loadFeed(); })');
  });

  it('wires a per-doc "Re-read with model…" bake-off control with multi-select', () => {
    expect(DASHBOARD_HTML).toContain('var REREAD_MODELS = BENCHMARK_CATALOG');
    expect(DASHBOARD_HTML).toContain('function rereadModelOptionsHtml(');
    expect(DASHBOARD_HTML).toContain('function rereadControlHtml(');
    expect(DASHBOARD_HTML).toContain('function rereadWithModel(');
    expect(DASHBOARD_HTML).toContain('Re-read with model');
    // multi-select allows picking 2-3 models in one submit
    expect(DASHBOARD_HTML).toContain('id="reread-sel-\' + esc(docId) + \'" multiple');
    expect(DASHBOARD_HTML).toContain('id="reread-btn-\' + esc(docId) + \'"');
    expect(DASHBOARD_HTML).toContain('id="reread-msg-\' + esc(docId) + \'"');
    // grouped by provider via optgroup
    expect(DASHBOARD_HTML).toContain("'<optgroup label=\"' + esc(p) + '\">'");
    // posts the existing bake-off endpoint scoped to this doc, persisted
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/bakeoff'");
    expect(DASHBOARD_HTML).toContain('JSON.stringify({ docIds: [docId], models: chosen, persist: true })');
    // in-flight state + inline error handling reuses the file\'s existing patterns
    expect(DASHBOARD_HTML).toContain('btn.disabled = true; sel.disabled = true;');
    expect(DASHBOARD_HTML).toContain("msg.textContent = 'Select at least one model.'");
    expect(DASHBOARD_HTML).toContain("isAuthError(e) ? ADMIN_MOVED_MSG : ('Re-read failed: ' + e.message)");
    // refreshes this doc's runs display after a successful re-read
    expect(DASHBOARD_HTML).toContain('viewReadings(docId); // refresh this doc\'s runs display with the new reading(s)');
  });

  it('derives every model menu from the ONE server-injected benchmark catalog', () => {
    // The catalog is serialized from benchmarkModelCatalog() at module load —
    // no hand-maintained duplicate lists remain in the template.
    expect(DASHBOARD_HTML).toContain('var BENCHMARK_CATALOG = [');
    expect(DASHBOARD_HTML).toContain('var REREAD_MODELS = BENCHMARK_CATALOG;');
    expect(DASHBOARD_HTML).not.toContain("{ provider: 'gemini', model: 'gemini-3.5-flash' }");
    // Injected JSON carries the corrected DEFAULT_CANDIDATES + LlamaParse set.
    expect(DASHBOARD_HTML).toContain('{"provider":"gemini","model":"gemini-3.5-flash"}');
    expect(DASHBOARD_HTML).toContain('{"provider":"openai","model":"gpt-5.6-terra"}');
    expect(DASHBOARD_HTML).toContain('{"provider":"openrouter","model":"deepseek/deepseek-v4-pro"}');
    expect(DASHBOARD_HTML).toContain('{"provider":"openrouter","model":"deepseek/deepseek-v4-flash"}');
    expect(DASHBOARD_HTML).toContain('{"provider":"openrouter","model":"google/gemini-3.5-flash"}');
    expect(DASHBOARD_HTML).toContain('{"provider":"llamaparse","model":"fast"}');
    // Dead-on-OpenRouter slugs and the retired GPT-4o family never render.
    expect(DASHBOARD_HTML).not.toContain('gpt-4o');
    expect(DASHBOARD_HTML).not.toContain('google/gemini-pro-1.5');
    expect(DASHBOARD_HTML).not.toContain('deepseek/deepseek-chat');
    expect(DASHBOARD_HTML).not.toContain('deepseek/deepseek-coder');
    expect(DASHBOARD_HTML).not.toContain('qwen/qwen-2.5-vl-72b-instruct:free');
    expect(DASHBOARD_HTML).not.toContain('moonshotai/kimi-chat');
    expect(DASHBOARD_HTML).not.toContain('minimax/minimax-hep-lite');
    // The AG #462 custom-selection checkbox grid and quick-run menu read the
    // same derived list, so they reflect catalog corrections automatically.
    expect(DASHBOARD_HTML).toContain('id="benchmarkModelCheckboxes"');
    expect(DASHBOARD_HTML).toContain('Custom Model Selection (for new runs)');
    expect(DASHBOARD_HTML).toContain('function benchmarkModelCheckboxesHtml() {\n  return REREAD_MODELS.map(');
    expect(DASHBOARD_HTML).toContain("return '<option value=\"\">-- Choose Model --</option>' + REREAD_MODELS.map(");
    expect(DASHBOARD_HTML).toContain('customModels = REREAD_MODELS.map(');
  });

  it('renders ONE unified per-chamber Model slots (A–E) panel with a single save flow', () => {
    expect(DASHBOARD_HTML).toContain('id="benchmarkModelSlots"');
    expect(DASHBOARD_HTML).toContain('<h4>Model slots (A–E)</h4>');
    // Five labeled slot selects, populated from the server catalog.
    expect(DASHBOARD_HTML).toContain("id: 'slotModelA', slot: 'A', label: 'A — Primary extractor (reads every new filing first)'");
    expect(DASHBOARD_HTML).toContain("id: 'slotModelB', slot: 'B', label: 'B — Failover extractor (used when A fails)'");
    expect(DASHBOARD_HTML).toContain("id: 'slotModelC', slot: 'C', label: 'C — Agreement voter 1 (tier-1 pair)'");
    expect(DASHBOARD_HTML).toContain("id: 'slotModelD', slot: 'D', label: 'D — Agreement voter 2 (tier-1 pair)'");
    expect(DASHBOARD_HTML).toContain("id: 'slotModelE', slot: 'E', label: 'E — Agreement voter 3 (tier-2/3 escalation)'");
    expect(DASHBOARD_HTML).toContain('benchmarkManualOptionHtml(selected)');
    // One save button; the handler GETs fresh versions then PUTs roles (A/B)
    // followed by settings (C/D/E), reporting each call separately.
    expect(DASHBOARD_HTML).toContain('onclick="saveBenchmarkModelSlots()"');
    const save = DASHBOARD_HTML.match(/async function saveBenchmarkModelSlots\(\) \{[\s\S]*?\n\}/);
    expect(save).not.toBeNull();
    const gets = save![0].indexOf("apiCall('/api/admin/benchmark/roles/' + encodeURIComponent(chamber), 'GET')");
    const putRoles = save![0].indexOf("apiCall('/api/admin/benchmark/roles/' + encodeURIComponent(chamber), 'PUT'");
    const putSettings = save![0].indexOf("apiCall('/api/admin/benchmark/settings/' + encodeURIComponent(chamber), 'PUT'");
    expect(gets).toBeGreaterThan(0);
    expect(putRoles).toBeGreaterThan(gets);
    expect(putSettings).toBeGreaterThan(putRoles);
    expect(save![0]).toContain('expectedVersion: freshRoles.version');
    expect(save![0]).toContain('expectedVersion: freshSettings.version');
    expect(save![0]).toContain("outcomes.push('A/B not saved: ' + rolesError.message)");
    expect(save![0]).toContain("outcomes.push('C/D/E not saved: ' + lineupError.message)");
    // Client-side pre-checks stay, phrased for the A–E panel.
    expect(DASHBOARD_HTML).toContain('Choose a model for every slot (A–E).');
    expect(DASHBOARD_HTML).toContain('A (primary) and B (failover) must use different providers');
    expect(DASHBOARD_HTML).toContain('C, D, and E must be three different models.');
    expect(DASHBOARD_HTML).toContain('C, D, and E must use three different providers');
    // Non-blocking provider-overlap advisory (a warning line, not an error).
    expect(DASHBOARD_HTML).toContain('tier-1 agreement shares a provider with the primary extractor — votes are less independent');
    expect(DASHBOARD_HTML).toContain('function updateBenchmarkSlotWarnings(');
    // Preview deployments stay read-only.
    expect(DASHBOARD_HTML).toContain('Preview is read-only; save the live model slots in production after approval.');
    // The benchmark-backed (sourceRunId) save flow survives below the panel.
    expect(DASHBOARD_HTML).toContain('sourceRunId: run.id');
    // The two replaced panels are fully gone — no orphaned ids or handlers.
    for (const gone of [
      'manualModelA', 'manualModelB', 'manualModelC',
      'roleModelPrimary', 'roleModelFailover',
      'benchmarkManualLineup', 'id="benchmarkRoles"',
      'saveManualBenchmarkLineup', 'saveBenchmarkRoles',
      'manualBenchmarkLineupStatus', 'benchmarkRolesStatus',
      'loadAllModelSettings', 'renderModelSettingsForChamber',
      'modelSettingsHouse', 'modelSettingsSenate', 'modelSettingsExec',
      'chamberSettings', 'chamberRoles',
      'Manual autopublish lineup', 'Primary / Failover extraction',
    ]) {
      expect(DASHBOARD_HTML).not.toContain(gone);
    }
  });

  it('persists branch benchmarks and exposes measured cost, speed, history, simulation, and lineup save controls', () => {
    expect(DASHBOARD_HTML).toContain('id="benchmarkHistory"');
    expect(DASHBOARD_HTML).toContain("selectBenchmarkChamber('house')");
    expect(DASHBOARD_HTML).toContain("selectBenchmarkChamber('senate')");
    expect(DASHBOARD_HTML).toContain("selectBenchmarkChamber('executive')");
    expect(DASHBOARD_HTML).toContain("'/api/admin/benchmark/runs?chamber='");
    expect(DASHBOARD_HTML).toContain("'/api/admin/benchmark/runs/' + encodeURIComponent(run.id) + '/complete'");
    expect(DASHBOARD_HTML).toContain("'/simulate'");
    expect(DASHBOARD_HTML).toContain("'/api/admin/benchmark/settings/'");
    expect(DASHBOARD_HTML).toContain("'/api/admin/benchmark/runs?chamber=' + encodeURIComponent(chamber)");
    expect(DASHBOARD_HTML).toContain("onclick=\"clearBenchmarkHistory()\"");
    expect(DASHBOARD_HTML).toContain('Model slots (A–E)');
    expect(DASHBOARD_HTML).toContain('saveBenchmarkModelSlots');
    expect(DASHBOARD_HTML).toContain('runAllBenchmarks()');
    expect(DASHBOARD_HTML).toContain('result.reusedCells');
    expect(DASHBOARD_HTML).toContain('callsNeedingReservation');
    expect(DASHBOARD_HTML).toContain('confirmPaidRun: true');
    expect(DASHBOARD_HTML).toContain('resolvedOnly: false');
    expect(DASHBOARD_HTML).toContain('Measured usage-based cost');
    expect(DASHBOARD_HTML).toContain('Measured usage-based spend');
    expect(DASHBOARD_HTML).toContain('provider-reported charges where available, otherwise actual metered units × pinned list price');
    expect(DASHBOARD_HTML).toContain('This is not invoice reconciliation.');
    expect(DASHBOARD_HTML).toContain('Tier 1 executes A then B; disagreement adds a fresh A then B then C tier.');
    expect(DASHBOARD_HTML).toContain('An expired cell may already have been billed');
    expect(DASHBOARD_HTML).toContain('this confirmation authorizes a new-day reservation for each remaining cell');
    expect(DASHBOARD_HTML).toContain("error.details.code === 'benchmark_attempt_outcome_unknown'");
    expect(DASHBOARD_HTML).toContain('body.confirmRetryAfterUnknownOutcome = true');
    expect(DASHBOARD_HTML).toContain('result.auditPersisted === false');
    expect(DASHBOARD_HTML).toContain('Settings were saved and verified, but the benchmark receipt was not persisted.');
    expect(DASHBOARD_HTML).toContain('avg / p50 / p95');
    expect(DASHBOARD_HTML).toContain('Cost coverage');
    expect(DASHBOARD_HTML).toContain('Save as ');
    expect(DASHBOARD_HTML).toContain('three different providers');
    expect(DASHBOARD_HTML).not.toContain('var MODEL_COSTS');
    expect(DASHBOARD_HTML).not.toContain('Based on model list pricing');
  });

  it('labels interrupted benchmark cells as pending instead of unavailable', () => {
    const { benchmarkRunCellProgress, benchmarkModelPresentation } = loadBenchmarkPresentationHelpers();
    const models = [
      ['gemini', 'gemini-3.5-flash'],
      ['openai', 'gpt-5.6-terra'],
      ['openai', 'gpt-5.6-luna'],
      ['openai', 'gpt-5.6-sol'],
      ['openai', 'gpt-4o'],
      ['anthropic', 'claude-sonnet-5'],
      ['anthropic', 'claude-sonnet-5'],
      ['mistral', 'mistral-ocr-latest'],
      ['xai', 'grok-4.3'],
      ['llamaparse', 'fast'],
      ['llamaparse', 'cost-effective'],
      ['llamaparse', 'agentic'],
    ].map(([provider, model]) => ({ provider, model }));
    const results: Array<Record<string, unknown>> = [];
    for (const ref of models.slice(0, 8)) {
      for (let index = 0; index < 25; index++) {
        const ok = ref.model === 'gpt-4o' || ref.provider === 'mistral';
        results.push({
          ...ref,
          docId: 'D-' + index,
          outcome: ok ? 'would_publish' : 'skipped',
          invoked: true,
          ok,
          autonomous: ok,
          latencyMs: 100,
          costUsd: ok ? 0.001 : null,
          perfectMatch: index < 23 ? false : null,
        });
      }
    }
    for (let index = 0; index < 15; index++) {
      results.push({
        provider: 'xai', model: 'grok-4.3', docId: 'D-' + index, outcome: 'would_publish',
        invoked: index < 13, ok: index < 13, autonomous: index < 13,
        latencyMs: index < 13 ? 200 : null, costUsd: index < 13 ? 0.001 : null,
        perfectMatch: index < 13 ? false : null,
        error: index < 13 ? null : 'document_load_failed',
      });
    }
    // A claimed-but-unfinished cell stays pending and must not become unavailable.
    results.push({
      provider: 'llamaparse', model: 'fast', docId: 'D-0', outcome: 'running',
      invoked: false, ok: false, autonomous: false, latencyMs: null, costUsd: null,
    });
    const run = { status: 'running', requestedDocCount: 25, models, results };

    expect(benchmarkRunCellProgress(run)).toMatchObject({
      planned: 300,
      completed: 215,
      invoked: 213,
      success: 63,
      failures: 150,
      unavailable: 2,
      claimed: 1,
      pending: 85,
    });
    expect(benchmarkModelPresentation(run, { provider: 'xai', model: 'grok-4.3' })).toMatchObject({
      plannedDocs: 25,
      docsMeasured: 15,
      providerCalls: 13,
      docsOk: 13,
      unavailableDocs: 2,
      pendingDocs: 10,
    });
    expect(benchmarkModelPresentation(run, { provider: 'llamaparse', model: 'fast' })).toMatchObject({
      plannedDocs: 25,
      docsMeasured: 0,
      providerCalls: 0,
      unavailableDocs: 0,
      claimedDocs: 1,
      pendingDocs: 25,
    });
    expect(benchmarkModelPresentation(run, { provider: 'llamaparse', model: 'agentic' })).toMatchObject({
      docsMeasured: 0,
      unavailableDocs: 0,
      claimedDocs: 0,
      pendingDocs: 25,
    });
  });

  it('separates success latency from failed-attempt latency and exposes saved diagnostics', () => {
    const { benchmarkModelPresentation } = loadBenchmarkPresentationHelpers();
    const model = { provider: 'openai', model: 'gpt-test' };
    const run = {
      status: 'running',
      requestedDocCount: 4,
      models: [model],
      results: [
        {
          ...model, docId: 'H-1', outcome: 'would_publish', invoked: true, ok: true,
          autonomous: true, latencyMs: 500, costUsd: 0.01, perfectMatch: true,
          truePositive: 1, falsePositive: 0, falseNegative: 0,
        },
        {
          ...model, docId: 'H-2', outcome: 'skipped', invoked: true, ok: false,
          autonomous: false, latencyMs: 20, costUsd: null, perfectMatch: false,
          truePositive: 0, falsePositive: 0, falseNegative: 1,
          costDetail: { unknownReason: 'usage_not_reported' },
          result: { failure: { code: 'model_not_found', scope: 'model', retryable: false, message: 'Model is unavailable' } },
        },
        {
          ...model, docId: 'H-3', outcome: 'skipped', invoked: false, ok: false,
          autonomous: false, latencyMs: null, costUsd: null, perfectMatch: null,
          error: 'document_load_failed',
        },
        {
          ...model, docId: 'H-4', outcome: 'running', invoked: false, ok: false,
          autonomous: false, latencyMs: null, costUsd: null,
        },
      ],
    };
    const presentation = benchmarkModelPresentation(run, model) as {
      f1: number;
      autonomyRate: number;
      unavailableDocs: number;
      pendingDocs: number;
      claimedDocs: number;
      successLatency: { count: number; avgLatencyMs: number };
      failureLatency: { count: number; avgLatencyMs: number };
      errorGroups: Array<{ key: string; count: number }>;
      unknownCostGroups: Array<{ key: string; count: number }>;
      errorSamples: Array<{ code: string; scope: string; retryable: boolean }>;
    };

    expect(presentation).toMatchObject({
      f1: 2 / 3,
      autonomyRate: 1,
      unavailableDocs: 1,
      pendingDocs: 1,
      claimedDocs: 1,
      successLatency: { count: 1, avgLatencyMs: 500 },
      failureLatency: { count: 1, avgLatencyMs: 20 },
    });
    expect(presentation.errorGroups).toEqual([
      { key: 'document_unavailable', count: 1 },
      { key: 'model_not_found', count: 1 },
    ]);
    expect(presentation.unknownCostGroups).toEqual([{ key: 'usage_not_reported', count: 1 }]);
    expect(presentation.errorSamples[0]).toMatchObject({
      code: 'model_not_found', scope: 'model', retryable: false,
    });
  });

  it('redacts legacy provider, project, request, account, key, token, and URL identifiers', () => {
    const { benchmarkModelPresentation } = loadBenchmarkPresentationHelpers();
    const model = { provider: 'openai', model: 'gpt-test' };
    const presentation = benchmarkModelPresentation({
      status: 'completed',
      requestedDocCount: 1,
      models: [model],
      results: [{
        ...model,
        docId: 'H-1',
        outcome: 'skipped',
        invoked: true,
        ok: false,
        autonomous: false,
        costUsd: null,
        error: 'project proj_secret request req_secret account acct_secret key sk-secret123456 token: token-secret Authorization: Bearer bearer-secret https://api.example.test/private',
      }],
    }, model) as { errorSamples: Array<{ message: string }> };
    const message = presentation.errorSamples[0].message;

    expect(message).toContain('[redacted-id]');
    expect(message).toContain('[redacted-key]');
    expect(message).toContain('Bearer [redacted]');
    expect(message).toContain('[redacted-url]');
    expect(message).not.toMatch(/proj_secret|req_secret|acct_secret|sk-secret|token-secret|bearer-secret|api\.example/);
  });

  it('classifies legacy model access errors before generic 403 authentication failures', () => {
    const { benchmarkModelPresentation } = loadBenchmarkPresentationHelpers();
    const model = { provider: 'openai', model: 'gpt-restricted' };
    const presentation = benchmarkModelPresentation({
      status: 'completed',
      requestedDocCount: 2,
      models: [model],
      results: [
        {
          ...model, docId: 'H-1', outcome: 'skipped', invoked: true, ok: false,
          error: '403 model_not_found: this project does not have access to the requested model',
        },
        {
          ...model, docId: 'H-2', outcome: 'skipped', invoked: true, ok: false,
          error: '403 Forbidden: invalid API key',
        },
      ],
    }, model) as { errorGroups: Array<{ key: string; count: number }> };

    expect(presentation.errorGroups).toEqual([
      { key: 'authentication_failed', count: 1 },
      { key: 'model_unavailable', count: 1 },
    ]);
  });

  it('only admits completed models with successful scored readings to simulation', () => {
    const { benchmarkModelEligibleForSimulation } = loadBenchmarkPresentationHelpers();
    expect(benchmarkModelEligibleForSimulation({
      pendingDocs: 0, plannedDocs: 25, providerCalls: 25, docsOk: 25,
      failures: 0, unavailableDocs: 0, successfulScoredDocs: 23,
    })).toBe(true);
    expect(benchmarkModelEligibleForSimulation({
      pendingDocs: 25, plannedDocs: 25, providerCalls: 0, docsOk: 0,
      failures: 0, unavailableDocs: 0, successfulScoredDocs: 0,
    })).toBe(false);
    expect(benchmarkModelEligibleForSimulation({
      pendingDocs: 0, plannedDocs: 25, providerCalls: 25, docsOk: 0,
      failures: 25, unavailableDocs: 0, successfulScoredDocs: 0,
    })).toBe(false);
    expect(benchmarkModelEligibleForSimulation({
      pendingDocs: 0, plannedDocs: 25, providerCalls: 25, docsOk: 25,
      failures: 0, unavailableDocs: 0, successfulScoredDocs: 0,
    })).toBe(false);
    expect(benchmarkModelEligibleForSimulation({
      pendingDocs: 0, plannedDocs: 25, providerCalls: 25, docsOk: 24,
      failures: 1, unavailableDocs: 0, successfulScoredDocs: 23,
    })).toBe(false);
    expect(DASHBOARD_HTML).toContain('Simulation is disabled for this ');
    expect(DASHBOARD_HTML).toContain('completed models with successful scored readings');
    expect(DASHBOARD_HTML).toContain('unavailable, failed-only, unscored, or incomplete');
  });

  it('runs benchmark document chunks breadth-first across all models', () => {
    const source = DASHBOARD_HTML.match(/async function runChamberBenchmark\(chamber, options\) \{[\s\S]*?\n\}/);
    if (!source) throw new Error('Benchmark runner was not found');
    const chunkLoop = source[0].indexOf('for (var start = 0; start < docs.length; start += concurrency)');
    const modelLoop = source[0].indexOf('for (var modelIndex = 0; modelIndex < models.length; modelIndex++)');
    expect(chunkLoop).toBeGreaterThan(0);
    expect(modelLoop).toBeGreaterThan(chunkLoop);
    expect(source[0]).toContain('var concurrency = 5');
    expect(source[0]).toContain('Completed cells remain cached and are reused on Resume.');
    expect(source[0]).toContain('models = run.models || models');
    expect(source[0]).toContain('Known-unavailable GPT-5.6 models');
  });

  it('lets an operator terminalize a paused run while keeping partial results', () => {
    expect(DASHBOARD_HTML).toContain('id="btnCancelBenchmark"');
    expect(DASHBOARD_HTML).toContain('Stop and keep partial results');
    expect(DASHBOARD_HTML).toContain("'/api/admin/benchmark/runs/' + encodeURIComponent(run.id) + '/cancel'");
    expect(DASHBOARD_HTML).toContain("run.error === 'cancelled_by_operator'");
    expect(DASHBOARD_HTML).toContain('stopped (partial results kept)');
    expect(DASHBOARD_HTML).toContain("? 'Start new ' : 'Run '");
    expect(DASHBOARD_HTML).toContain('This cannot be resumed; use Start New for a clean run.');
    expect(DASHBOARD_HTML).toContain('A cell already claimed or in flight may still finish and incur a provider charge.');
    expect(DASHBOARD_HTML).toContain("run.chamber === benchmarkState.chamber && run.status === 'running'");
    expect(DASHBOARD_HTML).toContain('Select the paused ');
    expect(DASHBOARD_HTML).toContain('before starting a clean run.');
  });

  it('warns after a saved run with provider failures instead of claiming an unqualified success', () => {
    const { benchmarkCompletionFeedback } = loadBenchmarkPresentationHelpers();
    const model = { provider: 'openai', model: 'gpt-test' };
    const failed = benchmarkCompletionFeedback('House', {
      status: 'completed', requestedDocCount: 1, models: [model],
      results: [{ ...model, outcome: 'skipped', invoked: true, ok: false, costUsd: null }],
    }, 0);
    expect(failed.warning).toBe(true);
    expect(failed.message).toContain('1 provider failure');
    expect(failed.message).toContain('Review diagnostics');

    const accessFiltered = benchmarkCompletionFeedback('House', {
      status: 'completed', requestedDocCount: 1, models: [model],
      results: [{ ...model, outcome: 'would_publish', invoked: true, ok: true, costUsd: 0.01 }],
    }, 0, 3);
    expect(accessFiltered.message).toContain('3 known-unavailable models excluded before paid calls');

    const successful = benchmarkCompletionFeedback('Senate', {
      status: 'completed', requestedDocCount: 1, models: [model],
      results: [{ ...model, outcome: 'would_publish', invoked: true, ok: true, costUsd: 0.01 }],
    }, 0);
    expect(successful).toEqual({ warning: false, message: 'Senate benchmark saved.' });
  });

  it('renders explicit progress, paused state, diagnostics, and split latency labels', () => {
    expect(DASHBOARD_HTML).toContain("return active ? 'running in this browser' : 'paused / resumable'");
    expect(DASHBOARD_HTML).toContain("(model.docsOk || 0) + ' success / ' + model.plannedDocs + ' planned'");
    expect(DASHBOARD_HTML).toContain("model.docsMeasured + ' measured · ' + model.providerCalls + ' invoked · '");
    expect(DASHBOARD_HTML).toContain("' unavailable · ' + model.pendingDocs + ' pending'");
    expect(DASHBOARD_HTML).toContain('Successful calls: ');
    expect(DASHBOARD_HTML).toContain('Failed attempts: ');
    expect(DASHBOARD_HTML).toContain('Failure classes:');
    expect(DASHBOARD_HTML).toContain('Unknown-cost reasons:');
    expect(DASHBOARD_HTML).toContain('they are not counted as unavailable');
    expect(DASHBOARD_HTML).toContain('progress loads on selection');
    expect(DASHBOARD_HTML).toContain('<th scope="col">Exact document match</th>');
    expect(DASHBOARD_HTML).toContain('<th scope="col">Row-detection F1</th>');
    expect(DASHBOARD_HTML).toContain('optional metadata is excluded from row identity');
    expect(DASHBOARD_HTML).toContain('function benchmarkModelAccessPreflightHtml(run)');
    expect(DASHBOARD_HTML).toContain('excluded before paid-call reservation and remain saved with this run');
  });

  it('never labels aggregate partial spend as per-document benchmark cost', () => {
    const usdSource = DASHBOARD_HTML.match(/function benchmarkUsd\(value\) \{[\s\S]*?\n\}/);
    const costSource = DASHBOARD_HTML.match(/function benchmarkCostText\(perDocument, covered, calls, knownCostUsd\) \{[\s\S]*?\n\}/);
    expect(usdSource).not.toBeNull();
    expect(costSource).not.toBeNull();
    const costText = new Function(
      usdSource![0] + '\n' + costSource![0] + '\nreturn benchmarkCostText;',
    )() as (perDocument: number | null, covered: number, calls: number, knownCostUsd?: number | null) => string;

    expect(costText(0.012, 2, 2)).toBe('$0.012');
    expect(costText(null, 1, 2, 0.1160589)).toBe('$0.116 known (partial)');
    expect(costText(null, 1, 2)).toBe('Unknown (partial)');
    expect(costText(null, 0, 2)).toBe('Unknown');
    expect(costText(null, 0, 0)).toBe('N/A');
    expect(DASHBOARD_HTML).not.toContain("benchmarkUsd(known) + '+ partial'");
  });

  it('requires one explicit confirmation before retrying an unknown paid benchmark outcome', async () => {
    const combined = DASHBOARD_HTML.match(
      /function confirmBenchmarkUnknownOutcomeRetry\(docId, model\) \{[\s\S]*?\n\}\n\nasync function runBenchmarkCell\(runId, docId, model\) \{[\s\S]*?\n\}\n\nasync function runChamberBenchmark/,
    );
    expect(combined).not.toBeNull();
    const source = combined![0].replace(/\n\nasync function runChamberBenchmark[\s\S]*$/, '');
    const model = { provider: 'openai', model: 'gpt-4o' };
    const state = { unknownOutcomeRetryDecision: null as boolean | null };
    const confirm = vi.fn(() => true);
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const apiCall = vi.fn(async (_path: string, _method: string, body: Record<string, unknown>) => {
      bodies.push({ ...body });
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error('unknown provider outcome'), {
          status: 409,
          details: { code: 'benchmark_attempt_outcome_unknown' },
        });
      }
      return { pending: false, ok: true };
    });
    const runCell = new Function(
      'apiCall',
      'benchmarkState',
      'window',
      'benchmarkModelKey',
      source + '\nreturn runBenchmarkCell;',
    )(
      apiCall,
      state,
      { confirm },
      (value: { provider: string; model: string }) => value.provider + ':' + value.model,
    ) as (runId: string, docId: string, model: { provider: string; model: string }) => Promise<unknown>;

    await expect(runCell('run-1', 'H-1', model)).resolves.toMatchObject({ ok: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toMatchObject({ confirmPaidRun: true });
    expect(bodies[0]).not.toHaveProperty('confirmRetryAfterUnknownOutcome');
    expect(bodies[1]).toMatchObject({ confirmRetryAfterUnknownOutcome: true });

    const declinedApi = vi.fn(async () => {
      throw Object.assign(new Error('unknown provider outcome'), {
        status: 409,
        details: { code: 'benchmark_attempt_outcome_unknown' },
      });
    });
    const declinedConfirm = vi.fn(() => false);
    const declinedRunCell = new Function(
      'apiCall',
      'benchmarkState',
      'window',
      'benchmarkModelKey',
      source + '\nreturn runBenchmarkCell;',
    )(
      declinedApi,
      { unknownOutcomeRetryDecision: null },
      { confirm: declinedConfirm },
      (value: { provider: string; model: string }) => value.provider + ':' + value.model,
    ) as (runId: string, docId: string, model: { provider: string; model: string }) => Promise<unknown>;

    await expect(declinedRunCell('run-1', 'H-1', model)).rejects.toThrow(/Retry was not confirmed/);
    expect(declinedConfirm).toHaveBeenCalledTimes(1);
    expect(declinedApi).toHaveBeenCalledTimes(1);
  });

  it('keeps House history backfill bounded from the admin UI', () => {
    expect(DASHBOARD_HTML).toContain('id="hiMax"');
    expect(DASHBOARD_HTML).toContain('value="500"');
    expect(DASHBOARD_HTML).toContain('maxFilings: max');
    expect(DASHBOARD_HTML).toContain('Dry Run only counts');
  });

  it('surfaces admin diagnostics for connections and app errors', () => {
    expect(DASHBOARD_HTML).toContain('Connection Status');
    expect(DASHBOARD_HTML).toContain('Recent App Errors');
    expect(DASHBOARD_HTML).toContain('id="diagConnections"');
    expect(DASHBOARD_HTML).toContain('id="diagErrors"');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/diagnostics'");
    expect(DASHBOARD_HTML).toContain('function loadDiagnostics(');
  });

  it('surfaces market-data coverage and bounded backfill controls in Admin', () => {
    expect(DASHBOARD_HTML).toContain('Market Data Coverage');
    expect(DASHBOARD_HTML).toContain('id="marketCoverage"');
    expect(DASHBOARD_HTML).toContain('function loadMarketCoverage(');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/enrich-securities/status'");
    expect(DASHBOARD_HTML).toContain('function runMarketBackfill(');
    expect(DASHBOARD_HTML).toContain("fetch('/api/admin/backfill-market'");
    expect(DASHBOARD_HTML).toContain('Missing Asset Samples');
  });

  it('keeps the educational + dollar-estimate disclaimers in the Trends view', () => {
    expect(DASHBOARD_HTML).toContain('estimates');
    expect(DASHBOARD_HTML.toLowerCase()).toContain('bracket');
    expect(DASHBOARD_HTML).toContain('from STOCK Act amount ranges');
    expect(DASHBOARD_HTML).toContain('<em>Primary Only</em>');
    expect(DASHBOARD_HTML).not.toContain('<em>Live Only</em>');
    expect(DASHBOARD_HTML).toContain('info-tip');
    // educational / liability framing must remain user-facing
    expect(DASHBOARD_HTML).toContain('not investment advice');
    expect(DASHBOARD_HTML.toLowerCase()).toContain('not financial advice');
    expect(DASHBOARD_HTML.toLowerCase()).toContain('educational');
  });

  it('formats trade amount brackets compactly', () => {
    expect(DASHBOARD_HTML).toContain('function fmtBracketAmount(');
    expect(DASHBOARD_HTML).toContain("fmtBracketAmount(min) + ' - '");
  });

  it('renders amount bracket categories above the compact amount text', () => {
    expect(DASHBOARD_HTML).toContain('function amountTier(');
    expect(DASHBOARD_HTML).toContain('function amountBarsHtml(');
    expect(DASHBOARD_HTML).toContain('function amountCellHtml(');
    expect(DASHBOARD_HTML).toContain("label: 'Up to $15k'");
    expect(DASHBOARD_HTML).toContain("label: 'Over $1M'");
    expect(DASHBOARD_HTML).toContain('class="amount-bars tier-');
    expect(DASHBOARD_HTML).toContain('class="amount-range fc-amt-val"');
    expect(DASHBOARD_HTML).toContain('cell: amountCellHtml');
    expect(DASHBOARD_HTML).not.toContain("label: 'Tier I'");
    expect(DASHBOARD_HTML).not.toContain('<span>\' + esc(tier.label)');
  });

  it('does not use imported/published time as disclosure lag', () => {
    expect(DASHBOARD_HTML).toContain("function lagBasisDate(r) { return (r && (r.filedDate || r.filed)) || ''; }");
    expect(DASHBOARD_HTML).not.toContain('r.filedDate || r.filed || publishedRaw(r)');
    expect(DASHBOARD_HTML).not.toContain('using Congress.Trade import date');
  });

  it('explains disclosure timeliness metrics and keeps slowest filers scrollable', () => {
    expect(DASHBOARD_HTML).toContain('class="trend-grid2 timeliness-grid"');
    expect(DASHBOARD_HTML).toContain('id="trLagDist" class="lag-dist"');
    expect(DASHBOARD_HTML).toContain('.timeliness-grid { margin-top: 8px; grid-template-columns: minmax(0, 1fr) minmax(0, .92fr);');
    expect(DASHBOARD_HTML).not.toContain('minmax(280px, .92fr)');
    expect(DASHBOARD_HTML).toContain('Disclosure lag is days between the transaction date and the official filing date.');
    expect(DASHBOARD_HTML).toContain('Avg: mean number of days between transaction date and official filing date.');
    expect(DASHBOARD_HTML).toContain('Max: longest single trade-to-filing delay');
    expect(DASHBOARD_HTML).toContain('Late: count of this filer\\\'s dated trade rows filed more than 45 days');
    expect(DASHBOARD_HTML).toContain('lf.slice(0, 50)');
  });

  it('uses responsive plain-English timeliness KPI labels', () => {
    expect(DASHBOARD_HTML).toContain("kpiLabel('90<sup>th</sup> Percentile', '90th Pctl', 'P90')");
    expect(DASHBOARD_HTML).toContain("kpiLabel('&gt;45 Day Lag', '>45d Lag', '>45d')");
    expect(DASHBOARD_HTML).toContain('#trLagKpis .k-label .k-mid');
    expect(DASHBOARD_HTML).not.toContain("kpi('90th Pct'");
    expect(DASHBOARD_HTML).not.toContain("kpi('Filed >45d'");
  });

  it('provides name/chamber/state/class display formatters', () => {
    for (const fn of ['function fmtName(', 'function chamberLabel(', 'function stateName(', 'function assetClassLabel(', 'function assetTypeLabel(', 'function assetTypeDetailHtml(']) {
      expect(DASHBOARD_HTML).toContain(fn);
    }
    // suffix + state maps present
    expect(DASHBOARD_HTML).toContain("'jr': 'Jr'");
    expect(DASHBOARD_HTML).toContain("CA: 'California'");
    expect(DASHBOARD_HTML).toContain("etf: 'ETF'");
    expect(DASHBOARD_HTML).toContain("['GS', 'Government Securities and Agency Debt', 'Government / Municipal Debt']");
    expect(DASHBOARD_HTML).toContain("['ST', 'Stocks (including ADRs)', 'Public Equity']");
    expect(DASHBOARD_HTML).toContain("kvRow('Asset Type', assetTypeDetailHtml(row))");
    expect(DASHBOARD_HTML).not.toContain("kvRow('Instrument', row.isOption ? 'Option' : 'Equity / Other')");
  });

  it('renames Members→Politicians and Tickers→Assets and softens Est.→Approx', () => {
    expect(DASHBOARD_HTML).toContain("kpi('Politicians'");
    expect(DASHBOARD_HTML).toContain("kpi('Assets'");
    expect(DASHBOARD_HTML).toContain("kpiInfo('Approx. Volume'");
    expect(DASHBOARD_HTML).toContain("kvRow('Distinct Assets'");
    expect(DASHBOARD_HTML).not.toContain("kpi('Members'");
    expect(DASHBOARD_HTML).not.toContain("kpi('Tickers'");
    expect(DASHBOARD_HTML).not.toContain('Most-traded tickers');
    expect(DASHBOARD_HTML).not.toContain('0B / ');
  });

  it('hides trade-row source provenance from the public feed', () => {
    expect(DASHBOARD_HTML).not.toContain('id="qSource"');
    expect(DASHBOARD_HTML).not.toContain("kvRow('Source', esc(sourceLabel(row.source)))");
    // the document link ("View source filing") is intentionally kept
    expect(DASHBOARD_HTML).toContain('View source filing');
  });

  it('uses a compact 2-row mobile feed card with an open-trade chevron', () => {
    for (const s of ['fc-main', 'fc-row1', 'fc-row2', 'fc-amt-val', 'fc-chevron']) {
      expect(DASHBOARD_HTML).toContain(s);
    }
    expect(DASHBOARD_HTML).not.toContain('feed-card-top');
  });

  it('differentiates the trade drawer from the company drawer', () => {
    expect(DASHBOARD_HTML).toContain('drawer-trade-head');
    expect(DASHBOARD_HTML).toContain('drawer-trade-identity');
    expect(DASHBOARD_HTML).toContain('drawer-trade-party');
    expect(DASHBOARD_HTML).toContain('drawer-kicker');
    expect(DASHBOARD_HTML).toContain('drawer-trade-headline');
    // ticker shown but NOT clickable in its own trade context (no data-asset on the in-line)
    expect(DASHBOARD_HTML).toContain('drawer-trade-in');
  });

  it('compacts the company profile into a responsive definition grid', () => {
    expect(DASHBOARD_HTML).toContain('def-grid');
    expect(DASHBOARD_HTML).toContain('repeat(auto-fit, minmax(130px, 1fr))');
    expect(DASHBOARD_HTML).toContain("item('IPO', ref.ipoDate ? esc(dateText(ref.ipoDate)) : '')");
  });

  it('adds a collapsible disclaimer and tap-to-reveal tooltips', () => {
    expect(DASHBOARD_HTML).toContain('function toggleDisclaimer(');
    expect(DASHBOARD_HTML).toContain('id="trDisclaimer"');
    expect(DASHBOARD_HTML).toContain('_disclaimerAutoTimer');
    expect(DASHBOARD_HTML).toContain('For Educational Use, Not Investment Advice');
    expect(DASHBOARD_HTML).toContain('class="dt-more"');
    expect(DASHBOARD_HTML).toContain('tip-pop');
    expect(DASHBOARD_HTML).toContain('(hover: none)');
  });

  it('gives AAPL a themeable glyph logo and reconstructs House filing links', () => {
    expect(DASHBOARD_HTML).toContain('CUSTOM_GLYPH');
    expect(DASHBOARD_HTML).toContain('function reconstructFilingUrl(');
    expect(DASHBOARD_HTML).toContain('public_disc/ptr-pdfs/');
  });

  it('labels every analytics section with its timeframe', () => {
    expect(DASHBOARD_HTML).toContain('function windowLabel(');
    expect(DASHBOARD_HTML).toContain('function stampWindowChips(');
    expect(DASHBOARD_HTML).toContain('stampWindowChips();'); // called in loadTrends
    expect(DASHBOARD_HTML).toContain('class="tf-h"');
// expect(DASHBOARD_HTML).toContain('id="trKpisCap"');
  });

  it('gives Net Flow a tooltip and de-underlines the info marker', () => {
    expect(DASHBOARD_HTML).toContain("kpiInfo('Net Flow'");
    expect(DASHBOARD_HTML).toContain('NET_FLOW_TIP');
    // info-tip marker: no dotted underline, raised toward the top
    expect(DASHBOARD_HTML).not.toContain('.info-tip { color: var(--text-dim); cursor: help; border-bottom: 1px dotted var(--text-dim); }');
    expect(DASHBOARD_HTML).toContain('.est-money::first-letter');
  });

  it('uses skeleton-shimmer loaders in the Trends view', () => {
    for (const fn of ['function skCards(', 'function skRows(', 'function skBars(', 'function skChart(']) {
      expect(DASHBOARD_HTML).toContain(fn);
    }
    expect(DASHBOARD_HTML).toContain('@keyframes tr-shimmer');
    expect(DASHBOARD_HTML).toContain('prefers-reduced-motion');
  });

  it('adds an independent time-range control to the buys/sells chart, anchored to recent', () => {
    expect(DASHBOARD_HTML).toContain('id="trTimeWin"');
    expect(DASHBOARD_HTML).toContain('function setTrTimeWin(');
    expect(DASHBOARD_HTML).toContain('function anchorChartRight(');
    expect(DASHBOARD_HTML).toContain('function trTimeParams(');
    expect(DASHBOARD_HTML).toContain('tc.scrollLeft = tc.scrollWidth');
  });

  it('surfaces source error and stale status instead of showing only successful polls', () => {
    expect(DASHBOARD_HTML).toContain('<th>Status</th>');
    expect(DASHBOARD_HTML).toContain('s.lastError');
    expect(DASHBOARD_HTML).toContain('s.stale');
    expect(DASHBOARD_HTML).toContain("stateRow(9, 'No source check activity logged yet.')");
  });

  it('wires the consensus grid + "Use Consensus" prefill alongside the per-model bake-off panel', () => {
    expect(DASHBOARD_HTML).toContain('var REVIEW_CONSENSUS');
    expect(DASHBOARD_HTML).toContain('function consensusGridHtml(');
    expect(DASHBOARD_HTML).toContain('function useConsensusRows(');
    expect(DASHBOARD_HTML).toContain('function consensusFieldValueForEdit(');
    expect(DASHBOARD_HTML).toContain('function consensusApplyField(');
    expect(DASHBOARD_HTML).toContain('REVIEW_CONSENSUS[docId] = data.consensus || null;');
    expect(DASHBOARD_HTML).toContain('REVIEW_CONSENSUS_STATUS[docId] = data.consensusStatus || null;');
    expect(DASHBOARD_HTML).toContain("}).join('') + consensusGridHtml(docId, data.consensus, data.consensusStatus);");
    // reuses the existing .conf hi/mid/lo confidence-color classes — no new stylesheet
    expect(DASHBOARD_HTML).toContain('function consensusFieldClass(fc) {');
    expect(DASHBOARD_HTML).toContain("if (fc.unanimous) return 'hi';");
    expect(DASHBOARD_HTML).toContain('<div class="conf hi">');
    expect(DASHBOARD_HTML).toContain('<div class="conf mid"');
    expect(DASHBOARD_HTML).toContain('<div class="conf lo"');
    expect(DASHBOARD_HTML).toContain('Queue-first safety');
    expect(DASHBOARD_HTML).toContain('Missing row from:');
    expect(DASHBOARD_HTML).toContain('Contested ');
    expect(DASHBOARD_HTML).not.toContain('.consensus-cell');
    expect(DASHBOARD_HTML).not.toContain('.consensus-grid {');
    // "Use This Model" and the queued-payload prefill stay wired unchanged (consensus is opt-in)
    expect(DASHBOARD_HTML).toContain('function useModelRows(docId, idx) {');
    expect(DASHBOARD_HTML).toContain("openReviewEditor(docId, rows, 'confirm', 'queued extracted rows', item && item.chamber);");
  });
});

/**
 * The consensus grid + "Use Consensus" prefill do real per-field branching
 * (majority vs. contested) that a plain `toContain` check on the template
 * literal can't exercise. These tests pull the actual function/var source
 * back out of DASHBOARD_HTML and compile it with `new Function`, so they run
 * the shipped logic itself rather than a re-implementation. DOM-touching
 * collaborators (openReviewEditor, reviewItemForDoc, reviewPayloadTransactions,
 * alert) are swapped for recording stubs since this suite runs outside a DOM.
 */
describe('consensus grid + Use Consensus prefill (executed)', () => {
  function extractFn(html: string, name: string): string {
    const marker = 'function ' + name + '(';
    const start = html.indexOf(marker);
    if (start < 0) throw new Error('function not found in DASHBOARD_HTML: ' + name);
    const braceStart = html.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    return html.slice(start, i);
  }

  function extractVarDecl(html: string, name: string): string {
    const re = new RegExp('var ' + name + ' = [\\s\\S]*?;');
    const m = re.exec(html);
    if (!m) throw new Error('var not found in DASHBOARD_HTML: ' + name);
    return m[0];
  }

  interface ConsensusSandbox {
    consensusGridHtml: (docId: string, consensus: unknown, status?: unknown) => string;
    useConsensusRows: (docId: string) => void;
    setReviewItem: (item: unknown) => void;
    setQueued: (rows: unknown[]) => void;
    setConsensus: (docId: string, consensus: unknown) => void;
    getEditorCall: () => null | { docId: string; rows: any[]; decision: string; label: string; chamber: string };
    getAlerts: () => string[];
  }

  function loadConsensusSandbox(): ConsensusSandbox {
    const html = DASHBOARD_HTML;
    const src = [
      'var CAPTURED_EDITOR_CALL = null;',
      'var ALERTS = [];',
      'var REVIEW_ITEM_FOR_TEST = null;',
      'var QUEUED_FOR_TEST = [];',
      'function alert(msg) { ALERTS.push(msg); }',
      'function openReviewEditor(docId, rows, decision, label, chamber) { CAPTURED_EDITOR_CALL = { docId: docId, rows: rows, decision: decision, label: label, chamber: chamber }; }',
      'function reviewItemForDoc(docId) { return REVIEW_ITEM_FOR_TEST; }',
      'function reviewPayloadTransactions(payload) { return QUEUED_FOR_TEST; }',
      'var REVIEW_CONSENSUS = {};',
      extractVarDecl(html, 'CONSENSUS_FIELD_ORDER'),
      extractVarDecl(html, 'CONSENSUS_FIELD_LABEL'),
      extractFn(html, 'esc'),
      extractFn(html, 'reviewMoney'),
      extractFn(html, 'reviewBracketLabel'),
      extractFn(html, 'consensusHasMajority'),
      extractFn(html, 'consensusFieldClass'),
      extractFn(html, 'consensusFieldDisplay'),
      extractFn(html, 'consensusModelFieldValue'),
      extractFn(html, 'consensusFieldCellHtml'),
      extractFn(html, 'consensusModelCellHtml'),
      extractFn(html, 'consensusStatusHtml'),
      extractFn(html, 'consensusGridHtml'),
      extractFn(html, 'consensusQueuedRowKey'),
      extractFn(html, 'consensusFieldValueForEdit'),
      extractFn(html, 'consensusApplyField'),
      extractFn(html, 'useConsensusRows'),
      'return { consensusGridHtml: consensusGridHtml, useConsensusRows: useConsensusRows, ' +
        'setReviewItem: function (item) { REVIEW_ITEM_FOR_TEST = item; }, ' +
        'setQueued: function (rows) { QUEUED_FOR_TEST = rows; }, ' +
        'setConsensus: function (docId, c) { REVIEW_CONSENSUS[docId] = c; }, ' +
        'getEditorCall: function () { return CAPTURED_EDITOR_CALL; }, ' +
        'getAlerts: function () { return ALERTS; } };',
    ].join('\n');
    // eslint-disable-next-line no-new-func -- executing the real shipped source, see comment above
    const factory = new Function(src);
    return factory() as ConsensusSandbox;
  }

  const MODELS = ['anthropic:claude-sonnet-5', 'gemini:gemini-3.5-flash', 'openai:gpt-4o'];

  function fieldConsensus(
    value: unknown,
    votes: number,
    total: number,
    dissenters: Array<{ model: string; value: unknown }>,
    unanimous: boolean,
  ) {
    return { value, votes, total, dissenters, unanimous };
  }

  // Every model agrees on every field.
  const unanimousRow = {
    rowKey: 'AAPL|2024-01-05|P',
    presentIn: MODELS,
    missingFrom: [],
    rowConsensus: 'unanimous',
    fields: {
      ticker: fieldConsensus('AAPL', 3, 3, [], true),
      txType: fieldConsensus('P', 3, 3, [], true),
      transactionDate: fieldConsensus('2024-01-05', 3, 3, [], true),
      owner: fieldConsensus('self', 3, 3, [], true),
      assetName: fieldConsensus('Apple Inc', 3, 3, [], true),
      amount: fieldConsensus({ amountMin: 1001, amountMax: 15000 }, 3, 3, [], true),
    },
  };

  // Every field has a strict majority, but "owner" has one dissenter (2-1).
  const majorityRow = {
    rowKey: 'MSFT|2024-02-01|S',
    presentIn: MODELS,
    missingFrom: [],
    rowConsensus: 'majority',
    fields: {
      ticker: fieldConsensus('MSFT', 3, 3, [], true),
      txType: fieldConsensus('S', 3, 3, [], true),
      transactionDate: fieldConsensus('2024-02-01', 3, 3, [], true),
      owner: fieldConsensus('joint', 2, 3, [{ model: 'openai:gpt-4o', value: 'spouse' }], false),
      assetName: fieldConsensus('Microsoft Corp', 3, 3, [], true),
      amount: fieldConsensus({ amountMin: 15001, amountMax: 50000 }, 3, 3, [], true),
    },
  };

  // "amount" is a 1-1 tie between the two present models -> no majority ->
  // contested (winner value null, every present value listed as a dissenter).
  const contestedRow = {
    rowKey: 'TSLA|2024-03-10|P',
    presentIn: ['anthropic:claude-sonnet-5', 'gemini:gemini-3.5-flash'],
    missingFrom: ['openai:gpt-4o'],
    rowConsensus: 'contested',
    fields: {
      ticker: fieldConsensus('TSLA', 2, 2, [], true),
      txType: fieldConsensus('P', 2, 2, [], true),
      transactionDate: fieldConsensus('2024-03-10', 2, 2, [], true),
      owner: fieldConsensus('self', 2, 2, [], true),
      assetName: fieldConsensus('Tesla Inc', 2, 2, [], true),
      amount: fieldConsensus(
        null,
        1,
        2,
        [
          { model: 'anthropic:claude-sonnet-5', value: { amountMin: 1001, amountMax: 15000 } },
          { model: 'gemini:gemini-3.5-flash', value: { amountMin: 15001, amountMax: 50000 } },
        ],
        false,
      ),
    },
  };

  it('colors a unanimous field green with no dissent', () => {
    const sandbox = loadConsensusSandbox();
    const consensus = {
      rows: [unanimousRow],
      summary: { models: MODELS, rowsUnanimous: 1, rowsMajority: 0, rowsContested: 0, perFieldAgreementPct: {} },
    };
    const html = sandbox.consensusGridHtml('doc-1', consensus);
    expect(html).toContain('<div class="conf hi"><strong>Symbol:</strong> AAPL');
    expect(html).toContain('<th>anthropic:claude-sonnet-5</th>');
    expect(html).toContain('<th>Consensus</th>');
    expect(html).toContain("useConsensusRows('doc-1')");
    expect(html).toContain('>Use Consensus<');
  });

  it('colors a majority-with-dissent field amber and shows the dissenting value', () => {
    const sandbox = loadConsensusSandbox();
    const consensus = {
      rows: [majorityRow],
      summary: { models: MODELS, rowsUnanimous: 0, rowsMajority: 1, rowsContested: 0, perFieldAgreementPct: {} },
    };
    const html = sandbox.consensusGridHtml('doc-1', consensus);
    expect(html).toContain('<div class="conf mid" title="openai:gpt-4o: spouse"><strong>Owner:</strong> joint');
    expect(html).toContain('Dissent: openai:gpt-4o: spouse');
  });

  it('colors a contested field red and shows every present model\'s value', () => {
    const sandbox = loadConsensusSandbox();
    const consensus = {
      rows: [contestedRow],
      summary: { models: MODELS, rowsUnanimous: 0, rowsMajority: 0, rowsContested: 1, perFieldAgreementPct: {} },
    };
    const html = sandbox.consensusGridHtml('doc-1', consensus);
    expect(html).toContain('conf lo');
    expect(html).toContain('anthropic:claude-sonnet-5: $1,001 - $15,000');
    expect(html).toContain('gemini:gemini-3.5-flash: $15,001 - $50,000');
    // the model missing from this row gets a muted placeholder, not a blank cell
    expect(html).toContain('Missing row');
    expect(html).toContain('Missing row from:');
  });

  // Seen by only ONE of the three models. Its row-level consensus is 'contested'
  // (minority presence), yet every field's local electorate is that single
  // model, so votes*2 > total is trivially true for each field.
  const minorityRow = {
    rowKey: 'NVDA|2024-04-01|P',
    presentIn: ['openai:gpt-4o'],
    missingFrom: ['anthropic:claude-sonnet-5', 'gemini:gemini-3.5-flash'],
    rowConsensus: 'contested',
    fields: {
      ticker: fieldConsensus('NVDA', 1, 1, [], true),
      txType: fieldConsensus('P', 1, 1, [], true),
      transactionDate: fieldConsensus('2024-04-01', 1, 1, [], true),
      owner: fieldConsensus('self', 1, 1, [], true),
      assetName: fieldConsensus('Nvidia Corp', 1, 1, [], true),
      amount: fieldConsensus({ amountMin: 1001, amountMax: 15000 }, 1, 1, [], true),
    },
  };

  it('renders nothing when there is no consensus block for the document', () => {
    const sandbox = loadConsensusSandbox();
    expect(sandbox.consensusGridHtml('doc-1', null)).toBe('');
    expect(
      sandbox.consensusGridHtml('doc-1', { rows: [], summary: { models: [], rowsUnanimous: 0, rowsMajority: 0, rowsContested: 0, perFieldAgreementPct: {} } }),
    ).toBe('');
  });

  it('"Use Consensus" updates complete majority rows but preserves contested rows wholesale', () => {
    const sandbox = loadConsensusSandbox();
    sandbox.setConsensus('doc-2', {
      rows: [majorityRow, contestedRow],
      summary: { models: MODELS, rowsUnanimous: 0, rowsMajority: 1, rowsContested: 1, perFieldAgreementPct: {} },
    });
    sandbox.setReviewItem({ docId: 'doc-2', chamber: 'house', payload: null });
    sandbox.setQueued([
      { ticker: 'MSFT', txType: 'S', txDate: '2024-02-01', owner: 'spouse', assetName: 'Microsoft (queued)', amountMin: 1, amountMax: 2 },
      { ticker: 'TSLA', txType: 'P', txDate: '2024-03-10', owner: 'spouse', assetName: 'Tesla Inc (queued)', amountMin: 999, amountMax: 1000 },
    ]);

    sandbox.useConsensusRows('doc-2');

    const call = sandbox.getEditorCall();
    expect(call).toBeTruthy();
    expect(call!.docId).toBe('doc-2');
    expect(call!.decision).toBe('confirm');
    expect(call!.label).toBe('model consensus');
    expect(call!.chamber).toBe('house');
    expect(call!.rows).toHaveLength(2);

    const [majority, contested] = call!.rows;
    // majority row: the vote winner is used for every field, including "owner"
    // (2-1 majority) — the dissenting model's "spouse" value must not leak in.
    expect(majority.ticker).toBe('MSFT');
    expect(majority.owner).toBe('joint');

    // Any contested field makes the row human-only: no fieldwise partial merge.
    expect(contested.ticker).toBe('TSLA');
    expect(contested.owner).toBe('spouse');
    expect(contested.assetName).toBe('Tesla Inc (queued)');
    expect(contested.amountMin).toBe(999);
    expect(contested.amountMax).toBe(1000);
  });

  it('"Use Consensus" falls a minority-presence row entirely back to the queued payload', () => {
    const sandbox = loadConsensusSandbox();
    sandbox.setConsensus('doc-4', {
      rows: [minorityRow],
      summary: { models: MODELS, rowsUnanimous: 0, rowsMajority: 0, rowsContested: 1, perFieldAgreementPct: {} },
    });
    sandbox.setReviewItem({ docId: 'doc-4', chamber: 'house', payload: null });
    // Queued payload for the same row key, with values that differ from the lone
    // model's reading so a leak would be visible.
    sandbox.setQueued([
      { ticker: 'NVDA', txType: 'P', txDate: '2024-04-01', owner: 'spouse', assetName: 'Nvidia (queued)', amountMin: 1, amountMax: 2 },
    ]);

    sandbox.useConsensusRows('doc-4');

    const call = sandbox.getEditorCall();
    expect(call).toBeTruthy();
    expect(call!.rows).toHaveLength(1);
    const [only] = call!.rows;
    // The row was seen by only 1 of 3 models → not authoritative → every field
    // uses the queued value, NOT the single model's unverified reading.
    expect(only.owner).toBe('spouse');
    expect(only.assetName).toBe('Nvidia (queued)');
    expect(only.amountMin).toBe(1);
    expect(only.amountMax).toBe(2);
  });

  it('preserves queued-only rows and every queued metadata/detail field', () => {
    const sandbox = loadConsensusSandbox();
    sandbox.setConsensus('doc-5', {
      // MSFT is consensus-only and must not be injected; AAPL matches queue.
      rows: [unanimousRow, majorityRow],
      summary: { models: MODELS, rowsUnanimous: 1, rowsMajority: 1, rowsContested: 0, perFieldAgreementPct: {} },
    });
    sandbox.setReviewItem({ docId: 'doc-5', chamber: 'house', payload: null });
    sandbox.setQueued([
      {
        ticker: 'AAPL', txType: 'P', txDate: '2024-01-05', owner: 'self',
        assetName: 'Apple queued', amountMin: 1001, amountMax: 15000,
        assetType: 'OP', assetTypeName: 'Stock Option', isOption: true,
        capGainsOver200: true, rawText: 'verbatim queued row', confidence: 0.42,
        filingStatus: 'N', subholding: 'Brokerage A', location: 'Delaware',
        description: 'Call option', supplementalText: 'Expires 2027-01-15',
      },
      {
        ticker: 'GOOG', txType: 'S', txDate: '2024-05-01', owner: 'spouse',
        assetName: 'Alphabet queued-only', amountMin: 50001, amountMax: 100000,
        assetType: 'ST', assetTypeName: 'Stock', isOption: false,
        capGainsOver200: false, rawText: 'queued-only raw', confidence: 0.81,
        filingStatus: 'A', subholding: 'Trust', location: 'California',
        description: 'Queued-only description', supplementalText: 'Queued-only note',
      },
    ]);

    sandbox.useConsensusRows('doc-5');

    const rows = sandbox.getEditorCall()!.rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.ticker)).toEqual(['AAPL', 'GOOG']);
    expect(rows[0]).toMatchObject({
      assetType: 'OP', assetTypeName: 'Stock Option', isOption: true,
      capGainsOver200: true, rawText: 'verbatim queued row', confidence: 0.42,
      filingStatus: 'N', subholding: 'Brokerage A', location: 'Delaware',
      description: 'Call option', supplementalText: 'Expires 2027-01-15',
    });
    expect(rows[1]).toMatchObject({
      ticker: 'GOOG', assetName: 'Alphabet queued-only', rawText: 'queued-only raw',
      filingStatus: 'A', subholding: 'Trust', location: 'California',
      description: 'Queued-only description', supplementalText: 'Queued-only note',
    });
  });

  it('corrects a single unresolved-ticker row when key matching drifts unambiguously', () => {
    const sandbox = loadConsensusSandbox();
    sandbox.setConsensus('doc-key-drift', {
      rows: [unanimousRow],
      summary: { models: MODELS, rowsUnanimous: 1, rowsMajority: 0, rowsContested: 0, perFieldAgreementPct: {} },
    });
    sandbox.setReviewItem({ docId: 'doc-key-drift', chamber: 'house', payload: null });
    sandbox.setQueued([{
      ticker: null, assetName: 'Apple Inc.', txType: 'P', txDate: '2024-01-05',
      owner: 'self', amountMin: 1, amountMax: 2, rawText: 'queued unresolved ticker',
    }]);

    sandbox.useConsensusRows('doc-key-drift');

    const [row] = sandbox.getEditorCall()!.rows;
    expect(row.ticker).toBe('AAPL');
    expect(row.rawText).toBe('queued unresolved ticker');
  });

  it('leaves duplicate queued lots untouched because occurrence order is ambiguous', () => {
    const sandbox = loadConsensusSandbox();
    const lot1 = {
      ...unanimousRow,
      rowKey: 'AAPL|2024-01-05|P#1', baseRowKey: 'AAPL|2024-01-05|P', occurrence: 1,
      fields: { ...unanimousRow.fields, amount: fieldConsensus({ amountMin: 1001, amountMax: 15000 }, 3, 3, [], true) },
    };
    const lot2 = {
      ...unanimousRow,
      rowKey: 'AAPL|2024-01-05|P#2', baseRowKey: 'AAPL|2024-01-05|P', occurrence: 2,
      fields: { ...unanimousRow.fields, amount: fieldConsensus({ amountMin: 15001, amountMax: 50000 }, 3, 3, [], true) },
    };
    sandbox.setConsensus('doc-6', {
      rows: [lot1, lot2],
      summary: { models: MODELS, rowsUnanimous: 2, rowsMajority: 0, rowsContested: 0, perFieldAgreementPct: {} },
    });
    sandbox.setReviewItem({ docId: 'doc-6', chamber: 'house', payload: null });
    sandbox.setQueued([
      { ticker: 'AAPL', txType: 'P', txDate: '2024-01-05', assetName: 'Lot 1', amountMin: 1, amountMax: 2, rawText: 'lot one' },
      { ticker: 'AAPL', txType: 'P', txDate: '2024-01-05', assetName: 'Lot 2', amountMin: 3, amountMax: 4, rawText: 'lot two' },
    ]);

    sandbox.useConsensusRows('doc-6');

    const rows = sandbox.getEditorCall()!.rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.amountMin, row.amountMax])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(rows.map((row) => row.rawText)).toEqual(['lot one', 'lot two']);
  });

  it('shows a newer failed run set instead of hiding why consensus is unavailable', () => {
    const sandbox = loadConsensusSandbox();
    const html = sandbox.consensusGridHtml('doc-7', null, {
      batchId: 'new-revision', kind: 'bakeoff', createdAt: '2026-06-26T02:00:00.000Z',
      failedModels: [{ model: 'anthropic:claude-sonnet-5', error: 'timeout' }],
      blockedReason: 'Latest comparable run set has fewer than two successful model readings; older successes were not mixed in.',
    });
    expect(html).toContain('Run set: bakeoff · new-revision');
    expect(html).toContain('Failed models:');
    expect(html).toContain('anthropic:claude-sonnet-5 (timeout)');
    expect(html).toContain('older successes were not mixed in');
  });

  it('alerts instead of opening the editor when the document has no consensus rows', () => {
    const sandbox = loadConsensusSandbox();
    sandbox.setReviewItem({ docId: 'doc-3', chamber: 'senate', payload: null });
    sandbox.useConsensusRows('doc-3'); // no setConsensus() call for doc-3
    expect(sandbox.getEditorCall()).toBeNull();
    expect(sandbox.getAlerts()).toHaveLength(1);
  });
});

describe('dashboard truth + a11y fixes (app review backlog)', () => {
  // Small standalone-function extractor shared by the pure-function tests
  // below (pluralCount / canonSector have no DOM or outer-scope deps).
  function extractFn(html: string, name: string): string {
    const marker = 'function ' + name + '(';
    const start = html.indexOf(marker);
    if (start < 0) throw new Error('function not found in DASHBOARD_HTML: ' + name);
    const braceStart = html.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    return html.slice(start, i);
  }

  // ---- 1. Consensus Moves "— · ~$40K" dangling fragment -------------------
  it('drops the leading date-range fragment on cluster cards when minDate is missing, instead of a dangling dash', () => {
    expect(DASHBOARD_HTML).toContain(
      "var range = c.minDate ? (compactDateText(c.minDate) + (c.minDate === c.maxDate ? '' : ' → ' + compactDateText(c.maxDate))) : '';",
    );
    expect(DASHBOARD_HTML).toContain(
      "'<div class=\"muted\" style=\"margin-top:2px\">' + (range ? esc(range) + ' · ' : '') + estUsd(c.estVolumeUsd) + '</div>'",
    );
  });

  // ---- 2. "1 Democrats" pluralization --------------------------------------
  it('pluralizes party counts correctly (1 Democrat, not 1 Democrats)', () => {
    const src = extractFn(DASHBOARD_HTML, 'pluralCount') + '\nreturn pluralCount;';
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const pluralCount = new Function(src)() as (n: number, noun: string) => string;
    expect(pluralCount(1, 'Democrat')).toBe('1 Democrat');
    expect(pluralCount(2, 'Democrat')).toBe('2 Democrats');
    expect(pluralCount(0, 'Republican')).toBe('0 Republicans');
    expect(pluralCount(1, 'Other')).toBe('1 Other');
  });

  it('builds cluster-card party breakdowns from pluralCount instead of hardcoded plurals', () => {
    expect(DASHBOARD_HTML).toContain(
      "var parties = pluralCount(c.parties.D, 'Democrat') + ', ' + pluralCount(c.parties.R, 'Republican') + (c.parties.O ? ', ' + pluralCount(c.parties.O, 'Other') : '');",
    );
    expect(DASHBOARD_HTML).not.toContain("c.parties.D + ' Democrats, ' + c.parties.R + ' Republicans'");
  });

  // ---- 3. Duplicated "Past 3 Months ▾ · Past 3 Months" timeframe label -----
  it('renders the analytics timeframe once (the per-panel <select>), no appended .tf-chip duplicate', () => {
    // The old implementation appended a second textual label; the fix only
    // clears out any stale chip left over from before this fix shipped.
    expect(DASHBOARD_HTML).not.toContain("chip.textContent = ' \\u00B7 ' + label");
    expect(DASHBOARD_HTML).not.toContain("chip.textContent = ' · ' + label");
    expect(DASHBOARD_HTML).toContain('function stampWindowChips() {');
    expect(DASHBOARD_HTML).toContain("var chip = heads[i].querySelector('.tf-chip');");
    expect(DASHBOARD_HTML).toContain('if (chip) chip.parentNode.removeChild(chip);');
  });

  // ---- 4. "Healthcare" vs "Health Care" sector canonicalization ------------
  it('canonicalizes sector-name aliases at the display layer', () => {
    const src = extractFn(DASHBOARD_HTML, 'canonSector');
    const varMatch = DASHBOARD_HTML.match(/var SECTOR_CANON = \{[^}]*\};/);
    if (!varMatch) throw new Error('SECTOR_CANON not found in DASHBOARD_HTML');
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const canonSector = new Function(varMatch[0] + '\n' + src + '\nreturn canonSector;')() as (s: string) => string;
    expect(canonSector('Health Care')).toBe('Healthcare');
    expect(canonSector('Healthcare')).toBe('Healthcare');
    expect(canonSector('Energy')).toBe('Energy'); // untouched passthrough
  });

  it('merges canonicalized sector rows and sorts sector-flow output by estimated volume, matching its own "ranked by" label', () => {
    expect(DASHBOARD_HTML).toContain('ranked by estimated volume');
    expect(DASHBOARD_HTML).toContain('var key = canonSector(r.sector);');
    expect(DASHBOARD_HTML).toContain('rows.sort(function (a, b) { return b.estVolumeUsd - a.estVolumeUsd; });');
  });

  // ---- 5. Inert "Status" pill ----------------------------------------------
  it('gives the live-feed pill a real status value + a11y wiring instead of an inert placeholder', () => {
    // The pill used to always show the literal word "Status" (its own label,
    // never a value). It's now a genuine status: Connecting… -> Live -> Updated.
    expect(DASHBOARD_HTML).toContain(
      '<span class="pill off" id="livePill" role="status" aria-live="polite" title="Live feed connection status">Connecting&hellip;</span>',
    );
    expect(DASHBOARD_HTML).not.toContain('id="livePill">Status<');
    expect(DASHBOARD_HTML).toContain("function setLivePill(cls, text) { var p = el('livePill'); p.className = 'pill ' + cls; p.textContent = text || 'Live'; }");
    expect(DASHBOARD_HTML).not.toContain("text || 'Status'");
  });

  // ---- 6. "ranked by estimated volume" label vs actual sort order ----------
  // (covered above alongside the sector canonicalization fix, since both land
  // in the same loadTrSectorFlow() change.)

  // ---- 7. Canonical Premium pricing = $9/mo · $90/yr -----------------------
  it('shows $9/mo and $90/yr consistently across the dashboard pricing surfaces (alerts gate note + pricing modal)', () => {
    expect(DASHBOARD_HTML).toContain('Alert Delivery is included in Premium &middot; $9/mo or $90/yr &middot; 7-day free trial');
    expect(DASHBOARD_HTML).toContain('$9<span class="per">/mo</span>');
    expect(DASHBOARD_HTML).toContain('$90<span class="per">/yr</span>');
    expect(DASHBOARD_HTML).not.toContain('$15/mo');
    expect(DASHBOARD_HTML).not.toContain('$140/yr');
  });

  // ---- 8a. Keyboard-focusable + Enter-activatable drill-down rows ----------
  it('makes Consensus Moves (cluster) cards keyboard-focusable and Enter-activatable', () => {
    expect(DASHBOARD_HTML).toContain(
      '<div class="ccard clickable" tabindex="0" role="button" aria-label="View trades for \' + esc(c.ticker) + \'" data-ticker="\' + esc(c.ticker) + \'">',
    );
  });

  // ---- 8b. Keyboard-operable sort headers ----------------------------------
  it('makes the "What Congress Is Trading" ticker leaderboard sort headers keyboard-operable', () => {
    for (const sortKey of ['trades', 'members', 'volume', 'netflow']) {
      expect(DASHBOARD_HTML).toContain(
        `event.preventDefault();setTickerSort('${sortKey}');}`,
      );
    }
    expect(DASHBOARD_HTML.match(/class="sortable[^"]*" (?:style="[^"]*" )?tabindex="0" role="button"/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('makes the main Trades feed table sort headers keyboard-operable with aria-sort', () => {
    expect(DASHBOARD_HTML).toContain("var sortAttrs = c.sort ? ' tabindex=\"0\" role=\"button\" aria-sort=\"none\"' : '';");
    expect(DASHBOARD_HTML).toContain('th.onkeydown = function (e) {');
    expect(DASHBOARD_HTML).toContain("th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');");
    expect(DASHBOARD_HTML).toContain("th.setAttribute('aria-sort', 'none');");
    expect(DASHBOARD_HTML).toContain('th.sortable:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }');
  });

  // ---- 8c. Focus trap + Escape in drawer/modals ----------------------------
  it('implements a shared Tab focus trap + focus-restore for the drawer and the login/pricing modals', () => {
    expect(DASHBOARD_HTML).toContain('function focusableEls(container)');
    expect(DASHBOARD_HTML).toContain('function trapFocusIn(container)');
    expect(DASHBOARD_HTML).toContain('function releaseFocusTrap()');
    expect(DASHBOARD_HTML).toContain('function openOverlayContainer()');
    // Escape already closed these overlays; this asserts that behavior is intact.
    expect(DASHBOARD_HTML).toContain("if (e.key === 'Escape') { closePanels(); closeDrawer(); closeLogin(); closePricing(); }");
    // Each open*() captures the pre-open focus target so close*() can restore it.
    expect(DASHBOARD_HTML).toContain('focusTrapReturnEl = document.activeElement;');
    expect(DASHBOARD_HTML).toContain('if (wasOpen) releaseFocusTrap();');
  });

  // ---- 8d. prefers-reduced-motion ------------------------------------------
  it('honors prefers-reduced-motion for entrance/pop animations outside the already-covered Trends charts', () => {
    expect(DASHBOARD_HTML).toContain('@media (prefers-reduced-motion: reduce) {');
    expect(DASHBOARD_HTML).toContain('.drawer.open .drawer-panel,');
    expect(DASHBOARD_HTML).toContain('dialog.search-panel[open],');
    expect(DASHBOARD_HTML).toContain('.tick-animate .tick-num {');
    expect(DASHBOARD_HTML).toContain('animation: none !important;');
  });

  // ---- 8e. alt text on politician images ------------------------------------
  it('gives politician avatar photos a real alt (the name), not alt=""', () => {
    const src = [
      extractFn(DASHBOARD_HTML, 'esc'),
      extractFn(DASHBOARD_HTML, 'initials'),
      extractFn(DASHBOARD_HTML, 'memberAvatarHtml'),
      'return memberAvatarHtml;',
    ].join('\n');
    // eslint-disable-next-line no-new-func -- executing the real shipped source
    const memberAvatarHtml = new Function(src)() as (name: string, photoUrl: string) => string;
    const html = memberAvatarHtml('Nancy Pelosi', 'https://example.com/photo.jpg');
    expect(html).toContain('alt="Nancy Pelosi"');
    expect(html).not.toContain('alt=""');
    // No photo -> no <img> at all (initials chip only); nothing to assert on alt.
    expect(memberAvatarHtml('Nancy Pelosi', '')).not.toContain('<img');
  });
});
