'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { apiGet } from '../../lib/clientApi';

const fetcher = <T,>(path: string) => apiGet<T>(path);

interface TickerLeaderboardItem {
  ticker: string;
  refCompanyName: string | null;
  assetClass: string;
  sector: string | null;
  industry: string | null;
  tradeCount: number;
  estVolumeUsd: number;
  netBuyVolUsd: number;
}

interface VolumeOverTimeItem {
  period: string;
  buys: number;
  sells: number;
  estBuyVolUsd: number;
  estSellVolUsd: number;
}

interface VolumeOverTimeResponse {
  granularity: string;
  count: number;
  series: VolumeOverTimeItem[];
}


interface MemberLeaderboardItem {
  filerId: string;
  fullName: string | null;
  party: string | null;
  chamber: string | null;
  state: string | null;
  tradeCount: number;
}

interface ClusterBuysItem {
  ticker: string;
  name: string | null;
  txType: string;
  memberCount: number;
}

interface SectorFlowItem {
  sector: string;
  estNetFlowUsd: number;
}

export function Trends() {
  const [timeframe, setTimeframe] = useState<'30' | '90' | '365'>('30');
  const [rankBy, setRankBy] = useState<'volume' | 'trades'>('volume');

  const { data: leaderboard, error: lbError } = useSWR<TickerLeaderboardItem[]>(
    `/analytics/ticker-leaderboard?window=${timeframe}&rankBy=${rankBy}`,
    fetcher
  );

  
  const { data: memberLeaderboard, error: memError } = useSWR<{members: MemberLeaderboardItem[]}>(
    `/analytics/member-leaderboard?window=${timeframe}`,
    fetcher
  );

  const { data: clusterBuys, error: clusterError } = useSWR<{clusters: ClusterBuysItem[]}>(
    `/analytics/cluster-buys?window=${timeframe}`,
    fetcher
  );

  const { data: sectorFlow, error: sectorError } = useSWR<{sectors: SectorFlowItem[]}>(
    `/analytics/sector-flow?window=${timeframe}`,
    fetcher
  );

  const { data: volumeData, error: volError } = useSWR<VolumeOverTimeResponse>(
    `/analytics/volume-over-time?window=${timeframe}`,
    fetcher
  );

  // Compute stats based on leaderboard
  const stats = (() => {
    if (!leaderboard) return { totalVol: 0, netBuy: 0, topSector: 'None' };
    let totalVol = 0;
    let netBuy = 0;
    const sectorVol: Record<string, number> = {};

    for (const item of leaderboard) {
      totalVol += item.estVolumeUsd;
      netBuy += item.netBuyVolUsd;
      if (item.sector) {
        sectorVol[item.sector] = (sectorVol[item.sector] || 0) + item.estVolumeUsd;
      }
    }

    let topSector = 'None';
    let maxSectorVol = -1;
    for (const [sec, vol] of Object.entries(sectorVol)) {
      if (vol > maxSectorVol) {
        maxSectorVol = vol;
        topSector = sec;
      }
    }

    return { totalVol, netBuy, topSector };
  })();

  const formatUsd = (num: number) => {
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
    if (num >= 1e3) return `$${(num / 1e3).toFixed(0)}k`;
    return `$${num.toFixed(0)}`;
  };

  const maxChartVol = volumeData?.series?.reduce((acc, curr) => {
    const total = curr.estBuyVolUsd + curr.estSellVolUsd;
    return total > acc ? total : acc;
  }, 0) || 1;

  return (
    <div className="trends-container">
      {/* Timeframe Toggles */}
      <div className="view-controls-row">
        <div className="segmented-control" role="group" aria-label="Timeframe">
          <button
            type="button"
            className={timeframe === '30' ? 'active' : ''}
            onClick={() => setTimeframe('30')}
          >
            30 Days
          </button>
          <button
            type="button"
            className={timeframe === '90' ? 'active' : ''}
            onClick={() => setTimeframe('90')}
          >
            90 Days
          </button>
          <button
            type="button"
            className={timeframe === '365' ? 'active' : ''}
            onClick={() => setTimeframe('365')}
          >
            1 Year
          </button>
        </div>

        <div className="segmented-control" role="group" aria-label="Rank By">
          <button
            type="button"
            className={rankBy === 'volume' ? 'active' : ''}
            onClick={() => setRankBy('volume')}
          >
            Rank by Volume
          </button>
          <button
            type="button"
            className={rankBy === 'trades' ? 'active' : ''}
            onClick={() => setRankBy('trades')}
          >
            Rank by Trades
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="status-strip">
        <div className="status-card">
          <span className="l">Total Volume</span>
          <span className="v">{formatUsd(stats.totalVol)}</span>
        </div>
        <div className="status-card">
          <span className="l">Net Flow</span>
          <span className={`v ${stats.netBuy >= 0 ? 'text-buy' : 'text-sell'}`}>
            {stats.netBuy >= 0 ? '+' : ''}{formatUsd(stats.netBuy)}
          </span>
        </div>
        <div className="status-card">
          <span className="l">Top Sector</span>
          <span className="v" style={{ fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {stats.topSector}
          </span>
        </div>
        <div className="status-card">
          <span className="l">Races Tracked</span>
          <span className="v">{leaderboard ? leaderboard.length : '—'}</span>
        </div>
      </div>

      {/* Volume Chart */}
      <div className="chart-card">
        <h3 className="chart-title">Trading Volume over Time</h3>
        {volError && <div className="muted text-center py-4">Failed to load volume timeline</div>}
        {!volumeData && !volError && <div className="muted text-center py-4">Loading volume data...</div>}
        {volumeData && (
          <>
            <div className="tchart">
              {volumeData.series.map((item, idx) => {
                const totalVol = item.estBuyVolUsd + item.estSellVolUsd;
                const buyPct = totalVol > 0 ? (item.estBuyVolUsd / totalVol) * 100 : 0;
                const sellPct = totalVol > 0 ? (item.estSellVolUsd / totalVol) * 100 : 0;
                const heightPct = (totalVol / maxChartVol) * 90; // scale to 90% max height
                
                return (
                  <div key={idx} className="tcol" style={{ height: `${Math.max(heightPct, 5)}%` }}>
                    <div className="tcol-bar-buy" style={{ height: `${buyPct}%` }} />
                    <div className="tcol-bar-sell" style={{ height: `${sellPct}%` }} />
                    <div className="chart-tooltip-react">
                      <div style={{ fontWeight: 800 }}>{item.period}</div>
                      <div style={{ color: 'var(--buy)' }}>Buys: {formatUsd(item.estBuyVolUsd)}</div>
                      <div style={{ color: 'var(--sell)' }}>Sells: {formatUsd(item.estSellVolUsd)}</div>
                      <div style={{ borderTop: '1px solid var(--border)', marginTop: '4px', paddingTop: '4px', fontWeight: 600 }}>
                        Total: {formatUsd(totalVol)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="tchart-legend">
              <div className="tchart-legend-item">
                <div className="tchart-legend-color tchart-legend-buy" />
                <span>Buys (Est. USD)</span>
              </div>
              <div className="tchart-legend-item">
                <div className="tchart-legend-color tchart-legend-sell" />
                <span>Sells (Est. USD)</span>
              </div>
            </div>
          </>
        )}
      </div>

      
      {/* Grid Layout for Desktop */}
      <div className="trends-grid">
        <div className="trend-section">
          <h3>Most Active Politicians</h3>
          {memError && <div className="muted text-center py-4">Failed to load politicians</div>}
          {!memberLeaderboard && !memError && <div className="muted text-center py-4">Loading politicians...</div>}
          {memberLeaderboard && (
            <div className="table-responsive-wrapper" style={{ boxShadow: 'none', background: 'transparent', border: 'none', margin: 0 }}>
              <table className="trades-table">
                <thead>
                  <tr>
                    <th>Politician</th>
                    <th>Trades</th>
                  </tr>
                </thead>
                <tbody>
                  {memberLeaderboard.members.slice(0, 10).map((item) => (
                    <tr key={item.filerId}>
                      <td>
                        <div className="asset-cell">
                          <span className="asset-ticker">{item.fullName || item.filerId}</span>
                          <span className="asset-name">{[item.chamber, item.party, item.state].filter(Boolean).join(' · ')}</span>
                        </div>
                      </td>
                      <td style={{ fontWeight: 700 }}>{item.tradeCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="trend-section">
          <h3>Top Traded Assets</h3>
          {lbError && <div className="muted text-center py-4">Failed to load leaderboard</div>}
          {!leaderboard && !lbError && <div className="muted text-center py-4">Loading leaderboard data...</div>}
          {leaderboard && (
            <div className="table-responsive-wrapper" style={{ boxShadow: 'none', background: 'transparent', border: 'none', margin: 0 }}>
              <table className="trades-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Trades</th>
                    <th>Est. Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.slice(0, 10).map((item) => (
                    <tr key={item.ticker}>
                      <td>
                        <div className="asset-cell">
                          <span className="asset-ticker">{item.ticker}</span>
                          <span className="asset-name">{item.refCompanyName || 'Unknown'}</span>
                        </div>
                      </td>
                      <td>{item.tradeCount}</td>
                      <td style={{ fontWeight: 700 }}>{formatUsd(item.estVolumeUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="trends-grid mt-4">
        <div className="trend-section">
          <h3>Consensus Moves</h3>
          {clusterError && <div className="muted text-center py-4">Failed to load consensus</div>}
          {!clusterBuys && !clusterError && <div className="muted text-center py-4">Loading consensus data...</div>}
          {clusterBuys && (
            <div className="table-responsive-wrapper" style={{ boxShadow: 'none', background: 'transparent', border: 'none', margin: 0 }}>
              <table className="trades-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Direction</th>
                    <th>Pols</th>
                  </tr>
                </thead>
                <tbody>
                  {clusterBuys.clusters.slice(0, 8).map((c) => (
                    <tr key={c.ticker + c.txType}>
                      <td>
                        <div className="asset-cell">
                          <span className="asset-ticker">{c.ticker}</span>
                          <span className="asset-name">{c.name || 'Unknown'}</span>
                        </div>
                      </td>
                      <td>
                        <span style={{ 
                          padding: '4px 8px', 
                          borderRadius: '6px', 
                          fontSize: '11px', 
                          fontWeight: 700, 
                          color: c.txType === 'P' ? '#000' : '#fff',
                          background: c.txType === 'P' ? 'var(--buy)' : 'var(--sell)' 
                        }}>
                          {c.txType === 'P' ? 'Buy' : 'Sell'}
                        </span>
                      </td>
                      <td style={{ fontWeight: 700 }}>{c.memberCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="trend-section">
          <h3>Net Flow by Sector</h3>
          {sectorError && <div className="muted text-center py-4">Failed to load sectors</div>}
          {!sectorFlow && !sectorError && <div className="muted text-center py-4">Loading sector data...</div>}
          {sectorFlow && (
            <div className="table-responsive-wrapper" style={{ boxShadow: 'none', background: 'transparent', border: 'none', margin: 0 }}>
              <table className="trades-table">
                <thead>
                  <tr>
                    <th>Sector</th>
                    <th>Net Flow</th>
                  </tr>
                </thead>
                <tbody>
                  {sectorFlow.sectors.slice(0, 10).map((s) => (
                    <tr key={s.sector}>
                      <td style={{ fontWeight: 500 }}>{s.sector}</td>
                      <td className={s.estNetFlowUsd >= 0 ? 'text-buy' : 'text-sell'} style={{ fontWeight: 700 }}>
                        {s.estNetFlowUsd >= 0 ? '+' : ''}{formatUsd(s.estNetFlowUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>


      <style jsx>{`

        .trends-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 16px;
        }
        @media (min-width: 768px) {
          .trends-grid {
            grid-template-columns: 1fr 1fr;
          }
        }
        .mt-4 { margin-top: 16px; }

        .text-buy { color: var(--buy); }
        .text-sell { color: var(--sell); }
        .text-center { text-align: center; }
        .py-4 { padding-top: 16px; padding-bottom: 16px; }
      `}</style>
    </div>
  );
}
