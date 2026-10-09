/**
 * Claude tool name -> normalized tool name used by the UI renderers
 * (docs/PHASE1_PLAN.md section 2, "Tool normalization"). Pure data and helpers, no dependencies:
 * imported by both the webview and the extension host.
 */

export const CLAUDE_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  Bash: 'bash',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'multiedit',
  Grep: 'grep',
  Glob: 'glob',
  LS: 'list',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  TodoWrite: 'todowrite',
  Task: 'task',
  Agent: 'task',
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan_exit',
  Skill: 'skill',
  SendMessage: 'sendmessage',
  // Passed through unchanged (rendered by the generic tool renderer):
  BashOutput: 'BashOutput',
  KillShell: 'KillShell',
  NotebookEdit: 'NotebookEdit',
};

/** Returns the normalized name; unknown tools and `mcp__*` tools pass through unchanged. */
export function normalizeToolName(name: string): string {
  if (name.startsWith('mcp__')) return name;
  return Object.hasOwn(CLAUDE_TOOL_NAME_MAP, name) ? CLAUDE_TOOL_NAME_MAP[name] : name;
}
