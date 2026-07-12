import type { ClientTrade } from '../../lib/contracts';
import {
  complianceInfo,
  formatAmount,
  formatEstimatedValue,
  formatShortDate,
  reportingLagDays,
} from '../../lib/formatters';

export function TradeCard({ item }: { item: ClientTrade }) {
  const lag = reportingLagDays(item.transaction.date, item.filing.filedDate);
  const compliance = complianceInfo(lag);

  return (
    <article className="trade-card">
      <div className="trade-card-head" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div className="gradient-asset">
          {item.asset.ticker ?? 'N/A'}
        </div>
        <div style={{ flex: 1 }}>
          <strong style={{ fontSize: '18px', color: 'var(--text)' }}>{item.asset.name}</strong>
          <span style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '2px' }}>{item.member.name ?? 'Unknown Politician'}</span>
        </div>
        <b className={item.transaction.type === 'S' ? 'sell' : 'buy'} style={{ borderRadius: '999px', padding: '6px 14px' }}>
          {item.transaction.type === 'S' ? 'Sale ↘' : item.transaction.type === 'P' ? 'Purchase ↗' : 'Exchange ↔'}
        </b>
      </div>
      <div className="trade-member">
        <small>{[item.member.chamber, item.member.state].filter(Boolean).join(' · ') || 'Congress'}</small>
      </div>
      <dl className="trade-grid">
        <div><dt>Amount</dt><dd>{formatAmount(item.transaction.amountMin, item.transaction.amountMax)}</dd></div>
        <div><dt>Value</dt><dd>{formatEstimatedValue(item.transaction.estValue)}</dd></div>
        <div><dt>Traded</dt><dd>{formatShortDate(item.transaction.date)}</dd></div>
        <div><dt>Filed</dt><dd>{formatShortDate(item.filing.filedDate)}</dd></div>
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
}
