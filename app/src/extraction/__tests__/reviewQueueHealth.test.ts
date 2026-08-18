import { describe, expect, it } from 'vitest';
import {
  classifyUnresolvedReviewItem,
  formatReviewQueueHealthDetail,
  isTerminalReviewReason,
} from '../reviewQueueHealth.ts';

describe('reviewQueueHealth buckets', () => {
  it('classifies rejected/exhausted reasons as terminal', () => {
    expect(isTerminalReviewReason('rejected: agreement_cascade_unresolved')).toBe(true);
    expect(isTerminalReviewReason('local_vision_exhausted,scanned_pdf_vision_spend')).toBe(true);
    expect(classifyUnresolvedReviewItem({
      suppressed: true,
      reason: 'rejected: bad_asset_name,low_confidence',
    })).toBe('terminal');
  });

  it('classifies suppressed non-terminal rows as suppressed', () => {
    expect(classifyUnresolvedReviewItem({
      suppressed: true,
      reason: 'doc_class_corrupt',
    })).toBe('suppressed');
  });

  it('classifies open cascade rows as eligible', () => {
    expect(classifyUnresolvedReviewItem({
      suppressed: false,
      reason: 'agreement_cascade_unresolved',
    })).toBe('eligible');
  });

  it('formats the operator-facing split', () => {
    expect(formatReviewQueueHealthDetail({
      unresolved: 219,
      eligible: 9,
      suppressed: 0,
      terminal: 210,
    })).toBe('219 unresolved human-review item(s) (eligible 9, suppressed 0, terminal 210)');
  });
});
