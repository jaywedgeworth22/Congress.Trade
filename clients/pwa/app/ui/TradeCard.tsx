import type { ClientTrade } from '../../lib/contracts';

interface AmountBracket {
  id: string;
  label: string;
  min: number | null;
  max: number | null;
}

function fmtAmount(min: number | null, max: number | null) {
  if (min == null && max == null) return 'Undisclosed';
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  return `${money.format(min ?? 0)} - ${max == null ? 'plus' : money.format(max)}`;
}

function fmtEstValue(estValue: number | null) {
  if (estValue == null) return 'Unknown';
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, notation: "compact", compactDisplay: "short" });
  return `Est. ${money.format(estValue)}`;
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

export function TradeCard({ item }: { item: ClientTrade }) {
  const lag = getLagDays(item.transaction.date, item.filing.filedDate);
  const compliance = getComplianceInfo(lag);

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
        <div><dt>Amount</dt><dd>{fmtAmount(item.transaction.amountMin, item.transaction.amountMax)}</dd></div>
        <div><dt>Value</dt><dd>{fmtEstValue(item.transaction.estValue)}</dd></div>
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
}
