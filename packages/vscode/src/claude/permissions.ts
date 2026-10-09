/**
 * `canUseTool` -> permission / question prompts (docs/PHASE1_PLAN.md section 3 "Permissions", W0 notes 2.2).
 *
 * - AskUserQuestion -> `question.asked`; answers go back as `updatedInput.answers[question] = labels.join(', ')`.
 * - ExitPlanMode -> `permission.asked{permission:'plan_exit'}`. The CLI returns to the previous mode by itself on
 *   allow; "always" additionally switches to `acceptEdits`. Reject keeps planning.
 * - everything else -> `permission.asked`; "once" allows unchanged, "always" echoes the SDK suggestions as
 *   `updatedPermissions`, "reject" denies. `always` holds readable summaries (empty when there are no suggestions).
 * - Subagent prompts (`options.agentID`) surface on the parent (main) session.
 * - An abort of `options.signal` (interrupt) resolves the prompt as rejected and clears it in the UI.
 */
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeEvent } from '@openchamber/ui/src/lib/claude/protocol';
import type {
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
  QuestionAnswer,
  QuestionInfo,
  QuestionRequest,
} from '@openchamber/ui/src/lib/claude/types';
import { buildEditDiff, buildWriteDiff, toRelativePath } from './diff';
import { normalizeToolInput, normalizeToolName } from './toolNormalize';

export type CanUseToolOptions = {
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID: string;
  agentID?: string;
  requestId: string;
};

export type PermissionBrokerOptions = {
  /** Main session id; every prompt (including subagent ones) is attached to it. */
  sessionId: string;
  cwd: string;
  emit: (events: ClaudeEvent[]) => void;
  /** Locates the tool part of a call so the prompt can be shown under it. */
  findTool?: (callId: string) => { messageID: string } | undefined;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  log?: (message: string, data?: unknown) => void;
};

type Pending =
  | { kind: 'permission'; request: PermissionRequest; toolName: string; input: Record<string, unknown>; suggestions: PermissionUpdate[]; resolve: (r: PermissionResult) => void; cleanup: () => void }
  | { kind: 'question'; request: QuestionRequest; input: Record<string, unknown>; resolve: (r: PermissionResult) => void; cleanup: () => void };

