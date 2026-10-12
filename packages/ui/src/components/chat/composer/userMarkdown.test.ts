import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { findMentionRanges, looksLikeFilePath } from './mentions';
import { toMarkdown } from './markdown';
import { UserMarkdown } from './userMarkdown';

const agents = new Set(['explore']);
const getMentionRanges = (text: string) => findMentionRanges(text, (n) => agents.has(n), looksLikeFilePath);

// React's static serializer escapes quotes as &quot; (the browser DOM text still has "), so
// decode one level of escaping: a double-escaped entity would stay visible as "&quot;" there.
const decode = (html: string) => html.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const user = (content: string, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(React.createElement(UserMarkdown, { content, getMentionRanges, ...extra }));

describe('user message rendering', () => {
  test('code block content is verbatim', () => {
    const code = '{\n  "name": "a<b>&c",\n  "path": "C:\\\\x"\n}';
    const raw = user('```js\n' + code + '\n```');
    expect(raw).not.toContain('&amp;quot;');
    expect(raw).not.toContain('&amp;amp;');
    expect(raw).not.toContain('&amp;lt;');
    const html = decode(raw);
    expect(html).toContain('<pre><code>' + code + '</code></pre>');
  });

  test('inline code is verbatim', () => {
    const raw = user('use `a<b && "c"` here');
    expect(raw).not.toContain('&amp;quot;');
    expect(decode(raw)).toContain('<code data-markdown="inline-code">a<b && "c"</code>');
  });

  test('literal html outside code is shown as text, never rendered', () => {
    const html = user('<b onclick="x()">hi</b>');
    expect(html).not.toContain('<b');
    expect(decode(html)).toContain('<b onclick="x()">hi</b>');
  });

  test('mentions are highlighted in text but not in code', () => {
    const html = user('see @src/a.ts and @explore\n`@src/b.ts`\n```\n@src/c.ts\n```');
    expect(html).toContain('<span class="composer-mention-file">@src/a.ts</span>');
    expect(html).toContain('<span class="composer-mention-agent">@explore</span>');
    expect(html).not.toContain('composer-mention-file">@src/b.ts');
    expect(html).not.toContain('composer-mention-file">@src/c.ts');
    expect(html).toContain('@src/b.ts</code>');
  });

  test('mention boundary rules match the composer', () => {
    expect(getMentionRanges('mail me@host.com')).toEqual([]);
    expect(getMentionRanges('(@src/a.ts)')).toEqual([{ from: 1, to: 11, kind: 'file' }]);
  });

  test('agent mention token is linked once and keeps the agent colour', () => {
    const html = user('@explore then @explore', {
      agentMention: { token: '@explore', href: 'https://example.test/#explore' },
    });
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('<a href="https://example.test/#explore" target="_blank" rel="noopener noreferrer"><span class="composer-mention-agent">@explore</span></a>');
  });

  test('lists, line breaks and paragraph gaps', () => {
    const html = user('a\nb\n\n- x\n- y\n\n1. one\n2. two');
    expect(html).toContain('<p>a<br/>\nb</p>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<ol>');
  });

  // Composer line model: a list, N empty paragraphs (N empty lines), then a paragraph.
  const doc = (kind: 'bulletList' | 'orderedList', blanks: number) => {
    const para = (text?: string) => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });
    const item = (text: string) => ({ type: 'listItem', content: [para(text)] });
    return { type: 'doc', content: [{ type: kind, content: [item('a'), item('b')] }, ...Array.from({ length: blanks }, () => para()), para('text')] };
  };

  for (const [kind, tag] of [['bulletList', 'ul'], ['orderedList', 'ol']] as const) {
    for (const blanks of [0, 1, 2, 3]) {
      test(`${kind} + ${blanks} empty lines + text matches the composer`, () => {
        const html = user(toMarkdown(doc(kind, blanks)));
        const spacers = '<div class="composer-blank-line" aria-hidden="true"></div>'.repeat(blanks);
        expect(html.replace(/\n/g, '')).toBe(`<${tag}><li>a</li><li>b</li></${tag}>${spacers}<p>text</p>`);
      });
    }
  }

  test('lazy text after a list keeps all its lines and mentions', () => {
    const html = user('- a\n- b\n@explore\nmore\n\nend');
    expect(html.replace(/\n/g, '')).toBe(
      '<ul><li>a</li><li>b</li></ul><p><span class="composer-mention-agent">@explore</span><br/>more</p>'
        + '<div class="composer-blank-line" aria-hidden="true"></div><p>end</p>',
    );
  });

  test('plain-text paragraph blank lines are unchanged', () => {
    expect(user('a\n\ntext').replace(/\n/g, '')).toBe('<p>a</p><div class="composer-blank-line" aria-hidden="true"></div><p>text</p>');
    expect(user('a\n\n\n\ntext').replace(/\n/g, '')).toBe(
      '<p>a</p>' + '<div class="composer-blank-line" aria-hidden="true"></div>'.repeat(3) + '<p>text</p>',
    );
    expect(user('a\ntext')).toBe('<p>a<br/>\ntext</p>');
  });

  test('assistant pipeline (gfm + math only) is not affected by user rendering', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkMath] }, 'a\nb @explore'),
    );
    expect(html).not.toContain('<br');
    expect(html).not.toContain('composer-');
  });
});
