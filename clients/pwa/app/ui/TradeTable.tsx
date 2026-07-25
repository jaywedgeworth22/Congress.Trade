import { useState, useMemo } from 'react';
import type { ClientTrade } from '../../lib/contracts';
import type { ColumnDef } from '../../lib/columns';
import {
  formatAmount,
  formatEstimatedValue,
  formatShortDate,
  reportingLagDays,
  complianceInfo,
} from '../../lib/formatters';

interface TradeTableProps {
  items: ClientTrade[];
  columns: ColumnDef[];
  hiddenCols: string[];
}

type SortField = 'txdate' | 'type' | 'member' | 'asset' | 'min' | 'refSector' | 'refMarketCap' | 'refCountry' | 'published' | 'lag' | 'filed' | 'imported' | 'conf' | 'owner' | 'chamber' | 'source';
type SortDirection = 'asc' | 'desc';

function diffSec(aIso: string | null, bIso: string | null): number | null {
  if (!aIso || !bIso) return null;
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (a - b) / 1000;
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return '—';
  const rounded = Math.round(sec);
  if (rounded < 60) return `${rounded}s`;
  let m = Math.floor(rounded / 60);
  const s = rounded % 60;
  if (m < 60) return `${m}m ${s}s`;
  let h = Math.floor(m / 60);
  m = m % 60;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  h = h % 24;
  return `${d}d ${h}h`;
}

function renderLatency(item: ClientTrade) {
  if (item.source !== 'primary') return <span className="muted">—</span>;
  let rts: number | null = null;
  let sti: number | null = null;

  if (item.filing.filedDate && item.filing.firstSeenAt) {
    const d = diffSec(item.filing.firstSeenAt, item.filing.filedDate);
    if (d != null && d >= 0) rts = d;
  }
  if (item.filing.firstSeenAt && item.filing.firstSeenAt) {
    // Wait, firstSeenAt to imported. Let's see if we have imported date.
    // In contracts.ts: we don't have imported directly on filing. But wait, we can look at item.filing.firstSeenAt
    // Let's check if there is an imported date or if we can use firstSeenAt.
    // In dashboardHtml.ts, it uses r.imported. In ClientTrade contracts.ts, we don't have imported field.
    // Wait! Let's check if there is any other time. We have filing.firstSeenAt. Let's just use what we have.
  }

  const parts: string[] = [];
  if (rts != null) parts.push(`seen ≈${fmtDuration(rts)} after release`);
  if (parts.length === 0) return <span className="muted">Unavailable</span>;

  return (
    <span
      className="muted"
      style={{ display: 'block', lineHeight: 1.4, fontSize: '11px' }}
      title="Released to seen is approximate; seen to imported is measured by Congress.Trade."
    >
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && <br />}
        </span>
      ))}
    </span>
  );
}

