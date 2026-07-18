'use client';

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { apiGet } from '../../lib/clientApi';
import { ClientFeedResponse } from '../../lib/contracts';
import { TradeCard } from './TradeCard';
import { TradeTable } from './TradeTable';
import { ColumnConfig } from './ColumnConfig';
import { getOrderedColumns, loadHiddenCols, ColumnDef } from '../../lib/columns';
import { formatSummaryCount, formatSummaryVolume } from '../../lib/formatters';

export type PoliticianProfileResponse = ClientFeedResponse & {
  member: {
    id: string;
    name: string | null;
    chamber: string | null;
    party: string | null;
    state: string | null;
    district: string | null;
    photoUrl: string | null;
    committees: string | null;
  };
  summary: {
    totalTrades: number;
    estimatedVolumeUsd: number | null;
    buyCount: number;
    sellCount: number;
    volMin: number;
    volMax: number;
    estValue: number;
    uniqueTickers: number;
    uniqueAssets: number;
  };
};

const fetcher = (url: string) => apiGet<PoliticianProfileResponse>(url);

export default function PoliticianProfile({ slug }: { slug: string }) {
  const { data, error, isLoading } = useSWR(`/member/${encodeURIComponent(slug)}`, fetcher);
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [hiddenCols, setHiddenCols] = useState<string[]>(['member']);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  useEffect(() => {
    setColumns(getOrderedColumns(false));
    const savedHidden = loadHiddenCols(false);
    if (!savedHidden.includes('member')) {
      savedHidden.push('member');
    }
    setHiddenCols(savedHidden);
  }, []);

  const handleConfigChange = () => {
    setColumns(getOrderedColumns(false));
    const savedHidden = loadHiddenCols(false);
    if (!savedHidden.includes('member')) {
      savedHidden.push('member');
    }
    setHiddenCols(savedHidden);
  };

  if (isLoading) {
    return (
      <div className="app-shell" style={{ padding: '24px', textAlign: 'center' }}>
        <p>Loading politician...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="app-shell" style={{ padding: '24px', textAlign: 'center' }}>
        <h2>Politician not found</h2>
        <p>Could not load data for "{slug}".</p>
      </div>
    );
  }

  const { member, summary, items, total } = data;

  return (
    <div className="app-shell profile-shell">
      <header className="profile-header">
        {member.photoUrl ? (
          <img src={member.photoUrl} alt={member.name || slug} className="profile-photo" />
        ) : (
          <div className="profile-photo fallback-photo" />
        )}
        <div className="profile-title">
          <h1>{member.name || slug}</h1>
          <p className="profile-subtitle">
            {[member.chamber ? member.chamber.charAt(0).toUpperCase() + member.chamber.slice(1) : '', member.party, member.state]
              .filter(Boolean)
              .join(' • ')}
          </p>
        </div>
      </header>

      <section className="profile-stats">
        <div className="stat-card">
          <div className="stat-label">Total Trades</div>
          <div className="stat-value">{formatSummaryCount(summary.totalTrades)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Estimated Volume</div>
          <div className="stat-value">
            {formatSummaryVolume(summary.estimatedVolumeUsd)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Unique Assets</div>
          <div className="stat-value">{summary.uniqueAssets.toLocaleString()}</div>
        </div>
      </section>

      <div className="view-controls">
        <h2>Recent Trades ({total})</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {viewMode === 'table' && (
            <div className="profile-config">
              <button className="icon-button" onClick={() => setIsConfigOpen(!isConfigOpen)}>⚙️</button>
              {isConfigOpen && (
                <ColumnConfig isAdmin={false} onChange={handleConfigChange} onClose={() => setIsConfigOpen(false)} />
              )}
            </div>
          )}
          <div className="segmented-control">
            <button
              type="button"
              className={viewMode === 'grid' ? 'active' : ''}
              onClick={() => setViewMode('grid')}
            >
              Grid
            </button>
            <button
              type="button"
              className={viewMode === 'table' ? 'active' : ''}
              onClick={() => setViewMode('table')}
            >
              Table
            </button>
          </div>
        </div>
      </div>

      {viewMode === 'grid' ? (
        <div className="trade-grid">
          {items.map((tx) => (
            <TradeCard key={tx.id} item={tx} />
          ))}
        </div>
      ) : (
        <TradeTable items={items} columns={columns} hiddenCols={hiddenCols} />
      )}

      <style jsx>{`
        .profile-shell {
          padding: 16px;
          max-width: 1000px;
          margin: 0 auto;
        }
        .profile-header {
          display: flex;
          align-items: center;
          gap: 20px;
          margin-bottom: 24px;
        }
        .profile-photo {
          width: 80px;
          height: 80px;
          border-radius: 50%;
          object-fit: cover;
          border: 2px solid var(--border);
          background: #fff;
        }
        .fallback-photo {
          background: var(--bg-elevated);
        }
        .profile-title h1 {
          font-size: 28px;
          margin: 0 0 4px 0;
          color: var(--text);
        }
        .profile-subtitle {
          margin: 0;
          font-size: 16px;
          color: var(--text-muted);
        }
        .profile-stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 16px;
          margin-bottom: 32px;
        }
        .stat-card {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 16px;
          text-align: center;
        }
        .stat-label {
          font-size: 12px;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }
        .stat-value {
          font-size: 24px;
          font-weight: 700;
          color: var(--text);
        }
        .view-controls {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }
        .view-controls h2 {
          margin: 0;
          font-size: 20px;
          color: var(--text);
        }
        .segmented-control {
          display: flex;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 6px;
          overflow: hidden;
        }
        .segmented-control button {
          flex: 1;
          background: none;
          border: none;
          padding: 6px 12px;
          font-size: 13px;
          font-weight: 500;
          color: var(--text-muted);
          cursor: pointer;
        }
        .segmented-control button.active {
          background: var(--bg-muted);
          color: var(--text);
        }
      `}</style>
    </div>
  );
}
