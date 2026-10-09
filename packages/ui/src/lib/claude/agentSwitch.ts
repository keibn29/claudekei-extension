/**
 * Main-agent switching, Option B (docs/PHASE1_1_UI_SPEC.md 2.3 / 2.5): the agent can be switched in place at any
 * time, but in a started session the switch only takes effect on the next send (the host restarts Claude with the
 * new agent's system prompt and keeps history). These pure helpers derive what the UI shows from data that already
 * exists, so nothing new is persisted:
 *
 * - applied agent   = `UserMessage.agent` of the latest user message (the agent Claude actually ran as);
 * - selected agent  = the composer's agent (`Session.agent` / config store), i.e. what the next send will use.
 *
 * Known limit: history replay stamps every user message with the session's current agent, so after a reload there
 * is no pending state and no divider (the JSONL stores no agent per message).
 */

export type AgentSwitchState = {
  /** A different agent is selected than the one that ran the last message. */
  pending: boolean;
  from?: string;
  to?: string;
  /** A turn is running: the switch is queued until the reply finishes. */
  deferred: boolean;
};

const NO_SWITCH: AgentSwitchState = { pending: false, deferred: false };

export const derivePendingAgentSwitch = (input: {
  /** The session already has at least one user message. */
  sessionStarted: boolean;
  selectedAgent?: string | null;
  appliedAgent?: string | null;
  busy: boolean;
}): AgentSwitchState => {
  const { sessionStarted, selectedAgent, appliedAgent, busy } = input;
  if (!sessionStarted || !selectedAgent || !appliedAgent || selectedAgent === appliedAgent) return NO_SWITCH;
  return { pending: true, from: appliedAgent, to: selectedAgent, deferred: busy };
};

export type AgentSwitchDivider = { from: string; to: string };

/**
 * Dividers for the transcript: a divider sits above a user message whose `agent` differs from the previous user
 * message's `agent`. Messages without an agent neither start nor reset a comparison.
 */
export const deriveAgentSwitchDividers = (
  userMessages: ReadonlyArray<{ id: string; agent?: string | null }>,
): Map<string, AgentSwitchDivider> => {
  const dividers = new Map<string, AgentSwitchDivider>();
  let previousAgent: string | undefined;
  for (const message of userMessages) {
    const agent = typeof message.agent === 'string' && message.agent.trim().length > 0 ? message.agent : undefined;
    if (!agent) continue;
    if (previousAgent !== undefined && previousAgent !== agent) {
      dividers.set(message.id, { from: previousAgent, to: agent });
    }
    previousAgent = agent;
  }
  return dividers;
};

/** Agent of the latest user message in a message list, `undefined` when there is none. */
export const findLatestUserAgent = (
  messages: ReadonlyArray<{ role: string; agent?: unknown }> | undefined,
): string | undefined => {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    return typeof message.agent === 'string' && message.agent.trim().length > 0 ? message.agent : undefined;
  }
  return undefined;
};

/** True when the message list contains a user message (the session is started). */
export const hasUserMessage = (messages: ReadonlyArray<{ role: string }> | undefined): boolean =>
  Boolean(messages?.some((message) => message.role === 'user'));

export type HostAdoptionMemory = { sessionId: string | null; agent?: string; model?: string };

/**
 * What the composer should take over from the host's `Session` (agent / model). After a reload the webview starts
 * with catalog defaults, so the first value seen for a session is always adopted; afterwards only host *changes* are,
 * which keeps a local, not yet acknowledged choice from being overwritten by a stale `session.updated`.
 */
export const planHostAdoption = (params: {
  previous: HostAdoptionMemory;
  sessionId: string;
  hostAgent?: string;
  hostModel?: string;
  knownAgents: readonly string[];
  knownModels: readonly string[];
}): { agent?: string; model?: string; next: HostAdoptionMemory } => {
  const { previous, sessionId, hostAgent, hostModel, knownAgents, knownModels } = params;
  const sessionChanged = previous.sessionId !== sessionId;
  const agent = hostAgent && (sessionChanged || previous.agent !== hostAgent) && knownAgents.includes(hostAgent) ? hostAgent : undefined;
  const model = hostModel && (sessionChanged || previous.model !== hostModel) && knownModels.includes(hostModel) ? hostModel : undefined;
  return { agent, model, next: { sessionId, agent: hostAgent, model: hostModel } };
};
