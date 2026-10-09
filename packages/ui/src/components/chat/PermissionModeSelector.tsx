import React from 'react';
import { RiCheckLine, RiListCheck3, RiShieldCheckLine, RiShieldFlashLine, RiShieldUserLine } from '@remixicon/react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { PermissionMode } from '@/lib/claude/types';
import {
  PERMISSION_MENU_MODES,
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODE_LABELS,
  nextPermissionMode,
  resolveComposerMode,
  useDraftPermissionModeStore,
} from '@/lib/claude/permissionMode';
import { setSessionPermissionMode } from '@/sync/session-actions';
import { useSession } from '@/sync/sync-context';
import { useCatalog } from './hooks/useComposerModel';

/** Window event the host command `claudekei.cyclePermissionMode` is forwarded as. */
export const CYCLE_PERMISSION_MODE_EVENT = 'openchamber:cycle-permission-mode';

const MODE_ICON_STYLE: Record<PermissionMode, React.CSSProperties | undefined> = {
  default: undefined,
  acceptEdits: { color: 'var(--status-info)' },
  plan: { color: 'var(--status-warning)' },
  dontAsk: undefined,
  bypassPermissions: { color: 'var(--status-warning)' },
};

const ModeIcon: React.FC<{ mode: PermissionMode; className?: string }> = ({ mode, className }) => {
  const style = MODE_ICON_STYLE[mode];
  if (mode === 'plan') return <RiListCheck3 className={className} style={style} />;
  if (mode === 'bypassPermissions') return <RiShieldFlashLine className={className} style={style} />;
  if (mode === 'acceptEdits') return <RiShieldCheckLine className={className} style={style} />;
  return <RiShieldUserLine className={className} style={style} />;
};

type PermissionModeSelectorProps = {
  sessionId: string | null;
  footerIconButtonClass: string;
  iconSizeClass: string;
  /** Hide the text label (icon only), used on narrow layouts. */
  iconOnly?: boolean;
  disabled?: boolean;
};

/** Composer control for the Claude permission mode (default / auto-accept edits / plan). */
export const PermissionModeSelector = React.memo(function PermissionModeSelector(props: PermissionModeSelectorProps) {
  const { sessionId, footerIconButtonClass, iconSizeClass, iconOnly = false, disabled = false } = props;
  const session = useSession(sessionId);
  const draftMode = useDraftPermissionModeStore((state) => state.draftMode);
  const setDraftMode = useDraftPermissionModeStore((state) => state.setDraftMode);
  const [open, setOpen] = React.useState(false);
  // The catalog default mode (host: bypassPermissions) applies to drafts; re-resolve once the catalog arrives.
  const catalog = useCatalog();

  // `draftMode` is a dependency so drafts re-render when the choice changes.
  const mode = React.useMemo(
    () => resolveComposerMode(session?.mode, Boolean(sessionId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.mode, sessionId, draftMode, catalog?.defaults.mode],
  );

  const selectMode = React.useCallback((next: PermissionMode) => {
    if (!sessionId) {
      setDraftMode(next);
      return;
    }
    void setSessionPermissionMode(sessionId, next).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to change permission mode');
    });
  }, [sessionId, setDraftMode]);

  React.useEffect(() => {
    const onCycle = () => {
      if (disabled) return;
      selectMode(nextPermissionMode(mode));
    };
    window.addEventListener(CYCLE_PERMISSION_MODE_EVENT, onCycle);
    return () => window.removeEventListener(CYCLE_PERMISSION_MODE_EVENT, onCycle);
  }, [disabled, mode, selectMode]);

  const label = PERMISSION_MODE_LABELS[mode];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={600}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className={cn(footerIconButtonClass, 'gap-1 rounded-md hover:bg-transparent hover:opacity-70 min-w-0')}
              aria-label={`Permission mode: ${label}`}
              data-permission-mode={mode}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
            >
              <ModeIcon mode={mode} className={cn(iconSizeClass, 'flex-shrink-0')} />
              {!iconOnly ? (
                <span className="typography-micro font-medium truncate max-w-[110px]" style={MODE_ICON_STYLE[mode]}>
                  {label}
                </span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          {`Permission mode: ${label}`}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-[min(260px,calc(100vw-2rem))] p-1">
        {/* dontAsk is host-controlled: show it as a read-only checked row. */}
        {!(PERMISSION_MENU_MODES as readonly PermissionMode[]).includes(mode) ? (
          <DropdownMenuItem
            disabled
            className="typography-meta"
            role="menuitemradio"
            aria-checked
            data-permission-mode-option={mode}
          >
            <div className="flex w-full items-start gap-2">
              <ModeIcon mode={mode} className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium">{PERMISSION_MODE_LABELS[mode]}</span>
                <span className="typography-micro text-muted-foreground break-words">{PERMISSION_MODE_DESCRIPTIONS[mode]}</span>
              </div>
              <RiCheckLine className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" />
            </div>
          </DropdownMenuItem>
        ) : null}
        {PERMISSION_MENU_MODES.map((value) => (
          <DropdownMenuItem
            key={value}
            className="typography-meta"
            onSelect={() => selectMode(value)}
            role="menuitemradio"
            aria-checked={value === mode}
            data-permission-mode-option={value}
          >
            <div className="flex w-full items-start gap-2">
              <ModeIcon mode={value} className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium">{PERMISSION_MODE_LABELS[value]}</span>
                <span className="typography-micro text-muted-foreground break-words">{PERMISSION_MODE_DESCRIPTIONS[value]}</span>
              </div>
              {value === mode ? <RiCheckLine className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" /> : null}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
