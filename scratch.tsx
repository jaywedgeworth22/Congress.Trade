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
