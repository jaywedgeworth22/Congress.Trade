'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import type {
  BootstrapResponse,
  ClientCommandResponse,
  ClientFeedResponse,
  ClientPreferencesResponse,
} from '../../lib/contracts';
import { ApiError, apiGet, apiPost } from '../../lib/clientApi';
import {
  activeFilterCount,
  AMOUNT_BRACKETS,
  buildFeedPath,
  commandBody,
  deliveryScopeHelperText,
  EMPTY_FILTERS,
  filterSummary,
  parseWatchlist,
  type CommandBody,
  type FeedFilters,
} from '../../lib/dashboardModel';
import { TradeCard } from './TradeCard';
import { ColumnConfig } from './ColumnConfig';
import { SpeedScorecard } from './SpeedScorecard';
import { TradeTable } from './TradeTable';
import {
  ColumnDef,
  getOrderedColumns,
  loadHiddenCols,
  isAdminView as checkAdminView,
} from '../../lib/columns';

type DeliveryMode = 'sse' | 'webhook';
type RetryIntent = { kind: 'preferences' | 'subscription'; body: CommandBody };
type OneTimeDelivery = {
  id: string;
  delivery: DeliveryMode;
  secret: string;
  streamUrl: string | null;
};

const fetcher = <T,>(path: string) => apiGet<T>(path);

