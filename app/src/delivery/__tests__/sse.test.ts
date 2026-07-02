import { describe, it, expect } from 'vitest';
import { formatTradeEvent } from '../sse';
import type { Transaction } from '../../shared/types';

/**
 * Cross-app contract guard. Agentic Trading's stream consumer
 * (congress-trade-events.ts) keys delivery on `type === 'congress.trade'` and
 * reads `data.trades`. This test pins the SSE frame to that shared contract so a
 * regression back to the old `trade.new` / bare-tx shape (which the peer app
 * silently dropped) fails the build.
 */
const tx = {
  id: 'tx_123',
  cursorSeq: 42,
  ticker: 'AAPL',
  txType: 'buy',
} as unknown as Transaction;

describe('formatTradeEvent (SSE cross-app contract)', () => {
  const frame = formatTradeEvent(tx);

  it('emits the canonical congress.trade event name', () => {
    expect(frame).toContain('\nevent: congress.trade\n');
    expect(frame).not.toContain('trade.new');
  });

  it('wraps the transaction in a { trades: [...] } envelope', () => {
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
    const payload = JSON.parse(dataLine.slice('data: '.length));
    expect(Array.isArray(payload.trades)).toBe(true);
    expect(payload.trades).toHaveLength(1);
    expect(payload.trades[0].id).toBe('tx_123');
  });

  it('carries cursorSeq as the SSE id for Last-Event-ID resume', () => {
    expect(frame.startsWith('id: 42\n')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});
