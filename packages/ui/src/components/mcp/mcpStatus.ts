import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { McpServerInfo } from '@/lib/claude/types';
import { useMcpStore } from '@/stores/useMcpStore';

type StatusKey =
  | 'claudeMcp.status.connected'
  | 'claudeMcp.status.failed'
  | 'claudeMcp.status.needsAuth'
  | 'claudeMcp.status.pending'
  | 'claudeMcp.status.disabled';

export const MCP_STATUS_KEYS: Record<McpServerInfo['status'], StatusKey> = {
  connected: 'claudeMcp.status.connected',
  failed: 'claudeMcp.status.failed',
  'needs-auth': 'claudeMcp.status.needsAuth',
  pending: 'claudeMcp.status.pending',
  disabled: 'claudeMcp.status.disabled',
};

/** Enable/disable a server through the store; failures surface as a toast (the store rolls the row back). */
export const useMcpToggle = (): ((name: string, enabled: boolean) => Promise<void>) => {
  const { t } = useI18n();
  return React.useCallback(
    async (name: string, enabled: boolean) => {
      try {
        await useMcpStore.getState().toggle(name, enabled);
      } catch (error) {
        toast.error(t('claudeMcp.toast.toggleFailed', { error: error instanceof Error ? error.message : String(error) }));
      }
    },
    [t],
  );
};
