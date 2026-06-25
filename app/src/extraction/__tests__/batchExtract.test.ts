import { describe, it, expect } from 'vitest';
import {
  decodeAnthropicLine,
  decodeOpenAiLine,
  decodeMistralLine,
  parseJsonl,
  isBatchProvider,
} from '../batchExtract';

describe('parseJsonl', () => {
  it('parses non-blank JSON lines and skips garbage', () => {
    const out = parseJsonl('{"a":1}\n\n  \nnot json\n{"b":2}');
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('isBatchProvider', () => {
  it('accepts the three supported providers only', () => {
    for (const p of ['anthropic', 'openai', 'mistral']) expect(isBatchProvider(p)).toBe(true);
    for (const p of ['xai', 'gemini', '', null, 42]) expect(isBatchProvider(p)).toBe(false);
  });
});

describe('decodeAnthropicLine', () => {
  it('decodes a succeeded message into rows', () => {
    const line = {
      custom_id: 'H-1',
      result: {
        type: 'succeeded',
        message: { content: [{ type: 'text', text: '[{"ticker":"AAPL","assetName":"Apple","txType":"P","amountRange":"$1,001 - $15,000"}]' }] },
      },
    };
    const r = decodeAnthropicLine(line);
    expect(r).toMatchObject({ docId: 'H-1', ok: true });
    expect(r.rows[0]).toMatchObject({ ticker: 'AAPL', txType: 'P' });
  });

  it('marks an errored line as not ok', () => {
    const r = decodeAnthropicLine({ custom_id: 'H-2', result: { type: 'errored', error: { type: 'overloaded' } } });
    expect(r).toMatchObject({ docId: 'H-2', ok: false });
    expect(r.rows).toHaveLength(0);
  });
});

describe('decodeOpenAiLine', () => {
  it('decodes a chat-completions batch output line into rows', () => {
    const line = {
      custom_id: 'H-3',
      response: { status_code: 200, body: { choices: [{ message: { content: '{"transactions":[{"ticker":"MSFT","assetName":"Microsoft","txType":"S","amountRange":"$1,001 - $15,000"}]}' } }] } },
    };
    const r = decodeOpenAiLine(line);
    expect(r).toMatchObject({ docId: 'H-3', ok: true });
    expect(r.rows[0]).toMatchObject({ ticker: 'MSFT', txType: 'S' });
  });

  it('marks a line with an error object as not ok', () => {
    const r = decodeOpenAiLine({ custom_id: 'H-4', error: { message: 'bad request' } });
    expect(r.ok).toBe(false);
  });
});

describe('decodeMistralLine', () => {
  it('decodes an OCR document_annotation into rows', () => {
    const line = {
      custom_id: 'H-5',
      response: { body: { document_annotation: JSON.stringify({ transactions: [{ ticker: 'TSLA', assetName: 'Tesla', txType: 'P', amountRange: '$1,001 - $15,000' }] }) } },
    };
    const r = decodeMistralLine(line);
    expect(r).toMatchObject({ docId: 'H-5', ok: true });
    expect(r.rows[0].ticker).toBe('TSLA');
  });

  it('also accepts the annotation directly on the line body', () => {
    const r = decodeMistralLine({ custom_id: 'H-6', body: { document_annotation: { transactions: [{ assetName: 'X', ticker: 'XOM', txType: 'P', amountRange: '$1,001 - $15,000' }] } } });
    expect(r.rows[0].ticker).toBe('XOM');
  });
});
