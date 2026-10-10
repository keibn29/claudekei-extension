/**
 * Claude-native domain model for ClaudeKei (docs/PHASE1_PLAN.md section 2).
 *
 * Replaces `@opencode-ai/sdk/v2` types. Field names intentionally mirror what the
 * existing UI components read (`type: 'text' | 'reasoning' | 'tool' | 'file'`,
 * `tool`, `state.{status,input,output,error,metadata,time}`, ...), so renderers keep
 * working unchanged. OpenCode-only fields are either dropped or kept optional and
 * marked `@deprecated legacy`.
 *
 * Type-only module: the only runtime values are a few tiny constants.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Id of the single synthetic provider that exposes Claude models. */
export const ANTHROPIC_PROVIDER_ID = 'anthropic' as const;
export type AnthropicProviderID = typeof ANTHROPIC_PROVIDER_ID;

/**
 * Permission modes in Shift+Tab cycling order (D8). `dontAsk` and `bypassPermissions`
 * are valid but not part of the default cycle.
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const;

/** Claude permission mode. Surfaced in the UI as a "primary agent" (D8). */
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * A conversation. `id` is the Claude session UUID (host generated for drafts).
 * Subagent runs surface as virtual child sessions `sub_<parentToolUseId>` with `parentID` set.
 */
export type Session = {
  id: string;
  title: string;
  directory: string;
  /** Set for virtual subagent child sessions. */
  parentID?: string;
  time: {
    created: number;
    /** Used for display ordering and `trimSessions` eviction. */
    updated: number;
    /** @deprecated legacy: never set by the host. */
    compacting?: number;
  };
  /**
   * Claude-specific extras. For subagent child sessions (one per subagent instance,
   * id `sub_<original Agent tool_use_id>`), `agentId`/`agentType`/`alias` identify the
   * subagent; every later `SendMessage` to it links here too (docs/PHASE1_1_*).
   */
  claude?: {
    gitBranch?: string;
    fileSize?: number;
    /** Subagent instance id (SDK `task_id` / `agent_id`). */
    agentId?: string;
    /** Subagent type, e.g. `claudekei:explorer`. */
    agentType?: string;
    /** Plugin alias used by the parent with SendMessage, e.g. `exp-1`, when known. */
    alias?: string;
    /** Latest progress from `task_progress` for the active run. */
    progress?: SubagentProgress;
  };
  /** Main-thread agent of this session (plugin primary agent name), when known. */
  agent?: string;
  /** Live permission mode of this session. Updated by the host on `session.updated` (e.g. after plan approval). */
  mode?: PermissionMode;
  /** Selected model for this session (`ModelInfo.value`, alias or full id). */
  model?: string;
  /** Concrete model id actually running (from `system/init.model`), e.g. `claude-opus-5-5`; display this, not `default`. */
  resolvedModel?: string;
  /** Selected effort for this session; undefined = model default. */
  effort?: EffortLevel;
  /**
   * Latest context-window usage (SDK `getContextUsage`), refreshed by the host after each turn and announced by
   * `session.updated`. Absent until the first measurement of a live process (cold sessions: use
   * `claude:session.contextUsage`).
   */
  contextUsage?: ContextUsage;
  /** @deprecated legacy: read by PlanView; the host does not set it. */
  slug?: string;
  /** @deprecated legacy: not populated. */
  summary?: { additions: number; deletions: number; files: number };
  /**
   * Set by the host while messages from `messageID` onward are reverted (hidden) and not yet committed.
   * Cleared by unrevert or the next send. The host sets only `messageID`.
   */
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string };
};

/** Dry run of the file rewind behind a revert. `files` are relative to the workspace cwd when inside it, else absolute. */
export type RevertPreview = { files: string[]; insertions: number; deletions: number; filesError?: string };

/** Outcome of a revert. `files`: same path convention as `RevertPreview`; `filesError`: the files could not be restored. */
export type RevertResult = { files: string[]; filesError?: string };

/** Live status of a session. */
export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number };

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** User prompt. `agent` is the main-thread agent name the prompt was sent to (docs/PHASE1_PLAN.md A1). */
export type UserMessage = {
  id: string;
  sessionID: string;
  role: 'user';
  time: { created: number };
  /** Main agent at send time (e.g. `claudekei:orchestrator`); history replay uses the session's current agent. */
  agent: string;
  model: { providerID: AnthropicProviderID; modelID: string; variant?: string };
  /** Claude transcript uuid, used for fork `resumeSessionAt`. */
  claudeUuid?: string;
  /** Set on user messages inside a subagent child session: an instruction from the parent agent. */
  instruction?: SubagentInstruction;
};

