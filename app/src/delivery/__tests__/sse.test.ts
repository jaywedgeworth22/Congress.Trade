import { describe, it, expect } from 'vitest';
import { formatTradeEvent } from '../sse.ts';
import type { Transaction } from '../../shared/types.ts';

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

  it('emits a shared CongressEvent envelope with data.trades', () => {
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
    const payload = JSON.parse(dataLine.slice('data: '.length));
    expect(payload.type).toBe('congress.trade');
    expect(payload.id).toBe('42');
    expect(typeof payload.emittedAt).toBe('string');
    expect(Array.isArray(payload.data?.trades)).toBe(true);
    expect(payload.data.trades).toHaveLength(1);
    expect(payload.data.trades[0].id).toBe('tx_123');
  });

  it('carries cursorSeq as the SSE id for Last-Event-ID resume', () => {
    expect(frame.startsWith('id: 42\n')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});
