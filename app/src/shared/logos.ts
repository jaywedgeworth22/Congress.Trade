/**
 * src/shared/logos.ts
 *
 * Company/ticker logos are a deterministic function of the ticker symbol: they
 * are served from the davidepalazzo/ticker-logos GitHub repo (transparent PNGs
 * for NYSE/NASDAQ symbols) via the jsDelivr CDN — no API call, no key, no
 * licensing entanglement. Coverage is ~80% of actively-traded symbols; misses
 * (delisted/renamed tickers, odd share classes) are expected and the UI must
 * fall back to a monogram/initials on the image's `onerror`.
 *
 * To switch source repos, change LOGO_REPO (e.g. 'nvstly/icons@main') — the
 * path layout (`ticker_icons/{UPPER}.png`) is identical across both repos.
 */

const LOGO_REPO = 'davidepalazzo/ticker-logos@main';

/** Stock tickers in these repos are uppercase, `.`/`/` → `-` (e.g. BRK.B → BRK-B). */
export function tickerLogoUrl(ticker: string | null | undefined): string | null {
  if (!ticker) return null;
  const sym = ticker.trim().toUpperCase().replace(/[./]/g, '-');
  if (!/^[A-Z0-9-]{1,12}$/.test(sym)) return null; // skip junk/non-symbol values
  return `https://cdn.jsdelivr.net/gh/${LOGO_REPO}/ticker_icons/${sym}.png`;
}
