import React from 'react';
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { cn } from '@/lib/utils';
import { createComposerHandle, type ComposerHandle } from './composerHandle';
import { fromMarkdown, toMarkdown } from './markdown';
import type { MentionRange } from './mentions';
import './composer.css';

export type { ComposerHandle } from './composerHandle';

const FENCE_RE = /^```([\w+#.-]*)$/;

/** Converts a "```lang" paragraph (caret at end) into a code block. Returns true when handled. */
const convertFenceToCodeBlock = (editor: Editor): boolean => {
  const { selection } = editor.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  const parent = $from.parent;
  if (parent.type.name !== 'paragraph' || $from.parentOffset !== parent.content.size) return false;
  const match = FENCE_RE.exec(parent.textContent);
  if (!match) return false;
  editor
    .chain()
    .deleteRange({ from: $from.start(), to: $from.end() })
    .setCodeBlock(match[1] ? { language: match[1] } : undefined)
    .run();
  return true;
};

/** Shift+Enter: the only way to create a newline. */
const insertNewline = (editor: Editor): boolean => {
  const { $from } = editor.state.selection;

  if (editor.isActive('codeBlock')) {
    const atEnd = editor.state.selection.empty && $from.parentOffset === $from.parent.content.size;
    if (atEnd && $from.parent.textContent.endsWith('\n\n')) {
      // Blank line at the end of the block: drop it and leave the block.
      return editor.chain().deleteRange({ from: $from.pos - 2, to: $from.pos }).exitCode().run();
    }
    return editor.commands.newlineInCode();
  }

  if (convertFenceToCodeBlock(editor)) return true;

  if (editor.isActive('listItem')) {
    // Shift+Enter in a list always starts a new item and never lifts out (Backspace on an
    // empty item does that). TipTap's splitListItem refuses on an empty top-level item, so
    // insert the sibling item ourselves in that case.
    if (editor.commands.splitListItem('listItem')) return true;
    return editor.commands.command(({ state, tr, dispatch }) => {
      const itemType = state.schema.nodes.listItem;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type !== itemType) continue;
        const insertPos = $from.after(depth);
        const created = itemType.createAndFill();
        if (!created) return false;
        if (dispatch) {
          tr.insert(insertPos, created);
          tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)));
          dispatch(tr.scrollIntoView());
        }
        return true;
      }
      return false;
    });
  }

  return editor.commands.splitBlock();
};

interface KeymapContext {
  send: () => void;
  isImeKey: () => boolean;
  enterSends: () => boolean;
}

const createComposerKeymap = (ctx: KeymapContext) =>
  Extension.create({
    name: 'composerKeymap',
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        // Enter always submits (paragraphs, lists, code blocks, fence lines), IME or not.
        // Composition-time Enter never reaches this handler: ProseMirror skips keydown while
        // composing, and the DOM keydown hook below defers the send until the text is committed.
        // When the host disables Enter-to-send (e.g. mobile soft keyboards) Enter behaves like
        // Shift+Enter, except while an IME is committing text.
        Enter: ({ editor }) => {
          if (!ctx.enterSends()) {
            if (ctx.isImeKey() || editor.view.composing) return false;
            return insertNewline(editor);
          }
          ctx.send();
          return true;
        },
        'Shift-Enter': ({ editor }) => {
          if (ctx.isImeKey() || editor.view.composing) return false;
          return insertNewline(editor);
        },
        // Lists are single-level: swallow Tab so list items are never sunk.
        Tab: ({ editor }) => editor.isActive('listItem'),
      };
    },
  });

const createMentionHighlight = (getRanges: () => ((text: string) => MentionRange[]) | undefined) =>
  Extension.create({
    name: 'composerMentionHighlight',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            decorations: (state) => {
              const find = getRanges();
              if (!find) return null;
              const decorations: Decoration[] = [];
              state.doc.descendants((node, pos, parent) => {
                if (!node.isText || !node.text || parent?.type.name === 'codeBlock') return;
                if (node.marks.some((m) => m.type.name === 'code')) return;
                for (const range of find(node.text)) {
                  decorations.push(
                    Decoration.inline(pos + range.from, pos + range.to, { class: `composer-mention-${range.kind}` }),
                  );
                }
              });
              return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null;
            },
          },
        }),
      ];
    },
  });

