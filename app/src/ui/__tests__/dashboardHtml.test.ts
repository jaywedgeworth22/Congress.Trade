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
    expect(DASHBOARD_HTML).toContain('data-mobile="Feed"');
    expect(DASHBOARD_HTML).toContain('id="feedCards"');
    expect(DASHBOARD_HTML).toContain('function feedCardHtml(');
    expect(DASHBOARD_HTML).toContain('function handleFeedOpenEvent(');
    expect(DASHBOARD_HTML).toContain('@media (max-width: 720px)');
    expect(DASHBOARD_HTML).toContain('(orientation: landscape) and (max-width: 950px)');
    expect(DASHBOARD_HTML).toContain('env(safe-area-inset-bottom)');
    expect(DASHBOARD_HTML).toContain('grid-template-columns: minmax(0, 1fr)');
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
    expect(DASHBOARD_HTML).toContain('drawer-title-line clickable');
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
    expect(DASHBOARD_HTML).toContain('Estimated from STOCK Act amount ranges');
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
});
