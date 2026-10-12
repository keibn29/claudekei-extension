import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

const render = (md: string, breaks: boolean): string =>
  renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: breaks ? [remarkGfm, remarkBreaks] : [remarkGfm] }, md),
  );

describe('user message line breaks (remark-breaks)', () => {
  test('single newlines become <br>', () => {
    expect(render('line1\nline2\nline3', true)).toBe('<p>line1<br/>\nline2<br/>\nline3</p>');
  });

  test('without the plugin a soft break collapses', () => {
    expect(render('line1\nline2', false)).not.toContain('<br');
  });

  test('blank lines stay paragraph gaps; lists and code blocks are untouched', () => {
    const html = render('a\nb\n\n- x\n- y\n\n```ts\nlet a;\nlet b;\n```', true);
    expect(html).toContain('<p>a<br/>\nb</p>');
    expect(html).toContain('<li>x</li>');
    expect(html).toContain('let a;\nlet b;');
    expect(html.match(/<br/g)).toHaveLength(1);
  });
});
