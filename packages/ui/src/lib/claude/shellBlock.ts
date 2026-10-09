/**
 * Fenced code blocks that can be run in the integrated terminal ("Run" next to "Copy", like Claude desktop).
 * Only explicit shell languages qualify: guessing from untagged blocks would run prose or output.
 */

const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shellsession', 'shell-session']);
/** Languages whose blocks show a transcript (prompt lines are commands, the rest is output). */
const TRANSCRIPT_LANGUAGES = new Set(['console', 'shellsession', 'shell-session']);
const PROMPT = /^\s*[$%]\s+/;

export const isRunnableShellLanguage = (language: string | undefined | null): boolean =>
  typeof language === 'string' && SHELL_LANGUAGES.has(language.trim().toLowerCase());

/**
 * Command text to send to the terminal: leading `$ ` / `% ` prompts are stripped per line and a multi-line block is
 * sent as-is. In transcript languages (`console`) only the prompted lines are commands; unprompted lines are output.
 */
export const toTerminalCommand = (code: string, language?: string | null): string => {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const prompted = lines.filter((line) => PROMPT.test(line));
  const transcript = typeof language === 'string' && TRANSCRIPT_LANGUAGES.has(language.trim().toLowerCase());
  const source = transcript && prompted.length > 0 ? prompted : lines;
  return source.map((line) => line.replace(PROMPT, '')).join('\n').trim();
};