/**
 * Instruction delivered to a subagent: the initial `Agent` prompt or a later `SendMessage`.
 * Rendered as "From <Parent agent> #n" in the child session.
 */
export type SubagentInstruction = {
  kind: 'initial' | 'followup';
  /** 1-based order within the child session. */
  index: number;
  /** Parent session id and the parent tool part (`Agent` or `SendMessage`) that sent it. */
  fromSessionID: string;
  fromMessageID?: string;
  toolCallID: string;
  /** Parent session's main agent at send time, e.g. `claudekei:orchestrator`. */
  fromAgent?: string;
};

/** Live progress of a subagent run (from SDK `task_progress`). */
export type SubagentProgress = {
  toolUses?: number;
  totalTokens?: number;
  durationMs?: number;
  lastToolName?: string;
  /** Last human-readable step/description, when available. */
  description?: string;
};

/**
 * Metadata keys set on `Agent` (normalized `task`) and `SendMessage` (normalized `sendmessage`)
 * tool parts, in `ToolPart.state.metadata`.
 */
export type SubagentToolMetadata = {
  /** Child session id (`sub_<original Agent tool_use_id>`). */
  sessionID?: string;
  agentId?: string;
  agentType?: string;
  /** Alias or raw `to` value used by the parent. */
  recipient?: string;
  /** Instruction text sent (Agent `prompt` / SendMessage `message`). */
  message?: string;
  /** Child user message created for this instruction. */
  childMessageID?: string;
  /** Subagent's reply for this run (from `task_notification.summary` or the tool result). */
  reply?: string;
  /** Run status of this particular instruction. */
  runStatus?: 'running' | 'completed' | 'error' | 'stopped';
};

/** Reason a turn failed. UI reads `data.message`, `message` or `name` (ChatMessage.tsx). */
export type MessageError = {
  name: string;
  message: string;
  /** Legacy OpenCode shape; mirror `message` here if convenient. */
  data?: { message?: string };
};

/** Assistant reply (one Claude API message). `parentID` is the user message that triggered it. */
export type AssistantMessage = {
  id: string;
  sessionID: string;
  role: 'assistant';
  parentID: string;
  time: { created: number; completed?: number };
  modelID: string;
  providerID: AnthropicProviderID;
  /** Claude `stop_reason`. */
  finish?: string;
  error?: MessageError;
  /** Zeros until usage is known. */
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  /** USD; 0 until the `result` message arrives. */
  cost: number;
  /** Claude transcript uuid. */
  claudeUuid?: string;
  /** Anthropic API message id (`msg_...`) used to reconcile streamed vs. final content. */
  apiMessageId?: string;
  /** @deprecated legacy: not populated. */
  mode?: string;
  /** @deprecated legacy: not populated. */
  agent?: string;
  /** @deprecated legacy: not populated. */
  path?: { cwd: string; root: string };
  /** @deprecated legacy: not populated. */
  summary?: boolean;
  /** @deprecated legacy: not populated. */
  variant?: string;
};

export type Message = UserMessage | AssistantMessage;

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/** Plain text block. `synthetic` marks host-generated text (e.g. "Context compacted"). */
export type TextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: Record<string, unknown>;
};

/** Extended-thinking block. */
export type ReasoningPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'reasoning';
  text: string;
  time: { start: number; end?: number };
  metadata?: Record<string, unknown>;
};

/** Attachment (image/document). `url` is a data URL or file URL. */
export type FilePart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
  /** @deprecated legacy: file/symbol/resource sources are not produced. */
  source?: { type: string; path?: string; text?: { value: string; start: number; end: number } };
};

/** Tool call not yet executed: input still streaming (`raw` is the partial JSON). */
export type ToolStatePending = {
  status: 'pending';
  input: Record<string, unknown>;
  raw: string;
};

/** Tool call executing. `metadata.elapsed` is updated from `tool_progress`. */
export type ToolStateRunning = {
  status: 'running';
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: { start: number };
};

/**
 * Tool finished successfully. `metadata` may carry `diff`, `filediff`, `files`,
 * `attachments`, `truncated`, and for `task` the child `sessionID`.
 */
export type ToolStateCompleted = {
  status: 'completed';
  input: Record<string, unknown>;
  output: string;
  /** Empty string when the tool has no meaningful title. */
  title: string;
  metadata: Record<string, unknown>;
  time: { start: number; end: number; compacted?: number };
  attachments?: FilePart[];
};