export default function Dashboard() {
  const [appliedFilters, setAppliedFilters] = useState<FeedFilters>(() => ({ ...EMPTY_FILTERS }));
  const [draftFilters, setDraftFilters] = useState<FeedFilters>(() => ({ ...EMPTY_FILTERS }));
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [watchlistDraft, setWatchlistDraft] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<DeliveryMode>('sse');
  const [targetUrl, setTargetUrl] = useState('');
  const [commandMessage, setCommandMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [retryIntent, setRetryIntent] = useState<RetryIntent | null>(null);
  const [oneTimeDelivery, setOneTimeDelivery] = useState<OneTimeDelivery | null>(null);

  const [viewMode, setViewMode] = useState<'card' | 'table'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('feed-view-mode');
      if (saved === 'card' || saved === 'table') return saved;
    }
    return 'card';
  });

  const [isConfigOpen, setIsConfigOpen] = useState(false);

  // Column config states
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [hiddenCols, setHiddenCols] = useState<string[]>([]);

  const firstFilterRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const feedPath = useMemo(() => buildFeedPath(appliedFilters), [appliedFilters]);
  const {
    data: bootstrap,
    error: bootstrapError,
    isLoading: isBootstrapLoading,
  } = useSWR<BootstrapResponse>('/bootstrap', fetcher);
  const {
    data: feed,
    error: feedError,
    mutate: refreshFeed,
    isLoading: isFeedLoading,
  } = useSWR<ClientFeedResponse>(feedPath, fetcher, {
    keepPreviousData: true,
  });
  const user = bootstrap?.auth.user;
  const premium = bootstrap?.auth.entitlement.premium ?? false;
  const isAdmin = checkAdminView();

  useEffect(() => {
    setColumns(getOrderedColumns(isAdmin));
    setHiddenCols(loadHiddenCols(isAdmin));
  }, [isAdmin]);

  const handleConfigChange = () => {
    setColumns(getOrderedColumns(isAdmin));
    setHiddenCols(loadHiddenCols(isAdmin));
  };
  const {
    data: preferencesEnvelope,
    error: preferencesError,
    isLoading: isPreferencesLoading,
    isValidating: isPreferencesValidating,
    mutate: refreshPreferences,
  } = useSWR<ClientPreferencesResponse>(user ? '/preferences' : null, fetcher);
  const watchlist = watchlistDraft ?? preferencesEnvelope?.preferences.watchlist.join(', ') ?? '';
  // Same source submitSubscription() reads from, kept in one place so the
  // Delivery form's scope summary can never drift from what actually gets sent.
  const watchlistTickers = useMemo(() => parseWatchlist(watchlist), [watchlist]);

  useEffect(() => {
    setWatchlistDraft(null);
    setRetryIntent(null);
    setOneTimeDelivery(null);
  }, [user?.id]);

  const feedRef = useRef(feed);
  const feedPathRef = useRef(feedPath);
  useEffect(() => {
    feedRef.current = feed;
    feedPathRef.current = feedPath;
  }, [feed, feedPath]);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    let isCancelled = false;

    async function poll() {
      if (isCancelled) return;

      const currentFeed = feedRef.current;
      const currentPath = feedPathRef.current;

      let nextDelay = 30_000;

      try {
        // `since` is a NUMERIC cursor (the server applies `cursor_seq > since`);
        // the trade id is a string and would be parsed as absent, returning the
        // oldest ascending page. Use the envelope's max-cursor watermark, and
        // only when we actually hold rows.
        const watermark =
          currentFeed && currentFeed.items.length > 0 ? currentFeed.cursor : null;

        if (watermark != null) {
          const params = new URLSearchParams(currentPath.split('?')[1] || '');
          params.set('since', String(watermark));
          params.set('order', 'asc');

          const delta = await apiGet<ClientFeedResponse>(`/feed?${params.toString()}`);

          if (!isCancelled && delta.items.length > 0) {
            const reversedNewItems = [...delta.items].reverse();
            void refreshFeed((prev) => {
              if (!prev) return prev;
              const existingIds = new Set(prev.items.map((i) => i.id));
              const actuallyNew = reversedNewItems.filter((i) => !existingIds.has(i.id));
              // Always advance the watermark so the same delta isn't refetched.
              const nextCursor = Math.max(prev.cursor, delta.cursor);
              if (actuallyNew.length === 0) return { ...prev, cursor: nextCursor };

              return {
                ...prev,
                cursor: nextCursor,
                total: delta.total,
                count: prev.count + actuallyNew.length,
                items: [...actuallyNew, ...prev.items],
              };
            }, { revalidate: false });
          }
        } else if (!isCancelled) {
          // No rows yet (e.g. an empty ticker/member/amount filter): there is no
          // cursor to poll from, so revalidate the base snapshot instead — a
          // user watching an empty filter still sees the first match arrive.
          await refreshFeed();
        }
      } catch (error) {
        if (error instanceof ApiError && error.retryAfter) {
          nextDelay = error.retryAfter * 1000;
        } else {
          nextDelay = 60_000;
        }
      }

      if (!isCancelled) {
        timeoutId = setTimeout(poll, nextDelay);
      }
    }

    timeoutId = setTimeout(poll, 30_000);
    return () => {
      isCancelled = true;
      clearTimeout(timeoutId);
    };
  }, [refreshFeed]);

  useEffect(() => {
    if (!dialogRef.current) return;
    if (isFilterOpen) {
      dialogRef.current.showModal();
      // Use a small delay for focusing the first input to ensure dialog is rendered
      const focusFrame = requestAnimationFrame(() => firstFilterRef.current?.focus());
      return () => cancelAnimationFrame(focusFrame);
    } else {
      dialogRef.current.close();
      triggerRef.current?.focus();
    }
  }, [isFilterOpen]);

  function openFilters() {
    setDraftFilters({ ...appliedFilters });
    setIsFilterOpen(true);
  }

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    setAppliedFilters({
      ...draftFilters,
      ticker: draftFilters.ticker.trim(),
      memberName: draftFilters.memberName.trim(),
    });
    setIsFilterOpen(false);
  }

  async function runIntent(intent: RetryIntent) {
    if (!user) {
      setCommandMessage('Sign in before changing account settings.');
      return;
    }
    setIsSubmitting(true);
    setCommandMessage('');
    try {
      const result = await apiPost<ClientCommandResponse>('/commands', intent.body);
      setRetryIntent(null);
      if (intent.kind === 'preferences') {
        await refreshPreferences();
        setWatchlistDraft(null);
        setCommandMessage(result.replayed ? 'Watchlist save confirmed.' : 'Watchlist saved.');
      } else {
        const subscription = result.result?.subscription;
        const intentDelivery = intent.body.payload.delivery === 'webhook' ? 'webhook' : 'sse';
        if (subscription?.secret) {
          const streamUrl = subscription.streamUrl
            ? new URL(subscription.streamUrl, window.location.origin).toString()
            : null;
          setOneTimeDelivery({ id: subscription.id, delivery: intentDelivery, secret: subscription.secret, streamUrl });
          setCommandMessage('Delivery created. Copy the credential below now; it will not be shown again.');
        } else if (result.replayed && result.command.status === 'succeeded') {
          setCommandMessage('Delivery already exists, but its one-time credential cannot be replayed. Create a new delivery if it was not saved.');
        } else {
          setCommandMessage(`Delivery ${result.command.status}.`);
        }
      }
    } catch (error) {
      const shouldRetainIntent = !(error instanceof ApiError) || error.status >= 500;
      setRetryIntent(shouldRetainIntent ? intent : null);
      setCommandMessage(
        shouldRetainIntent
          ? 'The request outcome is uncertain. Retry will reuse the same idempotency key.'
          : `Could not save: ${error.message}`,
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function submitWatchlist(event: FormEvent) {
    event.preventDefault();
    const body = commandBody('update_preferences', { watchlist: parseWatchlist(watchlist) });
    void runIntent({ kind: 'preferences', body });
  }

  function submitSubscription(event: FormEvent) {
    event.preventDefault();
    const body = commandBody('create_subscription', {
      delivery,
      targetUrl: delivery === 'webhook' ? targetUrl.trim() : null,
      filters: { tickers: watchlistTickers },
    });
    void runIntent({ kind: 'subscription', body });
  }

  async function copyCredential(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCommandMessage(`${label} copied.`);
    } catch {
      setCommandMessage(`Could not copy ${label.toLowerCase()}; select it manually.`);
    }
  }

  const currentFilterSummary = filterSummary(appliedFilters);
  const currentFilterCount = activeFilterCount(appliedFilters);
  const loadError = feedError || bootstrapError;

  return (
    <main className="app-shell">
      <header className="topbar" id="account">
        <div>
          <p className="eyebrow">Live Control Surface</p>
          <h1>Congress.Trade</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => void refreshFeed()}
          aria-label="Refresh feed"
          disabled={isFeedLoading}
        >
          ↻
        </button>
      </header>

      <section className="status-strip" aria-label="Feed and account status">
        <div><span>Matches</span><strong>{feed?.total ?? 0}</strong></div>
        <div><span>Showing</span><strong>{feed?.count ?? 0}</strong></div>
        <div><span>Account</span><strong>{user ? 'Signed In' : 'Guest'}</strong></div>
        <div><span>Plan</span><strong>{premium ? 'Premium' : 'Free'}</strong></div>
      </section>

      <SpeedScorecard />

      <button
        ref={triggerRef}
        className="toolbar-trigger"
        type="button"
        onClick={openFilters}
        aria-haspopup="dialog"
        aria-expanded={isFilterOpen}
      >
        <span className="filter-summary">
          <span className="filter-icon" aria-hidden="true">⌕</span>
          <span className="filter-text">{currentFilterSummary || 'Search and filter trades...'}</span>
        </span>
        <span className={currentFilterCount ? 'active-filter-count' : 'filter-badge'}>
          {currentFilterCount || 'Filters'}
        </span>
      </button>

      <div className="view-controls-row" style={{ display: 'flex', gap: '8px', marginBottom: '16px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <div className="segmented-controls" style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden', background: 'var(--panel)', backdropFilter: 'blur(10px)' }}>
          <button
            type="button"
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 700,
              background: viewMode === 'card' ? 'var(--accent)' : 'transparent',
              color: viewMode === 'card' ? 'var(--text)' : 'var(--muted)',
              border: 'none',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onClick={() => {
              setViewMode('card');
              localStorage.setItem('feed-view-mode', 'card');
            }}
          >
            🎴 Cards
          </button>
          <button
            type="button"
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 700,
              background: viewMode === 'table' ? 'var(--accent)' : 'transparent',
              color: viewMode === 'table' ? 'var(--text)' : 'var(--muted)',
              border: 'none',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onClick={() => {
              setViewMode('table');
              localStorage.setItem('feed-view-mode', 'table');
            }}
          >
            📊 Table
          </button>
        </div>

        <button
          type="button"
          style={{
            padding: '6px 14px',
            fontSize: '12px',
            fontWeight: 700,
            borderRadius: '10px',
            background: isConfigOpen ? 'var(--panel-2)' : 'var(--panel)',
            color: isConfigOpen ? 'var(--text)' : 'var(--muted)',
            border: '1px solid var(--border)',
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
          onClick={() => setIsConfigOpen(!isConfigOpen)}
        >
          ⚙️ Columns
        </button>
      </div>

      {isConfigOpen && (
        <ColumnConfig
          isAdmin={isAdmin}
          onChange={handleConfigChange}
          onClose={() => setIsConfigOpen(false)}
        />
      )}

      <dialog
        ref={dialogRef}
        className="filter-sheet-dialog"
        onClose={() => setIsFilterOpen(false)}
        onClick={(event) => {
          if (event.target === dialogRef.current) setIsFilterOpen(false);
        }}
        aria-labelledby="filter-dialog-title"
      >
        <div
          className="filter-sheet-container"
        >
            <div className="filter-sheet-drag-handle" aria-hidden="true" />
            <div className="filter-sheet-header">
              <h2 id="filter-dialog-title">Filter Trades</h2>
              <button className="filter-close-btn" type="button" onClick={() => setIsFilterOpen(false)} aria-label="Close filters">×</button>
            </div>

            <form onSubmit={applyFilters} className="filter-form">
              <div className="filter-sheet-body">
                <div className="filter-section">
                  <label htmlFor="filter-ticker-input">Ticker</label>
                  <input
                    ref={firstFilterRef}
                    id="filter-ticker-input"
                    value={draftFilters.ticker}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, ticker: event.target.value }))}
                    placeholder="e.g. AAPL"
                    autoComplete="off"
                  />
                </div>

                <div className="filter-section">
                  <label htmlFor="filter-member-input">Representative or Senator</label>
                  <input
                    id="filter-member-input"
                    value={draftFilters.memberName}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, memberName: event.target.value }))}
                    placeholder="e.g. Nancy Pelosi"
                    autoComplete="off"
                  />
                </div>

                <fieldset className="filter-section">
                  <legend>Chamber</legend>
                  <div className="checkbox-group">
                    {([
                      ['', 'All'],
                      ['house', 'House'],
                      ['senate', 'Senate'],
                      ['executive', 'Executive'],
                    ] as const).map(([value, label]) => (
                      <label key={value || 'all'} className="checkbox-chip">
                        <input
                          type="radio"
                          name="chamber"
                          value={value}
                          checked={draftFilters.chamber === value}
                          onChange={() => setDraftFilters((current) => ({ ...current, chamber: value }))}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="filter-section">
                  <legend>STOCK Act Amount Bracket</legend>
                  <div className="bracket-grid">
                    <label className="checkbox-chip">
                      <input
                        type="radio"
                        name="amount-bracket"
                        value=""
                        checked={!draftFilters.amountBracketId}
                        onChange={() => setDraftFilters((current) => ({ ...current, amountBracketId: '' }))}
                      />
                      <span>All amounts</span>
                    </label>
                    {AMOUNT_BRACKETS.map((bracket) => (
                      <label key={bracket.id} className="checkbox-chip">
                        <input
                          type="radio"
                          name="amount-bracket"
                          value={bracket.id}
                          checked={draftFilters.amountBracketId === bracket.id}
                          onChange={() => setDraftFilters((current) => ({ ...current, amountBracketId: bracket.id }))}
                        />
                        <span>{bracket.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>

              <div className="filter-sheet-footer">
                <button className="filter-reset-btn" type="button" onClick={() => setDraftFilters({ ...EMPTY_FILTERS })}>Reset</button>
                <button className="filter-apply-btn" type="submit">Apply filters</button>
              </div>
            </form>
        </div>
      </dialog>

      {loadError ? <p className="notice error" role="alert">{loadError instanceof Error ? loadError.message : 'Error loading feed.'}</p> : null}
      {commandMessage ? (
        <div className="notice" aria-live="polite">
          <span>{commandMessage}</span>
          {retryIntent ? (
            <button type="button" className="inline-action" disabled={isSubmitting} onClick={() => void runIntent(retryIntent)}>
              Retry safely
            </button>
          ) : null}
        </div>
      ) : null}

      {oneTimeDelivery ? (
        <section className="secret-panel" aria-labelledby="delivery-credential-title">
          <div className="secret-panel-head">
            <div>
              <p className="eyebrow">One-time credential</p>
              <h2 id="delivery-credential-title">Save this {oneTimeDelivery.delivery.toUpperCase()} credential now</h2>
            </div>
            <button type="button" className="dismiss-button" onClick={() => setOneTimeDelivery(null)}>Dismiss</button>
          </div>
          <p>The secret is kept only in this page&apos;s memory and cannot be retrieved after dismissal or reload.</p>
          <div className="secret-row">
            <label htmlFor="delivery-secret">Secret</label>
            <div>
              <input id="delivery-secret" readOnly value={oneTimeDelivery.secret} onFocus={(event) => event.currentTarget.select()} />
              <button type="button" onClick={() => void copyCredential('Secret', oneTimeDelivery.secret)}>Copy</button>
            </div>
          </div>
          {oneTimeDelivery.streamUrl ? (
            <div className="secret-row">
              <label htmlFor="delivery-stream-url">SSE URL</label>
              <div>
                <input id="delivery-stream-url" readOnly value={oneTimeDelivery.streamUrl} onFocus={(event) => event.currentTarget.select()} />
                <button type="button" onClick={() => void copyCredential('SSE URL', oneTimeDelivery.streamUrl!)}>Copy</button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="feed-list" id="feed" aria-label="Recent trades" aria-busy={isFeedLoading}>
        {isFeedLoading && !feed ? <div className="empty">Loading latest trades...</div> : null}
        {!isFeedLoading && !feedError && (feed?.items.length ?? 0) === 0 ? (
          <div className="empty">No trades match these filters.</div>
        ) : null}
        {viewMode === 'card' ? (
          (feed?.items ?? []).map((item) => <TradeCard key={item.id} item={item} />)
        ) : (
          <TradeTable
            items={feed?.items ?? []}
            columns={columns}
            hiddenCols={hiddenCols}
          />
        )}
      </section>

      <section className="control-panel" id="controls" aria-label="Account controls">
        {isBootstrapLoading ? <div className="empty">Loading account...</div> : null}
        {!isBootstrapLoading && !user ? (
          <section className="auth-gate">
            <h2>Sign in to save account settings</h2>
            <p>The feed is public. Watchlists and delivery credentials are account-owned and require a session.</p>
            <a className="primary-link" href="/auth/google/start">Sign in with Google</a>
          </section>
        ) : null}
        {user ? (
          <>
            <form onSubmit={submitWatchlist}>
              <h2>Watchlist</h2>
              <p>Loaded from and saved to your backend preferences.</p>
              {preferencesError ? (
                <div className="form-error" role="alert">
                  <span>Could not load saved preferences. Editing remains locked to protect existing data.</span>
                  <button
                    type="button"
                    disabled={isPreferencesValidating}
                    onClick={() => void refreshPreferences()}
                  >
                    Retry loading
                  </button>
                </div>
              ) : null}
              <textarea
                value={watchlist}
                onChange={(event) => setWatchlistDraft(event.target.value)}
                aria-label="Watchlist tickers"
                placeholder={isPreferencesLoading ? 'Loading saved watchlist...' : 'Comma-separated tickers'}
                disabled={isPreferencesLoading || Boolean(preferencesError) || isSubmitting}
              />
              <button type="submit" disabled={isPreferencesLoading || Boolean(preferencesError) || isSubmitting}>Save Watchlist</button>
            </form>

            <form onSubmit={submitSubscription}>
              <h2>Delivery</h2>
              <p>Create an SSE or webhook delivery through the command gateway.</p>
              <div className="segmented" aria-label="Delivery type">
                <button type="button" aria-pressed={delivery === 'sse'} className={delivery === 'sse' ? 'active' : ''} onClick={() => setDelivery('sse')}>SSE</button>
                <button type="button" aria-pressed={delivery === 'webhook'} className={delivery === 'webhook' ? 'active' : ''} onClick={() => setDelivery('webhook')}>Webhook</button>
              </div>
              {delivery === 'webhook' ? (
                <input
                  type="url"
                  required
                  value={targetUrl}
                  onChange={(event) => setTargetUrl(event.target.value)}
                  placeholder="https://example.com/webhook"
                  aria-label="Webhook URL"
                  autoComplete="off"
                  disabled={isSubmitting}
                />
              ) : null}
              <div className="delivery-scope" aria-live="polite">
                <span className="delivery-scope-label">Scope</span>
                {watchlistTickers.length > 0 ? (
                  <div className="delivery-scope-tickers">
                    {watchlistTickers.map((ticker) => (
                      <span key={ticker} className="filter-badge">{ticker}</span>
                    ))}
                  </div>
                ) : null}
                <p className="delivery-scope-helper">{deliveryScopeHelperText(watchlistTickers)}</p>
              </div>
              <button type="submit" disabled={isSubmitting}>Create Delivery</button>
            </form>
          </>
        ) : null}

        <div style={{ marginTop: '32px', paddingTop: '16px', borderTop: '1px solid var(--border)', fontSize: '12px', color: 'var(--muted)', textAlign: 'center' }}>
          <a href="/terms-of-service" style={{ color: 'var(--muted)', textDecoration: 'none', marginRight: '12px' }}>Terms of Service</a>
          <a href="/privacy-policy" style={{ color: 'var(--muted)', textDecoration: 'none' }}>Privacy Policy</a>
        </div>
      </section>

      <nav className="bottom-nav" aria-label="Primary">
        <a href="#feed">Feed</a>
        <a href="#controls">Controls</a>
        <a href="#account">Account</a>
      </nav>
    </main>
  );
}
