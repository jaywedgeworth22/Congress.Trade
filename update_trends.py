import re

with open('clients/pwa/app/ui/Trends.tsx', 'r') as f:
    content = f.read()

# Add new interfaces
interfaces = """
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
"""
content = content.replace('export function Trends() {', interfaces + '\nexport function Trends() {')

# Add fetchers
fetchers = """
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
"""
content = content.replace('const { data: volumeData', fetchers + '\n  const { data: volumeData')

with open('clients/pwa/app/ui/Trends.tsx', 'w') as f:
    f.write(content)
