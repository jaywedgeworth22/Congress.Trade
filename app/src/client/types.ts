import type { FeedTransactionRow } from '../delivery/rows';

export type ClientTradeRow = FeedTransactionRow & {
  __chamber?: string | null;
  __member_name?: string | null;
  __party?: string | null;
};

export type ClientTradeListEnvelope = {
  items: import('../shared/types').ClientTrade[];
  cursor: number;
  count: number;
  total: number;
  limit: number;
};

export type TradeSummaryRow = {
  total_trades: number | string | null;
  buy_count: number | string | null;
  sell_count: number | string | null;
  exchange_count: number | string | null;
  member_count?: number | string | null;
  unique_tickers?: number | string | null;
  unique_assets?: number | string | null;
  est_volume: number | string | null;
  est_net_flow: number | string | null;
  first_trade: string | null;
  last_trade: string | null;
};

export type SecurityRefRow = {
  ticker: string;
  company_name: string | null;
  sector: string | null;
  industry: string | null;
  asset_class: string | null;
  country: string | null;
  exchange_short: string | null;
  currency: string | null;
  market_cap: number | string | null;
  market_cap_bucket: string | null;
  current_price?: number | string | null;
  current_price_date?: string | null;
};

export type MemberProfileRow = {
  bioguide_id: string;
  chamber: string | null;
  full_name: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  committees: string | null;
  photo_url: string | null;
};

export type ResolvedMember = {
  id: string;
  profile: MemberProfileRow | null;
};
