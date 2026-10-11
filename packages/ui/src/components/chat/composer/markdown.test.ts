import { describe, expect, test } from 'bun:test';
import { fromMarkdown, toMarkdown } from './markdown';

const roundTrip = (s: string) => toMarkdown(fromMarkdown(s));

describe('composer markdown', () => {
  const samples = [
    '',
    'hello',
    'a\n\nb',
    'use `foo` and `bar`',
    '- a\n- b',
    '1. a\n2. b\n3. c',
    '3. a\n4. b',
    '```ts\nconst a = 1;\n\nconst b = 2;\n```',
    '```\n\n```',
    'intro\n- a\n- b\noutro',
    '- a\n1. b\n```js\nx\n```\ntail',
    '**not bold** # not heading > not quote [x](y)',
  ];
  for (const s of samples) {
    test(`round-trips ${JSON.stringify(s)}`, () => {
      expect(roundTrip(s)).toBe(s);
    });
  }

  test('parses structure', () => {
    const doc = fromMarkdown('```ts\nx\n```\n* a\n5. b');
    expect(doc.content?.map((b) => b.type)).toEqual(['codeBlock', 'bulletList', 'orderedList']);
    expect(doc.content?.[0].attrs?.language).toBe('ts');
    expect(doc.content?.[2].attrs?.start).toBe(5);
  });

  test('unclosed fence consumes rest', () => {
    expect(fromMarkdown('```\na\nb').content?.[0].content?.[0].text).toBe('a\nb');
  });
});
