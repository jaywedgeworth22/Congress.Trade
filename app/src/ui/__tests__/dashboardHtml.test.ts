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

import { describe, it, expect } from 'vitest';
import { DASHBOARD_HTML } from '../dashboardHtml';

function scriptBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks;
}

describe('DASHBOARD_HTML', () => {
  it('contains at least the boot + main script blocks', () => {
    expect(scriptBlocks(DASHBOARD_HTML).length).toBeGreaterThanOrEqual(2);
  });

  it('every embedded <script> parses as valid JavaScript', () => {
    for (const js of scriptBlocks(DASHBOARD_HTML)) {
      // new Function compiles (parses) the body without running it — DOM refs OK.
      expect(() => new Function(js)).not.toThrow();
    }
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
    expect(DASHBOARD_HTML).toContain('loadTrends();      // Trends is the default landing view');
  });

  it('exposes a public Alerts tab while keeping delivery MANAGEMENT admin-only', () => {
    // The Alerts tab is public nav (education for signed-out visitors)…
    expect(DASHBOARD_HTML).toMatch(/<button[^>]+data-view="subs"[^>]*>Alerts<\/button>/);
    expect(DASHBOARD_HTML).not.toMatch(/<button[^>]+data-view="subs"[^>]+data-admin-tab/);
    // …but the management section inside it stays admin-gated and defaults hidden
    // so anon never flashes the subscriptions table before /auth/me resolves.
    expect(DASHBOARD_HTML).toContain('id="subsManage" data-admin-only hidden');
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

  it('renders the honest speed-vs-providers scoreboard on Trends', () => {
    expect(DASHBOARD_HTML).toContain('id="trLatencySection"');
    expect(DASHBOARD_HTML).toContain("fetch('/api/analytics/latency-summary')");
    // Filter-independent: not stamped with the Trends window chip and not in loadTrends.
    expect(DASHBOARD_HTML).not.toMatch(/Speed vs\. Data Providers[^<]*<\/h3[^>]*class="tf-h"/);
    expect(DASHBOARD_HTML).toContain('function renderSpeedProof(');
    // Honesty guard rails: lane threshold, boast threshold, empty-state copy,
    // losses always displayed, sample sizes visible, trademark fine print.
    expect(DASHBOARD_HTML).toContain('var SPEED_LANE_MIN_MATCHED = 5');
    expect(DASHBOARD_HTML).toContain('var SPEED_BOAST_MIN_MATCHED = 10');
    expect(DASHBOARD_HTML).toContain('No overlapping disclosures yet');
    expect(DASHBOARD_HTML).toContain('Behind ');
    expect(DASHBOARD_HTML).toContain(' of ' + "' + p.candidates + '" + ' matched');
    expect(DASHBOARD_HTML).toContain('A live measurement, not a promise');
    expect(DASHBOARD_HTML).toContain('trademarks of their respective owners');
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
    expect(DASHBOARD_HTML).toContain("var COL_ORDER_KEY = 'feed-cols-order-v1'");
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

  it('uses subtle Premium cues without implying the public feed is paywalled', () => {
    expect(DASHBOARD_HTML).toContain('Premium enrichment');
    expect(DASHBOARD_HTML).toContain('data-premium-col');
    expect(DASHBOARD_HTML).toContain('CSV Export Requires Premium');
    expect(DASHBOARD_HTML).toContain('CSV export is Premium');
    expect(DASHBOARD_HTML).toContain('Full-history CSV exports');
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
    expect(DASHBOARD_HTML).toContain('id="panelBackdrop"');
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
    expect(DASHBOARD_HTML).toContain("var sortKey = 'published'");
    expect(DASHBOARD_HTML).toContain("var COL_HIDDEN_KEY = 'feed-cols-hidden-v2'");
    expect(DASHBOARD_HTML).toContain("var COL_WIDTH_KEY = 'feed-col-widths-v8'");
    expect(DASHBOARD_HTML).toContain("asset: estimatedColWidth('asset', 48, 40, 54)");
    expect(DASHBOARD_HTML).not.toContain('width: max-content');
    expect(DASHBOARD_HTML).not.toContain('feed-col-widths-v7');
    expect(DASHBOARD_HTML).toContain('function dateTimeCellHtml(');
    expect(DASHBOARD_HTML).toContain('date-time-cell');
    expect(DASHBOARD_HTML).toContain('#feedTable.resizable th { text-align: center;');
    expect(DASHBOARD_HTML).toContain('minColWidth(key)');
    expect(DASHBOARD_HTML).toContain("p.set('sort', 'published')");
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

  it('wires a per-doc "Re-read with model…" bake-off control with multi-select', () => {
    expect(DASHBOARD_HTML).toContain('var REREAD_MODELS');
    expect(DASHBOARD_HTML).toContain('function rereadModelOptionsHtml(');
    expect(DASHBOARD_HTML).toContain('function rereadControlHtml(');
    expect(DASHBOARD_HTML).toContain('function rereadWithModel(');
    expect(DASHBOARD_HTML).toContain('Re-read with model');
    // multi-select allows picking 2-3 models in one submit
    expect(DASHBOARD_HTML).toContain('id="reread-sel-\' + esc(docId) + \'" multiple');
    expect(DASHBOARD_HTML).toContain('id="reread-btn-\' + esc(docId) + \'"');
    expect(DASHBOARD_HTML).toContain('id="reread-msg-\' + esc(docId) + \'"');
    // curated provider/model pairs mirror DEFAULT_CANDIDATES in src/extraction/bakeoff.ts
    expect(DASHBOARD_HTML).toContain("{ provider: 'gemini', model: 'gemini-3.5-flash' }");
    expect(DASHBOARD_HTML).toContain("{ provider: 'openai', model: 'gpt-4o' }");
    expect(DASHBOARD_HTML).toContain("{ provider: 'anthropic', model: 'claude-sonnet-4-6' }");
    expect(DASHBOARD_HTML).toContain("{ provider: 'anthropic', model: 'claude-haiku-4-5' }");
    expect(DASHBOARD_HTML).toContain("{ provider: 'mistral', model: 'mistral-ocr-latest' }");
    expect(DASHBOARD_HTML).toContain("{ provider: 'xai', model: 'grok-4.3' }");
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
    expect(DASHBOARD_HTML).toContain('class="late-filers-wrap"');
    expect(DASHBOARD_HTML).toContain('.timeliness-grid { margin-top: 8px; grid-template-columns: minmax(0, 1fr) minmax(0, .92fr);');
    expect(DASHBOARD_HTML).not.toContain('minmax(280px, .92fr)');
    expect(DASHBOARD_HTML).toContain('.late-filers-wrap { max-height: 232px; overflow: auto;');
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
    expect(DASHBOARD_HTML).toContain('id="trKpisCap"');
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

  const MODELS = ['anthropic:claude-sonnet-4-6', 'gemini:gemini-3.5-flash', 'openai:gpt-4o'];

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
    presentIn: ['anthropic:claude-sonnet-4-6', 'gemini:gemini-3.5-flash'],
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
          { model: 'anthropic:claude-sonnet-4-6', value: { amountMin: 1001, amountMax: 15000 } },
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
    expect(html).toContain('<th>anthropic:claude-sonnet-4-6</th>');
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
    expect(html).toContain('anthropic:claude-sonnet-4-6: $1,001 - $15,000');
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
    missingFrom: ['anthropic:claude-sonnet-4-6', 'gemini:gemini-3.5-flash'],
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
      failedModels: [{ model: 'anthropic:claude-sonnet-4-6', error: 'timeout' }],
      blockedReason: 'Latest comparable run set has fewer than two successful model readings; older successes were not mixed in.',
    });
    expect(html).toContain('Run set: bakeoff · new-revision');
    expect(html).toContain('Failed models:');
    expect(html).toContain('anthropic:claude-sonnet-4-6 (timeout)');
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
