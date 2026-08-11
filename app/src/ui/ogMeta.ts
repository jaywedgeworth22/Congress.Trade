/**
 * Open Graph / Twitter card meta for shareable deep links.
 *
 * Crawlers (Slack, iMessage, X, LinkedIn) only read server-rendered meta tags —
 * they do not execute the SPA. We pick the card image + title from the request
 * query string so sharing Trends / a company / a politician unfurls the right art.
 *
 * Query priority (first match wins):
 *   1. ?member=…  → politician card
 *   2. ?ticker=…  → company card
 *   3. ?view=trends → trends card
 *   4. default home card
 */

import { OG_IMAGE_VERSION } from './assets.ts';

export type OgContext = 'default' | 'trends' | 'company' | 'politician';

export type OgMeta = {
  context: OgContext;
  title: string;
  description: string;
  /** Absolute page URL for og:url / canonical. */
  url: string;
  /** Absolute image URL including cache-bust query. */
  imageUrl: string;
  imageAlt: string;
};

const SITE = 'https://congress.trade';
const DEFAULT_DESC =
  'We ingest and publish official House & Senate STOCK Act disclosures ourselves — a live congressional stock-trade feed, not a wrapper around one third-party API.';

function imagePath(context: OgContext): string {
  switch (context) {
    case 'trends':
      return '/og-image-trends.png';
    case 'company':
      return '/og-image-company.png';
    case 'politician':
      return '/og-image-politician.png';
    default:
      return '/og-image.png';
  }
}

function absImage(context: OgContext): string {
  return `${SITE}${imagePath(context)}?v=${OG_IMAGE_VERSION}`;
}

/** Escape text for use inside HTML attribute double-quotes. */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export type ResolveOgMetaOptions = {
  /** Optional display name for ?member= (resolved server-side from filers). */
  memberDisplayName?: string | null;
  /**
   * Optional seat descriptor for ?member=, already formatted by the caller —
   * a congressional seat (`D-CA-11`, `R-TX-Sen`) or an executive-branch
   * position (`President`, `Treasury Secretary`). Rendered in parentheses
   * after the name so a shared politician link identifies the office, not
   * just the person.
   */
  memberDistrict?: string | null;
};

/**
 * Trim a caller-supplied seat descriptor down to something safe to render.
 *
 * The cap has to clear a real executive-branch position, not just a compact
 * congressional seat code: the longest curated title is 'Social Security
 * Commissioner' at 28 characters, and a 24-char limit silently truncated five
 * of them mid-word. 40 leaves headroom for the next cabinet title while still
 * refusing an unbounded string.
 */
function normalizeDistrict(raw: string | null | undefined): string {
  let s = (raw || '').trim();
  if (!s) return '';

  // Order matters. Unwrap a fully-parenthesised descriptor FIRST — "(R-TX-02)"
  // -> "R-TX-02" — but only when the parens wrap the whole string. A blanket
  // /^\(+|\)+$/ strip would eat the closing paren of 'U.S. Senator (PA)' and
  // leave an unbalanced 'U.S. Senator (PA' for the next step to miss.
  while (/^\([^()]*\)$/.test(s)) s = s.slice(1, -1).trim();

  // The descriptor is itself rendered inside parentheses, so a remaining
  // interior pair would nest: the curated title 'U.S. Senator (PA)' would
  // print as "David McCormick (U.S. Senator (PA))". Flatten it to a comma.
  s = s.replace(/\s*\(([^)]*)\)\s*/g, ', $1');

  // Anything left unbalanced is caller junk, not structure.
  s = s.replace(/^[(),\s]+|[(),\s]+$/g, '').trim();
  if (!s) return '';

  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}

/**
 * Resolve OG meta from a request URL (path + query). `origin` defaults to the
 * production site so crawlers always get absolute congress.trade image URLs.
 */
export function resolveOgMeta(
  requestUrl: string | URL,
  origin: string = SITE,
  opts: ResolveOgMetaOptions = {},
): OgMeta {
  const u = typeof requestUrl === 'string' ? new URL(requestUrl, origin) : new URL(requestUrl.toString());
  // Canonical share URLs always use the public production host (not localhost).
  const path = u.pathname === '/admin' ? '/' : u.pathname;
  const search = u.search || '';
  const pageUrl = `${SITE}${path === '/' ? '/' : path}${search}`;

  const member = (u.searchParams.get('member') || '').trim();
  const ticker = (u.searchParams.get('ticker') || '').trim().toUpperCase();
  const view = (u.searchParams.get('view') || '').trim().toLowerCase();

  // Titles deliberately omit a `· Congress.Trade` suffix: every unfurl already
  // shows the site name above the title and the URL below it, so repeating it
  // spends the one line crawlers give us on something the reader can see twice.
  if (member) {
    const name = (opts.memberDisplayName || '').trim();
    const label = name || (member.length > 48 ? `${member.slice(0, 45)}…` : member);
    const district = normalizeDistrict(opts.memberDistrict);
    const heading = district ? `${label} (${district})` : label;
    return {
      context: 'politician',
      title: heading,
      description: `Congressional STOCK Act trading activity for ${heading} on Congress.Trade.`,
      url: pageUrl,
      imageUrl: absImage('politician'),
      imageAlt:
        'Congress.Trade lockup (CONGRESS eagle TRADE) above a "Politician profile" label ' +
        'and a stylised profile page showing disclosed buys and sells',
    };
  }

  if (ticker) {
    return {
      context: 'company',
      title: ticker,
      description: `Congressional STOCK Act trades in ${ticker} on Congress.Trade.`,
      url: pageUrl,
      imageUrl: absImage('company'),
      imageAlt:
        'Congress.Trade lockup (CONGRESS eagle TRADE) above a "Company profile" label ' +
        'and a stylised company page showing buy versus sell volume',
    };
  }

  if (view === 'trends') {
    return {
      context: 'trends',
      title: 'Trends',
      description:
        'Congressional trading trends — volume, consensus moves, sectors, and disclosure lag on Congress.Trade.',
      url: pageUrl,
      imageUrl: absImage('trends'),
      imageAlt:
        'Congress.Trade lockup (CONGRESS eagle TRADE) above a "Trends" label ' +
        'and a stylised buy/sell volume chart',
    };
  }

  return {
    context: 'default',
    title: 'Congress.Trade',
    description: DEFAULT_DESC,
    url: pageUrl.endsWith('?') ? SITE + '/' : pageUrl || `${SITE}/`,
    imageUrl: absImage('default'),
    imageAlt:
      'Congress.Trade lockup (CONGRESS, eagle mark, TRADE) on a white background above a ' +
      '"Congressional STOCK Act disclosures" label and a stylised dashboard of summary ' +
      'tiles and disclosed trades',
  };
}

/** Apply OG placeholders in the dashboard HTML template. */
export function applyOgMeta(html: string, meta: OgMeta): string {
  return html
    .split('%OG_TITLE%').join(escapeAttr(meta.title))
    .split('%OG_DESCRIPTION%').join(escapeAttr(meta.description))
    .split('%OG_URL%').join(escapeAttr(meta.url))
    .split('%OG_IMAGE%').join(escapeAttr(meta.imageUrl))
    .split('%OG_IMAGE_ALT%').join(escapeAttr(meta.imageAlt))
    .split('%TWITTER_TITLE%').join(escapeAttr(meta.title))
    .split('%TWITTER_DESCRIPTION%').join(escapeAttr(meta.description))
    .split('%TWITTER_IMAGE%').join(escapeAttr(meta.imageUrl))
    .split('%CANONICAL_URL%').join(escapeAttr(meta.url));
}
