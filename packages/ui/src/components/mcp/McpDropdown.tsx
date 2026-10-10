import React from 'react';
import { RiRefreshLine } from '@remixicon/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Switch } from '@/components/ui/switch';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { computeMcpHealth, useMcpStore } from '@/stores/useMcpStore';
import { McpIcon } from '@/components/icons/McpIcon';
import { useI18n } from '@/lib/i18n';
import type { McpServerInfo } from '@/lib/claude/types';
import { MCP_STATUS_KEYS, useMcpToggle } from './mcpStatus';
import { McpStatusDot } from './McpStatusDot';

const EMPTY_SERVERS: McpServerInfo[] = [];

/** Re-probe on demand; keeps the spinner visible for at least half a second. */
const useMcpRefresh = () => {
  const [spinning, setSpinning] = React.useState(false);
  const refresh = React.useCallback(
    (event?: React.MouseEvent) => {
      event?.preventDefault();
      if (spinning) return;
      setSpinning(true);
      const minSpin = new Promise((resolve) => setTimeout(resolve, 500));
      void Promise.all([useMcpStore.getState().refresh(true), minSpin]).finally(() => setSpinning(false));
    },
    [spinning],
  );
  return { spinning, refresh };
};

const RefreshButton: React.FC<{ spinning: boolean; onClick: (event: React.MouseEvent) => void; className?: string }> = ({ spinning, onClick, className }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={cn('inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', className)}
      disabled={spinning}
      onClick={onClick}
      aria-label={t('claudeMcp.refresh')}
    >
      <RiRefreshLine className={cn('h-4 w-4', spinning && 'animate-spin')} />
    </button>
  );
};

interface McpServerListProps {
  /** Refreshes (cached, `refresh(false)`) each time this turns true. */
  active: boolean;
  /** Horizontal padding utility for the rows. */
  rowClassName?: string;
}

/** Server rows with status dot and inline enable toggle; shared by the desktop dropdown and the mobile panel. */
const McpServerList: React.FC<McpServerListProps> = ({ active, rowClassName }) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const servers = useMcpStore((state) => state.snapshot?.servers ?? EMPTY_SERVERS);
  const hasSnapshot = useMcpStore((state) => state.snapshot !== null);
  const loading = useMcpStore((state) => state.loading);
  const error = useMcpStore((state) => state.error);
  const toggleSupported = useMcpStore((state) => state.toggleSupported);
  const toggle = useMcpToggle();

  React.useEffect(() => {
    if (active) void useMcpStore.getState().refresh(false);
  }, [active]);

  const sorted = React.useMemo(() => [...servers].sort((a, b) => a.name.localeCompare(b.name)), [servers]);

  const statusText = (server: McpServerInfo): string =>
    server.status === 'failed' && server.error
      ? t('claudeMcp.status.failedWithError', { error: server.error })
      : t(MCP_STATUS_KEYS[server.status]);

  if (sorted.length === 0) {
    const message = !hasSnapshot && loading ? t('claudeMcp.loading') : !hasSnapshot && error ? error : t('claudeMcp.empty');
    return <div className="px-4 py-5 text-center typography-ui-label text-muted-foreground">{message}</div>;
  }

  return (
    <>
      {sorted.map((server) => {
        const text = statusText(server);
        const dot = <McpStatusDot status={server.status} label={text} />;
        return (
          <div key={server.name} className={cn('flex items-center justify-between gap-2 rounded-lg py-1.5 hover:bg-interactive-hover/50', rowClassName ?? 'px-4')}>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {isMobile ? (
                dot
              ) : (
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>{dot}</TooltipTrigger>
                  <TooltipContent side="left">
                    <p className="max-w-xs break-words">{text}</p>
                  </TooltipContent>
                </Tooltip>
              )}
              <div className="min-w-0">
                <div className="truncate typography-ui-label">{server.name}</div>
                {server.status === 'needs-auth' || server.status === 'failed' ? (
                  <div
                    className={cn('truncate typography-micro', server.status === 'failed' ? 'text-[var(--status-error)]' : 'text-[var(--status-warning)]')}
                    title={text}
                  >
                    {server.status === 'failed' ? server.error ?? t('claudeMcp.status.failed') : t('claudeMcp.status.needsAuth')}
                  </div>
                ) : null}
              </div>
            </div>
            <Switch
              checked={server.status !== 'disabled'}
              disabled={!toggleSupported}
              aria-label={t('claudeMcp.toggleAria', { name: server.name })}
              className="data-[checked]:bg-status-info"
              onCheckedChange={(checked) => void toggle(server.name, checked)}
            />
          </div>
        );
      })}
      {!toggleSupported ? (
        <div className="px-4 pt-1 typography-micro text-muted-foreground">{t('claudeMcp.toggleUnsupported')}</div>
      ) : null}
    </>
  );
};