/** Tool failed, was denied, or was interrupted. */
export type ToolStateError = {
  status: 'error';
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: { start: number; end: number };
};

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

/**
 * Tool invocation. `tool` is the normalized name (see `toolNames.ts`) and `state.input`
 * is normalized to what renderers expect (`filePath`, `oldString`, ...); the raw Claude
 * name and input stay on `claude`.
 */
export type ToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'tool';
  tool: string;
  /** Claude `tool_use` block id. */
  callID: string;
  state: ToolState;
  claude: { name: string; input: unknown };
  metadata?: Record<string, unknown>;
};

/**
 * OpenCode-only part shapes. The host never emits these; they stay in the union so
 * existing narrowing code (`part.type === 'subtask'`, ...) keeps compiling until it is removed.
 */
type LegacyPartBase = { id: string; sessionID: string; messageID: string };
/** @deprecated legacy shape */
export type SubtaskPart = LegacyPartBase & {
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
  command?: string;
};
/** @deprecated legacy shape */
export type StepStartPart = LegacyPartBase & { type: 'step-start'; snapshot?: string };
/** @deprecated legacy shape */
export type StepFinishPart = LegacyPartBase & {
  type: 'step-finish';
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: AssistantMessage['tokens'];
};
/** @deprecated legacy shape */
export type SnapshotPart = LegacyPartBase & { type: 'snapshot'; snapshot: string };
/** @deprecated legacy shape */
export type PatchPart = LegacyPartBase & { type: 'patch'; hash: string; files: string[] };
/** @deprecated legacy shape */
export type AgentPart = LegacyPartBase & {
  type: 'agent';
  name: string;
  source?: { value: string; start: number; end: number };
};
/** @deprecated legacy shape */
export type RetryPart = LegacyPartBase & {
  type: 'retry';
  attempt: number;
  error: MessageError;
  time: { created: number };
};
/** @deprecated legacy shape */
export type CompactionPart = LegacyPartBase & {
  type: 'compaction';
  auto: boolean;
  overflow?: boolean;
  tail_start_id?: string;
};

export type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | SubtaskPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart;

// ---------------------------------------------------------------------------
// Todos, permissions, questions
// ---------------------------------------------------------------------------

/** TodoWrite item. */
export type Todo = {
  id: string;
  content: string;
  /** `cancelled` is legacy: Claude never emits it. */
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  /** Always `medium` from Claude. */
  priority: 'high' | 'medium' | 'low';
  /** Present-continuous label from TodoWrite (`activeForm`). */
  activeForm?: string;
};

/**
 * Pending tool-permission prompt (from `canUseTool`). `permission` is the normalized tool name,
 * or `plan_exit` for ExitPlanMode. `always` holds readable summaries of the SDK permission suggestions.
 */
export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  /** May hold `input`, `command`, `filepath`, `diff`, `suggestions`, `plan`. */
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
};

/** User answer to a permission prompt. */
export type PermissionResponse = 'once' | 'always' | 'reject';

export type QuestionOption = { label: string; description: string };

export type QuestionInfo = {
  question: string;
  /** Very short label. */
  header: string;
  options: QuestionOption[];
  /** Mapped from AskUserQuestion `multiSelect`. */
  multiple?: boolean;
  /** Allow a typed answer (default true). */
  custom?: boolean;
};

/** Pending AskUserQuestion prompt. */
export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
};

/** Selected labels (or custom text) for one question. */
export type QuestionAnswer = string[];

// ---------------------------------------------------------------------------
// Catalog: models, commands, agents, provider, account
// ---------------------------------------------------------------------------

/** Reasoning effort level (SDK `effort`). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// ---------------------------------------------------------------------------
// Context window and plan usage limits (Claude desktop style popups)
// ---------------------------------------------------------------------------

/** `used` occupies the window, `free` is what is left, `buffer` is the autocompact reserve, `deferred` is out-of-window. */
export type ContextCategoryKind = 'used' | 'free' | 'buffer' | 'deferred';

/** One row of the context breakdown (segment of the bar). Draw `used` + `buffer` + `free` rows; list `deferred` ones only in the detail view. */
export type ContextCategory = {
  /** Stable slug of the category: `system-prompt`, `system-tools`, `mcp-tools`, `memory-files`, `custom-agents`, `skills`, `messages`, `autocompact-buffer`, `free-space`, ... */
  id: string;
  /** Display label from Claude Code, e.g. "System tools". */
  label: string;
  tokens: number;
  kind: ContextCategoryKind;
  /** Claude Code theme token (e.g. `promptBorder`, `warning`); not a CSS color. Pick the palette by `id` / `kind`. */
  color?: string;
};

