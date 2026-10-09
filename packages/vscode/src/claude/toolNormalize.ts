/**
 * Tool name / input normalization (docs/PHASE1_PLAN.md D4, section 2 "Tool normalization").
 *
 * Existing renderers expect OpenCode-style tools (`edit` with `filePath/oldString/newString`, ...). The mapper
 * normalizes the name via `normalizeToolName` and the input via `normalizeToolInput`; the raw Claude `{name, input}`
 * stays on `ToolPart.claude`.
 */
import { normalizeToolName } from '@openchamber/ui/src/lib/claude/toolNames';
import { toRelativePath } from './diff';

export { normalizeToolName };

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `snake_case` / `kebab-case` -> `camelCase`. Leaves `-X` single-letter flags and already camel keys alone. */
export function camelCase(key: string): string {
  if (key.startsWith('-')) return key;
  return key.replace(/[_-]+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Copies `input`, applying explicit renames first (`renames[rawKey] = newKey`), then camelCasing every other key.
 * `keepKeys` are copied verbatim.
 */
function remap(input: Rec, renames: Record<string, string> = {}, keepKeys: readonly string[] = []): Rec {
  const out: Rec = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (keepKeys.includes(key)) out[key] = value;
    else if (Object.hasOwn(renames, key)) out[renames[key]!] = value;
    else out[camelCase(key)] = value;
  }
  return out;
}

const GREP_RENAMES: Record<string, string> = {
  glob: 'include',
  output_mode: 'outputMode',
  '-i': 'caseInsensitive',
  '-n': 'lineNumbers',
  '-A': 'after',
  '-B': 'before',
  '-C': 'context',
};

function normalizeTodos(value: unknown): Rec[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((todo, index) => ({
    id: typeof todo.id === 'string' && todo.id ? todo.id : String(index + 1),
    content: typeof todo.content === 'string' ? todo.content : '',
    status: typeof todo.status === 'string' ? todo.status : 'pending',
    priority: 'medium',
    ...(typeof todo.activeForm === 'string' ? { activeForm: todo.activeForm } : {}),
  }));
}

function normalizeQuestions(value: unknown): Rec[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((q) => {
    const { multiSelect, ...rest } = q;
    return { ...rest, multiple: multiSelect === true };
  });
}

/**
 * Normalizes a tool input for the renderers. Unknown tools and `mcp__*` tools are returned unchanged
 * (shallow copy). Never throws: non-object input yields `{}`.
 */
export function normalizeToolInput(claudeName: string, input: unknown): Rec {
  if (!isRecord(input)) return {};
  const tool = normalizeToolName(claudeName);

  switch (tool) {
    case 'bash':
      return remap(input, { run_in_background: 'runInBackground', dangerouslyDisableSandbox: 'dangerouslyDisableSandbox' });
    case 'read':
    case 'write':
    case 'edit':
      return remap(input, { file_path: 'filePath' });
    case 'multiedit': {
      const out = remap(input, { file_path: 'filePath' }, ['edits']);
      if (Array.isArray(input.edits)) {
        out.edits = input.edits.filter(isRecord).map((e) => remap(e, { old_string: 'oldString', new_string: 'newString', replace_all: 'replaceAll' }));
      }
      return out;
    }
    case 'grep':
      return remap(input, GREP_RENAMES);
    case 'glob':
    case 'list':
    case 'webfetch':
    case 'websearch':
      return remap(input);
    case 'todowrite':
      return { ...remap(input, {}, ['todos']), todos: normalizeTodos(input.todos) };
    case 'task':
      // Renderers read `subagent_type` (snake case) for the agent label.
      return remap(input, {}, ['subagent_type']);
    case 'question':
      return { ...remap(input, {}, ['questions']), questions: normalizeQuestions(input.questions) };
    case 'plan_exit':
      return remap(input);
    case 'sendmessage': {
      // `to` is an agentId or a plugin alias; `content` is a (possibly truncated) copy of `message`.
      const out = remap(input);
      if (typeof out.message !== 'string' && typeof out.content === 'string') out.message = out.content;
      return out;
    }
    case 'skill': {
      const out = remap(input, { skill: 'name' });
      return out;
    }
    default:
      return { ...input };
  }
}

/** True for the subagent tool (`Agent` in current CLIs, `Task` in older ones). */
export function isTaskTool(claudeName: string): boolean {
  return normalizeToolName(claudeName) === 'task';
}

/** Task-v2 todo tools (`TaskCreate` / `TaskUpdate`), used when `CLAUDE_CODE_ENABLE_TASKS` is not disabled. */
export function isTaskCreateTool(claudeName: string): boolean {
  return claudeName === 'TaskCreate';
}
export function isTaskUpdateTool(claudeName: string): boolean {
  return claudeName === 'TaskUpdate';
}

const firstLine = (text: string): string => text.split('\n', 1)[0] ?? '';

/**
 * Short title for a completed tool call (`ToolState.title`): workspace-relative path for file tools,
 * description for bash/task, pattern for search tools. Empty string when there is nothing meaningful.
 */
export function toolTitle(tool: string, input: Rec, cwd: string): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (tool) {
    case 'read':
    case 'write':
    case 'edit':
    case 'multiedit':
      return toRelativePath(cwd, str(input.filePath));
    case 'bash':
      return str(input.description) || firstLine(str(input.command));
    case 'task':
      return str(input.description);
    case 'grep':
    case 'glob':
      return str(input.pattern);
    case 'list':
      return toRelativePath(cwd, str(input.path));
    case 'webfetch':
      return str(input.url);
    case 'websearch':
      return str(input.query);
    case 'skill':
      return str(input.name);
    case 'sendmessage':
      return str(input.summary) || str(input.to);
    default:
      return '';
  }
}

/**
 * `ToolSearch` calls that only load the deferred SendMessage tool are noise: the UI hides parts whose
 * `state.metadata.hidden === true`. Keyword searches and other selections stay visible.
 */
const HIDDEN_DEFERRED_TOOLS = new Set(['SendMessage']);
export function isHiddenToolSearch(claudeName: string, input: unknown): boolean {
  if (claudeName !== 'ToolSearch' || !isRecord(input) || typeof input.query !== 'string') return false;
  const match = /^\s*select:\s*(.+?)\s*$/i.exec(input.query);
  if (!match) return false;
  const names = match[1]!.split(',').map((n) => n.trim()).filter(Boolean);
  return names.length > 0 && names.every((n) => HIDDEN_DEFERRED_TOOLS.has(n));
}