/** Human readable summary of one SDK permission suggestion. */
export function summarizeSuggestion(update: PermissionUpdate): string {
  switch (update.type) {
    case 'setMode':
      return update.mode === 'acceptEdits'
        ? 'Auto-accept edits for this session'
        : `Switch to ${update.mode} mode${update.destination === 'session' ? ' for this session' : ''}`;
    case 'addRules':
    case 'replaceRules': {
      const verb = update.behavior === 'deny' ? 'Always deny' : update.behavior === 'ask' ? 'Always ask for' : 'Always allow';
      const rules = update.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ');
      const where = update.destination === 'session' ? '' : update.destination === 'localSettings' ? ' (saved to .claude/settings.local.json)' : update.destination === 'projectSettings' ? ' (saved to .claude/settings.json)' : update.destination === 'userSettings' ? ' (saved to ~/.claude/settings.json)' : '';
      return `${verb} ${rules}${where}`;
    }
    case 'removeRules':
      return `Remove rules ${update.rules.map((r) => r.toolName).join(', ')}`;
    case 'addDirectories':
      return `Allow access to ${update.directories.join(', ')}`;
    case 'removeDirectories':
      return `Remove access to ${update.directories.join(', ')}`;
    default:
      return 'Always allow';
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const isRejection = (v: unknown): v is { reject: true } => typeof v === 'object' && v !== null && !Array.isArray(v) && (v as { reject?: unknown }).reject === true;

/** `string[][]`: one label list per question. */
export const isAnswerList = (v: unknown): v is QuestionAnswer[] => Array.isArray(v) && v.every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'));

export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: PermissionBrokerOptions) {}

  get permissions(): PermissionRequest[] {
    return [...this.pending.values()].flatMap((p) => (p.kind === 'permission' ? [structuredClone(p.request)] : []));
  }

  get questions(): QuestionRequest[] {
    return [...this.pending.values()].flatMap((p) => (p.kind === 'question' ? [structuredClone(p.request)] : []));
  }

  get size(): number {
    return this.pending.size;
  }

  /** The `canUseTool` callback. */
  canUseTool = (toolName: string, input: Record<string, unknown>, options: CanUseToolOptions): Promise<PermissionResult> => {
    if (options.signal.aborted) return Promise.resolve({ behavior: 'deny', message: 'Interrupted', interrupt: true });
    const id = options.requestId || options.toolUseID;
    const tool = this.options.findTool?.(options.toolUseID);
    const toolRef = tool ? { messageID: tool.messageID, callID: options.toolUseID } : undefined;
    return new Promise<PermissionResult>((resolve) => {
      const onAbort = (): void => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.cleanup();
        if (entry.kind === 'question') this.options.emit([{ type: 'question.rejected', properties: { sessionID: this.options.sessionId, requestID: id } }]);
        else this.options.emit([{ type: 'permission.replied', properties: { sessionID: this.options.sessionId, requestID: id, reply: 'reject' } }]);
        entry.resolve({ behavior: 'deny', message: 'Interrupted', interrupt: true });
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => options.signal.removeEventListener('abort', onAbort);

      if (toolName === 'AskUserQuestion') {
        const questions = this.questionsFrom(input);
        const request: QuestionRequest = { id, sessionID: this.options.sessionId, questions, ...(toolRef ? { tool: toolRef } : {}) };
        this.pending.set(id, { kind: 'question', request, input, resolve, cleanup });
        this.options.emit([{ type: 'question.asked', properties: structuredClone(request) }]);
        return;
      }

      const suggestions = options.suggestions ?? [];
      const request = toolName === 'ExitPlanMode' ? this.planRequest(id, input, toolRef) : this.toolRequest(id, toolName, input, suggestions, options, toolRef);
      this.pending.set(id, { kind: 'permission', request, toolName, input, suggestions, resolve, cleanup });
      this.options.emit([{ type: 'permission.asked', properties: structuredClone(request) }]);
    });
  };

  /** Answers a permission prompt. Unknown ids are ignored (already resolved / aborted). */
  respondPermission(requestId: string, response: PermissionResponse): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== 'permission') return false;
    this.pending.delete(requestId);
    entry.cleanup();
    this.options.emit([{ type: 'permission.replied', properties: { sessionID: this.options.sessionId, requestID: requestId, reply: response } }]);

    if (entry.toolName === 'ExitPlanMode') {
      if (response === 'reject') {
        entry.resolve({ behavior: 'deny', message: 'The user wants you to keep planning. Revise the plan before calling ExitPlanMode again.' });
        return true;
      }
      // Allow: the CLI itself returns to the previous mode. "always" = continue with auto-accepted edits.
      // The prompt is resolved no matter what the mode switch does.
      let done: Promise<unknown> = Promise.resolve();
      try {
        if (response === 'always') done = Promise.resolve(this.options.setPermissionMode('acceptEdits')).catch((e) => this.options.log?.('setPermissionMode failed', e));
      } catch (e) {
        this.options.log?.('setPermissionMode failed', e);
      }
      void done.finally(() => entry.resolve({ behavior: 'allow', updatedInput: entry.input }));
      return true;
    }
    if (response === 'reject') {
      entry.resolve({ behavior: 'deny', message: 'User rejected' });
    } else if (response === 'always' && entry.suggestions.length > 0) {
      entry.resolve({ behavior: 'allow', updatedInput: entry.input, updatedPermissions: entry.suggestions });
    } else {
      entry.resolve({ behavior: 'allow', updatedInput: entry.input });
    }
    return true;
  }

  /**
   * Answers (or rejects) a question prompt. The result is built first and the pending entry is always resolved
   * (try/finally), so a malformed answer can never leave `canUseTool` hanging.
   */
  respondQuestion(requestId: string, answers: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== 'question') return false;
    let result: PermissionResult = { behavior: 'deny', message: 'The user declined to answer the question.' };
    let event: ClaudeEvent = { type: 'question.rejected', properties: { sessionID: this.options.sessionId, requestID: requestId } };
    try {
      if (isRejection(answers)) {
        // keep the defaults
      } else if (isAnswerList(answers)) {
        const mapped: Record<string, string> = {};
        entry.request.questions.forEach((q, i) => {
          mapped[q.question] = (answers[i] ?? []).join(', ');
        });
        result = { behavior: 'allow', updatedInput: { ...entry.input, answers: mapped } };
        event = { type: 'question.replied', properties: { sessionID: this.options.sessionId, requestID: requestId, answers } };
      } else {
        result = { behavior: 'deny', message: 'The answer was malformed.' };
      }
    } finally {
      this.pending.delete(requestId);
      entry.cleanup();
      this.options.emit([event]);
      entry.resolve(result);
    }
    return true;
  }

  /** Denies and clears everything (session ended / closed). */
  denyAll(message = 'Session ended'): void {
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      entry.cleanup();
      this.options.emit([
        entry.kind === 'question'
          ? { type: 'question.rejected', properties: { sessionID: this.options.sessionId, requestID: id } }
          : { type: 'permission.replied', properties: { sessionID: this.options.sessionId, requestID: id, reply: 'reject' } },
      ]);
      entry.resolve({ behavior: 'deny', message, interrupt: true });
    }
  }

  // --- request builders -------------------------------------------------------

  private questionsFrom(input: Record<string, unknown>): QuestionInfo[] {
    const raw = Array.isArray(input.questions) ? input.questions : [];
    return raw
      .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
      .map((q) => ({
        question: str(q.question) ?? '',
        header: str(q.header) ?? '',
        options: (Array.isArray(q.options) ? q.options : [])
          .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
          .map((o) => ({ label: str(o.label) ?? '', description: str(o.description) ?? '' })),
        multiple: q.multiSelect === true,
        custom: true,
      }));
  }

  private planRequest(id: string, input: Record<string, unknown>, tool?: PermissionRequest['tool']): PermissionRequest {
    return {
      id,
      sessionID: this.options.sessionId,
      permission: 'plan_exit',
      patterns: [],
      metadata: { plan: str(input.plan) ?? '', planFilePath: str(input.planFilePath), input },
      always: ['Approve & auto-accept edits'],
      ...(tool ? { tool } : {}),
    };
  }

  private toolRequest(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    suggestions: PermissionUpdate[],
    options: CanUseToolOptions,
    tool?: PermissionRequest['tool'],
  ): PermissionRequest {
    const cwd = this.options.cwd;
    const permission = normalizeToolName(toolName);
    const normalized = normalizeToolInput(toolName, input);
    const filePath = str(normalized.filePath) ?? str(normalized.path) ?? options.blockedPath;
    const command = str(normalized.command);
    const metadata: Record<string, unknown> = { input, toolName };
    if (command) metadata.command = command;
    if (filePath) metadata.filepath = filePath;
    if (suggestions.length > 0) metadata.suggestions = suggestions;
    for (const key of ['description', 'displayName', 'title', 'decisionReason'] as const) {
      if (options[key]) metadata[key] = options[key];
    }
    if (permission === 'edit' || permission === 'write') {
      const diff = permission === 'edit'
        ? buildEditDiff(cwd, { filePath: filePath ?? '', oldString: str(normalized.oldString), newString: str(normalized.newString) })
        : buildWriteDiff(cwd, { filePath: filePath ?? '', content: str(normalized.content) });
      if (diff) metadata.diff = diff.patch;
    }
    const patterns = command ? [command] : filePath ? [toRelativePath(cwd, filePath)] : [str(normalized.pattern) ?? str(normalized.url) ?? str(normalized.query)].filter((p): p is string => !!p);
    return {
      id,
      sessionID: this.options.sessionId,
      permission,
      patterns,
      metadata,
      always: suggestions.map(summarizeSuggestion),
      ...(tool ? { tool } : {}),
    };
  }
}