/** One line of a detail list (a memory file, an MCP tool, a skill, ...). */
export type ContextUsageItem = { name: string; tokens: number; detail?: string };

/** Per-category detail for "See detailed breakdown"; items are sorted by tokens (largest first) and capped. */
export type ContextUsageSection = {
  /** `memory-files`, `mcp-tools`, `custom-agents`, `skills`, `system-tools`, `messages`. */
  id: string;
  label: string;
  items: ContextUsageItem[];
};

/** Context window usage of a session (SDK `getContextUsage`). */
export type ContextUsage = {
  /** Tokens occupying the window now (sum of the `used` categories). */
  usedTokens: number;
  /** Window size the percentage refers to (e.g. 1_000_000). */
  maxTokens: number;
  /** `usedTokens / maxTokens * 100`, one decimal (e.g. 43.2). */
  percent: number;
  /** Tokens reserved for autocompact, when autocompact is on. */
  autocompactBufferTokens?: number;
  /** Usage at which autocompact triggers. */
  autocompactThresholdTokens?: number;
  autocompactEnabled?: boolean;
  /** Concrete model the figures were measured for. */
  model?: string;
  categories: ContextCategory[];
  sections?: ContextUsageSection[];
  /** Epoch ms of the measurement. */
  updatedAt: number;
  /** `exact` = SDK per-category token count; `estimate` = derived (cold session: last known or from message tokens). */
  source: 'exact' | 'estimate';
};

/** One plan limit row, e.g. "Session limit" or "Weekly · Fable". */
export type UsageWindow = {
  /** Stable id: `session`, `weekly`, `weekly:<model or surface>`; other server rows use their kind. */
  id: string;
  /** Server meter kind (`session`, `weekly_all`, `weekly_scoped`, ...). */
  kind: string;
  /** Desktop style label: "Session limit", "Weekly · All models", "Weekly · Fable". */
  label: string;
  /** 0-1 (the bar fill; 0.34 = 34%). */
  utilization: number;
  /** Epoch ms when the window resets; render "Resets in 2 hr 12 min" / "Resets Wed 12:00 PM" from it. */
  resetsAt?: number;
  /** From `rate_limit_event`: `allowed` | `allowed_warning` | `rejected`. */
  status?: 'allowed' | 'allowed_warning' | 'rejected';
  /** The server's grade for the meter colour: `normal` | `warning` | `critical`. */
  severity?: string;
  /** The server's headline row (single-value indicator). */
  active?: boolean;
};

/** Plan rate limits of a claude.ai subscription. `windows` is empty for API-key / third-party providers. */
export type UsageLimits = {
  /** Plan name, e.g. "Team", "Pro", "Max". */
  plan?: string;
  windows: UsageWindow[];
  /** Extra usage (overage) state, when the plan has it. Money in `currency` units (not minor units). */
  extraUsage?: { enabled: boolean; used?: number; limit?: number; utilization?: number; currency?: string };
  /** Epoch ms of the last refresh. */
  updatedAt: number;
  /** `usage` = SDK usage endpoint (all rows); `rate_limit_event` = partial, from the last event only. */
  source: 'usage' | 'rate_limit_event';
};

/** Mirrors the SDK `ModelInfo` returned by `supportedModels()`. */
export type ModelInfo = {
  /** Value passed as `model` (alias like `sonnet` or full id). */
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  /** Context window in tokens for this model, measured by the host (SDK getContextUsage maxTokens); undefined = unknown. */
  contextWindow?: number;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};

/** Mirrors the SDK `SlashCommand` returned by `supportedCommands()`. */
export type SlashCommand = {
  /** Name without the leading slash. */
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
  /** True for Claude Code's own commands. */
  builtin?: boolean;
};

/**
 * A claudekei plugin primary agent: a catalog agent whose description contains "primary agent".
 * These are what Shift+Tab cycles (the session's main-thread agent).
 */
export type PrimaryAgentInfo = {
  /** Agent type, e.g. `claudekei:orchestrator`. */
  name: string;
  displayName: string;
  /** Theme color name (`purple`, `blue`, ...) or CSS color. */
  color: string;
  description: string;
  /**
   * Default model for this agent (alias like `opus` or full id): claudekei.jsonc `primaryAgents.<name>.model`
   * (project file wins over user file), else the agent frontmatter `model`. Applied when switching to this agent.
   */
  defaultModel?: string;
  /** Default effort for this agent from claudekei.jsonc `primaryAgents.<name>.effort`; undefined = model default. */
  defaultEffort?: EffortLevel;
};

