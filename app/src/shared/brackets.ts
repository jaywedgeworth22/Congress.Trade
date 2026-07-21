/**
 * src/shared/brackets.ts
 * STOCK Act disclosure amount brackets — re-exported from the shared package
 * so App A and App B stay on one canonical bracket set.
 */

export {
  type AmountBracket,
  STOCK_ACT_BRACKETS,
  matchBracket,
  isValidBracket,
  nearestBracket,
} from '@jaywedgeworth22/congress-trading-shared';
