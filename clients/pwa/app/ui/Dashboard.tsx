'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { BootstrapResponse, ClientCommandResponse, ClientFeedResponse } from '../../lib/contracts';
import { apiGet, apiPost } from '../../lib/clientApi';

type LoadState = 'loading' | 'ready' | 'error';
type DeliveryMode = 'sse' | 'webhook';

interface AmountBracket {
  id: string;
  label: string;
  min: number | null;
  max: number | null;
}

const AMOUNT_BRACKETS: AmountBracket[] = [
  { id: '1k-15k', label: '$1k - $15k', min: 1000, max: 15000 },
  { id: '15k-50k', label: '$15k - $50k', min: 15001, max: 50000 },
  { id: '50k-100k', label: '$50k - $100k', min: 50001, max: 100000 },
  { id: '100k-250k', label: '$100k - $250k', min: 100001, max: 250000 },
  { id: '250k-500k', label: '$250k - $500k', min: 250001, max: 500000 },
  { id: '500k-1m', label: '$500k - $1M', min: 500001, max: 1000000 },
  { id: '1m-plus', label: '$1M+', min: 1000001, max: null }
];

function fmtAmount(min: number | null, max: number | null) {
  if (min == null && max == null) return 'Undisclosed';
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  return `${money.format(min ?? 0)} - ${max == null ? 'plus' : money.format(max)}`;
}

