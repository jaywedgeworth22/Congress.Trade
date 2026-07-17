import { useEffect, useState } from 'react';
import useSWR from 'swr';

interface LatencyProvider {
  id: string;
  label: string;
  candidates: number;
  matched: number;
  coveragePct: number;
  usFirstCount: number;
  providerFirstCount: number;
  tieCount: number;
  medianLeadSec: number | null;
  avgLeadSec: number | null;
  p90LeadSec: number | null;
}

interface LatencySummary {
  generatedAt: string;
  totals: {
    racedDisclosures: number;
    matched: number;
    pending: number;
    comparableProviders: number;
  };
  providers: LatencyProvider[];
}

const SPEED_LANE_MIN_MATCHED = 5;

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
const latencyFetcher = async (path: string) => {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
  return res.json() as Promise<LatencySummary>;
};

function formatLead(secs: number): string {
  const s = Math.abs(secs || 0);
  const sign = secs < 0 ? '-' : '';
  const one = (x: number) => {
    const t = x.toFixed(1);
    return t.endsWith('.0') ? t.slice(0, -2) : t;
  };

  if (s < 90) return `${sign}${Math.round(s)} sec`;
  if (s < 5400) return `${sign}${Math.round(s / 60)} min`;
  if (s < 172800) return `${sign}${one(s / 3600)} hr`;
  return `${sign}${one(s / 86400)} days`;
}

