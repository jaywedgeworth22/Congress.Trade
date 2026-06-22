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

  it('keeps the dollar-estimate disclaimer in the Trends view', () => {
    expect(DASHBOARD_HTML).toContain('estimates');
    expect(DASHBOARD_HTML.toLowerCase()).toContain('bracket');
  });
});
