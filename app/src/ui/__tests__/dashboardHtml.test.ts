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

  it('keeps admin delivery surfaces out of public primary nav', () => {
    expect(DASHBOARD_HTML).toMatch(/<button[^>]+data-view="subs"[^>]+data-admin-tab="true"[^>]+hidden[^>]*>Developer Delivery<\/button>/);
    expect(DASHBOARD_HTML).toMatch(/<button[^>]+data-view="admin"[^>]+data-admin-tab="true"[^>]+hidden[^>]*>Admin · Cadence<\/button>/);
    expect(DASHBOARD_HTML).toContain('Developer Alert Delivery');
    expect(DASHBOARD_HTML).toContain('No alert deliveries yet. Create one below.');
    expect(DASHBOARD_HTML).not.toContain('>Subscriptions</button>');
    expect(DASHBOARD_HTML).not.toContain('<h3>Delivery Subscriptions</h3>');
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
    expect(DASHBOARD_HTML).toContain('assetTypeName: reviewAssetTypeName(assetType) || null');
    expect(DASHBOARD_HTML).toContain("tr.setAttribute('data-chamber', chamber || '')");
    expect(DASHBOARD_HTML).toContain('class="me-option"');
    expect(DASHBOARD_HTML).toContain('Option Contract');
    expect(DASHBOARD_HTML).toContain('class="me-cap"');
    expect(DASHBOARD_HTML).not.toContain('class="me-min"');
    expect(DASHBOARD_HTML).not.toContain('class="me-max"');
    expect(DASHBOARD_HTML).toContain('JSON.stringify({ decision: decision, edits: edits })');
    expect(DASHBOARD_HTML).not.toContain('JSON.stringify({ decision: decision, edits: [] })');
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
});
