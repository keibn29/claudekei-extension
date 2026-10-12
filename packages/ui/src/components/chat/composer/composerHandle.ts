import type { Editor } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { fromMarkdown, toMarkdown } from './markdown';
import { buildMarkdownMap, offsetToPosition, positionToOffset } from './selectionMap';

/**
 * Textarea-like handle backed by the TipTap editor. Offsets are character
 * offsets into the markdown string (`value`), so code written against a
 * textarea (caret math on a plain string) keeps working.
 */
export interface ComposerHandle {
  readonly value: string;
  selectionStart: number;
  selectionEnd: number;
  focus: (options?: { preventScroll?: boolean }) => void;
  blur: () => void;
  /** Selects the whole document. */
  select: () => void;
  setSelectionRange: (start: number, end: number) => void;
  /** Replaces the document with the given markdown without emitting onChange. */
  setValue: (markdown: string) => void;
  /** True when the caret is collapsed at the very start of the document. */
  isAtStart: () => boolean;
  /** True when the caret is collapsed at the very end of the document. */
  isAtEnd: () => boolean;
  isInCodeBlock: () => boolean;
  /** Scrollable root element (padding, max-height and scroll live here). */
  getRootElement: () => HTMLElement | null;
  /** Viewport coordinates of the line containing the given markdown offset. */
  getCaretCoords: (offset: number) => { top: number; left: number } | null;
  /** Free-form slot kept from the textarea implementation (slash command metadata). */
  commandMetadata?: unknown;
}

export const createComposerHandle = (editor: Editor, getRoot: () => HTMLElement | null): ComposerHandle => {
  const map = () => buildMarkdownMap(editor.state.doc);
  const offsetAt = (pos: number) => positionToOffset(map().segments, pos);

  return {
    get value() {
      return toMarkdown(editor.getJSON());
    },
    get selectionStart() {
      return offsetAt(editor.state.selection.from);
    },
    set selectionStart(offset: number) {
      const { segments } = map();
      editor.commands.setTextSelection({
        from: offsetToPosition(segments, offset),
        to: offsetToPosition(segments, Math.max(offset, offsetAt(editor.state.selection.to))),
      });
    },
    get selectionEnd() {
      return offsetAt(editor.state.selection.to);
    },
    set selectionEnd(offset: number) {
      const { segments } = map();
      const from = editor.state.selection.from;
      editor.commands.setTextSelection({ from, to: Math.max(from, offsetToPosition(segments, offset)) });
    },
    focus: () => {
      // ProseMirror's focus never scrolls the page, so preventScroll needs no special handling.
      editor.view.focus();
    },
    blur: () => {
      editor.commands.blur();
    },
    select: () => {
      editor.commands.selectAll();
    },
    setSelectionRange: (start, end) => {
      const { segments } = map();
      editor.commands.setTextSelection({
        from: offsetToPosition(segments, start),
        to: offsetToPosition(segments, end),
      });
    },
    setValue: (markdown) => {
      editor.commands.setContent(fromMarkdown(markdown), { emitUpdate: false });
    },
    isAtStart: () => {
      const { selection, doc } = editor.state;
      return selection.empty && selection.from === Selection.atStart(doc).from;
    },
    isAtEnd: () => {
      const { selection, doc } = editor.state;
      return selection.empty && selection.to === Selection.atEnd(doc).to;
    },
    isInCodeBlock: () => editor.isActive('codeBlock'),
    getRootElement: getRoot,
    getCaretCoords: (offset) => {
      try {
        const pos = offsetToPosition(map().segments, offset);
        const coords = editor.view.coordsAtPos(pos);
        return { top: coords.top, left: coords.left };
      } catch {
        return null;
      }
    },
  };
};
