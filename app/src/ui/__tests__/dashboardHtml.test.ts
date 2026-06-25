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
    // The Trends section is the default-active view; the feed section is not.
    expect(DASHBOARD_HTML).toContain('<section class="view active" id="view-trends">');
    expect(DASHBOARD_HTML).toContain('<section class="view" id="view-feed">');
    // The former "Live Feed" tab is now labelled "Trades".
    expect(DASHBOARD_HTML).toContain('data-view="feed" data-mobile="Trades" data-icon="▦">Trades</button>');
    // Trends is warmed on boot since it is the landing view.
    expect(DASHBOARD_HTML).toContain('loadTrends();      // Trends is the default landing view');
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
    // the new date/lag columns the user asked for
    expect(DASHBOARD_HTML).toContain("id: 'traded'");
    expect(DASHBOARD_HTML).toContain("id: 'lag'");
    expect(DASHBOARD_HTML).toContain("id: 'published'");
    expect(DASHBOARD_HTML).toContain("id: 'filed'");
    expect(DASHBOARD_HTML).toContain("id: 'imported'");
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
    // member drawer hits the per-member analytics endpoint
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
    expect(DASHBOARD_HTML).toContain('Historical source note:');
    expect(DASHBOARD_HTML).toContain("e.target.closest('[data-member]')");
    // The company-drawer title is NOT clickable (it would just reopen the same drawer);
    // clickable entities are the member/asset links inside the drawer body instead.
    expect(DASHBOARD_HTML).not.toContain('drawer-title-line clickable');
    expect(DASHBOARD_HTML).toContain('drawer-member-title');
    expect(DASHBOARD_HTML).toContain('color:var(--text)');
    expect(DASHBOARD_HTML).not.toContain('<pre class="raw-notes">');
  });

  it('uses published timing, tighter asset defaults, and source links in drawers', () => {
    expect(DASHBOARD_HTML).toContain("var sortKey = 'published'");
    expect(DASHBOARD_HTML).toContain("var COL_HIDDEN_KEY = 'feed-cols-hidden-v2'");
    expect(DASHBOARD_HTML).toContain("var COL_WIDTH_KEY = 'feed-col-widths-v4'");
    expect(DASHBOARD_HTML).toContain('asset: 180');
    expect(DASHBOARD_HTML).toContain("p.set('sort', 'published')");
    expect(DASHBOARD_HTML).toContain("p.set('memberName', m)");
    expect(DASHBOARD_HTML).toContain('function handleFeedTextFilter(');
    expect(DASHBOARD_HTML).toContain('feedRequestSeq');
    expect(DASHBOARD_HTML).toContain("arr.textContent = '↕'");
    expect(DASHBOARD_HTML).toContain('function publishedDetailText(');
    expect(DASHBOARD_HTML).toContain('function miniSourceLinkHtml(');
    expect(DASHBOARD_HTML).toContain('Official Filed');
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

  it('keeps the educational + dollar-estimate disclaimers in the Trends view', () => {
    expect(DASHBOARD_HTML).toContain('estimates');
    expect(DASHBOARD_HTML.toLowerCase()).toContain('bracket');
    expect(DASHBOARD_HTML).toContain('from STOCK Act amount ranges');
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

  it('does not use imported/published time as disclosure lag', () => {
    expect(DASHBOARD_HTML).toContain("function lagBasisDate(r) { return (r && (r.filedDate || r.filed)) || ''; }");
    expect(DASHBOARD_HTML).not.toContain('r.filedDate || r.filed || publishedRaw(r)');
    expect(DASHBOARD_HTML).not.toContain('using Congress.Trade import date');
  });

  it('provides name/chamber/state/class display formatters', () => {
    for (const fn of ['function fmtName(', 'function chamberLabel(', 'function stateName(', 'function assetClassLabel(', 'function assetTypeLabel(']) {
      expect(DASHBOARD_HTML).toContain(fn);
    }
    // suffix + state maps present
    expect(DASHBOARD_HTML).toContain("'jr': 'Jr'");
    expect(DASHBOARD_HTML).toContain("CA: 'California'");
    expect(DASHBOARD_HTML).toContain("etf: 'ETF'");
  });

  it('renames Members→Politicians and Tickers→Assets and softens Est.→Approx', () => {
    expect(DASHBOARD_HTML).toContain("kpi('Politicians'");
    expect(DASHBOARD_HTML).toContain("kpi('Assets'");
    expect(DASHBOARD_HTML).toContain("kpiInfo('Approx. Volume'");
    expect(DASHBOARD_HTML).toContain("kvRow('Distinct Assets'");
    expect(DASHBOARD_HTML).not.toContain("kpi('Members'");
    expect(DASHBOARD_HTML).not.toContain("kpi('Tickers'");
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
    expect(DASHBOARD_HTML).toContain('For Educational Uses (NOT Investment Advice)');
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