export interface MinimalComposerProps {
  value?: string;
  onChange?: (markdown: string) => void;
  onSend: (markdown: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Clear the editor after onSend (default true). Hosts that own the value should pass false. */
  clearOnSend?: boolean;
  /** When false, Enter inserts a newline like Shift+Enter (default true). */
  enterSends?: boolean;
  /**
   * Runs before the editor handles a keydown. Return true when the event was handled
   * (the editor then skips it).
   */
  onKeyDown?: (event: KeyboardEvent) => boolean;
  /** Fired whenever the selection changes. */
  onSelectionChange?: () => void;
  /** Finds mention ranges inside a plain text node; they are rendered highlighted. */
  getMentionRanges?: (text: string) => MentionRange[];
  /** Extra attributes for the editable element (data-*, aria-*, spellcheck, ...). Undefined removes. */
  contentAttributes?: Record<string, string | boolean | undefined>;
  /** Props spread on the scrollable root (drag/paste/scroll/click handlers). */
  rootProps?: Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'style' | 'children'>;
}

const isImeKeyEvent = (event: KeyboardEvent) => event.isComposing || event.keyCode === 229;

// Some browsers report key "Process" for IME-handled keys, so also look at the physical code.
const isEnterEvent = (event: KeyboardEvent) =>
  event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';

export const MinimalComposer = React.forwardRef<ComposerHandle, MinimalComposerProps>(function MinimalComposer(
  {
    value,
    onChange,
    onSend,
    placeholder,
    disabled = false,
    className,
    style,
    clearOnSend = true,
    enterSends = true,
    onKeyDown,
    onSelectionChange,
    getMentionRanges,
    contentAttributes,
    rootProps,
  },
  ref,
) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const editorRef = React.useRef<Editor | null>(null);
  const sendRef = React.useRef<() => void>(() => undefined);
  const imeKeyRef = React.useRef(false);
  // The Enter keydown that was deferred until the IME commits; the normal key pipeline skips it.
  const deferredEnterRef = React.useRef<KeyboardEvent | null>(null);
  const latest = React.useRef({
    onSend,
    onChange,
    onKeyDown,
    onSelectionChange,
    getMentionRanges,
    disabled,
    enterSends,
    clearOnSend,
    placeholder,
  });
  React.useEffect(() => {
    latest.current = {
      onSend,
      onChange,
      onKeyDown,
      onSelectionChange,
      getMentionRanges,
      disabled,
      enterSends,
      clearOnSend,
      placeholder,
    };
  });

  sendRef.current = () => {
    const editor = editorRef.current;
    const { disabled: isDisabled, onSend: send, clearOnSend: clear } = latest.current;
    if (!editor || editor.isDestroyed || isDisabled) return;
    const md = toMarkdown(editor.getJSON()).trim();
    if (!md) return;
    send(md);
    if (clear) editor.commands.clearContent(true);
  };

  // Extensions are created once; callbacks read the latest values through the ref.
  const [extensions] = React.useState(() => [
    StarterKit.configure({
      bold: false,
      italic: false,
      strike: false,
      underline: false,
      link: false,
      heading: false,
      blockquote: false,
      horizontalRule: false,
      hardBreak: false,
      // Enter always submits, so the triple-Enter exit is replaced by Shift+Enter on a blank line.
      codeBlock: { exitOnTripleEnter: false },
    }),
    Placeholder.configure({ placeholder: () => latest.current.placeholder ?? '' }),
    createMentionHighlight(() => latest.current.getMentionRanges),
    createComposerKeymap({
      isImeKey: () => imeKeyRef.current,
      enterSends: () => latest.current.enterSends,
      send: () => sendRef.current(),
    }),
  ]);

  const editor = useEditor({
    extensions,
    content: fromMarkdown(value ?? ''),
    editable: !disabled,
    editorProps: {
      attributes: { role: 'textbox', 'aria-multiline': 'true', class: 'composer-content' },
      handleKeyDown: (_view, event) => {
        if (event === deferredEnterRef.current) return true;
        imeKeyRef.current = isImeKeyEvent(event);
        return latest.current.onKeyDown?.(event) ?? false;
      },
      handleDOMEvents: {
        // ProseMirror ignores keydown while composing, so Enter during IME composition is
        // handled here: let the IME commit its text, then run the normal Enter path.
        keydown: (view, event) => {
          if (!isEnterEvent(event) || event.shiftKey || !latest.current.enterSends) return false;
          if (!(view.composing || isImeKeyEvent(event))) return false;
          deferredEnterRef.current = event;
          const run = () => {
            const editor = editorRef.current;
            if (!editor || editor.isDestroyed || latest.current.disabled) return;
            const replay = new KeyboardEvent('keydown', {
              key: 'Enter',
              code: event.code,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              altKey: event.altKey,
              cancelable: true,
            });
            if (latest.current.onKeyDown?.(replay)) return;
            sendRef.current();
          };
          const waitForCommit = (attempt: number) => {
            if (view.composing && attempt < 40) {
              setTimeout(() => waitForCommit(attempt + 1), 25);
              return;
            }
            // ProseMirror flushes the composed text ~20ms after compositionend; wait past that
            // so the editor value and host state are up to date before sending.
            setTimeout(run, 40);
          };
          setTimeout(() => waitForCommit(0), 0);
          return false;
        },
      },
    },
    onCreate: ({ editor: e }) => {
      editorRef.current = e;
    },
    onUpdate: ({ editor: e }) => {
      latest.current.onChange?.(toMarkdown(e.getJSON()));
    },
    onSelectionUpdate: () => {
      latest.current.onSelectionChange?.();
    },
  });

  React.useImperativeHandle(ref, () => (editor ? createComposerHandle(editor, () => rootRef.current) : (null as never)), [editor]);

  React.useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // Re-evaluate mention decorations when the finder changes.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta('composerMentions', true));
  }, [editor, getMentionRanges]);

  // Apply host-provided attributes straight to the editable element.
  const attributesKey = JSON.stringify(contentAttributes ?? {});
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    const attrs = JSON.parse(attributesKey) as Record<string, string | boolean>;
    const applied: string[] = [];
    for (const [name, attrValue] of Object.entries(attrs)) {
      dom.setAttribute(name, String(attrValue));
      applied.push(name);
    }
    return () => {
      for (const name of applied) dom.removeAttribute(name);
    };
  }, [editor, attributesKey]);

  // Controlled value: push into the editor only when it differs (loop guard).
  React.useEffect(() => {
    if (!editor || value === undefined) return;
    if (toMarkdown(editor.getJSON()) !== value) {
      editor.commands.setContent(fromMarkdown(value), { emitUpdate: false });
    }
  }, [editor, value]);

  return (
    <div
      {...rootProps}
      ref={rootRef}
      className={cn('minimal-composer', className)}
      style={{ maxHeight: '14rem', ...style }}
      onMouseDown={(event) => {
        // Clicks on the padding around the editable area should still focus the editor.
        if (event.target === event.currentTarget && editor && !disabled) {
          event.preventDefault();
          editor.commands.focus('end');
        }
        rootProps?.onMouseDown?.(event);
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
});