/** Mirrors the SDK `AgentInfo` returned by `supportedAgents()` (Claude subagent definitions). */
export type AgentInfo = {
  name: string;
  description: string;
  model?: string;
};

/** One permission rule; kept so permission-resolution helpers that read `agent.permission` compile. */
export type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' | 'ask' };

/**
 * UI "agent". `primary` entries are the claudekei plugin primary agents (main-thread agent,
 * name = agent type); `subagent` entries are every other catalog agent (for @mentions).
 * Permission mode is a separate control and is not an agent.
 */
export type Agent = {
  name: string;
  /** Human label for primary agents (`Orchestrator`). */
  displayName?: string;
  description?: string;
  /** `all` is legacy and never emitted by the host. */
  mode: 'primary' | 'subagent' | 'all';
  native?: boolean;
  hidden?: boolean;
  color?: string;
  /** Always empty from the host; present for compatibility with permission helpers. */
  permission: PermissionRule[];
  /** Always empty from the host. */
  options: Record<string, unknown>;
  model?: { modelID: string; providerID: string };
  /** @deprecated legacy: variants are not supported. */
  variant?: string;
  /** @deprecated legacy: not populated. */
  prompt?: string;
  /** @deprecated legacy: sampling options are not configurable. */
  temperature?: number;
  /** @deprecated legacy: sampling options are not configurable. */
  topP?: number;
  /** @deprecated legacy: not populated. */
  steps?: number;
};

/** UI model entry for the synthetic anthropic provider, derived from `ModelInfo`. */
export type Model = {
  /** `ModelInfo.value`. */
  id: string;
  /** Always `anthropic` from the host; typed as string for compatibility with generic provider code. */
  providerID: string;
  /** `ModelInfo.displayName`. */
  name: string;
  family?: string;
  description?: string;
  capabilities?: {
    temperature?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    toolcall?: boolean;
    input?: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    output?: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    interleaved?: boolean | { field: string };
  };
  /** Not provided by the SDK; UI treats missing cost as unknown. */
  cost?: { input: number; output: number; cache: { read: number; write: number } };
  /** Static context-window table maintained by the host (Phase 1). */
  limit: { context: number; input?: number; output: number };
  status?: 'alpha' | 'beta' | 'deprecated' | 'active';
  release_date?: string;
  /** @deprecated legacy: variants are not supported. */
  variants?: Record<string, Record<string, unknown>>;
  /** Source model info from the SDK. */
  claude?: ModelInfo;
};

/** Synthetic single provider (`anthropic`) holding all Claude models. */
export type Provider = {
  /** Always `anthropic` from the host; typed as string for compatibility with generic provider code. */
  id: string;
  name: string;
  source?: 'api' | 'env' | 'config' | 'custom';
  env?: string[];
  options?: Record<string, unknown>;
  models: Record<string, Model>;
};

/** Mirrors the SDK `AccountInfo` returned by `accountInfo()`. */
export type AccountInfo = {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
};

/** Everything the host learns from the SDK about what is available. */
export type Catalog = {
  models: ModelInfo[];
  commands: SlashCommand[];
  /** Every catalog agent (primary agents included). */
  agents: AgentInfo[];
  /** Plugin primary agents in cycling order. May be empty when the plugin is not installed. */
  primaryAgents: PrimaryAgentInfo[];
  /** Selected defaults. `model` is a `ModelInfo.value`; `agent` is the default main agent name. */
  defaults: { model: string; mode: PermissionMode; agent: string; effort?: EffortLevel };
};

// ---------------------------------------------------------------------------
// Legacy stand-ins
//
// OpenCode-only shapes that remaining UI code still references. Minimal and structurally
// sufficient; each is removed together with the code that uses it (docs/PHASE1_PLAN.md, W5/W6).
// ---------------------------------------------------------------------------

/** @deprecated legacy shape: OpenCode server configuration. */
export type Config = {
  model?: string;
  small_model?: string;
  default_agent?: string;
  username?: string;
  [key: string]: unknown;
};

