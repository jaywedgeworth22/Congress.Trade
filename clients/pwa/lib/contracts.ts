export type ClientTrade = {
  id: string;
  cursor: number;
  docId: string;
  member: {
    id: string | null;
    name: string | null;
    chamber: 'house' | 'senate' | null;
    party: string | null;
    state: string | null;
    photoUrl: string | null;
  };
  asset: {
    name: string;
    ticker: string | null;
    type: string | null;
    sector: string | null;
    marketCapBucket: string | null;
  };
  transaction: {
    date: string | null;
    type: 'P' | 'S' | 'E';
    owner: string | null;
    amountMin: number | null;
    amountMax: number | null;
    isOption: boolean;
  };
  filing: {
    filedDate: string | null;
    firstSeenAt: string | null;
    sourceUrl?: string;
  };
  confidence: number;
  source: 'primary' | 'seed_dataset';
};

export type BootstrapResponse = {
  serverTime: string;
  auth: {
    user: null | { id: string; email: string; name: string | null; picture: string | null };
    entitlement: { premium: boolean; status: string | null; plan: string | null };
  };
  capabilities: Record<string, boolean>;
  endpoints: Record<string, string>;
};

export type ClientFeedResponse = {
  items: ClientTrade[];
  cursor: number;
  count: number;
  total: number;
  limit: number;
  nextPollAfterSec: number;
};

export type ClientCommandResponse = {
  command: {
    id: string;
    type: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    error: string | null;
  };
  result?: {
    subscription?: {
      id: string;
      secret?: string;
      streamUrl?: string;
    };
  };
  replayed?: boolean;
  error?: string;
};
