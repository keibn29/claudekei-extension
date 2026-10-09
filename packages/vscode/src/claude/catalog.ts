/**
 * Catalog (models, slash commands, agents, account) via a startup probe: a streaming query whose prompt never yields
 * (W0: no model call, no transcript, ~0.3-0.5 s) and `initializationResult()`.
 */
import type { AccountInfo, AgentInfo, Catalog, ModelInfo, PermissionMode, PrimaryAgentInfo, SlashCommand } from '@openchamber/ui/src/lib/claude/types';
import type { AgentPreset } from './claudekeiConfig';
import { neverYieldingPrompt } from './asyncQueue';
import type { ClaudeQuery, InitializationResult, QueryFactory, SdkOptions, SDKUserMessage } from './sdk';

export type ProbeResult = {
  models: ModelInfo[];
  commands: SlashCommand[];
  agents: AgentInfo[];
  account: AccountInfo | null;
};

export const FALLBACK_MODELS: ModelInfo[] = [
  { value: 'default', displayName: 'Default', description: 'Default model' },
  { value: 'opus', displayName: 'Opus', description: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku' },
];

/** Default metadata of the claudekei plugin's primary agents, in cycling order. */
export const DEFAULT_PRIMARY_AGENTS: ReadonlyArray<Omit<PrimaryAgentInfo, 'description'>> = [
  { name: 'claudekei:orchestrator', displayName: 'Orchestrator', color: 'purple' },
  { name: 'claudekei:planner', displayName: 'Planner', color: 'blue' },
  { name: 'claudekei:sprinter', displayName: 'Sprinter', color: 'green' },
  { name: 'claudekei:business-analyst', displayName: 'Business Analyst', color: 'orange' },
];

/** Entry of the `claudekei.primaryAgents` setting. */
export type PrimaryAgentSetting = { name: string; displayName?: string; color?: string };

const titleCase = (name: string): string =>
  (name.split(':').pop() ?? name)
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');

/**
 * Primary agents = catalog agents whose description contains "primary agent" (the plugin marks them), ordered and
 * decorated by the metadata table. `override` (the setting) is authoritative for order/metadata when non-empty.
 * Fallback when no description matches: the table entries that exist in the catalog.
 */
export function derivePrimaryAgents(agents: readonly AgentInfo[], override?: readonly PrimaryAgentSetting[], presets: Readonly<Record<string, AgentPreset>> = {}): PrimaryAgentInfo[] {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const marked = agents.filter((a) => /primary agent/i.test(a.description)).map((a) => a.name);
  const table = new Map(DEFAULT_PRIMARY_AGENTS.map((m) => [m.name, m]));
  const decorate = (name: string, o?: PrimaryAgentSetting): PrimaryAgentInfo => {
    const meta = table.get(name);
    const preset = presets[name];
    // The config file wins; the agent's own frontmatter model is the fallback (`inherit` means "no preference").
    const frontmatter = byName.get(name)?.model;
    const defaultModel = preset?.model ?? (frontmatter && frontmatter !== 'inherit' ? frontmatter : undefined);
    return {
      name,
      ...(defaultModel ? { defaultModel } : {}),
      ...(preset?.effort ? { defaultEffort: preset.effort } : {}),
      displayName: o?.displayName ?? meta?.displayName ?? titleCase(name),
      color: o?.color ?? meta?.color ?? 'gray',
      description: byName.get(name)?.description ?? '',
    };
  };

  if (override && override.length > 0) {
    return override.filter((o) => byName.has(o.name)).map((o) => decorate(o.name, o));
  }
  const names = marked.length > 0 ? marked : DEFAULT_PRIMARY_AGENTS.map((m) => m.name).filter((n) => byName.has(n));
  const rank = (n: string): number => {
    const i = DEFAULT_PRIMARY_AGENTS.findIndex((m) => m.name === n);
    return i < 0 ? DEFAULT_PRIMARY_AGENTS.length : i;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((n) => decorate(n));
}

/** Converts the SDK initialize response into our probe shape. */
export function probeFromInit(init: InitializationResult): ProbeResult {
  return {
    models: (init.models ?? []) as unknown as ModelInfo[],
    commands: (init.commands ?? []).map((c) => ({
      name: c.name,
      description: c.description ?? '',
      argumentHint: c.argumentHint ?? '',
      ...(c.aliases ? { aliases: c.aliases } : {}),
      ...(c.builtin ? { builtin: true } : {}),
    })),
    agents: (init.agents ?? []).map((a) => ({ name: a.name, description: a.description ?? '', ...(a.model ? { model: a.model } : {}) })),
    account: init.account && Object.keys(init.account).length > 0 ? (init.account as AccountInfo) : null,
  };
}

export type BuildCatalogOptions = {
  defaultModel?: string;
  defaultMode?: PermissionMode;
  defaultAgent?: string;
  primaryAgentsSetting?: readonly PrimaryAgentSetting[];
  /** claudekei.jsonc presets by full agent type. */
  agentPresets?: Readonly<Record<string, AgentPreset>>;
};

export function buildCatalog(probe: ProbeResult, options: BuildCatalogOptions = {}): Catalog {
  const primaryAgents = derivePrimaryAgents(probe.agents, options.primaryAgentsSetting, options.agentPresets);
  const models = probe.models.length > 0 ? probe.models : FALLBACK_MODELS;
  return {
    models,
    commands: probe.commands,
    agents: probe.agents,
    primaryAgents,
    defaults: {
      model: options.defaultModel ?? models[0]?.value ?? 'default',
      mode: options.defaultMode ?? 'default',
      agent: options.defaultAgent ?? primaryAgents[0]?.name ?? '',
    },
  };
}

export type ProbeOptions = {
  queryFactory: QueryFactory;
  cwd: string;
  env: Record<string, string | undefined>;
  executablePath?: string;
  timeoutMs?: number;
  stderr?: (data: string) => void;
  /** Runs on the probe's query after `initializationResult()` (e.g. the usage-limits fetch); failures are ignored. */
  afterInit?: (query: ClaudeQuery) => Promise<void>;
  /** Upper bound for `afterInit` (default 8 s). */
  afterInitTimeoutMs?: number;
};

/**
 * Runs the probe. `settingSources` include `user`/`project`/`local` so plugin agents and skills appear.
 * `persistSession: false` is belt and braces; W0 showed no transcript is written either way.
 */
export async function probeCatalog(options: ProbeOptions): Promise<ProbeResult> {
  const abort = new AbortController();
  const queryOptions: SdkOptions = {
    cwd: options.cwd,
    permissionMode: 'default',
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    persistSession: false,
    env: options.env,
    abortController: abort,
    canUseTool: async () => ({ behavior: 'deny', message: 'catalog probe' }),
    ...(options.executablePath ? { pathToClaudeCodeExecutable: options.executablePath } : {}),
    ...(options.stderr ? { stderr: options.stderr } : {}),
  };
  const q: ClaudeQuery = options.queryFactory({ prompt: neverYieldingPrompt<SDKUserMessage>(), options: queryOptions });
  // Drain so a failing process surfaces as a rejection of initializationResult() instead of an unhandled rejection.
  void (async () => {
    try {
      for await (const _ of q) void _;
    } catch {
      /* surfaced through initializationResult */
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const init = await Promise.race([
      q.initializationResult(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`catalog probe timed out after ${options.timeoutMs ?? 30000}ms`)), options.timeoutMs ?? 30000);
      }),
    ]);
    const result = probeFromInit(init);
    if (options.afterInit) {
      let guard: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([options.afterInit(q), new Promise<void>((resolve) => (guard = setTimeout(resolve, options.afterInitTimeoutMs ?? 8000)))]);
      } catch {
        /* optional extra data */
      } finally {
        if (guard) clearTimeout(guard);
      }
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    q.close();
  }
}

/**
 * True when the account info shows no logged-in identity. Third-party providers (Bedrock, Vertex, gateways, ...)
 * authenticate outside `claude login` and never report an account, so any non-firstParty provider counts as logged in.
 */
export function looksLoggedOut(account: AccountInfo | null): boolean {
  if (!account) return true;
  if (account.apiProvider && account.apiProvider !== 'firstParty') return false;
  return !account.email && !account.subscriptionType && !account.tokenSource && !account.apiKeySource;
}