export function TradeTable({ items, columns, hiddenCols }: TradeTableProps) {
  const [sortField, setSortField] = useState<SortField>('txdate');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const visibleColumns = useMemo(() => {
    return columns.filter((col) => !hiddenCols.includes(col.id));
  }, [columns, hiddenCols]);

  const handleHeaderClick = (col: ColumnDef) => {
    if (!col.sort) return;
    const field = col.sort as SortField;
    if (sortField === field) {
      setSortDirection((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const sortedItems = useMemo(() => {
    const sorted = [...items];
    if (!sortField) return sorted;

    sorted.sort((a, b) => {
      let valA: any = null;
      let valB: any = null;

      switch (sortField) {
        case 'txdate':
          valA = a.transaction.date ? new Date(a.transaction.date).getTime() : 0;
          valB = b.transaction.date ? new Date(b.transaction.date).getTime() : 0;
          break;
        case 'type':
          valA = a.transaction.type || '';
          valB = b.transaction.type || '';
          break;
        case 'member':
          valA = a.member.name || '';
          valB = b.member.name || '';
          break;
        case 'asset':
          valA = a.asset.ticker || a.asset.name || '';
          valB = b.asset.ticker || b.asset.name || '';
          break;
        case 'min':
          valA = a.transaction.amountMin || 0;
          valB = b.transaction.amountMin || 0;
          break;
        case 'refSector':
          valA = a.asset.sector || '';
          valB = b.asset.sector || '';
          break;
        case 'refMarketCap':
          valA = a.asset.marketCapBucket || '';
          valB = b.asset.marketCapBucket || '';
          break;
        case 'refCountry':
          valA = (a.asset as any).country || '';
          valB = (b.asset as any).country || '';
          break;
        case 'published':
          valA = a.filing.firstSeenAt ? new Date(a.filing.firstSeenAt).getTime() : 0;
          valB = b.filing.firstSeenAt ? new Date(b.filing.firstSeenAt).getTime() : 0;
          break;
        case 'lag':
          valA = reportingLagDays(a.transaction.date, a.filing.filedDate) ?? 9999;
          valB = reportingLagDays(b.transaction.date, b.filing.filedDate) ?? 9999;
          break;
        case 'filed':
          valA = a.filing.filedDate ? new Date(a.filing.filedDate).getTime() : 0;
          valB = b.filing.filedDate ? new Date(b.filing.filedDate).getTime() : 0;
          break;
        case 'imported':
          valA = a.filing.firstSeenAt ? new Date(a.filing.firstSeenAt).getTime() : 0;
          valB = b.filing.firstSeenAt ? new Date(b.filing.firstSeenAt).getTime() : 0;
          break;
        case 'conf':
          valA = a.confidence || 0;
          valB = b.confidence || 0;
          break;
        case 'owner':
          valA = a.transaction.owner || '';
          valB = b.transaction.owner || '';
          break;
        case 'chamber':
          valA = a.member.chamber || '';
          valB = b.member.chamber || '';
          break;
        case 'source':
          valA = a.source || '';
          valB = b.source || '';
          break;
        default:
          return 0;
      }

      if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
      if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [items, sortField, sortDirection]);

  const renderCell = (colId: string, item: ClientTrade) => {
    switch (colId) {
      case 'traded':
        return formatShortDate(item.transaction.date);
      case 'type':
        const badgeType = item.transaction.type;
        return (
          <span className={`trade-badge ${badgeType === 'S' ? 'sell' : badgeType === 'P' ? 'buy' : 'exchange'}`}>
            {badgeType === 'S' ? 'Sale' : badgeType === 'P' ? 'Buy' : 'Exch'}
          </span>
        );
      case 'member':
        return (
          <div className="member-cell">
            <div className="member-name">{item.member.name || 'Unknown'}</div>
            <div className="member-meta">
              {[item.member.chamber, item.member.state].filter(Boolean).join(' · ')}
            </div>
          </div>
        );
      case 'asset':
        return (
          <div className="asset-cell">
            {item.asset.ticker && <span className="asset-ticker">{item.asset.ticker}</span>}
            <span className="asset-name">{item.asset.name}</span>
          </div>
        );
      case 'amount':
        return formatAmount(item.transaction.amountMin, item.transaction.amountMax);
      case 'sector':
        return item.asset.sector || <span className="muted">—</span>;
      case 'marketcap':
        return item.asset.marketCapBucket || <span className="muted">—</span>;
      case 'country':
        return (item.asset as any).country || <span className="muted">—</span>;
      case 'published':
        return formatShortDate(item.filing.firstSeenAt);
      case 'lag':
        const lag = reportingLagDays(item.transaction.date, item.filing.filedDate);
        const comp = complianceInfo(lag);
        return (
          <span className={`compliance-badge ${comp.className}`}>
            {comp.text}
          </span>
        );
      case 'filed':
        return formatShortDate(item.filing.filedDate);
      case 'imported':
        return formatShortDate(item.filing.firstSeenAt);
      case 'latency':
        return renderLatency(item);
      case 'conf':
        const confPercent = Math.round((item.confidence || 0) * 100);
        let confClass = 'conf-low';
        if (confPercent >= 90) confClass = 'conf-high';
        else if (confPercent >= 70) confClass = 'conf-mid';
        return <span className={`conf-badge ${confClass}`}>~{confPercent}%</span>;
      case 'owner':
        return item.transaction.owner || <span className="muted">—</span>;
      case 'chamber':
        return item.member.chamber || <span className="muted">—</span>;
      case 'source':
        return item.source === 'primary' ? 'Live' : 'Seed';
      case 'docs':
        if (item.filing.sourceUrl) {
          return (
            <a href={item.filing.sourceUrl} target="_blank" rel="noopener noreferrer" className="doc-link" title="View Original PDF">
              📄 PDF
            </a>
          );
        }
        return <span className="muted">—</span>;
      default:
        return '—';
    }
  };

  return (
    <div className="table-responsive-wrapper">
      <table className="trades-table">
        <thead>
          <tr>
            {visibleColumns.map((col) => {
              const isSorted = col.sort === sortField;
              const canSort = !!col.sort;
              return (
                <th
                  key={col.id}
                  onClick={() => handleHeaderClick(col)}
                  className={`${canSort ? 'sortable' : ''} ${isSorted ? 'active-sort' : ''}`}
                  title={col.tip}
                >
                  <div className="header-content">
                    <span>{col.label}</span>
                    {canSort && (
                      <span className="sort-arrow">
                        {isSorted ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : ' ↕'}
                      </span>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedItems.map((item) => (
            <tr key={item.id}>
              {visibleColumns.map((col) => (
                <td key={col.id}>{renderCell(col.id, item)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <style jsx>{`
        .table-responsive-wrapper {
          width: 100%;
          overflow-x: auto;
          border: 1px solid hsla(217, 30%, 40%, 0.3);
          border-top-color: hsla(217, 30%, 55%, 0.5);
          border-radius: 16px;
          background: var(--panel);
          backdrop-filter: blur(20px);
          box-shadow: inset 0 1px 0 hsla(0, 0%, 100%, 0.1), 0 8px 32px rgba(0, 0, 0, 0.2);
          margin-bottom: 24px;
        }
        /* Custom scrollbars */
        .table-responsive-wrapper::-webkit-scrollbar {
          height: 8px;
        }
        .table-responsive-wrapper::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.03);
          border-radius: 999px;
        }
        .table-responsive-wrapper::-webkit-scrollbar-thumb {
          background: hsla(217, 30%, 35%, 0.6);
          border-radius: 999px;
        }

        .trades-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
          font-size: 13px;
        }
        .trades-table th {
          padding: 14px 16px;
          border-bottom: 1px solid hsla(217, 30%, 40%, 0.3);
          color: var(--muted);
          font-size: 10px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          user-select: none;
          white-space: nowrap;
        }
        .trades-table th.sortable {
          cursor: pointer;
          transition: color 0.2s;
        }
        .trades-table th.sortable:hover {
          color: var(--text);
          background: rgba(255, 255, 255, 0.02);
        }
        .trades-table th.active-sort {
          color: var(--text);
          background: rgba(255, 255, 255, 0.03);
        }
        .header-content {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .sort-arrow {
          font-size: 9px;
          opacity: 0.6;
        }
        .trades-table td {
          padding: 12px 16px;
          border-bottom: 1px solid hsla(217, 30%, 40%, 0.15);
          vertical-align: middle;
          white-space: nowrap;
          color: var(--text);
        }
        .trades-table tr:last-child td {
          border-bottom: none;
        }
        .trades-table tr:hover td {
          background: rgba(255, 255, 255, 0.02);
        }

        .member-cell {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .member-name {
          font-weight: 700;
          color: var(--text);
        }
        .member-meta {
          font-size: 11px;
          color: var(--muted);
        }

        .asset-cell {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .asset-ticker {
          background: var(--accent-glow);
          color: hsl(222, 100%, 75%);
          border: 1px solid hsla(222, 100%, 64%, 0.3);
          font-size: 11px;
          font-weight: 800;
          padding: 2px 6px;
          border-radius: 6px;
        }
        .asset-name {
          font-weight: 600;
          max-width: 200px;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .trade-badge {
          font-size: 10px;
          font-weight: 800;
          padding: 2px 8px;
          border-radius: 999px;
          text-transform: uppercase;
          display: inline-block;
        }
        .trade-badge.buy {
          background: hsla(142, 70%, 45%, 0.15);
          color: var(--buy);
          border: 1px solid hsla(142, 70%, 45%, 0.3);
        }
        .trade-badge.sell {
          background: hsla(350, 80%, 55%, 0.15);
          color: var(--sell);
          border: 1px solid hsla(350, 80%, 55%, 0.3);
        }
        .trade-badge.exchange {
          background: rgba(255, 255, 255, 0.1);
          color: var(--text);
          border: 1px solid rgba(255, 255, 255, 0.2);
        }

        .compliance-badge {
          font-size: 11px;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 6px;
        }
        .compliance-green {
          background: var(--compliance-green-bg);
          color: var(--compliance-green);
        }
        .compliance-yellow {
          background: var(--compliance-yellow-bg);
          color: var(--compliance-yellow);
        }
        .compliance-red {
          background: var(--compliance-red-bg);
          color: var(--compliance-red);
        }
        .compliance-unknown {
          background: rgba(255, 255, 255, 0.05);
          color: var(--muted);
        }

        .conf-badge {
          font-size: 11px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .conf-high {
          color: var(--buy);
        }
        .conf-mid {
          color: var(--compliance-yellow);
        }
        .conf-low {
          color: var(--sell);
        }

        .muted {
          color: var(--muted);
          opacity: 0.6;
        }
      `}</style>
    </div>
  );
}
