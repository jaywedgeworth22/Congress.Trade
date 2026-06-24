'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { BootstrapResponse, ClientCommandResponse, ClientFeedResponse } from '../../lib/contracts';
import { apiGet, apiPost } from '../../lib/clientApi';

type LoadState = 'loading' | 'ready' | 'error';
type DeliveryMode = 'sse' | 'webhook';

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

export default function Dashboard() {
  const [state, setState] = useState<LoadState>('loading');
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [feed, setFeed] = useState<ClientFeedResponse | null>(null);
  const [query, setQuery] = useState('');
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

  const filtered = useMemo(() => {
    const items = feed?.items ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => {
      return [
        item.asset.ticker,
        item.asset.name,
        item.member.name,
        item.member.state
      ].some((v) => (v ?? '').toLowerCase().includes(needle));
    });
  }, [feed, query]);

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

      <section className="toolbar" aria-label="Feed tools">
        <label>
          <span>Search</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ticker, member, state" />
        </label>
      </section>

      {state === 'error' ? <p className="notice error">{commandMessage}</p> : null}
      {commandMessage && state !== 'error' ? <p className="notice">{commandMessage}</p> : null}

      <section className="feed-list" id="feed" aria-label="Recent trades">
        {state === 'loading' ? <div className="empty">Loading feed...</div> : null}
        {state !== 'loading' && filtered.length === 0 ? <div className="empty">No matching trades.</div> : null}
        {filtered.map((item) => (
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
              <div><dt>Source</dt><dd>{item.source === 'primary' ? 'Live' : 'Historical'}</dd></div>
            </dl>
          </article>
        ))}
      </section>

      <section className="control-panel" id="controls">
        <form onSubmit={submitWatchlist}>
          <h2>Watchlist</h2>
          <p>Saved through the backend preference command.</p>
          <textarea value={watchlist} onChange={(event) => setWatchlist(event.target.value)} />
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
            <input value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://example.com/webhook" />
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
