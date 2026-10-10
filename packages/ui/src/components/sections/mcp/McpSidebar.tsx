import React from 'react';
import { RiAddLine, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { MCP_STATUS_KEYS } from '@/components/mcp/mcpStatus';
import { McpStatusDot } from '@/components/mcp/McpStatusDot';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { McpServerInfo } from '@/lib/claude/types';
import { useMcpStore } from '@/stores/useMcpStore';

interface McpSidebarProps {
  onItemSelect?: () => void;
}

const EMPTY_SERVERS: McpServerInfo[] = [];

/** Origins shown first, in this order; anything else follows alphabetically. */
const ORIGIN_ORDER = ['user', 'local', 'project', 'plugin', 'claudeai', 'managed'];
const KNOWN_ORIGINS = new Set(ORIGIN_ORDER);

const groupByOrigin = (servers: McpServerInfo[]): Array<{ origin: string; servers: McpServerInfo[] }> => {
  const groups = new Map<string, McpServerInfo[]>();
  for (const server of servers) {
    const list = groups.get(server.origin) ?? [];
    list.push(server);
    groups.set(server.origin, list);
  }
  const rank = (origin: string) => {
    const index = ORIGIN_ORDER.indexOf(origin);
    return index === -1 ? ORIGIN_ORDER.length : index;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([origin, list]) => ({ origin, servers: [...list].sort((a, b) => a.name.localeCompare(b.name)) }));
};

/** MCP server list grouped by origin, with a status dot per row and a "New" button. */
export const McpSidebar: React.FC<McpSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const servers = useMcpStore((state) => state.snapshot?.servers ?? EMPTY_SERVERS);
  const hasSnapshot = useMcpStore((state) => state.snapshot !== null);
  const loading = useMcpStore((state) => state.loading);
  const error = useMcpStore((state) => state.error);
  const selected = useMcpStore((state) => state.selected);
  const select = useMcpStore((state) => state.select);
  const refresh = useMcpStore((state) => state.refresh);

  const groups = React.useMemo(() => groupByOrigin(servers), [servers]);

  const originLabel = (origin: string): string =>
    KNOWN_ORIGINS.has(origin)
      ? t(`claudeMcp.origin.${origin}` as 'claudeMcp.origin.user')
      : origin === 'unknown'
        ? t('claudeMcp.origin.unknown')
        : origin;

  const header = (
    <div className="flex items-center justify-between gap-1.5 border-b px-3 py-2">
      <span className="typography-ui-label font-medium text-foreground">{t('claudeMcp.title')}</span>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 flex-shrink-0 p-0 text-muted-foreground"
          disabled={loading}
          onClick={() => void refresh(true)}
          aria-label={t('claudeMcp.refresh')}
        >
          <RiRefreshLine className={cn('size-4', loading && 'animate-spin')} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 flex-shrink-0 gap-1 px-2 text-muted-foreground"
          onClick={() => {
            select('new');
            onItemSelect?.();
          }}
        >
          <RiAddLine className="size-4" />
          {t('claudeMcp.sidebar.new')}
        </Button>
      </div>
    </div>
  );

  const sectionLabel = (label: string) => (
    <div className="px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
  );

  const metadataFor = (server: McpServerInfo): string => {
    if (server.status === 'failed' && server.error) return server.error;
    const parts = [t(MCP_STATUS_KEYS[server.status])];
    if (server.status === 'connected') parts.push(t('claudeMcp.status.tools', { count: server.toolCount }));
    return parts.join(' · ');
  };

  let body: React.ReactNode;
  if (!hasSnapshot && loading) {
    body = <p className="px-2 py-3 typography-meta text-muted-foreground">{t('claudeMcp.loading')}</p>;
  } else if (!hasSnapshot && error) {
    body = (
      <div className="space-y-2 px-2 py-3">
        <p className="typography-meta text-[var(--status-error)]">{t('claudeMcp.loadFailed')}</p>
        <p className="break-words typography-micro text-muted-foreground">{error}</p>
        <Button type="button" size="xs" variant="outline" className="!font-normal" onClick={() => void refresh(true)}>
          {t('claudeMcp.sidebar.retry')}
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        {selected === 'new' ? (
          <SettingsSidebarItem
            title={
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate italic">{t('claudeMcp.sidebar.draftTitle')}</span>
                <span className="typography-micro flex-shrink-0 rounded border border-primary/30 bg-primary/10 px-1 pb-px leading-none text-primary">
                  {t('claudeMcp.sidebar.draftBadge')}
                </span>
              </span>
            }
            selected
            onSelect={onItemSelect ?? (() => {})}
          />
        ) : null}
        {groups.length === 0 && selected !== 'new' ? (
          <p className="px-2 py-3 typography-meta text-muted-foreground">{t('claudeMcp.empty')}</p>
        ) : null}
        {groups.map((group) => (
          <React.Fragment key={group.origin}>
            {sectionLabel(originLabel(group.origin))}
            {group.servers.map((server) => (
              <SettingsSidebarItem
                key={server.name}
                icon={<McpStatusDot status={server.status} label={t(MCP_STATUS_KEYS[server.status])} />}
                title={server.name}
                metadata={metadataFor(server)}
                selected={selected === server.name}
                onSelect={() => {
                  select(server.name);
                  onItemSelect?.();
                }}
              />
            ))}
          </React.Fragment>
        ))}
      </>
    );
  }

  return <SettingsSidebarLayout header={header}>{body}</SettingsSidebarLayout>;
};