interface McpDropdownProps {
  headerIconButtonClass: string;
}

interface McpDropdownContentProps {
  active: boolean;
  className?: string;
}

export const McpDropdownContent: React.FC<McpDropdownContentProps> = ({ active, className }) => {
  const { t } = useI18n();
  const directory = useDirectoryStore((state) => state.currentDirectory) ?? null;
  const { spinning, refresh } = useMcpRefresh();

  return (
    <div className={cn('w-full', className)}>
      <div className="border-b border-[var(--interactive-border)]">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <div className="typography-ui-header font-semibold text-foreground">{t('claudeMcp.title')}</div>
            {directory && (
              <div className="truncate typography-micro text-muted-foreground">{directory.split('/').pop() || directory}</div>
            )}
          </div>
          <RefreshButton spinning={spinning} onClick={refresh} className="h-7 w-7" />
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto py-2">
        <McpServerList active={active} />
      </div>
    </div>
  );
};

export const McpDropdown: React.FC<McpDropdownProps> = ({ headerIconButtonClass }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const blockTooltipRef = React.useRef(false);
  const { isMobile } = useDeviceInfo();
  const directory = useDirectoryStore((state) => state.currentDirectory) ?? null;
  const servers = useMcpStore((state) => state.snapshot?.servers);
  const { spinning, refresh } = useMcpRefresh();

  const health = React.useMemo(() => computeMcpHealth(servers), [servers]);

  const handleDropdownOpenChange = React.useCallback((isOpen: boolean) => {
    if (!isOpen) {
      blockTooltipRef.current = true;
      setTooltipOpen(false);
      setTimeout(() => {
        blockTooltipRef.current = false;
      }, 200);
    }
    setOpen(isOpen);
  }, []);

  const handleTooltipOpenChange = React.useCallback((isOpen: boolean) => {
    if (blockTooltipRef.current) return;
    setTooltipOpen(isOpen);
  }, []);

  const triggerButton = (
    <button
      type="button"
      aria-label={t('claudeMcp.openAria')}
      className={cn(headerIconButtonClass, 'relative')}
      onClick={isMobile ? () => setOpen(true) : undefined}
    >
      <McpIcon className="h-[1.0625rem] w-[1.0625rem]" />
      {health.total > 0 && (
        <span
          className={cn(
            'absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full',
            health.hasFailed
              ? 'bg-status-error'
              : health.hasAuthRequired
                ? 'bg-status-warning'
                : health.connected > 0
                  ? 'bg-status-success'
                  : 'bg-muted-foreground/40'
          )}
          aria-label={t('claudeMcp.statusAria')}
        />
      )}
    </button>
  );

  if (isMobile) {
    return (
      <>
        {triggerButton}
        <MobileOverlayPanel
          open={open}
          title={t('claudeMcp.title')}
          onClose={() => setOpen(false)}
          renderHeader={(closeButton) => (
            <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
              <h2 className="typography-ui-label font-semibold text-foreground">{t('claudeMcp.title')}</h2>
              <div className="flex items-center gap-1">
                <RefreshButton spinning={spinning} onClick={refresh} className="p-1" />
                {closeButton}
              </div>
            </div>
          )}
        >
          <div className="py-1">
            <McpServerList active={open} rowClassName="px-2" />
          </div>
          {directory && (
            <div className="mt-1 border-t border-border/40 px-2 py-1">
              <span className="block truncate typography-meta text-muted-foreground">{directory.split('/').pop() || directory}</span>
            </div>
          )}
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleDropdownOpenChange}>
      <Tooltip delayDuration={1000} open={open ? false : tooltipOpen} onOpenChange={handleTooltipOpenChange}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('claudeMcp.title')}</p>
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-72">
        <McpDropdownContent active={open} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