/** @deprecated legacy shape: OpenCode project record. */
export type Project = {
  id: string;
  worktree: string;
  vcs?: 'git';
  name?: string;
  icon?: { url?: string; override?: string; color?: string };
  commands?: { start?: string };
  time: { created: number; updated: number; initialized?: number };
  sandboxes: string[];
};

/** @deprecated legacy shape: OpenCode server paths. */
export type Path = {
  home: string;
  state: string;
  config: string;
  worktree: string;
  directory: string;
};

/** @deprecated legacy shape */
export type VcsInfo = { branch?: string; default_branch?: string };

/** @deprecated legacy shape */
export type LspStatus = { id: string; name: string; root: string; status: 'connected' | 'error' };

/** @deprecated legacy shape: OpenCode command. Slash commands now come from `SlashCommand`. */
export type Command = {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: 'command' | 'mcp' | 'skill';
  template: string;
  subtask?: boolean;
  hints: string[];
};

/** @deprecated legacy shape */
export type ProviderAuthMethod = { type: 'oauth' | 'api'; label: string; [key: string]: unknown };
/** @deprecated legacy shape */
export type ProviderAuthResponse = Record<string, ProviderAuthMethod[]>;

/** @deprecated legacy shape: OpenCode provider list response. */
export type ProviderListResponse = {
  all: Provider[];
  default: Record<string, string>;
  connected: string[];
};

// ---------------------------------------------------------------------------
// Settings: agents / commands / skills / plugins / MCP / usage activity (docs/SETTINGS_USAGE_SPEC.md 2.1)
// ---------------------------------------------------------------------------

export type ConfigScope = 'user' | 'project';
export type ConfigItemKind = 'agent' | 'command' | 'skill';
export type ConfigField = 'description' | 'model' | 'effort' | 'color' | 'tools' | 'argument-hint' | 'allowed-tools';
export const CONFIG_FIELDS: Readonly<Record<ConfigItemKind, readonly ConfigField[]>> = {
  agent: ['description', 'model', 'effort', 'color', 'tools'],
  command: ['description', 'argument-hint', 'allowed-tools', 'model'],
  skill: ['description', 'allowed-tools'],
};
export const CONFIG_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const;
export type ConfigItem = {
  kind: ConfigItemKind;
  /** Invocation name; plugin items are `<plugin>:<name>`. */
  name: string;
  source: ConfigScope | 'plugin';
  /** `name@marketplace` when source === 'plugin'. */
  plugin?: string;
  /** Commands: sub-directory under commands/ (display only). */
  group?: string;
  description: string;
  /** Absolute path of the .md / SKILL.md. */
  path: string;
  /** A project item with the same kind+name exists (project wins). */
  shadowed?: true;
  /** Frontmatter parse error; still listed, openable in editor. */
  error?: string;
};
export type ConfigItemDetail = ConfigItem & {
  fields: Partial<Record<ConfigField, string>>; // YAML arrays joined with ', '
  otherKeys: string[];
  body: string;
  files?: string[]; // skills only
};
export type PluginInfo = { id: string; name: string; marketplace: string; version?: string; description?: string; scope: 'user' | 'project' | 'local'; enabled: boolean; installPath: string };
export type MarketplaceInfo = { name: string; source: string; installLocation: string; lastUpdated?: number };
export type ConfigSnapshot = {
  items: ConfigItem[];
  plugins: PluginInfo[];
  marketplaces: MarketplaceInfo[];
  claudekeiFiles: Array<{ scope: ConfigScope; path: string; exists: boolean }>;
  projectMcpFile: { path: string; exists: boolean };
};
export type McpServerScope = 'user' | 'local' | 'project';
export type McpTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };
export type McpServerInfo = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  /** SDK `source ?? scope ?? 'unknown'`. */
  origin: string;
  /** Present iff origin is user/local/project AND config is stdio/http/sse. */
  scope?: McpServerScope;
  config?: McpTransportConfig;
  error?: string;
  serverInfo?: { name: string; version: string };
  toolCount: number;
};
export type McpStatusSnapshot = { servers: McpServerInfo[]; updatedAt: number; error?: string };
export type SkillCatalogItem = { dir: string; name: string; description?: string; installable: boolean; warning?: string; installed: ConfigScope[] };
export type UsageShare = { name: string; pct: number };
export type UsageActivityWindow = { requests: number; sessions: number; behaviors: Array<{ key: string; pct: number }>; agents: UsageShare[]; skills: UsageShare[]; plugins: UsageShare[]; mcpServers: UsageShare[] };
export type UsageActivity = { day: UsageActivityWindow; week: UsageActivityWindow; updatedAt: number };