export function SpeedScorecard() {
  const { data, error, isLoading } = useSWR<LatencySummary>(
    '/api/analytics/latency-summary',
    latencyFetcher,
    {
      refreshInterval: 300000, // Refresh every 5 minutes
      keepPreviousData: true,
    }
  );

  const [timeAgoText, setTimeAgoText] = useState('');

  useEffect(() => {
    if (!data?.generatedAt) return;
    const updateText = () => {
      const parsed = Date.parse(data.generatedAt);
      if (Number.isNaN(parsed)) return;
      const mins = Math.max(0, Math.round((Date.now() - parsed) / 60000));
      let text = `LIVE · updated ${mins < 1 ? 'just now' : `${mins} min ago`}`;
      if (mins > 30) text += ' · data may be stale';
      setTimeAgoText(text);
    };

    updateText();
    const interval = setInterval(updateText, 60000);
    return () => clearInterval(interval);
  }, [data?.generatedAt]);

  if (isLoading && !data) {
    return <div className="empty">Loading speed metrics...</div>;
  }

  if (error) {
    return (
      <div className="notice error" role="alert">
        Failed to load speed metrics: {error.message || 'Unknown error'}
      </div>
    );
  }

  if (!data || !data.providers || data.providers.length === 0) {
    return null;
  }

  // Sort providers by matched candidate count descending
  const sortedProviders = [...data.providers].sort((a, b) => b.matched - a.matched);

  return (
    <section className="speed-scorecard-section" aria-label="Data Providers Speed Scorecard">
      <div className="speed-scorecard-header">
        <div>
          <h2>Speed vs. Data Providers</h2>
          <p className="eyebrow" style={{ color: 'var(--muted)', marginTop: '4px' }}>
            {timeAgoText}
          </p>
        </div>
      </div>

      <div className="scorecard-grid">
        {sortedProviders.map((p) => {
          const hasStats = p.matched >= SPEED_LANE_MIN_MATCHED;
          const wins = p.usFirstCount || 0;
          const losses = p.providerFirstCount || 0;
          const ahead = hasStats && wins > losses;
          const tied = hasStats && !ahead && wins === losses;

          let cardStatusClass = 'sp-gathering';
          let badgeText = '📊 Gathering data';
          if (hasStats) {
            if (ahead) {
              cardStatusClass = 'sp-ahead';
              badgeText = '⚡ Ahead';
            } else if (tied) {
              cardStatusClass = 'sp-tied';
              badgeText = '⚖️ Tied';
            } else {
              cardStatusClass = 'sp-behind';
              badgeText = '▼ Behind';
            }
          }

          const winPct = hasStats && p.matched > 0 ? Math.round(100 * wins / p.matched) : 0;
          const need = SPEED_LANE_MIN_MATCHED - p.matched;

          return (
            <article key={p.id} className={`scorecard-card ${cardStatusClass}`}>
              <div className="card-header">
                <span className="provider-label">{p.label}</span>
                <span className={`status-badge ${cardStatusClass}`}>
                  {badgeText}
                </span>
              </div>

              {hasStats ? (
                <>
                  <div className="metric-bar-section">
                    <div className="metric-bar-labels">
                      <span>Win Rate</span>
                      <span>{winPct}% ({wins}/{p.matched})</span>
                    </div>
                    <div className="bar-track">
                      <div
                        className={`bar-fill ${cardStatusClass}`}
                        style={{ width: `${winPct}%` }}
                      />
                    </div>
                  </div>

                  <div className="lead-time-section">
                    <span className="lead-time-value">
                      {p.medianLeadSec != null ? `${p.medianLeadSec > 0 ? '+' : ''}${formatLead(p.medianLeadSec)}` : '0s'}
                    </span>
                    <span className="lead-time-label">
                      typical lead vs. their feed
                      {p.p90LeadSec != null && (
                        <span className="p90-label">P90: {formatLead(p.p90LeadSec)}</span>
                      )}
                    </span>
                  </div>

                  <div className="wlt-grid">
                    <div className="wlt-item">
                      <span className="wlt-val win">{wins}</span>
                      <span className="wlt-lbl">Wins</span>
                    </div>
                    <div className="wlt-item">
                      <span className="wlt-val loss">{losses}</span>
                      <span className="wlt-lbl">Losses</span>
                    </div>
                    <div className="wlt-item">
                      <span className="wlt-val tie">{p.tieCount || 0}</span>
                      <span className="wlt-lbl">Ties</span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="gathering-content">
                  {p.matched > 0 ? (
                    <p>
                      We&apos;ve matched <strong>{p.matched}</strong> of {p.candidates} filings so far. <strong>{need}</strong> more needed for timing estimates.
                    </p>
                  ) : (
                    <p>Probes haven&apos;t found overlapping disclosures yet. Sample builds automatically.</p>
                  )}
                  <span className="sample-label">n = {p.matched} / {p.candidates} matched</span>
                </div>
              )}
            </article>
          );
        })}
      </div>

      <style jsx>{`
        .speed-scorecard-section {
          margin-bottom: 24px;
        }
        .speed-scorecard-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          margin-bottom: 16px;
        }
        .scorecard-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 16px;
        }
        .scorecard-card {
          border: 1px solid hsla(217, 30%, 40%, 0.3);
          border-top-color: hsla(217, 30%, 55%, 0.5);
          border-radius: 16px;
          background: var(--panel);
          backdrop-filter: blur(20px);
          padding: 18px;
          box-shadow: inset 0 1px 0 hsla(0, 0%, 100%, 0.1), 0 8px 32px rgba(0, 0, 0, 0.2);
          display: flex;
          flex-direction: column;
          gap: 16px;
          transition: border-color 0.3s, box-shadow 0.3s;
        }
        .scorecard-card:hover {
          border-color: var(--border-hover);
        }
        .card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }
        .provider-label {
          font-weight: 800;
          font-size: 15px;
          color: var(--text);
        }
        .status-badge {
          font-size: 11px;
          font-weight: 800;
          padding: 4px 10px;
          border-radius: 999px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }
        .status-badge.sp-gathering {
          background: rgba(255, 255, 255, 0.08);
          color: var(--muted);
          border: 1px solid rgba(255, 255, 255, 0.15);
        }
        .status-badge.sp-ahead {
          background: hsla(142, 70%, 45%, 0.15);
          color: var(--buy);
          border: 1px solid hsla(142, 70%, 45%, 0.3);
        }
        .status-badge.sp-tied {
          background: rgba(255, 255, 255, 0.1);
          color: var(--muted);
          border: 1px solid rgba(255, 255, 255, 0.2);
        }
        .status-badge.sp-behind {
          background: hsla(350, 80%, 55%, 0.15);
          color: var(--sell);
          border: 1px solid hsla(350, 80%, 55%, 0.3);
        }

        .metric-bar-section {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .metric-bar-labels {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          font-weight: 700;
          color: var(--muted);
          text-transform: uppercase;
        }
        .bar-track {
          height: 8px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 999px;
          overflow: hidden;
        }
        .bar-fill {
          height: 100%;
          border-radius: 999px;
          transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .bar-fill.sp-ahead {
          background: var(--buy);
        }
        .bar-fill.sp-tied {
          background: var(--muted);
        }
        .bar-fill.sp-behind {
          background: var(--sell);
        }

        .lead-time-section {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 12px;
          background: rgba(255, 255, 255, 0.02);
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .lead-time-value {
          font-size: 24px;
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          letter-spacing: -0.02em;
        }
        .scorecard-card.sp-ahead .lead-time-value {
          color: var(--buy);
        }
        .scorecard-card.sp-behind .lead-time-value {
          color: var(--sell);
        }
        .lead-time-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--muted);
          line-height: 1.3;
          display: flex;
          flex-direction: column;
        }
        .p90-label {
          font-size: 10px;
          color: rgba(255, 255, 255, 0.4);
          margin-top: 2px;
        }

        .wlt-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          text-align: center;
          background: rgba(255, 255, 255, 0.02);
          border-radius: 12px;
          padding: 10px 4px;
          border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .wlt-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .wlt-val {
          font-size: 16px;
          font-weight: 800;
          font-variant-numeric: tabular-nums;
        }
        .wlt-val.win {
          color: var(--buy);
        }
        .wlt-val.loss {
          color: var(--sell);
        }
        .wlt-val.tie {
          color: var(--text);
        }
        .wlt-lbl {
          font-size: 10px;
          font-weight: 700;
          color: var(--muted);
          text-transform: uppercase;
        }

        .gathering-content {
          font-size: 12px;
          color: var(--muted);
          line-height: 1.5;
          display: flex;
          flex-direction: column;
          gap: 8px;
          flex: 1;
          justify-content: center;
        }
        .gathering-content strong {
          color: var(--text);
        }
        .sample-label {
          font-size: 10px;
          text-transform: uppercase;
          font-weight: 700;
          letter-spacing: 0.05em;
          color: rgba(255, 255, 255, 0.4);
        }
      `}</style>
    </section>
  );
}
