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
        <span>{item.member.name ?? 'Unknown Politician'}</span>
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
