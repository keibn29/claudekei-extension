/**
 * Bootstrap on `claude:bootstrap`: one host round trip seeds the global store (workspace project,
 * synthetic anthropic provider) and each directory store (agents, commands, sessions, live state).
 */

import { loadBootstrap } from "@/lib/claude/bootstrapCache"
import { buildAgents, buildAnthropicProvider, buildCommands } from "@/lib/claude/catalog"
import type { BootstrapResponse } from "@/lib/claude/protocol"
import { ANTHROPIC_PROVIDER_ID, type PermissionRequest, type Project, type QuestionRequest, type Session } from "@/lib/claude/types"
import { retry } from "./retry"
import type { GlobalState, State } from "./types"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const BOOTSTRAP_ATTEMPTS = 4
const SESSION_LIST_MIN_LIMIT = 50

/** Ask the host for the bootstrap snapshot. The host may still be warming up, so retry a few times. */
export const fetchBootstrap = (force = false): Promise<BootstrapResponse> =>
  retry(() => loadBootstrap(force), { attempts: BOOTSTRAP_ATTEMPTS, delay: 500, retryIf: () => true })

const workspaceName = (cwd: string): string => cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd

/** The workspace folder presented as the single OpenChamber "project". */
export const buildWorkspaceProject = (cwd: string): Project => {
  const now = Date.now()
  return {
    id: cwd,
    worktree: cwd,
    name: workspaceName(cwd),
    time: { created: now, updated: now },
    sandboxes: [],
  }
}

const providerListFrom = (response: BootstrapResponse): GlobalState["providers"] => ({
  all: [buildAnthropicProvider(response.catalog)],
  connected: [ANTHROPIC_PROVIDER_ID],
  default: { [ANTHROPIC_PROVIDER_ID]: response.catalog.defaults.model },
})

function groupBySession<T extends { id: string; sessionID: string }>(items: T[]): Record<string, T[]> {
  const grouped: Record<string, T[]> = {}
  for (const item of items) {
    if (!item?.id || !item.sessionID) continue
    ;(grouped[item.sessionID] ??= []).push(item)
  }
  for (const list of Object.values(grouped)) list.sort((a, b) => cmp(a.id, b.id))
  return grouped
}

/**
 * Directory state derived from a bootstrap snapshot. Sessions are merged so virtual subagent
 * children already loaded (they are not in `claude:session.list`) survive a re-bootstrap.
 */
export function buildDirectoryPatch(current: State, response: BootstrapResponse): Partial<State> {
  const sessions = new Map<string, Session>()
  for (const session of current.session) {
    if (session.parentID) sessions.set(session.id, session)
  }
  for (const session of response.sessions) {
    if (session?.id) sessions.set(session.id, session)
  }
  const sorted = Array.from(sessions.values()).sort((a, b) => cmp(a.id, b.id))

  const status: State["session_status"] = {}
  const permissions: PermissionRequest[] = []
  const questions: QuestionRequest[] = []
  for (const [sessionID, live] of Object.entries(response.live)) {
    status[sessionID] = live.status
    permissions.push(...live.permissions)
    questions.push(...live.questions)
  }

  return {
    project: response.cwd,
    provider: providerListFrom(response),
    agent: buildAgents(response.catalog),
    command: buildCommands(response.catalog),
    path: { directory: response.cwd, worktree: response.cwd, home: "", state: "", config: "" },
    session: sorted,
    sessionTotal: sorted.filter((session) => !session.parentID).length,
    limit: Math.max(sorted.length, current.limit, SESSION_LIST_MIN_LIMIT),
    session_status: status,
    permission: groupBySession(permissions),
    question: groupBySession(questions),
  }
}

export async function bootstrapGlobal(
  set: (patch: Partial<GlobalState>) => void,
  options?: { force?: boolean },
) {
  try {
    const response = await fetchBootstrap(options?.force)
    set({
      path: { directory: response.cwd, worktree: response.cwd, home: "", state: "", config: "" },
      projects: [buildWorkspaceProject(response.cwd)],
      providers: providerListFrom(response),
      ready: true,
      error: undefined,
    })
    return response
  } catch (error) {
    console.error("[bootstrap] global bootstrap failed", error)
    set({
      ready: true,
      error: { type: "init", message: error instanceof Error ? error.message : String(error) },
    })
    return null
  }
}

export async function bootstrapDirectory(input: {
  getState: () => State
  set: (patch: Partial<State>) => void
  force?: boolean
}) {
  const { getState, set } = input
  if (getState().status !== "complete") set({ status: "partial" })

  try {
    const response = await fetchBootstrap(input.force)
    set({ ...buildDirectoryPatch(getState(), response), status: "complete" })
    return response
  } catch (error) {
    console.error("[bootstrap] directory bootstrap failed", error)
    return null
  }
}
