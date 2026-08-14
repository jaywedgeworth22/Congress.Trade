import { describe, expect, it } from 'vitest';
import { applyOgMeta, escapeAttr, resolveOgMeta } from '../ogMeta.ts';
import { OG_IMAGE_VERSION } from '../assets.ts';

describe('resolveOgMeta', () => {
  it('defaults to the home lockup card', () => {
    const m = resolveOgMeta('https://congress.trade/');
    expect(m.context).toBe('default');
    expect(m.title).toBe('Congress.Trade');
    expect(m.imageUrl).toBe(`https://congress.trade/og-image.png?v=${OG_IMAGE_VERSION}`);
    expect(m.url).toBe('https://congress.trade/');
  });

  it('uses the Trends card for ?view=trends', () => {
    const m = resolveOgMeta('https://congress.trade/?view=trends');
    expect(m.context).toBe('trends');
    expect(m.title).toBe('Trends');
    expect(m.imageUrl).toContain('/og-image-trends.png?v=');
    expect(m.description).toMatch(/^Trading trends/);
    expect(m.description).not.toMatch(/Congressional/i);
  });

  it('uses the Company card for ?ticker=', () => {
    const m = resolveOgMeta('https://congress.trade/?ticker=aapl');
    expect(m.context).toBe('company');
    expect(m.title).toBe('AAPL');
    expect(m.imageUrl).toContain('/og-image-company.png?v=');
    expect(m.description).toContain('Disclosed trades in AAPL');
    expect(m.description).not.toMatch(/Congressional/i);
  });

  it('uses the Politician card for ?member= (priority over view)', () => {
    const m = resolveOgMeta('https://congress.trade/?view=trends&member=P000197');
    expect(m.context).toBe('politician');
    expect(m.title).toBe('P000197');
    expect(m.imageUrl).toContain('/og-image-politician.png?v=');
  });

  it('prefers ticker over view when both present', () => {
    const m = resolveOgMeta('https://congress.trade/?view=trends&ticker=MSFT');
    expect(m.context).toBe('company');
    expect(m.title).toBe('MSFT');
  });

  it('never repeats the site name in a context title', () => {
    const urls = [
      'https://congress.trade/?view=trends',
      'https://congress.trade/?ticker=AAPL',
      'https://congress.trade/?member=P000197',
    ];
    for (const url of urls) {
      expect(resolveOgMeta(url).title).not.toContain('Congress.Trade');
    }
  });

  it('renders the district after the member name when provided', () => {
    const m = resolveOgMeta('https://congress.trade/?member=P000197', 'https://congress.trade', {
      memberDisplayName: 'Nancy Pelosi',
      memberDistrict: 'D-CA-11',
    });
    expect(m.title).toBe('Nancy Pelosi (D-CA-11)');
    expect(m.description).toContain('Nancy Pelosi (D-CA-11)');
    expect(m.description).toMatch(/^Trading activity for/);
    expect(m.description).not.toMatch(/Congressional/i);
  });

  it('falls back to the bare name when no district is known', () => {
    const m = resolveOgMeta('https://congress.trade/?member=P000197', 'https://congress.trade', {
      memberDisplayName: 'Nancy Pelosi',
      memberDistrict: '   ',
    });
    expect(m.title).toBe('Nancy Pelosi');
  });

  it('normalises a district that arrives already parenthesised', () => {
    const m = resolveOgMeta('https://congress.trade/?member=X', 'https://congress.trade', {
      memberDisplayName: 'Rep Example',
      memberDistrict: '(R-TX-02)',
    });
    expect(m.title).toBe('Rep Example (R-TX-02)');
  });

  // Cap raised 24 -> 40 so real executive-branch positions survive intact:
  // the longest curated title, 'Social Security Commissioner' (28 chars), was
  // being cut mid-word to 'Social Security Commissio…'. Still bounded.
  it('truncates an implausibly long district descriptor', () => {
    const m = resolveOgMeta('https://congress.trade/?member=X', 'https://congress.trade', {
      memberDisplayName: 'Rep Example',
      memberDistrict: 'D-CALIFORNIA-ELEVENTH-CONGRESSIONAL-DISTRICT-AT-LARGE-SEAT',
    });
    expect(m.title.length).toBeLessThanOrEqual('Rep Example '.length + 42);
    expect(m.title).toContain('…');
  });

  it('keeps a real executive-branch title intact', () => {
    const m = resolveOgMeta('https://congress.trade/?member=X', 'https://congress.trade', {
      memberDisplayName: 'Frank J. Bisignano',
      memberDistrict: 'Social Security Commissioner',
    });
    expect(m.title).toBe('Frank J. Bisignano (Social Security Commissioner)');
  });
});

describe('applyOgMeta', () => {
  it('fills every placeholder and escapes attribute text', () => {
    const meta = resolveOgMeta('https://congress.trade/?ticker=BRK.B');
    const html = applyOgMeta(
      '<title>x</title><meta property="og:title" content="%OG_TITLE%" />' +
        '<meta property="og:image" content="%OG_IMAGE%" />' +
        '<link rel="canonical" href="%CANONICAL_URL%" />' +
        '<meta name="twitter:image" content="%TWITTER_IMAGE%" />',
      meta,
    );
    expect(html).toContain('content="BRK.B"');
    expect(html).toContain(`content="https://congress.trade/og-image-company.png?v=${OG_IMAGE_VERSION}"`);
    expect(html).toContain('href="https://congress.trade/?ticker=BRK.B"');
    expect(html).not.toContain('%OG_');
  });

  it('escapeAttr encodes quotes and angle brackets', () => {
    expect(escapeAttr('a"b<c>')).toBe('a&quot;b&lt;c&gt;');
  });
});
