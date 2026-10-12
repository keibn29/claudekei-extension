import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { RiCheckLine, RiFileCopyLine } from '@remixicon/react';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { MentionRange } from './mentions';

// Renders user-authored message text so it looks like it did in the composer:
// verbatim code blocks / inline code, line breaks kept, @mentions coloured.

export interface UserAgentMention {
  token: string;
  href: string;
}

export interface UserMarkdownOptions {
  getMentionRanges?: (text: string) => MentionRange[];
  /** The first occurrence of this token is rendered as a link (previous behaviour for agent mentions). */
  agentMention?: UserAgentMention;
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  url?: string;
  data?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
}

const SKIPPED_PARENTS = new Set(['code', 'inlineCode', 'link', 'linkReference', 'math', 'inlineMath']);

const mentionNode = (value: string, kind: 'file' | 'agent'): MdastNode => ({
  type: 'mention',
  data: { hName: 'span', hProperties: { className: [`composer-mention-${kind}`] } },
  children: [{ type: 'text', value }],
});

const splitText = (
  value: string,
  options: UserMarkdownOptions,
  state: { agentLinked: boolean },
): MdastNode[] | null => {
  const ranges = options.getMentionRanges?.(value) ?? [];
  if (ranges.length === 0) return null;
  const out: MdastNode[] = [];
  let last = 0;
  for (const range of ranges) {
    if (range.from > last) out.push({ type: 'text', value: value.slice(last, range.from) });
    const text = value.slice(range.from, range.to);
    const token = options.agentMention?.token;
    if (token && !state.agentLinked && range.kind === 'agent' && text === token) {
      state.agentLinked = true;
      out.push({
        type: 'link',
        url: options.agentMention!.href,
        children: [mentionNode(text, 'agent')],
        data: { hProperties: { target: '_blank', rel: 'noopener noreferrer' } },
      });
    } else {
      out.push(mentionNode(text, range.kind));
    }
    last = range.to;
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
};

const transform = (node: MdastNode, options: UserMarkdownOptions, state: { agentLinked: boolean }): void => {
  if (!node.children || SKIPPED_PARENTS.has(node.type)) return;
  const next: MdastNode[] = [];
  for (const child of node.children) {
    // Raw HTML is never rendered: show it as literal text, like the composer did.
    const current: MdastNode = child.type === 'html' ? { type: 'text', value: child.value ?? '', position: child.position } : child;
    if (current.type === 'text') {
      const parts = splitText(current.value ?? '', options, state);
      if (parts) next.push(...parts);
      else next.push(current);
      continue;
    }
    transform(current, options, state);
    next.push(current);
  }
  node.children = next;
};

const spacerNodes = (count: number): MdastNode[] =>
  Array.from({ length: count }, () => ({
    type: 'blankLine',
    data: { hName: 'div', hProperties: { className: ['composer-blank-line'], 'aria-hidden': 'true' } },
  }));

const blankLinesBetween = (prev: MdastNode, next: MdastNode): number => {
  if (!prev.position || !next.position) return 0;
  return Math.max(0, next.position.start.line - prev.position.end.line - 1);
};

// The composer never writes a multi-line list item, so "- b\ntext" (no blank line) means "text" is a
// separate line after the list. Markdown folds it into the last item as a lazy continuation;
// move everything after the item's first line break out into its own paragraph.
const splitLazyTail = (list: MdastNode): MdastNode | null => {
  const item = list.children?.[list.children.length - 1];
  const para = item?.children?.length === 1 && item.children[0].type === 'paragraph' ? item.children[0] : null;
  const breakAt = para?.children?.findIndex((node) => node.type === 'break') ?? -1;
  if (!item || !para?.children || breakAt < 0) return null;
  const tailChildren = para.children.slice(breakAt + 1);
  if (tailChildren.length === 0) return null;
  para.children = para.children.slice(0, breakAt);
  // Nodes created by remark-breaks carry no position; the tail ends where the list ended, which is
  // all the blank-line counting after it needs.
  const listEnd = list.position?.end;
  return {
    type: 'paragraph',
    children: tailChildren,
    position: listEnd ? { start: listEnd, end: listEnd } : undefined,
  };
};

// Markdown collapses any run of blank lines into one paragraph break. The composer shows every
// Shift+Enter as an empty line, so re-insert one spacer per blank source line between blocks.
// Positions come from the parser, so blank lines inside fenced code are never touched.
const insertBlankLineSpacers = (parent: MdastNode): void => {
  if (!parent.children) return;
  const out: MdastNode[] = [];
  parent.children.forEach((child, index) => {
    const prev = out[out.length - 1];
    if (prev && index > 0) {
      const blanks = blankLinesBetween(prev, child);
      if (blanks > 0) {
        if (parent.type === 'list') {
          // Spacers cannot be list children; put them at the end of the previous item.
          (out[out.length - 1].children ??= []).push(...spacerNodes(blanks));
        } else {
          out.push(...spacerNodes(blanks));
        }
      }
    }
    if (child.type === 'list') insertBlankLineSpacers(child);
    out.push(child);
    const tail = child.type === 'list' ? splitLazyTail(child) : null;
    if (tail) out.push(tail);
  });
  parent.children = out;
};

const remarkUserText = (options: UserMarkdownOptions) => (tree: MdastNode) => {
  // Spacers first: transform() below replaces nodes and would lose their positions.
  insertBlankLineSpacers(tree);
  transform(tree, options, { agentLinked: false });
};

const extractText = (children: React.ReactNode): string => {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (React.isValidElement(children)) return extractText((children.props as { children?: React.ReactNode }).children);
  return '';
};

const UserCodeBlock: React.FC<{ code: string }> = ({ code }) => {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = React.useCallback(async () => {
    const result = await copyTextToClipboard(code);
    if (!result.ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [code]);
  return (
    <div className="composer-code-wrap">
      <pre>
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={() => { void handleCopy(); }}
        className="rounded p-1 hover:text-foreground"
        title={copied ? 'Copied' : 'Copy code'}
        aria-label="Copy code"
        data-code-action="copy"
      >
        {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
      </button>
    </div>
  );
};

const userMarkdownComponents: Components = {
  pre({ children }) {
    const child = React.Children.only(children) as React.ReactElement<{ children?: React.ReactNode }>;
    // Verbatim text: no entity handling, normalisation or highlighting.
    return <UserCodeBlock code={extractText(child.props.children).replace(/\n$/, '')} />;
  },
  code({ children }) {
    return <code data-markdown="inline-code">{children}</code>;
  },
};

export const UserMarkdown: React.FC<{ content: string } & UserMarkdownOptions> = ({
  content,
  getMentionRanges,
  agentMention,
}) => {
  const remarkPlugins = React.useMemo(
    () => [remarkGfm, remarkMath, remarkBreaks, [remarkUserText, { getMentionRanges, agentMention }]] as React.ComponentProps<typeof ReactMarkdown>['remarkPlugins'],
    [getMentionRanges, agentMention],
  );
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, errorColor: 'var(--destructive)' }]]}
      components={userMarkdownComponents}
    >
      {content}
    </ReactMarkdown>
  );
};
