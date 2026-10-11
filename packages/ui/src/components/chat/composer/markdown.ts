import type { JSONContent } from '@tiptap/core';

// Pure string <-> TipTap JSON helpers for the minimal composer.
// Only 4 constructs are supported: fenced code blocks, inline code,
// bullet lists and ordered lists. Nothing is escaped (output goes to an LLM).

const FENCE_RE = /^```([\w+#.-]*)$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d+)\. (.*)$/;
const INLINE_CODE_RE = /`([^`]+)`/g;

const inlineToMarkdown = (nodes: JSONContent[] | undefined): string => {
  if (!nodes) return '';
  let out = '';
  for (const node of nodes) {
    if (node.type !== 'text') continue;
    const text = node.text ?? '';
    out += node.marks?.some((m) => m.type === 'code') ? `\`${text}\`` : text;
  }
  return out;
};

const listItemToMarkdown = (item: JSONContent): string =>
  (item.content ?? [])
    .filter((child) => child.type === 'paragraph')
    .map((child) => inlineToMarkdown(child.content))
    .join(' ');

const blockToMarkdown = (block: JSONContent): string => {
  switch (block.type) {
    case 'codeBlock': {
      const lang = (block.attrs?.language as string | null | undefined) ?? '';
      const body = (block.content ?? []).map((n) => n.text ?? '').join('');
      return `\`\`\`${lang}\n${body}\n\`\`\``;
    }
    case 'bulletList':
      return (block.content ?? []).map((item) => `- ${listItemToMarkdown(item)}`).join('\n');
    case 'orderedList': {
      const start = typeof block.attrs?.start === 'number' ? block.attrs.start : 1;
      return (block.content ?? []).map((item, i) => `${start + i}. ${listItemToMarkdown(item)}`).join('\n');
    }
    default:
      return inlineToMarkdown(block.content);
  }
};

export const toMarkdown = (json: JSONContent): string =>
  (json.content ?? []).map(blockToMarkdown).join('\n');

const inlineFromMarkdown = (line: string): JSONContent[] => {
  const nodes: JSONContent[] = [];
  let last = 0;
  for (const match of line.matchAll(INLINE_CODE_RE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push({ type: 'text', text: line.slice(last, index) });
    nodes.push({ type: 'text', text: match[1], marks: [{ type: 'code' }] });
    last = index + match[0].length;
  }
  if (last < line.length) nodes.push({ type: 'text', text: line.slice(last) });
  return nodes;
};

const paragraph = (text: string): JSONContent => {
  const content = inlineFromMarkdown(text);
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
};

const listItem = (text: string): JSONContent => ({ type: 'listItem', content: [paragraph(text)] });

export const fromMarkdown = (md: string): JSONContent => {
  const lines = md.split('\n');
  const blocks: JSONContent[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      // An unclosed fence consumes the rest of the input.
      while (i < lines.length && lines[i] !== '```') {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      const text = body.join('\n');
      const block: JSONContent = { type: 'codeBlock', attrs: { language: fence[1] || null } };
      if (text) block.content = [{ type: 'text', text }];
      blocks.push(block);
      continue;
    }

    if (BULLET_RE.test(line)) {
      const items: JSONContent[] = [];
      while (i < lines.length) {
        const m = BULLET_RE.exec(lines[i]);
        if (!m) break;
        items.push(listItem(m[1]));
        i += 1;
      }
      blocks.push({ type: 'bulletList', content: items });
      continue;
    }

    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      const start = Number(ordered[1]);
      const items: JSONContent[] = [];
      while (i < lines.length) {
        const m = ORDERED_RE.exec(lines[i]);
        if (!m) break;
        items.push(listItem(m[2]));
        i += 1;
      }
      blocks.push({ type: 'orderedList', attrs: { start }, content: items });
      continue;
    }

    blocks.push(paragraph(line));
    i += 1;
  }

  return { type: 'doc', content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }] };
};
