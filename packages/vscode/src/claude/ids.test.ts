import { describe, expect, test } from 'bun:test';
import { childSessionId, createIdGenerator } from './ids';

describe('createIdGenerator', () => {
  test('ids ascend lexicographically within one millisecond', () => {
    const gen = createIdGenerator({ now: () => 1_700_000_000_000 });
    const ids = Array.from({ length: 50 }, () => gen.next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    expect(ids[0]).toBe('17000000000000000');
    expect(ids[1]).toBe('17000000000000001');
  });

  test('resets the sequence when the clock advances', () => {
    let t = 1_700_000_000_000;
    const gen = createIdGenerator({ now: () => t });
    gen.next();
    gen.next();
    t += 5;
    expect(gen.next()).toBe('17000000000050000');
  });

  test('never goes backwards when the clock does', () => {
    let t = 1_700_000_000_010;
    const gen = createIdGenerator({ now: () => t });
    const a = gen.next();
    t -= 100;
    const b = gen.next();
    expect(b > a).toBe(true);
  });

  test('timestamp hint is honoured but clamped to monotonic', () => {
    const gen = createIdGenerator({ now: () => 5 });
    const a = gen.next(1_700_000_000_500);
    const b = gen.next(1_700_000_000_100);
    const c = gen.next(1_700_000_000_900);
    expect(a.startsWith('1700000000500')).toBe(true);
    expect(b > a).toBe(true);
    expect(c.startsWith('1700000000900')).toBe(true);
  });

  test('sequence overflow borrows the next millisecond', () => {
    const gen = createIdGenerator({ now: () => 1_700_000_000_000 });
    let prev = gen.next();
    for (let i = 0; i < 10_050; i++) {
      const next = gen.next();
      expect(next > prev).toBe(true);
      prev = next;
    }
  });
});

test('childSessionId', () => {
  expect(childSessionId('toolu_1')).toBe('sub_toolu_1');
});
