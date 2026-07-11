import { describe, expect, it } from 'vitest';
import { BASE_SCHEMA_STATEMENTS, RELIABILITY_SCHEMA_STATEMENTS } from '../migrations';

describe('admin migration bootstrap', () => {
  it('creates base tables before incremental ALTER statements run', () => {
    expect(BASE_SCHEMA_STATEMENTS[0]).toContain('CREATE TABLE IF NOT EXISTS filers');
    expect(BASE_SCHEMA_STATEMENTS.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS transactions'))).toBe(true);
    expect(BASE_SCHEMA_STATEMENTS.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS review_queue'))).toBe(true);
  });
  it('includes reliability schema mirrored by migrations 0030 and 0031', () => {
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('delivery_outbox');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('ingestion_outbox');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('dead_letter_cycles');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('claim_token');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('lease_until');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('trg_subscriptions_total_quota');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('source_attempts');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('trg_sse_subscription_connection_quota');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('trg_sse_client_connection_quota');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('idx_deliveries_subscription_tx');
  });
});
