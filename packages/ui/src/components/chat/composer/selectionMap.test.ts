import { describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Node as PMNode } from '@tiptap/pm/model';
import { fromMarkdown } from './markdown';
import { buildMarkdownMap, offsetToPosition, positionToOffset } from './selectionMap';

const schema = getSchema([StarterKit]);
const docOf = (md: string) => PMNode.fromJSON(schema, fromMarkdown(md));

describe('selectionMap', () => {
  const samples = ['', 'hello', 'a\n\nb', 'x `code` y', '- a\n- b', '2. a\n3. b', '```ts\nlet a;\nb\n```\ntail', '- a\n```\n\n```', '- ', '- a\n- ', '1. a\n2. '];

  for (const md of samples) {
    test(`markdown matches serializer and offsets round-trip: ${JSON.stringify(md)}`, () => {
      const doc = docOf(md);
      const map = buildMarkdownMap(doc);
      expect(map.markdown).toBe(md);
      for (const seg of map.segments) {
        for (let i = 0; i <= seg.len; i += 1) {
          expect(offsetToPosition(map.segments, seg.mdFrom + i)).toBe(seg.pmFrom + i);
          const pos = seg.pmFrom + i;
          expect(offsetToPosition(map.segments, positionToOffset(map.segments, pos))).toBe(pos);
        }
      }
    });
  }

  test('maps caret after list prefix', () => {
    const map = buildMarkdownMap(docOf('- ab'));
    // doc: <ul><li><p>|ab -> position 3
    expect(positionToOffset(map.segments, 3)).toBe(2);
    expect(offsetToPosition(map.segments, 4)).toBe(5);
  });
});
