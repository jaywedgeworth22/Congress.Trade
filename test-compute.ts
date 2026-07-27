import { computeConvictionScore } from './app/src/analytics/compute.ts';
const moderate = {
  memberCount: 4,
  buyCount: 7,
  sellCount: 1,
  netSentiment: 0.875,
  estNetFlowUsd: 200_000,
  tradeCount: 8,
  deltaCount: 2,
  recentMembers: 2,
  lateShare: 0.1,
  skill: null,
};
const bipartisan = computeConvictionScore({ ...moderate, dMembers: 2, rMembers: 2 });
const onePartyOnly = computeConvictionScore({ ...moderate, dMembers: 4, rMembers: 0 });
console.log("bipartisan:", bipartisan.score);
console.log("oneParty:", onePartyOnly.score);
