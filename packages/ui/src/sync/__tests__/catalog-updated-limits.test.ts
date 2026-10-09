import { afterEach, describe, expect, it } from 'bun:test'
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry'
import { resetBootstrapCache } from '@/lib/claude/bootstrapCache'
import { createMockClaudeRuntime } from '@/lib/claude/mockRuntime'
import type { ClaudeRuntimeAPI, RuntimeAPIs } from '@/lib/api/types'
import type { Catalog } from '@/lib/claude/types'
import { useConfigStore } from '@/stores/useConfigStore'
import { runEventSideEffects } from '../sync-context'
import type { StoreApi } from 'zustand'
import type { DirectoryStore } from '../child-store'

/** Mock host whose bootstrap catalog has no `contextWindow`: a cold host cache. */
const coldRuntime = (): ClaudeRuntimeAPI => {
  const mock = createMockClaudeRuntime()
  const strip = (catalog: Catalog): Catalog => ({ ...catalog, models: catalog.models.map(({ contextWindow: _ignored, ...model }) => { void _ignored; return model }) })
  return {
    subscribe: mock.subscribe,
    request: (async (type: string, payload: unknown) => {
      const response = await (mock.request as (t: string, p: unknown) => Promise<unknown>)(type, payload)
      if (type === 'claude:bootstrap') {
        const bootstrap = response as { catalog: Catalog }
        return { ...bootstrap, catalog: strip(bootstrap.catalog) }
      }
      return response
    }) as ClaudeRuntimeAPI['request'],
  }
}

describe('catalog.updated refreshes the config-store providers (model limits)', () => {
  afterEach(() => {
    registerRuntimeAPIs(null)
    resetBootstrapCache()
  })

  it('a late contextWindow reaches getModelMetadata', async () => {
    resetBootstrapCache()
    const runtime = coldRuntime()
    registerRuntimeAPIs({ claude: runtime } as unknown as RuntimeAPIs)

    await useConfigStore.getState().loadProviders()
    // Cold cache: the static table says 200K for every model.
    expect(useConfigStore.getState().getModelMetadata('anthropic', 'opus')?.limit?.context).toBe(200_000)

    const bootstrap = await runtime.request('claude:bootstrap', {})
    const updated: Catalog = {
      ...bootstrap.catalog,
      models: bootstrap.catalog.models.map((model) => (model.value === 'opus' ? { ...model, contextWindow: 1_000_000 } : model)),
    }
    runEventSideEffects({ type: 'catalog.updated', properties: { catalog: updated } }, '/mock/workspace', {} as StoreApi<DirectoryStore>)

    const deadline = Date.now() + 3000
    while (useConfigStore.getState().getModelMetadata('anthropic', 'opus')?.limit?.context !== 1_000_000) {
      if (Date.now() > deadline) throw new Error('providers were not refreshed')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(useConfigStore.getState().getModelMetadata('anthropic', 'opus')?.limit?.context).toBe(1_000_000)
    // Models without a measured window keep the table value.
    expect(useConfigStore.getState().getModelMetadata('anthropic', 'haiku')?.limit?.context).toBe(200_000)
  })
})
