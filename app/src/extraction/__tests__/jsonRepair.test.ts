import { describe, it, expect } from 'vitest';
import { parseModelJson } from '../visionLlm.js';

describe('jsonrepair via extractJsonFallback', () => {
  it('parses valid un-fenced JSON perfectly', () => {
    const json = '[{"txDate": "2024-01-01"}]';
    expect(parseModelJson(json)).toEqual([{ txDate: '2024-01-01' }]);
  });

  it('heals truncated JSON array using jsonrepair', () => {
    const json = '```json\n[{"txDate": "2024-01-01", "ticker": "AAPL"';
    const result = parseModelJson(json);
    expect(result).toEqual([{ txDate: '2024-01-01', ticker: 'AAPL' }]);
  });

  it('extracts valid JSON from surrounding prose', () => {
    const json = 'Here are the transactions:\n\n[{"txDate": "2024-02-02"}]\n\nHope this helps!';
    expect(parseModelJson(json)).toEqual([{ txDate: '2024-02-02' }]);
  });

  it('throws a specific error when completely unrepairable', () => {
    const bad = 'This is just some conversational text without JSON';
    expect(() => parseModelJson(bad)).toThrow('visionLlm: could not parse model JSON');
  });
});
