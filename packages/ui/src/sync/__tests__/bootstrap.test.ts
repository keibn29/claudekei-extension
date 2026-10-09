import { describe, expect, it } from 'bun:test'
import { buildDirectoryPatch, buildWorkspaceProject } from '../bootstrap'
import { INITIAL_STATE } from '../types'
import type { BootstrapResponse } from '@/lib/claude/protocol'
import type { Session } from '@/lib/claude/types'

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  title: id,
  directory: '/work/app',
  time: { created: 1, updated: 2 },
  ...extra,
})

const response: BootstrapResponse = {
  cwd: '/work/app',
  account: null,
  catalog: {
    models: [{ value: 'sonnet', displayName: 'Sonnet', description: '' }],
    commands: [{ name: 'compact', description: '', argumentHint: '' }],
    agents: [
      { name: 'claudekei:planner', description: 'x (claudekei primary agent)' },
      { name: 'Explore', description: '' },
    ],
    primaryAgents: [{ name: 'claudekei:planner', displayName: 'Planner', color: 'blue', description: 'x' }],
    defaults: { model: 'sonnet', mode: 'default', agent: 'claudekei:planner' },
  },
  sessions: [session('b'), session('a')],
  live: {
    a: {
      status: { type: 'busy' },
      permissions: [{ id: 'p2', sessionID: 'a', permission: 'edit', patterns: [], metadata: {}, always: [] }],
      questions: [],
    },
  },
  eventSeq: 7,
}

describe('buildDirectoryPatch', () => {
  it('sorts sessions by id, seeds agents/commands/provider and groups live prompts by session', () => {
    const patch = buildDirectoryPatch(structuredClone(INITIAL_STATE), response)
    expect(patch.session?.map((s) => s.id)).toEqual(['a', 'b'])
    expect(patch.sessionTotal).toBe(2)
    expect(patch.project).toBe('/work/app')
    expect(patch.provider?.all[0].id).toBe('anthropic')
    expect(patch.agent?.map((a) => [a.name, a.mode])).toEqual([['claudekei:planner', 'primary'], ['Explore', 'subagent']])
    expect(patch.command?.[0].name).toBe('compact')
    expect(patch.session_status).toEqual({ a: { type: 'busy' } })
    expect(patch.permission?.a).toHaveLength(1)
    expect(patch.limit).toBeGreaterThanOrEqual(50)
  })

  it('keeps already loaded virtual subagent children across a re-bootstrap', () => {
    const state = structuredClone(INITIAL_STATE)
    state.session = [session('sub_toolu1', { parentID: 'a' }), session('stale')]
    const patch = buildDirectoryPatch(state, response)
    expect(patch.session?.map((s) => s.id)).toEqual(['a', 'b', 'sub_toolu1'])
    expect(patch.sessionTotal).toBe(2)
  })
})

describe('buildWorkspaceProject', () => {
  it('presents the workspace folder as the single project', () => {
    const project = buildWorkspaceProject('/work/app/')
    expect(project.id).toBe('/work/app/')
    expect(project.name).toBe('app')
    expect(project.worktree).toBe('/work/app/')
  })
})
