import type { BridgeContext, BridgeResponse } from './bridge';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type ConfigRuntimeDeps = {
  readSettings: (ctx?: BridgeContext) => Record<string, unknown>;
  persistSettings: (changes: Record<string, unknown>, ctx?: BridgeContext) => Promise<Record<string, unknown>>;
  readMagicPromptOverrides: () => { version: number; overrides: Record<string, string> };
  saveMagicPromptOverride: (id: string, text: string) => Promise<{ version: number; overrides: Record<string, string> }>;
  resetMagicPromptOverride: (id: string) => Promise<{ version: number; overrides: Record<string, string> }>;
  resetAllMagicPromptOverrides: () => Promise<{ version: number; overrides: Record<string, string> }>;
};

/** Settings still managed by the extension: UI settings and magic prompts. Agents / commands / skills / MCP / plugins use the typed `claude:*` routes. */
export async function handleConfigBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: ConfigRuntimeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:config/settings:get': {
      return { id, type, success: true, data: deps.readSettings(ctx) };
    }

    case 'api:config/settings:save': {
      const changes = (payload as Record<string, unknown>) || {};
      const updated = await deps.persistSettings(changes, ctx);
      return { id, type, success: true, data: updated };
    }

    case 'api:magic-prompts:get': {
      return { id, type, success: true, data: deps.readMagicPromptOverrides() };
    }

    case 'api:magic-prompts:save': {
      const request = (payload || {}) as { id?: string; text?: string };
      const promptId = typeof request.id === 'string' ? request.id : '';
      if (!promptId) {
        return { id, type, success: false, error: 'Prompt id is required' };
      }
      if (typeof request.text !== 'string') {
        return { id, type, success: false, error: 'Prompt text is required' };
      }
      const data = await deps.saveMagicPromptOverride(promptId, request.text);
      return { id, type, success: true, data };
    }

    case 'api:magic-prompts:reset': {
      const request = (payload || {}) as { id?: string };
      const promptId = typeof request.id === 'string' ? request.id : '';
      if (!promptId) {
        return { id, type, success: false, error: 'Prompt id is required' };
      }
      const data = await deps.resetMagicPromptOverride(promptId);
      return { id, type, success: true, data };
    }

    case 'api:magic-prompts:reset-all': {
      const data = await deps.resetAllMagicPromptOverrides();
      return { id, type, success: true, data };
    }

    case 'api:config/reload': {
      // Only refresh the catalog: live sessions are never restarted by a config reload.
      await ctx?.manager?.refreshCatalog();
      return { id, type, success: true, data: { restarted: false } };
    }

    default:
      return null;
  }
}
