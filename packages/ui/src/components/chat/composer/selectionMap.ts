import type { Node as PMNode } from '@tiptap/pm/model';

// Maps between ProseMirror positions and character offsets into the markdown
// string produced by `toMarkdown`. The walk below must mirror markdown.ts.

interface Segment {
  /** ProseMirror position where this run of characters starts. */
  pmFrom: number;
  /** Number of characters in the run (same in the document and in markdown). */
  len: number;
  /** Offset in the markdown string where the run starts. */
  mdFrom: number;
}

export interface MarkdownMap {
  markdown: string;
  segments: Segment[];
}

export const buildMarkdownMap = (doc: PMNode): MarkdownMap => {
  let out = '';
  const segments: Segment[] = [];

  const inline = (block: PMNode, contentStart: number) => {
    if (block.childCount === 0) {
      segments.push({ pmFrom: contentStart, len: 0, mdFrom: out.length });
      return;
    }
    block.forEach((child, offset) => {
      if (!child.isText) return;
      const text = child.text ?? '';
      const isCode = child.marks.some((m) => m.type.name === 'code');
      if (isCode) out += '`';
      segments.push({ pmFrom: contentStart + offset, len: text.length, mdFrom: out.length });
      out += text;
      if (isCode) out += '`';
    });
  };

  const list = (block: PMNode, blockStart: number, prefixOf: (index: number) => string) => {
    let index = 0;
    block.forEach((item, itemOffset) => {
      if (index > 0) out += '\n';
      out += prefixOf(index);
      const itemInner = blockStart + 1 + itemOffset + 1;
      let first = true;
      item.forEach((child, childOffset) => {
        if (child.type.name !== 'paragraph') return;
        if (!first) out += ' ';
        first = false;
        inline(child, itemInner + childOffset + 1);
      });
      index += 1;
    });
  };

  doc.forEach((block, offset, blockIndex) => {
    if (blockIndex > 0) out += '\n';
    switch (block.type.name) {
      case 'codeBlock': {
        const lang = (block.attrs.language as string | null | undefined) ?? '';
        out += `\`\`\`${lang}\n`;
        segments.push({ pmFrom: offset + 1, len: block.textContent.length, mdFrom: out.length });
        out += `${block.textContent}\n\`\`\``;
        break;
      }
      case 'bulletList':
        list(block, offset, () => '- ');
        break;
      case 'orderedList': {
        const start = typeof block.attrs.start === 'number' ? block.attrs.start : 1;
        list(block, offset, (i) => `${start + i}. `);
        break;
      }
      default:
        inline(block, offset + 1);
    }
  });

  return { markdown: out, segments };
};

export const positionToOffset = (segments: Segment[], pos: number): number => {
  if (segments.length === 0) return 0;
  let found = segments[0];
  let isBefore = pos < found.pmFrom;
  for (const seg of segments) {
    if (seg.pmFrom <= pos) {
      found = seg;
      isBefore = false;
    } else break;
  }
  return isBefore ? found.mdFrom : found.mdFrom + Math.min(pos - found.pmFrom, found.len);
};

export const offsetToPosition = (segments: Segment[], offset: number): number => {
  if (segments.length === 0) return 1;
  let found = segments[0];
  let isBefore = offset < found.mdFrom;
  for (const seg of segments) {
    if (seg.mdFrom <= offset) {
      found = seg;
      isBefore = false;
    } else break;
  }
  return isBefore ? found.pmFrom : found.pmFrom + Math.min(offset - found.mdFrom, found.len);
};
