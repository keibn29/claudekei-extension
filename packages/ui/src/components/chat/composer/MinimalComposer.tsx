import React from 'react';
import { Extension, type Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { cn } from '@/lib/utils';
import { fromMarkdown, toMarkdown } from './markdown';
import './composer.css';

const FENCE_RE = /^```([\w+#.-]*)$/;

const isInCodeBlock = (editor: Editor): boolean => editor.isActive('codeBlock');

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

const createComposerKeymap = (send: () => void) =>
  Extension.create({
    name: 'composerKeymap',
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => {
          if (editor.view.composing) return false;
          if (isInCodeBlock(editor)) return false; // CodeBlock default: newline / triple-Enter exit
          if (convertFenceToCodeBlock(editor)) return true;
          send();
          return true;
        },
        'Shift-Enter': ({ editor }) => {
          if (editor.view.composing) return false;
          if (isInCodeBlock(editor)) return editor.commands.newlineInCode();
          if (convertFenceToCodeBlock(editor)) return true;
          if (editor.isActive('listItem')) {
            return editor.state.selection.$from.parent.content.size === 0
              ? editor.commands.liftListItem('listItem')
              : editor.commands.splitListItem('listItem');
          }
          return editor.commands.splitBlock();
        },
        // Lists are single-level: swallow Tab so list items are never sunk.
        Tab: ({ editor }) => editor.isActive('listItem'),
      };
    },
  });

export interface MinimalComposerProps {
  value?: string;
  onChange?: (markdown: string) => void;
  onSend: (markdown: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export const MinimalComposer: React.FC<MinimalComposerProps> = ({
  value,
  onChange,
  onSend,
  placeholder,
  disabled = false,
  className,
}) => {
  const onSendRef = React.useRef(onSend);
  const onChangeRef = React.useRef(onChange);
  const disabledRef = React.useRef(disabled);
  const placeholderRef = React.useRef(placeholder);
  React.useEffect(() => {
    onSendRef.current = onSend;
    onChangeRef.current = onChange;
    disabledRef.current = disabled;
    placeholderRef.current = placeholder;
  });

  // Extensions are created once; the send callback reads the latest refs.
  const editorRef = React.useRef<Editor | null>(null);
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
    }),
    Placeholder.configure({ placeholder: () => placeholderRef.current ?? '' }),
    createComposerKeymap(() => {
      const editor = editorRef.current;
      if (!editor || disabledRef.current) return;
      const md = toMarkdown(editor.getJSON()).trim();
      if (!md) return;
      onSendRef.current(md);
      editor.commands.clearContent(true);
    }),
  ]);

  const editor = useEditor({
    extensions,
    content: fromMarkdown(value ?? ''),
    editable: !disabled,
    editorProps: { attributes: { 'aria-label': placeholder ?? 'Message', role: 'textbox', 'aria-multiline': 'true' } },
    onCreate: ({ editor: e }) => {
      editorRef.current = e;
    },
    onUpdate: ({ editor: e }) => {
      onChangeRef.current?.(toMarkdown(e.getJSON()));
    },
  });

  React.useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // Controlled value: push into the editor only when it differs (loop guard).
  React.useEffect(() => {
    if (!editor || value === undefined) return;
    if (toMarkdown(editor.getJSON()) !== value) {
      editor.commands.setContent(fromMarkdown(value), { emitUpdate: false });
    }
  }, [editor, value]);

  return (
    <div className={cn('minimal-composer', className)}>
      <EditorContent editor={editor} />
    </div>
  );
};
