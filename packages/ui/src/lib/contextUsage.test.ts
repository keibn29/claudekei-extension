import { describe, expect, test } from 'bun:test';
import {
  createEmptyContextUsage,
  isSubagentSessionId,
  pickLatestContextUsage,
  resolveDisplayContextUsage,
} from './contextUsage';

describe('isSubagentSessionId', () => {
  test('detects sub_ ids only', () => {
    expect(isSubagentSessionId('sub_abc')).toBe(true);
    expect(isSubagentSessionId('abc')).toBe(false);
    expect(isSubagentSessionId(null)).toBe(false);
    expect(isSubagentSessionId(undefined)).toBe(false);
  });
});

describe('pickLatestContextUsage', () => {
  const older = { updatedAt: 1, id: 'old' };
  const newer = { updatedAt: 2, id: 'new' };

  test('prefers the newer measurement regardless of source', () => {
    expect(pickLatestContextUsage(older, newer)).toBe(newer);
    expect(pickLatestContextUsage(newer, older)).toBe(newer);
  });

  test('ties go to the candidate', () => {
    const tie = { updatedAt: 1, id: 'tie' };
    expect(pickLatestContextUsage(older, tie)).toBe(tie);
  });

  test('falls back to whichever exists', () => {
    expect(pickLatestContextUsage(undefined, newer)).toBe(newer);
    expect(pickLatestContextUsage(older, undefined)).toBe(older);
    expect(pickLatestContextUsage(undefined, undefined)).toBeUndefined();
  });
});

describe('resolveDisplayContextUsage', () => {
  const real = { ...createEmptyContextUsage(200000, 0), totalTokens: 1234, percentage: 1 };

  test('returns null without a session', () => {
    expect(resolveDisplayContextUsage(null, null, 200000, 0)).toBeNull();
  });

  test('prefers current, then last known, then an empty placeholder', () => {
    const current = { ...real, totalTokens: 99 };
    expect(resolveDisplayContextUsage('s', current, 200000, 0, real)).toBe(current);
    expect(resolveDisplayContextUsage('s', null, 200000, 0, real)).toBe(real);
    expect(resolveDisplayContextUsage('s', null, 200000, 0)?.totalTokens).toBe(0);
  });
});
