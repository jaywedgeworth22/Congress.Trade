import re

with open('clients/pwa/app/ui/Trends.tsx', 'r') as f:
    content = f.read()

# Let's replace the Leaderboard Table section with a new grid structure

new_layout = """
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
"""

# Replace the existing leaderboard table block
content = re.sub(
    r'\{/\* Leaderboard Table \*/\}.*?</div>\s+<style jsx>',
    new_layout + '\n\n      <style jsx>',
    content,
    flags=re.DOTALL
)

# Add CSS for trends-grid
styles = """
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
"""

content = content.replace('<style jsx>{`', '<style jsx>{`\n' + styles)

with open('clients/pwa/app/ui/Trends.tsx', 'w') as f:
    f.write(content)

