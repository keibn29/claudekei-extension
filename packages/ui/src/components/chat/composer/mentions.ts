// Single source of truth for @mention detection, shared by the composer
// (editor decorations) and the user message bubble in the transcript.

export interface MentionRange {
  /** Start offset inside the text (inclusive). */
  from: number;
  /** End offset inside the text (exclusive). */
  to: number;
  kind: 'file' | 'agent';
}

const BOUNDARY_RE = /(\s|\(|\)|\[|\]|\{|\}|"|'|`|,|\.|;|:)/;

export const findMentionRanges = (
  text: string,
  isAgentName: (lowerCasedName: string) => boolean,
  isFilePath: (mention: string) => boolean,
): MentionRange[] => {
  if (!text.includes('@')) {
    return [];
  }
  const ranges: MentionRange[] = [];
  const mentionRegex = /@([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text)) !== null) {
    const start = match.index;
    const charBefore = start > 0 ? text[start - 1] : null;
    if (charBefore && !BOUNDARY_RE.test(charBefore)) {
      continue;
    }
    const mention = String(match[1] || '').trim().replace(/[),.;:!?`"'>]+$/g, '');
    if (!mention) {
      continue;
    }
    const isAgent = isAgentName(mention.toLowerCase());
    if (isAgent || isFilePath(mention)) {
      ranges.push({ from: start, to: start + match[0].length, kind: isAgent ? 'agent' : 'file' });
    }
  }
  return ranges;
};

/** Heuristic used when no confirmed-mention set is available (e.g. already sent messages). */
export const looksLikeFilePath = (text: string): boolean =>
  text.includes('/') || text.includes('\\') || text.includes('.');