function shortDate(value: string | null) {
  if (!value) return 'Unavailable';
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function getLagDays(tradeDateStr: string | null, filedDateStr: string | null): number | null {
  if (!tradeDateStr || !filedDateStr) return null;
  const trade = new Date(tradeDateStr.slice(0, 10));
  const filed = new Date(filedDateStr.slice(0, 10));
  if (Number.isNaN(trade.getTime()) || Number.isNaN(filed.getTime())) return null;
  const diffTime = filed.getTime() - trade.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}

function getComplianceInfo(days: number | null) {
  if (days === null) return { text: 'Unknown', className: 'compliance-unknown' };
  if (days < 0) return { text: `${days} days (Early)`, className: 'compliance-green' };
  if (days < 15) return { text: `${days} days`, className: 'compliance-green' };
  if (days <= 45) return { text: `${days} days`, className: 'compliance-yellow' };
  return { text: `${days} days`, className: 'compliance-red' };
}

function matchesBracket(min: number | null, max: number | null, bracket: AmountBracket) {
  if (min === null) return false;
  const bMin = bracket.min ?? 0;
  const bMax = bracket.max ?? Infinity;
  return min >= bMin && (bracket.max === null || min <= bMax);
}

export default function Dashboard() {
  const [state, setState] = useState<LoadState>('loading');
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [feed, setFeed] = useState<ClientFeedResponse | null>(null);
  
  // Filter panel states
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [filterTicker, setFilterTicker] = useState('');
  const [filterMember, setFilterMember] = useState('');
  const [filterChambers, setFilterChambers] = useState({ house: false, senate: false });
  const [filterBrackets, setFilterBrackets] = useState<string[]>([]);
  
  const [watchlist, setWatchlist] = useState('AAPL, MSFT, NVDA');
  const [delivery, setDelivery] = useState<DeliveryMode>('sse');
  const [targetUrl, setTargetUrl] = useState('');
  const [commandMessage, setCommandMessage] = useState('');

  async function refresh() {
    setState('loading');
    try {
      const [boot, rows] = await Promise.all([
        apiGet<BootstrapResponse>('/bootstrap'),
        apiGet<ClientFeedResponse>('/feed?limit=30')
      ]);
      setBootstrap(boot);
      setFeed(rows);
      setState('ready');
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : 'Could not load.');
      setState('error');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filterTicker.trim()) count++;
    if (filterMember.trim()) count++;
    if (filterChambers.house || filterChambers.senate) count++;
    if (filterBrackets.length > 0) count += filterBrackets.length;
    return count;
  }, [filterTicker, filterMember, filterChambers, filterBrackets]);

  const activeFiltersSummary = useMemo(() => {
    const parts: string[] = [];
    if (filterTicker.trim()) parts.push(`Ticker: ${filterTicker.trim().toUpperCase()}`);
    if (filterMember.trim()) parts.push(`Member: ${filterMember.trim()}`);
    
    const chamberParts: string[] = [];
    if (filterChambers.house) chamberParts.push('House');
    if (filterChambers.senate) chamberParts.push('Senate');
    if (chamberParts.length > 0) parts.push(chamberParts.join('+'));

    if (filterBrackets.length > 0) {
      if (filterBrackets.length === 1) {
        const b = AMOUNT_BRACKETS.find(x => x.id === filterBrackets[0]);
        if (b) parts.push(b.label);
      } else {
        parts.push(`${filterBrackets.length} ranges`);
      }
    }
    return parts.join(' · ');
  }, [filterTicker, filterMember, filterChambers, filterBrackets]);

  const filtered = useMemo(() => {
    const items = feed?.items ?? [];
    return items.filter((item) => {
      // 1. Ticker filter
      if (filterTicker.trim()) {
        const tickerNeedle = filterTicker.trim().toLowerCase();
        const assetTicker = (item.asset.ticker ?? '').toLowerCase();
        if (!assetTicker.includes(tickerNeedle)) return false;
      }

      // 2. Member filter
      if (filterMember.trim()) {
        const memberNeedle = filterMember.trim().toLowerCase();
        const memberName = (item.member.name ?? '').toLowerCase();
        const memberState = (item.member.state ?? '').toLowerCase();
        if (!memberName.includes(memberNeedle) && !memberState.includes(memberNeedle)) return false;
      }

      // 3. Chamber filter
      if (filterChambers.house && !filterChambers.senate) {
        if (item.member.chamber !== 'house') return false;
      }
      if (filterChambers.senate && !filterChambers.house) {
        if (item.member.chamber !== 'senate') return false;
      }

      // 4. Amount brackets filter
      if (filterBrackets.length > 0) {
        const min = item.transaction.amountMin;
        const max = item.transaction.amountMax;
        
        const matchesAny = filterBrackets.some((bracketId) => {
          const bracket = AMOUNT_BRACKETS.find(b => b.id === bracketId);
          if (!bracket) return false;
          return matchesBracket(min, max, bracket);
        });
        
        if (!matchesAny) return false;
      }

      return true;
    });
  }, [feed, filterTicker, filterMember, filterChambers, filterBrackets]);

  function handleChamberToggle(chamber: 'house' | 'senate') {
    setFilterChambers(prev => ({
      ...prev,
      [chamber]: !prev[chamber]
    }));
  }

  function handleBracketToggle(bracketId: string) {
    setFilterBrackets(prev => 
      prev.includes(bracketId) 
        ? prev.filter(id => id !== bracketId) 
        : [...prev, bracketId]
    );
  }

  function resetFilters() {
    setFilterTicker('');
    setFilterMember('');
    setFilterChambers({ house: false, senate: false });
    setFilterBrackets([]);
  }

  async function submitWatchlist(event: FormEvent) {
    event.preventDefault();
    const tickers = watchlist.split(',').map((t) => t.trim()).filter(Boolean);
    const result = await apiPost<ClientCommandResponse>('/commands', {
      type: 'update_preferences',
      idempotencyKey: `prefs-${tickers.join('-').toUpperCase()}`,
      payload: { watchlist: tickers }
    });
    setCommandMessage(`Preferences ${result.command.status}`);
  }

  async function submitSubscription(event: FormEvent) {
    event.preventDefault();
    const result = await apiPost<ClientCommandResponse>('/commands', {
      type: 'create_subscription',
      idempotencyKey: `sub-${delivery}-${targetUrl || 'local'}`,
      payload: {
        delivery,
        targetUrl: delivery === 'webhook' ? targetUrl : null,
        filters: { tickers: watchlist.split(',').map((t) => t.trim()).filter(Boolean) }
      }
    });
    const subscription = result.result?.subscription;
    setCommandMessage(
      subscription?.streamUrl
        ? `SSE ready: ${subscription.streamUrl}`
        : `Subscription ${result.command.status}.`
    );
  }

  const user = bootstrap?.auth.user;
  const premium = bootstrap?.auth.entitlement.premium;

  return (
    <main className="app-shell">
      <header className="topbar" id="account">
        <div>
          <p className="eyebrow">Live Control Surface</p>
          <h1>Congress.Trade</h1>
        </div>
        <button className="icon-button" onClick={() => void refresh()} aria-label="Refresh feed">↻</button>
      </header>

      <section className="status-strip">
        <div><span>Feed</span><strong>{feed?.total ?? 0}</strong></div>
        <div><span>Cursor</span><strong>{feed?.cursor ?? 0}</strong></div>
        <div><span>Account</span><strong>{user ? 'Signed In' : 'Guest'}</strong></div>
        <div><span>Plan</span><strong>{premium ? 'Premium' : 'Free'}</strong></div>
      </section>

      {/* Trigger button for the filter panel */}
      <section className="toolbar-trigger" onClick={() => setIsFilterOpen(true)} aria-label="Open filter panel">
        <div className="filter-summary">
          <span className="filter-icon">🔍</span>
          <span className="filter-text">
            {activeFiltersSummary || 'Search and filter trades...'}
          </span>
        </div>
        <button className="filter-badge-btn" type="button">
          {activeFilterCount > 0 ? (
            <span className="active-filter-count">{activeFilterCount}</span>
          ) : (
            'Filters'
          )}
        </button>
      </section>

      {/* Bottom Sheet Filter Panel */}
      {isFilterOpen ? (
        <div className="filter-sheet-overlay" onClick={() => setIsFilterOpen(false)}>
          <div className="filter-sheet-container" onClick={(e) => e.stopPropagation()}>
            <div className="filter-sheet-drag-handle" />
            <div className="filter-sheet-header">
              <h2>Filter Trades</h2>
              <button className="filter-close-btn" onClick={() => setIsFilterOpen(false)} aria-label="Close filters">×</button>
            </div>
            
            <div className="filter-sheet-body">
              <div className="filter-section">
                <label htmlFor="filter-ticker-input">Ticker</label>
                <input
                  id="filter-ticker-input"
                  value={filterTicker}
                  onChange={(e) => setFilterTicker(e.target.value)}
                  placeholder="e.g. AAPL, MSFT"
                />
              </div>

              <div className="filter-section">
                <label htmlFor="filter-member-input">Representative / Senator / State</label>
                <input
                  id="filter-member-input"
                  value={filterMember}
                  onChange={(e) => setFilterMember(e.target.value)}
                  placeholder="e.g. Nancy Pelosi, CA"
                />
              </div>

              <div className="filter-section">
                <label>Chamber</label>
                <div className="checkbox-group">
                  <label className="checkbox-chip">
                    <input
                      type="checkbox"
                      checked={filterChambers.house}
                      onChange={() => handleChamberToggle('house')}
                    />
                    <span>House</span>
                  </label>
                  <label className="checkbox-chip">
                    <input
                      type="checkbox"
                      checked={filterChambers.senate}
                      onChange={() => handleChamberToggle('senate')}
                    />
                    <span>Senate</span>
                  </label>
                </div>
              </div>

              <div className="filter-section">
                <label>STOCK Act Amount Brackets</label>
                <div className="bracket-grid">
                  {AMOUNT_BRACKETS.map((bracket) => (
                    <label key={bracket.id} className="checkbox-chip">
                      <input
                        type="checkbox"
                        checked={filterBrackets.includes(bracket.id)}
                        onChange={() => handleBracketToggle(bracket.id)}
                      />
                      <span>{bracket.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="filter-sheet-footer">
              <button className="filter-reset-btn" onClick={resetFilters}>
                Clear
              </button>
              <button className="filter-apply-btn" onClick={() => setIsFilterOpen(false)}>
                Apply ({filtered.length} matches)
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {state === 'error' ? <p className="notice error">{commandMessage}</p> : null}
      {commandMessage && state !== 'error' ? <p className="notice">{commandMessage}</p> : null}

      <section className="feed-list" id="feed" aria-label="Recent trades">
        {state === 'loading' ? <div className="empty">Loading feed...</div> : null}
        {state !== 'loading' && filtered.length === 0 ? <div className="empty">No matching trades.</div> : null}
        {filtered.map((item) => {
          const lag = getLagDays(item.transaction.date, item.filing.filedDate);
          const compliance = getComplianceInfo(lag);

          return (
            <article className="trade-card" key={item.id}>
              <div className="trade-card-head">
                <div>
                  <strong>{item.asset.ticker ?? 'Asset'}</strong>
                  <span>{item.asset.name}</span>
                </div>
                <b className={item.transaction.type === 'S' ? 'sell' : 'buy'}>
                  {item.transaction.type === 'S' ? 'Sale' : item.transaction.type === 'P' ? 'Purchase' : 'Exchange'}
                </b>
              </div>
              <div className="trade-member">
                <span>{item.member.name ?? 'Unknown Member'}</span>
                <small>{[item.member.chamber, item.member.state].filter(Boolean).join(' · ') || 'Congress'}</small>
              </div>
              <dl className="trade-grid">
                <div><dt>Amount</dt><dd>{fmtAmount(item.transaction.amountMin, item.transaction.amountMax)}</dd></div>
                <div><dt>Traded</dt><dd>{shortDate(item.transaction.date)}</dd></div>
                <div><dt>Filed</dt><dd>{shortDate(item.filing.filedDate)}</dd></div>
                <div>
                  <dt>Reporting Lag</dt>
                  <dd>
                    <span className={`compliance-badge ${compliance.className}`}>
                      {compliance.text}
                    </span>
                  </dd>
                </div>
                <div><dt>Source</dt><dd>{item.source === 'primary' ? 'Live' : 'Historical'}</dd></div>
              </dl>
            </article>
          );
        })}
      </section>

      <section className="control-panel" id="controls">
        <form onSubmit={submitWatchlist}>
          <h2>Watchlist</h2>
          <p>Saved through the backend preference command.</p>
          <textarea value={watchlist} onChange={(event) => setWatchlist(event.target.value)} aria-label="Watchlist tickers" />
          <button type="submit">Save Watchlist</button>
        </form>

        <form onSubmit={submitSubscription}>
          <h2>Delivery</h2>
          <p>Configure SSE or webhook delivery through the command gateway.</p>
          <div className="segmented">
            <button type="button" className={delivery === 'sse' ? 'active' : ''} onClick={() => setDelivery('sse')}>SSE</button>
            <button type="button" className={delivery === 'webhook' ? 'active' : ''} onClick={() => setDelivery('webhook')}>Webhook</button>
          </div>
          {delivery === 'webhook' ? (
            <input value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://example.com/webhook" aria-label="Webhook URL" />
          ) : null}
          <button type="submit">Create Delivery</button>
        </form>
      </section>

      <nav className="bottom-nav" aria-label="Primary">
        <a href="#feed">Feed</a>
        <a href="#controls">Controls</a>
        <a href="#account">Account</a>
      </nav>
    </main>
  );
}