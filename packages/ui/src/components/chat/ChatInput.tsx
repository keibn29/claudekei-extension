import React from 'react';
import { MinimalComposer, type ComposerHandle } from './composer/MinimalComposer';
import { findMentionRanges, type MentionRange as ComposerMentionRange } from './composer/mentions';
import {
    RiAddCircleLine,
    RiAiAgentLine,
    RiAttachment2,
    RiCommandLine,
    RiDragDropLine,
    RiFolderLine,
    RiFullscreenLine,
    RiSendPlane2Line,
} from '@remixicon/react';
// sessionStore removed — currentSessionId comes from useSessionUIStore
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useInputStore, type VSCodeSelectionContext } from '@/sync/input-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import * as sessionActions from '@/sync/session-actions';
import { useUserMessageHistory } from '@/sync/sync-context';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { appendInlineComments } from '@/lib/messages/inlineComments';
import { AttachedFilesList } from './FileAttachment';
import { QueuedMessageChips } from './QueuedMessageChips';
import { FileMentionAutocomplete, type FileMentionHandle } from './FileMentionAutocomplete';
import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from './CommandAutocomplete';
import { SkillAutocomplete, type SkillAutocompleteHandle } from './SkillAutocomplete';
import { COMPOSER_POPUP_ID } from './autocompletePopupIds';
import { cn, formatDirectoryName, isMacOS } from '@/lib/utils';
import { ModelControls } from './ModelControls';
import { UnifiedControlsDrawer } from './UnifiedControlsDrawer';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { StatusRow } from './StatusRow';
import { PendingChangesBar } from './PendingChangesBar';
import { MobileAgentButton } from './MobileAgentButton';
import { MobileModelButton } from './MobileModelButton';
import { MobileSessionStatusBar } from './MobileSessionStatusBar';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { toast } from '@/components/ui';
// useMessageStore removed — messages now come from sync system
import { isTauriShell, isVSCodeRuntime } from '@/lib/desktop';
import { isIMECompositionEvent } from '@/lib/ime';
import { StopIcon } from '@/components/icons/StopIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isPrimaryMode, type MobileControlsPanel } from './mobileControlsUtils';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { claudeHost } from '@/lib/claude/host';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP } from '@/lib/projectMeta';
import { useGitBranches, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { extractGitChangedFiles } from './changedFiles';
import { useI18n } from '@/lib/i18n';
import { PermissionModeSelector } from './PermissionModeSelector';
import { ClaudeStatusBanner } from './ClaudeStatusBanner';
import { useCurrentSessionIsSubtask } from '@/hooks/useCurrentSessionIsSubtask';
import { PendingAgentSwitchNotice } from './PendingAgentSwitchNotice';

const MAX_VISIBLE_TEXTAREA_LINES = 8;

// Subset of React.KeyboardEvent used by the composer key pipeline (the editor emits native events).
type ComposerKeyEvent = Pick<React.KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'preventDefault'> & {
    nativeEvent: KeyboardEvent;
};
const EMPTY_QUEUE: QueuedMessage[] = [];
const FILE_MENTION_TOKEN = /^@[^\s]+$/;
const CHAT_DRAFT_PERSIST_DEBOUNCE_MS = 500;
const VS_CODE_DROP_DATA_TYPES = [
    'CodeFiles',
    'codefiles',
    'application/vnd.code.tree',
    'application/vnd.code.tree.explorer',
    'text/uri-list',
    'text/plain',
];

const FILE_URI_PREFIX = 'file://';

const encodeFilePath = (filepath: string): string => {
    let normalized = filepath.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(normalized)) {
        normalized = `/${normalized}`;
    }
    return normalized
        .split('/')
        .map((segment, index) => {
            if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
            return encodeURIComponent(segment);
        })
        .join('/');
};

const toServerFileUrl = (filepath: string): string => {
    const normalized = filepath.replace(/\\/g, '/').trim();
    if (normalized.toLowerCase().startsWith(FILE_URI_PREFIX)) {
        return normalized;
    }
    return `file://${encodeFilePath(normalized)}`;
};

const isLikelyAbsolutePath = (value: string): boolean => (
    value.startsWith('/')
    || value.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(value)
);

const toLikelyFileDropReference = (value: string): string | null => {
    const trimmed = value.trim().replace(/^['"]+|['"]+$/g, '');
    if (!trimmed) {
        return null;
    }

    if (/[\r\n]/.test(trimmed)) {
        return null;
    }

    if (trimmed.toLowerCase().startsWith(FILE_URI_PREFIX)) {
        return trimmed;
    }

    if (isLikelyAbsolutePath(trimmed)) {
        return trimmed;
    }

    return null;
};

const collectStringLeaves = (input: unknown, output: Set<string>, depth = 0): void => {
    if (depth > 6 || input == null) {
        return;
    }

    if (typeof input === 'string') {
        output.add(input);
        return;
    }

    if (Array.isArray(input)) {
        for (const item of input) {
            collectStringLeaves(item, output, depth + 1);
        }
        return;
    }

    if (typeof input !== 'object') {
        return;
    }

    for (const value of Object.values(input)) {
        collectStringLeaves(value, output, depth + 1);
    }
};

const parseDroppedFileReferences = (rawPayload: string): string[] => {
    const extracted = new Set<string>();

    const addCandidatesFromText = (value: string): void => {
        const direct = toLikelyFileDropReference(value);
        if (direct) {
            extracted.add(direct);
            return;
        }

        for (const line of value.split(/\r?\n/)) {
            const candidate = toLikelyFileDropReference(line);
            if (candidate) {
                extracted.add(candidate);
            }
        }
    };

    addCandidatesFromText(rawPayload);

    try {
        const parsed = JSON.parse(rawPayload) as unknown;
        const leaves = new Set<string>();
        collectStringLeaves(parsed, leaves);
        for (const leaf of leaves) {
            addCandidatesFromText(leaf);
        }
    } catch {
        // Ignore non-JSON payloads.
    }

    return Array.from(extracted);
};

const normalizePath = (value?: string | null): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const normalized = trimmed.replace(/\\/g, '/');
    if (normalized === '/') {
        return '/';
    }
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const getProjectDisplayLabel = (project: { label?: string; path: string }): string => {
    const label = project.label?.trim();
    if (label) {
        return label;
    }
    return formatDirectoryName(project.path);
};

const getProjectIconColor = (projectColor?: string | null): string | undefined => {
    if (!projectColor) {
        return undefined;
    }
    return PROJECT_COLOR_MAP[projectColor] ?? undefined;
};

const MemoModelControls = React.memo(ModelControls);
const MemoUnifiedControlsDrawer = React.memo(UnifiedControlsDrawer);
const MemoMobileAgentButton = React.memo(MobileAgentButton);
const MemoMobileModelButton = React.memo(MobileModelButton);
const MemoStatusRow = React.memo(StatusRow);

type ComposerAttachmentControlsProps = {
    isMobile: boolean;
    isVSCode: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    fileInputRef: React.RefObject<HTMLInputElement | null>;
    handleLocalFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
    handlePickLocalFiles: () => void;
    handleOpenCommandMenu: () => void;
    onOpenSettings?: () => void;
};

const ComposerAttachmentControls = React.memo(function ComposerAttachmentControls(props: ComposerAttachmentControlsProps) {
    const { t } = useI18n();
    const {
        isMobile,
        isVSCode,
        footerIconButtonClass,
        iconSizeClass,
        fileInputRef,
        handleLocalFileSelect,
        handlePickLocalFiles,
        handleOpenCommandMenu,
        onOpenSettings,
    } = props;

    return (
        <div className="flex items-center gap-x-1.5">
            {isMobile ? (
                <button
                    type="button"
                    className={cn(
                        footerIconButtonClass,
                        'rounded-md',
                        'hover:bg-interactive-hover/40'
                    )}
                    onPointerDownCapture={(event) => {
                        if (event.pointerType === 'touch') {
                            event.preventDefault();
                            event.stopPropagation();
                        }
                    }}
                    onClick={handleOpenCommandMenu}
                    title={t('chat.chatInput.actions.commands')}
                    aria-label={t('chat.chatInput.actions.commands')}
                >
                    <RiCommandLine className={cn(iconSizeClass)} />
                </button>
            ) : null}
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleLocalFileSelect}
                accept="*/*"
            />

            <div className="relative inline-flex">
                {isVSCode ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        onClick={handlePickLocalFiles}
                        title={t('chat.chatInput.actions.attachFiles')}
                        aria-label={t('chat.chatInput.actions.attachFiles')}
                    >
                        <RiAttachment2 className={cn(iconSizeClass, 'text-current')} />
                    </button>
                ) : (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className={footerIconButtonClass}
                                title={t('chat.chatInput.actions.addAttachment')}
                                aria-label={t('chat.chatInput.actions.addAttachment')}
                            >
                                <RiAddCircleLine className={cn(iconSizeClass, 'text-current')} />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(handlePickLocalFiles);
                                }}
                            >
                                <RiAttachment2 />
                                {t('chat.chatInput.actions.attachFiles')}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>

            {onOpenSettings ? (
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className={footerIconButtonClass}
                    title={t('chat.chatInput.actions.modelAgentSettings')}
                    aria-label={t('chat.chatInput.actions.modelAgentSettings')}
                >
                    <RiAiAgentLine className={cn(iconSizeClass, 'text-current')} />
                </button>
            ) : null}
        </div>
    );
}, (prev, next) => (
    prev.isMobile === next.isMobile
    && prev.isVSCode === next.isVSCode
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.iconSizeClass === next.iconSizeClass
    && prev.onOpenSettings === next.onOpenSettings
));

type FocusModeButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    isExpandedInput: boolean;
    onToggle: () => void;
};

const FocusModeButton = React.memo(function FocusModeButton(props: FocusModeButtonProps) {
    const { footerIconButtonClass, iconSizeClass, isExpandedInput, onToggle } = props;
    const { t } = useI18n();

    return (
        <Tooltip delayDuration={600}>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        footerIconButtonClass,
                        'rounded-md',
                        isExpandedInput
                            ? 'text-primary'
                            : 'text-foreground hover:bg-[var(--interactive-hover)]/40'
                    )}
                    onMouseDown={(event) => {
                        event.preventDefault();
                    }}
                    onClick={onToggle}
                    aria-label={t('chat.chatInput.focusMode.toggleAria')}
                    aria-pressed={isExpandedInput}
                >
                    <RiFullscreenLine className={cn(iconSizeClass)} />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                <div className="flex flex-col gap-0.5 text-center">
                    <span>{t('chat.chatInput.focusMode.label')}</span>
                    <span className="font-mono opacity-60">
                        {isMacOS() ? '⌘⇧E' : 'Ctrl+Shift+E'}
                    </span>
                </div>
            </TooltipContent>
        </Tooltip>
    );
});

type ComposerActionButtonsProps = {
    isMobile: boolean;
    footerIconButtonClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
    canSend: boolean;
    canAbort: boolean;
    hasContent: boolean;
    currentSessionId: string | null;
    newSessionDraftOpen: boolean;
    onPrimaryAction: () => void;
    onQueueMessage: () => void;
    onAbort: () => void;
};

const ComposerActionButtons = React.memo(function ComposerActionButtons(props: ComposerActionButtonsProps) {
    const {
        isMobile,
        footerIconButtonClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        canAbort,
        hasContent,
        currentSessionId,
        newSessionDraftOpen,
        onPrimaryAction,
        onQueueMessage,
        onAbort,
    } = props;
    const { t } = useI18n();

    const sendButton = (
        <button
            type={isMobile ? 'button' : 'submit'}
            disabled={!canSend || (!currentSessionId && !newSessionDraftOpen)}
            onClick={(event) => {
                if (!isMobile) {
                    return;
                }

                event.preventDefault();
                onPrimaryAction();
            }}
            className={cn(
                footerIconButtonClass,
                canSend && (currentSessionId || newSessionDraftOpen)
                    ? 'text-primary hover:text-primary'
                    : 'opacity-30'
            )}
            aria-label={t('chat.chatInput.actions.sendMessageAria')}
        >
            <RiSendPlane2Line className={cn(sendIconSizeClass)} />
        </button>
    );

    if (!canAbort) {
        return sendButton;
    }

    return (
        <div className="relative">
            {hasContent ? (
                <button
                    type="button"
                    disabled={!currentSessionId}
                    onClick={(event) => {
                        if (isMobile) {
                            event.preventDefault();
                        }
                        onQueueMessage();
                    }}
                    className={cn(
                        footerIconButtonClass,
                        'absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-1',
                        currentSessionId ? 'text-primary hover:text-primary' : 'opacity-30'
                    )}
                    aria-label={t('chat.chatInput.actions.queueMessageAria')}
                >
                    <RiSendPlane2Line className={cn(sendIconSizeClass, '-rotate-90')} />
                </button>
            ) : null}
            <button
                type="button"
                onClick={onAbort}
                className={cn(
                    footerIconButtonClass,
                    'text-[var(--status-error)] hover:text-[var(--status-error)]'
                )}
                aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
            >
                <StopIcon className={cn(stopIconSizeClass)} />
            </button>
        </div>
    );
}, (prev, next) => (
    prev.isMobile === next.isMobile
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.sendIconSizeClass === next.sendIconSizeClass
    && prev.stopIconSizeClass === next.stopIconSizeClass
    && prev.canSend === next.canSend
    && prev.canAbort === next.canAbort
    && prev.hasContent === next.hasContent
    && prev.currentSessionId === next.currentSessionId
    && prev.newSessionDraftOpen === next.newSessionDraftOpen
));

const appendWithLineBreaks = (base: string, next: string): string => {
    const separator = !base
        ? ''
        : base.endsWith('\n\n')
            ? ''
            : base.endsWith('\n')
                ? '\n'
                : '\n\n';

    const nextWithTrailingBreaks = next.endsWith('\n\n')
        ? next
        : next.endsWith('\n')
            ? `${next}\n`
            : `${next}\n\n`;

    return `${base}${separator}${nextWithTrailingBreaks}`;
};

const appendInlineText = (base: string, next: string): string => {
    const nextTrimmed = next.trim();
    if (!nextTrimmed) {
        return base;
    }
    if (!base) {
        return `${nextTrimmed} `;
    }
    const separator = /[\s\n]$/.test(base) ? '' : ' ';
    return `${base}${separator}${nextTrimmed} `;
};

interface ChatInputProps {
    onOpenSettings?: () => void;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
}

type AutocompleteOverlayPosition = {
    top: number;
    left: number;
    place: 'above' | 'below';
    maxHeight: number;
};

// Per-session draft key — preserves in-progress messages across project switches
const getDraftKey = (sessionId: string | null): string =>
    `openchamber_chat_input_draft_${sessionId ?? 'new'}`;

// Helper to safely read from localStorage for a given session
const getStoredDraft = (sessionId: string | null): string => {
    try {
        return localStorage.getItem(getDraftKey(sessionId)) ?? '';
    } catch {
        return '';
    }
};

// Helper to safely write/clear a per-session draft
const saveStoredDraft = (sessionId: string | null, draft: string): void => {
    try {
        if (draft) {
            localStorage.setItem(getDraftKey(sessionId), draft);
        } else {
            localStorage.removeItem(getDraftKey(sessionId));
        }
    } catch {
        // Ignore localStorage errors
    }
};

// Per-session confirmed mentions key — tracks which @mentions are confirmed (blue) vs plain text
const getConfirmedMentionsKey = (sessionId: string | null): string =>
    `openchamber_chat_confirmed_mentions_${sessionId ?? 'new'}`;

const saveConfirmedMentions = (sessionId: string | null, mentions: Set<string>): void => {
    try {
        if (mentions.size > 0) {
            localStorage.setItem(getConfirmedMentionsKey(sessionId), JSON.stringify([...mentions]));
        } else {
            localStorage.removeItem(getConfirmedMentionsKey(sessionId));
        }
    } catch {
        // Ignore localStorage errors
    }
};

const loadConfirmedMentions = (sessionId: string | null): Set<string> => {
    try {
        const raw = localStorage.getItem(getConfirmedMentionsKey(sessionId));
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return new Set(parsed.filter((v): v is string => typeof v === 'string'));
            }
        }
    } catch {
        // Ignore localStorage errors
    }
    return new Set();
};

type MentionRange = {
    startLine: number;
    endLine: number;
};

type ParsedFileMention = {
    mentionText: string;
    filePath: string;
    range: MentionRange | null;
    sourceText: {
        value: string;
        start: number;
        end: number;
    };
};

const buildRangeToken = (range: MentionRange): string => (
    range.startLine === range.endLine
        ? `#L${range.startLine}`
        : `#L${range.startLine}-#L${range.endLine}`
);

const buildSelectionMentionText = (filePath: string, range: MentionRange): string => (
    `@${filePath}:<${buildRangeToken(range)}>`
);

const buildSelectionSyntheticText = (context: VSCodeSelectionContext): string => {
    const rangeToken = buildRangeToken({ startLine: context.startLine, endLine: context.endLine });
    const language = typeof context.languageId === 'string' ? context.languageId.trim() : '';
    const fencedLanguage = language.length > 0 ? language : 'text';
    return `Selected range from ${context.filePath} (${rangeToken})\n\n\`\`\`${fencedLanguage}\n${context.selectedText}\n\`\`\``;
};

const parseInlineFileMention = (rawMentionPath: string, offset: number): ParsedFileMention | null => {
    const trimmed = String(rawMentionPath || '')
        .trim()
        .replace(/^[`"'<(]+/, '');

    if (!trimmed) {
        return null;
    }

    const rangeMatch = trimmed.match(/^(.*):<#L(\d+)(?:-#L(\d+))?>$/i);
    if (rangeMatch) {
        const filePath = rangeMatch[1]?.trim().replace(/[),.;!?`"']+$/g, '');
        const startLine = Number(rangeMatch[2]);
        const endLine = Number(rangeMatch[3] ?? rangeMatch[2]);
        if (!filePath || !Number.isFinite(startLine) || !Number.isFinite(endLine)) {
            return null;
        }
        const mentionText = buildSelectionMentionText(filePath, { startLine, endLine });
        return {
            mentionText,
            filePath,
            range: { startLine, endLine },
            sourceText: {
                value: mentionText,
                start: offset,
                end: offset + mentionText.length,
            },
        };
    }

    const filePath = trimmed.replace(/[),.;:!?`"'>]+$/g, '');
    if (!filePath) {
        return null;
    }

    return {
        mentionText: `@${filePath}`,
        filePath,
        range: null,
        sourceText: {
            value: `@${filePath}`,
            start: offset,
            end: offset + filePath.length + 1,
        },
    };
};

const ChatInputComponent: React.FC<ChatInputProps> = ({ onOpenSettings, scrollToBottom }) => {
    const { t } = useI18n();
    // Track if we restored a draft on mount (for text selection)
    const initialDraftRef = React.useRef<string | null>(null);
    // Track initial session ID (captured at mount time for draft restoration)
    const initialSessionIdRef = React.useRef<string | null>(null);
    const [message, setMessage] = React.useState(() => {
        // Read per-session draft at mount time using the current session from the store
        const sessionId = useSessionUIStore.getState().currentSessionId;
        initialSessionIdRef.current = sessionId;
        const draft = getStoredDraft(sessionId);
        if (draft) {
            initialDraftRef.current = draft;
        }
        return draft;
    });
    // Restore confirmed mentions from localStorage on mount
    const confirmedMentionsRef = React.useRef<Set<string>>(loadConfirmedMentions(initialSessionIdRef.current));
    // Helper: check if a mention path looks like a file/folder (has path separators, extension, or was explicitly confirmed)
    const isConfirmedFilePath = React.useCallback(
        (text: string): boolean => text.includes('/') || text.includes('\\') || text.includes('.') || confirmedMentionsRef.current.has(text),
        [],
    );
    const [isDragging, setIsDragging] = React.useState(false);
    // True while files are dragged over the composer without Shift (VS Code webviews only accept drops with Shift held).
    const [needsShiftHint, setNeedsShiftHint] = React.useState(false);
    const [isInternalDrag, setIsInternalDrag] = React.useState(false);
    const [showFileMention, setShowFileMention] = React.useState(false);
    const [mentionQuery, setMentionQuery] = React.useState('');
    const [showCommandAutocomplete, setShowCommandAutocomplete] = React.useState(false);
    const [commandQuery, setCommandQuery] = React.useState('');
    const [autocompleteTab, setAutocompleteTab] = React.useState<'commands' | 'agents' | 'files'>('commands');
    const [showSkillAutocomplete, setShowSkillAutocomplete] = React.useState(false);
    const [skillQuery, setSkillQuery] = React.useState('');
    const [composerMaxHeight, setComposerMaxHeight] = React.useState<number | null>(null);
    const [mobileControlsOpen, setMobileControlsOpen] = React.useState(false);
    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);
    // Message history navigation state (up/down arrow to recall previous messages)
    const [historyIndex, setHistoryIndex] = React.useState(-1); // -1 = not browsing, 0+ = index from most recent
    const [draftMessage, setDraftMessage] = React.useState(''); // Preserves input when entering history mode
    // Mirrors of the two states above for code that must not wait for a render (session switch, unmount)
    const historyIndexRef = React.useRef(-1);
    const draftMessageRef = React.useRef('');
    const setHistory = React.useCallback((index: number, draft: string) => {
        historyIndexRef.current = index;
        draftMessageRef.current = draft;
        setHistoryIndex(index);
        setDraftMessage(draft);
    }, []);
    // Textarea-like handle backed by the TipTap composer; offsets are markdown string offsets.
    const textareaRef = React.useRef<ComposerHandle | null>(null);
    const cursorPosRef = React.useRef(0);
    const dropZoneRef = React.useRef<HTMLDivElement>(null);
    const dragEnterCountRef = React.useRef(0);
    const suppressNextFileDropTextInsertRef = React.useRef(false);
    const suppressNextFileDropTextInsertTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingDroppedAbsolutePathsRef = React.useRef<string[]>([]);
    const canAcceptDropRef = React.useRef(false);
    const nativeDragInsideDropZoneRef = React.useRef(false);
    const mentionRef = React.useRef<FileMentionHandle>(null);
    const commandRef = React.useRef<CommandAutocompleteHandle>(null);
    const skillRef = React.useRef<SkillAutocompleteHandle>(null);
    // Ref to track current message value without triggering re-renders in effects
    const messageRef = React.useRef(message);
    const draftPersistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const skipNextDraftPersistRef = React.useRef(false);
    const lastPersistedDraftRef = React.useRef<Map<string, string>>(new Map());
    const currentSessionIdForDraftRef = React.useRef<string | null>(null);
    const vscodeSelectionContextsByDraftRef = React.useRef<Map<string, Map<string, VSCodeSelectionContext>>>(new Map());

    // TODO: port sendMessage to session-actions (complex — creates sessions, handles attachments, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMessage = React.useRef((...args: any[]) =>
        Promise.resolve((useSessionUIStore.getState().sendMessage as (...a: unknown[]) => unknown)(...args)),
    ).current;
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const isCurrentSessionSubtask = useCurrentSessionIsSubtask();
    const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const newSessionDraftOpen = Boolean(newSessionDraft?.open);
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const abortPromptSessionId = useSessionUIStore((s) => s.abortPromptSessionId);
    const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
    const attachedFiles = useInputStore((s) => s.attachedFiles);
    const addAttachedFile = useInputStore((s) => s.addAttachedFile);
    const clearAttachedFiles = useInputStore((s) => s.clearAttachedFiles);
    const saveSessionAgentSelection = useSelectionStore((s) => s.saveSessionAgentSelection);
    const consumePendingInputText = useInputStore((s) => s.consumePendingInputText);
    const setPendingInputText = useInputStore((s) => s.setPendingInputText);
    const pendingInputText = useInputStore((s) => s.pendingInputText);
    const consumePendingSyntheticParts = useInputStore((s) => s.consumePendingSyntheticParts);
    const pendingSelectionContexts = useInputStore((s) => s.pendingSelectionContexts);
    const consumePendingSelectionContexts = useInputStore((s) => s.consumePendingSelectionContexts);
    const acknowledgeSessionAbort = useSessionUIStore((s) => s.acknowledgeSessionAbort);
    const abortCurrentOperation = React.useCallback(
        (sessionIdOverride?: string) => sessionActions.abortCurrentOperation(sessionIdOverride ?? currentSessionId ?? ''),
        [currentSessionId],
    );
    const projects = useProjectsStore((state) => state.projects);
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);

    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const currentVariant = useConfigStore((state) => state.currentVariant);
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const setAgent = useConfigStore((state) => state.setAgent);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const agents = getVisibleAgents();
    const primaryAgents = React.useMemo(() => agents.filter((agent) => isPrimaryMode(agent.mode)), [agents]);
    const isMobile = useUIStore((state) => state.isMobile);
    const isKeyboardOpen = useUIStore((state) => state.isKeyboardOpen);
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);
    const persistChatDraft = useUIStore((state) => state.persistChatDraft);
    const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const setExpandedInput = useUIStore((state) => state.setExpandedInput);
    const { git: runtimeGit } = useRuntimeAPIs();
    const { currentTheme } = useThemeSystem();
    const chatSearchDirectory = useChatSearchDirectory();
    const isGitRepo = useIsGitRepo(currentDirectory);
    const currentGitStatus = useGitStore((state) =>
        currentDirectory ? state.directories.get(currentDirectory)?.status ?? null : null,
    );
    const [showAbortStatus, setShowAbortStatus] = React.useState(false);
    
    const resolveCurrentDraftKey = React.useCallback(
        () => getDraftKey(newSessionDraftOpen ? null : currentSessionId),
        [currentSessionId, newSessionDraftOpen],
    );

    const getSelectionContextsForDraft = React.useCallback((draftKey: string) => {
        const existing = vscodeSelectionContextsByDraftRef.current.get(draftKey);
        if (existing) {
            return existing;
        }
        const next = new Map<string, VSCodeSelectionContext>();
        vscodeSelectionContextsByDraftRef.current.set(draftKey, next);
        return next;
    }, []);

    const isDesktopExpanded = isExpandedInput && !isMobile;
    const chatInputRadius = 'var(--radius-xl)';
    const composerInteractionDisabled = isCurrentSessionSubtask;

    const sendableAttachedFiles = attachedFiles;

    const knownAgentNames = React.useMemo(
        () => new Set(agents.map((agent) => agent.name.toLowerCase())),
        [agents]
    );
    const knownAgentNamesRef = React.useRef(knownAgentNames);
    knownAgentNamesRef.current = knownAgentNames;

    // Finds @mentions inside a plain text run; the composer renders them highlighted.
    const getMentionRanges = React.useCallback(
        (text: string): ComposerMentionRange[] => findMentionRanges(text, (name) => knownAgentNames.has(name), isConfirmedFilePath),
        [isConfirmedFilePath, knownAgentNames],
    );

    const sanitizeAttachmentsForSend = React.useCallback(
        (files: AttachedFile[] | undefined): AttachedFile[] => (files ?? [])
            .map((file) => ({
                ...file,
                dataUrl: file.source === 'server' && file.serverPath
                    ? toServerFileUrl(file.serverPath)
                    : file.dataUrl,
            })),
        [],
    );

    const extractInlineFileMentions = React.useCallback((rawText: string): { sanitizedText: string; attachments: AttachedFile[]; syntheticParts: Array<{ text: string; synthetic: true }> } => {
        if (!rawText || !rawText.includes('@')) {
            return { sanitizedText: rawText, attachments: [], syntheticParts: [] };
        }

        const clientDirectory = claudeHost.getDirectory() || '';
        const root = (chatSearchDirectory || clientDirectory).replace(/\\/g, '/').replace(/\/+$/, '');
        const seenMentions = new Set<string>();
        const seenSyntheticMentions = new Set<string>();
        const attachments: AttachedFile[] = [];
        const syntheticParts: Array<{ text: string; synthetic: true }> = [];
        const selectionContextMap = getSelectionContextsForDraft(resolveCurrentDraftKey());

        const mentionRegex = /@([^\s]+)/g;
        let match: RegExpExecArray | null;
        while ((match = mentionRegex.exec(rawText)) !== null) {
            const offset = match.index;
            const original = rawText;
            const charBefore = offset > 0 ? original[offset - 1] : null;
            if (charBefore && !/(\s|\(|\)|\[|\]|\{|\}|"|'|`|,|\.|;|:)/.test(charBefore)) {
                continue;
            }

            const parsedMention = parseInlineFileMention(match[1], offset);
            if (!parsedMention) {
                continue;
            }

            if (knownAgentNamesRef.current.has(parsedMention.filePath.toLowerCase())) {
                continue;
            }

            if (!isConfirmedFilePath(parsedMention.filePath)) {
                continue;
            }

            const normalizedMentionPath = parsedMention.filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
            if (!normalizedMentionPath) {
                continue;
            }

            const serverPath = parsedMention.filePath.startsWith('/')
                ? parsedMention.filePath.replace(/\\/g, '/')
                : root
                    ? `${root}/${normalizedMentionPath}`
                    : null;

            if (!serverPath) {
                continue;
            }

            const normalizedServerPath = serverPath.replace(/\/+/g, '/');
            if (seenMentions.has(parsedMention.mentionText)) {
                continue;
            }
            seenMentions.add(parsedMention.mentionText);

            const filename = normalizedMentionPath.split('/').filter(Boolean).pop() || normalizedMentionPath;
            attachments.push({
                id: `inline-server-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                file: new File([], filename, { type: 'text/plain' }),
                filename,
                mimeType: 'text/plain',
                size: 0,
                dataUrl: toServerFileUrl(normalizedServerPath),
                source: 'server',
                serverPath: normalizedServerPath,
                filePartSource: {
                    type: 'file',
                    path: normalizedServerPath,
                    text: parsedMention.sourceText,
                },
            });

            if (parsedMention.range && !seenSyntheticMentions.has(parsedMention.mentionText)) {
                const selectionContext = selectionContextMap.get(parsedMention.mentionText);
                if (selectionContext) {
                    syntheticParts.push({
                        text: buildSelectionSyntheticText(selectionContext),
                        synthetic: true,
                    });
                    seenSyntheticMentions.add(parsedMention.mentionText);
                }
            }
        }

        return {
            sanitizedText: rawText,
            attachments,
            syntheticParts,
        };
    }, [chatSearchDirectory, getSelectionContextsForDraft, isConfirmedFilePath, resolveCurrentDraftKey]);
    const [autocompleteOverlayPosition, setAutocompleteOverlayPosition] = React.useState<AutocompleteOverlayPosition | null>(null);
    const abortTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevWasAbortedRef = React.useRef(false);

    // Message queue
    const queueModeEnabled = useMessageQueueStore((state) => state.queueModeEnabled);
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!currentSessionId) return EMPTY_QUEUE;
                return state.queuedMessages[currentSessionId] ?? EMPTY_QUEUE;
            },
            [currentSessionId]
        )
    );
    const addToQueue = useMessageQueueStore((state) => state.addToQueue);
    const clearQueue = useMessageQueueStore((state) => state.clearQueue);

    // Inline comment drafts
    const draftCount = useInlineCommentDraftStore(
        React.useCallback(
            (state) => {
                const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');
                if (!sessionKey) return 0;
                return (state.drafts[sessionKey] ?? []).length;
            },
            [currentSessionId, newSessionDraftOpen]
        )
    );
    const consumeDrafts = useInlineCommentDraftStore((state) => state.consumeDrafts);
    const hasDrafts = draftCount > 0;

    // User message history for up/down arrow navigation.
    // Keep this on a narrow hook instead of full session message records.
    const userMessageHistory = useUserMessageHistory(currentSessionId ?? "");

    // Keep messageRef in sync with message state
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);

    // While browsing history the textarea shows a recalled message; the real draft is what must be persisted.
    const getDraftToPersist = React.useCallback(
        () => (historyIndexRef.current >= 0 ? draftMessageRef.current : messageRef.current),
        [],
    );

    React.useEffect(() => {
        currentSessionIdForDraftRef.current = currentSessionId;
    }, [currentSessionId]);

    const persistDraftImmediately = React.useCallback((sessionId: string | null, draft: string) => {
        const key = getDraftKey(sessionId);
        const lastPersisted = lastPersistedDraftRef.current.get(key);
        if (lastPersisted === draft) {
            return;
        }

        saveStoredDraft(sessionId, draft);
        // Only persist confirmed mentions that are actually present in the draft text
        const activeMentions = new Set<string>();
        for (const mention of confirmedMentionsRef.current) {
            if (draft.includes(`@${mention}`)) {
                activeMentions.add(mention);
            }
        }
        confirmedMentionsRef.current = activeMentions;
        saveConfirmedMentions(sessionId, activeMentions);
        lastPersistedDraftRef.current.set(key, draft);
    }, []);

    const clearPendingDraftPersist = React.useCallback(() => {
        if (!draftPersistTimerRef.current) {
            return;
        }
        clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
    }, []);

    // Handle initial draft restoration and text selection
    const hasHandledInitialDraftRef = React.useRef(false);
    React.useEffect(() => {
        if (hasHandledInitialDraftRef.current) return;
        hasHandledInitialDraftRef.current = true;

        const draft = initialDraftRef.current;
        if (!draft) return;

        if (!persistChatDraft) {
            // Setting disabled - clear the restored draft
            setMessage('');
            try {
                localStorage.removeItem(getDraftKey(initialSessionIdRef.current));
            } catch {
                // Ignore
            }
        } else {
            // Setting enabled - select all text
            requestAnimationFrame(() => {
                textareaRef.current?.select();
            });
        }
    }, [persistChatDraft]);

    // Handle session switching: save draft for old session, restore draft for new session
    const prevSessionIdRef = React.useRef(currentSessionId);
    React.useEffect(() => {
        if (prevSessionIdRef.current !== currentSessionId) {
            const oldSessionId = prevSessionIdRef.current;
            prevSessionIdRef.current = currentSessionId;
            clearPendingDraftPersist();
            skipNextDraftPersistRef.current = true;

            const leavingDraft = getDraftToPersist();
            // History browsing belongs to the session we are leaving
            setHistory(-1, '');

            if (persistChatDraft) {
                // Save current draft for the session we're leaving
                persistDraftImmediately(oldSessionId, leavingDraft);
                // Restore draft for the session we're entering
                const newDraft = getStoredDraft(currentSessionId);
                setMessage(newDraft);
                confirmedMentionsRef.current = loadConfirmedMentions(currentSessionId);
                if (newDraft) {
                    requestAnimationFrame(() => {
                        textareaRef.current?.select();
                    });
                }
            } else {
                // Persist disabled: clear input without saving
                setMessage('');
                confirmedMentionsRef.current = new Set();
            }
        }
    }, [clearPendingDraftPersist, currentSessionId, getDraftToPersist, persistChatDraft, persistDraftImmediately, setHistory]);

    // Focus textarea when new session draft is opened
    const prevNewSessionDraftOpenRef = React.useRef(newSessionDraftOpen);
    React.useEffect(() => {
        if (!prevNewSessionDraftOpenRef.current && newSessionDraftOpen) {
            // New session draft just opened - focus the textarea
            requestAnimationFrame(() => {
                if (isMobile) {
                    // On mobile, use preventScroll to avoid viewport jumping
                    textareaRef.current?.focus({ preventScroll: true });
                } else {
                    textareaRef.current?.focus();
                }
            });
        }
        prevNewSessionDraftOpenRef.current = newSessionDraftOpen;
    }, [newSessionDraftOpen, isMobile]);

    // Persist chat input draft to localStorage per session (only if setting enabled)
    React.useEffect(() => {
        if (!persistChatDraft) {
            clearPendingDraftPersist();
            persistDraftImmediately(currentSessionId, '');
            return;
        }

        if (skipNextDraftPersistRef.current) {
            skipNextDraftPersistRef.current = false;
            return;
        }

        clearPendingDraftPersist();
        const draftSnapshot = historyIndex >= 0 ? draftMessage : message;
        const sessionSnapshot = currentSessionId;
        draftPersistTimerRef.current = setTimeout(() => {
            draftPersistTimerRef.current = null;
            persistDraftImmediately(sessionSnapshot, draftSnapshot);
        }, CHAT_DRAFT_PERSIST_DEBOUNCE_MS);

        return () => {
            clearPendingDraftPersist();
        };
    }, [clearPendingDraftPersist, currentSessionId, draftMessage, historyIndex, message, persistChatDraft, persistDraftImmediately]);

    React.useEffect(() => {
        return () => {
            clearPendingDraftPersist();
            if (persistChatDraft) {
                persistDraftImmediately(currentSessionIdForDraftRef.current, getDraftToPersist());
            }
        };
    }, [clearPendingDraftPersist, getDraftToPersist, persistChatDraft, persistDraftImmediately]);

    // Session activity for queue availability and controls
    const { phase: sessionPhase } = useCurrentSessionActivity();

    const handleOpenMobileControls = React.useCallback(() => {
        if (!isMobile) {
            return;
        }

        if (mobileControlsOpen) {
            setMobileControlsOpen(false);
            return;
        }

        setMobileControlsPanel(null);

        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }

        setMobileControlsOpen(true);
    }, [isMobile, mobileControlsOpen]);

    const handleCloseMobileControls = React.useCallback(() => {
        setMobileControlsOpen(false);
    }, []);

    const handleOpenMobilePanel = React.useCallback((panel: MobileControlsPanel) => {
        if (!isMobile) {
            return;
        }
        setMobileControlsOpen(false);
        textareaRef.current?.blur();
        requestAnimationFrame(() => {
            setMobileControlsPanel(panel);
        });
    }, [isMobile]);

    const handleReturnToUnifiedControls = React.useCallback(() => {
        if (!isMobile) {
            return;
        }
        setMobileControlsPanel(null);
        requestAnimationFrame(() => {
            setMobileControlsOpen(true);
        });
    }, [isMobile]);

    // Consume pending input text (e.g., from revert action)
    React.useEffect(() => {
        if (pendingInputText !== null) {
            const pending = consumePendingInputText();
            if (pending?.text) {
                let inlineCursorPosition: number | null = null;
                if (pending.mode === 'append') {
                    setMessage((prev) => {
                        const next = pending.text;
                        if (!next.trim()) return prev;
                        return appendWithLineBreaks(prev, next);
                    });
                } else if (pending.mode === 'append-inline') {
                    const textarea = textareaRef.current;
                    if (textarea) {
                        const start = textarea.selectionStart ?? messageRef.current.length;
                        const end = textarea.selectionEnd ?? start;
                        setMessage((prev) => {
                            const before = prev.substring(0, start);
                            const after = prev.substring(end);
                            const nextValue = appendInlineText(before, pending.text);
                            inlineCursorPosition = nextValue.length;
                            return `${nextValue}${after}`;
                        });
                    } else {
                        setMessage((prev) => appendInlineText(prev, pending.text));
                    }
                } else {
                    setMessage(pending.text);
                }
                // Focus textarea after setting message
                setTimeout(() => {
                    const textarea = textareaRef.current;
                    textarea?.focus();
                    if (textarea && inlineCursorPosition !== null) {
                        textarea.selectionStart = inlineCursorPosition;
                        textarea.selectionEnd = inlineCursorPosition;
                        cursorPosRef.current = inlineCursorPosition;
                    }
                }, 0);
            }
        }
    }, [pendingInputText, consumePendingInputText]);

    React.useEffect(() => {
        if (pendingSelectionContexts === null) {
            return;
        }

        const incoming = consumePendingSelectionContexts();
        if (!incoming || incoming.length === 0) {
            return;
        }

        const contextMap = getSelectionContextsForDraft(resolveCurrentDraftKey());
        incoming.forEach((context) => {
            if (!context.mentionText) {
                return;
            }
            contextMap.set(context.mentionText, context);
        });
    }, [consumePendingSelectionContexts, getSelectionContextsForDraft, pendingSelectionContexts, resolveCurrentDraftKey]);

    React.useEffect(() => {
        const contextMap = getSelectionContextsForDraft(resolveCurrentDraftKey());
        const activeTexts = [message, ...queuedMessages.map((queued) => queued.content)];
        for (const mentionText of Array.from(contextMap.keys())) {
            if (!activeTexts.some((text) => text.includes(mentionText))) {
                contextMap.delete(mentionText);
            }
        }
    }, [getSelectionContextsForDraft, message, queuedMessages, resolveCurrentDraftKey]);

    const hasContent = message.trim().length > 0 || sendableAttachedFiles.length > 0 || hasDrafts;
    const hasQueuedMessages = queuedMessages.length > 0;
    const canSend = !composerInteractionDisabled && (hasContent || hasQueuedMessages);

    const canAbort = !composerInteractionDisabled && sessionPhase !== 'idle';

    // Keep a ref to handleSubmit so callbacks don't depend on it.
    type SubmitOptions = {
        queuedOnly?: boolean;
    };
    const handleSubmitRef = React.useRef<(options?: SubmitOptions) => Promise<void>>(async () => {});

    // Add message to queue instead of sending
    const handleQueueMessage = React.useCallback(() => {
        if (composerInteractionDisabled || !hasContent || !currentSessionId) return;

        const drafts = consumeDrafts(currentSessionId);

        let messageToQueue = message.replace(/^\n+|\n+$/g, '');
        if (drafts.length > 0) {
            messageToQueue = appendInlineComments(messageToQueue, drafts);
        }
        const attachmentsToQueue = sanitizeAttachmentsForSend(sendableAttachedFiles);

        addToQueue(currentSessionId, {
            content: messageToQueue,
            attachments: attachmentsToQueue.length > 0 ? attachmentsToQueue : undefined,
            sendConfig: currentProviderId && currentModelId ? {
                providerID: currentProviderId,
                modelID: currentModelId,
                agent: currentAgentName ?? undefined,
                variant: currentVariant ?? undefined,
            } : undefined,
        });

        // Clear input and attachments
        // Note: confirmedMentionsRef is NOT cleared here because queued messages
        // are processed later in handleSubmit which reads the ref via extractInlineFileMentions.
        // The ref is cleared in handleSubmit after all queued messages are sent.
        setMessage('');
        if (attachmentsToQueue.length > 0) {
            clearAttachedFiles();
        }

        if (!isMobile) {
            textareaRef.current?.focus();
        }
    }, [composerInteractionDisabled, hasContent, currentSessionId, message, sendableAttachedFiles, sanitizeAttachmentsForSend, addToQueue, clearAttachedFiles, isMobile, consumeDrafts, currentProviderId, currentModelId, currentAgentName, currentVariant]);

    const handleQueuedMessageEdit = React.useCallback((content: string) => {
        setMessage(content);
        setTimeout(() => {
            textareaRef.current?.focus();
        }, 0);
    }, []);

    const handleOpenAgentPanel = React.useCallback(() => {
        setMobileControlsPanel('agent');
    }, []);

    const handleToggleExpandedInput = React.useCallback(() => {
        setExpandedInput(!isExpandedInput);
    }, [isExpandedInput, setExpandedInput]);

    const handleSubmit = async (options?: SubmitOptions) => {
        const queuedOnly = options?.queuedOnly ?? false;

        if (composerInteractionDisabled) {
            return;
        }

        if (queuedOnly) {
            if (!hasQueuedMessages || !currentSessionId) return;
        } else if (!canSend || (!currentSessionId && !newSessionDraftOpen)) {
            return;
        }

        if (!currentProviderId || !currentModelId) {
            console.warn('Cannot send message: provider or model not selected');
            return;
        }

        // Build the primary message (first part) and additional parts
        let primaryText = '';
        let primaryAttachments: AttachedFile[] = [];
        let agentMentionName: string | undefined;
        const additionalParts: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }> = [];

        // Consume any pending synthetic parts (from conflict resolution, etc.)
        const syntheticParts = consumePendingSyntheticParts();

        // Process queued messages first
        for (let i = 0; i < queuedMessages.length; i++) {
            const queuedMsg = queuedMessages[i];
            const { sanitizedText, mention } = parseAgentMentions(queuedMsg.content, agents);
            const {
                sanitizedText: queuedText,
                attachments: mentionAttachments,
                syntheticParts: mentionSyntheticParts,
            } = extractInlineFileMentions(sanitizedText);

            // Use agent mention from first message that has one
            if (!agentMentionName && mention?.name) {
                agentMentionName = mention.name;
            }

            if (i === 0) {
                // First queued message becomes primary
                primaryText = queuedText;
                primaryAttachments = [
                    ...sanitizeAttachmentsForSend(queuedMsg.attachments),
                    ...mentionAttachments,
                ];
            } else {
                // Subsequent queued messages become additional parts
                const queuedAttachments = sanitizeAttachmentsForSend(queuedMsg.attachments);
                additionalParts.push({
                    text: queuedText,
                    attachments: [...queuedAttachments, ...mentionAttachments],
                });
            }

            mentionSyntheticParts.forEach((part) => {
                additionalParts.push(part);
            });
        }

        // Add current input (skip for queued-only auto-send)
        if (!queuedOnly && hasContent) {
            const messageToSend = message.replace(/^\n+|\n+$/g, '');
            const { sanitizedText, mention } = parseAgentMentions(messageToSend, agents);
            const {
                sanitizedText: messageText,
                attachments: mentionAttachments,
                syntheticParts: mentionSyntheticParts,
            } = extractInlineFileMentions(sanitizedText);
            const attachmentsToSend = sanitizeAttachmentsForSend(sendableAttachedFiles);

            if (!agentMentionName && mention?.name) {
                agentMentionName = mention.name;
            }

            if (queuedMessages.length === 0) {
                // No queue - current input is primary
                primaryText = messageText;
                primaryAttachments = [...attachmentsToSend, ...mentionAttachments];
            } else {
                // Has queue - current input is additional part
                additionalParts.push({
                    text: messageText,
                    attachments: [...attachmentsToSend, ...mentionAttachments],
                });
            }

            mentionSyntheticParts.forEach((part) => {
                additionalParts.push(part);
            });
        }

        const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
        let drafts: InlineCommentDraft[] = [];
        if (!queuedOnly && sessionKey) {
            drafts = consumeDrafts(sessionKey);
        }

        if (drafts.length > 0) {
            if (queuedMessages.length === 0) {
                primaryText = appendInlineComments(primaryText, drafts);
            } else if (additionalParts.length > 0) {
                const lastPart = additionalParts[additionalParts.length - 1];
                lastPart.text = appendInlineComments(lastPart.text, drafts);
            } else {
                primaryText = appendInlineComments(primaryText, drafts);
            }
        }

        // Add synthetic parts (from conflict resolution, etc.)
        if (syntheticParts && syntheticParts.length > 0) {
            for (const part of syntheticParts) {
                additionalParts.push({
                    text: part.text,
                    synthetic: true,
                });
            }
        }

        if (!primaryText && additionalParts.length === 0) return;

        // Clear queue and input
        if (currentSessionId && hasQueuedMessages) {
            clearQueue(currentSessionId);
        }
        if (!queuedOnly) {
            vscodeSelectionContextsByDraftRef.current.delete(resolveCurrentDraftKey());
            setMessage('');
            confirmedMentionsRef.current.clear();
            // Clear per-session draft on submit
            saveStoredDraft(currentSessionId, '');
            saveConfirmedMentions(currentSessionId, confirmedMentionsRef.current);
            // Reset message history navigation state
            setHistory(-1, '');
            if (attachedFiles.length > 0) {
                clearAttachedFiles();
            }
            // Close expanded input overlay when submitting
            setExpandedInput(false);
        }

        if (isMobile) {
            textareaRef.current?.blur();
        }

        // Handle local slash commands
        const normalizedCommand = primaryText.trimStart();
        if (normalizedCommand.startsWith('/')) {
            const commandName = normalizedCommand
                .slice(1)
                .trim()
                .split(/\s+/)[0]
                ?.toLowerCase();

            // `/clear` is client-side: it starts a fresh session (Claude has no in-place clear).
            if (commandName === 'clear') {
                useSessionUIStore.getState().openNewSessionDraft();
                return;
            }
            // `/undo` and `/redo` step the revert marker (no confirmation); the composer is refilled by revertToMessage.
            else if ((commandName === 'undo' || commandName === 'redo') && currentSessionId) {
                try {
                    const store = useSessionUIStore.getState();
                    await (commandName === 'undo' ? store.handleSlashUndo(currentSessionId) : store.handleSlashRedo(currentSessionId));
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.revertDialog.toast.failed'));
                }
                scrollToBottom?.({ instant: true, force: true });
                return;
            }
            else if (commandName === 'compact' && currentSessionId) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const { sendPrompt } = await import('@/lib/claude/send');
                    const configState = useConfigStore.getState();
                    await sendPrompt({
                        sessionId: currentSessionId,
                        text: '',
                        command: { name: 'compact', args: '' },
                        modelID: configState.currentModelId || undefined,
                    });
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.compactFailed'));
                }
                return;
            }
        }

        // Collect all attachments for error recovery
        const allAttachments = [
            ...primaryAttachments,
            ...additionalParts.flatMap(p => p.attachments ?? []),
        ];

        const sendPromise = sendMessage(
            primaryText,
            currentProviderId,
            currentModelId,
            currentAgentName,
            primaryAttachments,
            agentMentionName,
            additionalParts.length > 0 ? additionalParts : undefined,
            currentVariant
        );

        if (typeof window === 'undefined') {
            scrollToBottom?.({ instant: true, force: true });
        } else {
            window.requestAnimationFrame(() => {
                scrollToBottom?.({ instant: true, force: true });
            });
        }

        void sendPromise.catch((error: unknown) => {
            const rawMessage =
                error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                        ? error
                        : String(error ?? '');
            const normalized = rawMessage.toLowerCase();

            console.error('Message send failed:', rawMessage || error);

            const isSoftNetworkError =
                normalized.includes('timeout') ||
                normalized.includes('timed out') ||
                normalized.includes('may still be processing') ||
                normalized.includes('being processed') ||
                normalized.includes('failed to fetch') ||
                normalized.includes('networkerror') ||
                normalized.includes('network error') ||
                normalized.includes('gateway timeout') ||
                normalized === 'failed to send message';

            if (normalized.includes('payload too large') || normalized.includes('413') || normalized.includes('entity too large')) {
                toast.error(t('chat.chatInput.toast.attachmentsTooLarge'));
                if (allAttachments.length > 0) {
                    useInputStore.setState({ attachedFiles: allAttachments });
                }
                return;
            }

            if (isSoftNetworkError) {
                if (allAttachments.length > 0) {
                    useInputStore.setState({ attachedFiles: allAttachments });
                    toast.error(t('chat.chatInput.toast.sendAttachmentsFailed'));
                }
                return;
            }

            if (allAttachments.length > 0) {
                useInputStore.setState({ attachedFiles: allAttachments });
            }
            toast.error(rawMessage || t('chat.chatInput.toast.messageSendFailed'));
        });

        if (!isMobile) {
            textareaRef.current?.focus();
        }
    };

    // Update ref with latest handleSubmit on every render
    handleSubmitRef.current = handleSubmit;

    // Primary action for send button - respects queue mode setting
    // Enter sends; Cmd/Ctrl+Enter (`alternate`) is the other action. Queue mode swaps the two.
    // Queueing only works with an existing, busy session; everything else sends immediately.
    const sendOrQueue = React.useCallback((alternate: boolean) => {
        const canQueue = !composerInteractionDisabled && hasContent && currentSessionId && sessionPhase !== 'idle';
        const queue = queueModeEnabled ? !alternate : alternate;
        if (queue && canQueue) {
            handleQueueMessage();
        } else {
            void handleSubmitRef.current();
        }
    }, [composerInteractionDisabled, hasContent, currentSessionId, sessionPhase, queueModeEnabled, handleQueueMessage]);

    const handlePrimaryAction = React.useCallback(() => sendOrQueue(false), [sendOrQueue]);

    const handleKeyDown = (e: ComposerKeyEvent) => {
        // Early return during IME composition to prevent interference with autocomplete.
        // Uses keyCode === 229 fallback for WebKit where compositionend fires before keydown.
        if (isIMECompositionEvent(e)) return;

        if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const textarea = textareaRef.current;
            const selectionStart = textarea?.selectionStart ?? message.length;
            const selectionEnd = textarea?.selectionEnd ?? message.length;
            const hasCollapsedSelection = selectionStart === selectionEnd;

            if (hasCollapsedSelection) {
                const probeIndex = e.key === 'Backspace' ? selectionStart - 1 : selectionStart;
                if (probeIndex >= 0 && probeIndex < message.length) {
                    let tokenStart = probeIndex;
                    while (tokenStart > 0 && !/\s/.test(message[tokenStart - 1])) {
                        tokenStart -= 1;
                    }

                    let tokenEnd = probeIndex + 1;
                    while (tokenEnd < message.length && !/\s/.test(message[tokenEnd])) {
                        tokenEnd += 1;
                    }

                    const token = message.slice(tokenStart, tokenEnd);
                    const mentionContent = token.slice(1);
                    const looksLikeFileMention = FILE_MENTION_TOKEN.test(token)
                        && !knownAgentNamesRef.current.has(mentionContent.toLowerCase())
                        && isConfirmedFilePath(mentionContent);

                    if (looksLikeFileMention) {
                        confirmedMentionsRef.current.delete(mentionContent);
                        const removeUntil = message[tokenEnd] === ' ' ? tokenEnd + 1 : tokenEnd;
                        const nextMessage = `${message.slice(0, tokenStart)}${message.slice(removeUntil)}`;
                        e.preventDefault();
                        setMessage(nextMessage);
                        requestAnimationFrame(() => {
                            if (textareaRef.current) {
                                textareaRef.current.selectionStart = tokenStart;
                                textareaRef.current.selectionEnd = tokenStart;
                            }
                            adjustTextareaHeight();
                        });
                        updateAutocompleteState(nextMessage, tokenStart);
                        return;
                    }
                }
            }
        }

        if (showCommandAutocomplete && commandRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                // A popup without results does not consume the key (Enter then sends, arrows move the caret).
                if (commandRef.current.handleKeyDown(e.key)) {
                    e.preventDefault();
                    requestAnimationFrame(syncPopupActiveOption);
                    return;
                }
            }
        }

        if (showSkillAutocomplete && skillRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                // A popup without results does not consume the key (Enter then sends, arrows move the caret).
                if (skillRef.current.handleKeyDown(e.key)) {
                    e.preventDefault();
                    requestAnimationFrame(syncPopupActiveOption);
                    return;
                }
            }
        }

        if (showFileMention && mentionRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                // A popup without results does not consume the key (Enter then sends, arrows move the caret).
                if (mentionRef.current.handleKeyDown(e.key)) {
                    e.preventDefault();
                    requestAnimationFrame(syncPopupActiveOption);
                    return;
                }
            }
        }

        if (isDesktopExpanded && e.key === 'Escape') {
            e.preventDefault();
            setExpandedInput(false);
            return;
        }

        if (
            isVSCodeRuntime()
            && e.key === 'Tab'
            && e.shiftKey
            && !e.altKey
            && !e.metaKey
            && !e.ctrlKey
            && !showCommandAutocomplete
            && !showFileMention
            && !showSkillAutocomplete
        ) {
            e.preventDefault();
            handleCycleAgent();
            return;
        }

        if (!isVSCodeRuntime() && e.key === 'Tab' && !showCommandAutocomplete && !showFileMention) {
            e.preventDefault();
            handleCycleAgent();
            return;
        }

        // Handle ArrowUp/ArrowDown for message history navigation
        // ArrowUp: only when cursor at start (position 0) or input is empty
        // ArrowDown: also works when cursor at end (to cycle forward through history)
        const isAnyAutocompleteOpen = showCommandAutocomplete || showSkillAutocomplete || showFileMention;
        // History keys only apply at the very start/end of the document, never inside a code block.
        const composer = textareaRef.current;
        const insideCodeBlock = composer?.isInCodeBlock() ?? false;
        const cursorAtStart = !insideCodeBlock && (composer?.isAtStart() ?? false);
        const cursorAtEnd = !insideCodeBlock && (composer?.isAtEnd() ?? false);
        const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
        const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

        if (e.key === 'ArrowUp' && canNavigateHistoryUp && userMessageHistory.length > 0) {
            e.preventDefault();
            if (historyIndex === -1) {
                // Entering history mode - save current input as draft
                setHistory(0, message);
                setMessage(userMessageHistory[0]);
            } else if (historyIndex < userMessageHistory.length - 1) {
                // Navigate to older message
                const newIndex = historyIndex + 1;
                setHistory(newIndex, draftMessage);
                setMessage(userMessageHistory[newIndex]);
            }
            // Move cursor to start after history navigation
            requestAnimationFrame(() => {
                textareaRef.current?.setSelectionRange(0, 0);
            });
            // If at oldest message, do nothing
            return;
        }

        if (e.key === 'ArrowDown' && canNavigateHistoryDown && historyIndex >= 0) {
            e.preventDefault();
            if (historyIndex === 0) {
                // Exit history mode - restore draft
                setHistory(-1, '');
                setMessage(draftMessage);
            } else {
                // Navigate to newer message
                const newIndex = historyIndex - 1;
                setHistory(newIndex, draftMessage);
                setMessage(userMessageHistory[newIndex]);
            }
            return;
        }

        // Handle Enter/Ctrl+Enter based on queue mode
        if (e.key === 'Enter' && !e.shiftKey && (!isMobile || e.ctrlKey || e.metaKey)) {
            e.preventDefault();

            // Queue mode: Enter queues, Ctrl+Enter sends. Normal mode: Enter sends, Ctrl+Enter queues.
            sendOrQueue(e.ctrlKey || e.metaKey);
        }
    };

    // The editor emits native keydown events; adapt them to the key pipeline above.
    // Returns true when the pipeline handled the key (it called preventDefault).
    const handleComposerKeyDown = (event: KeyboardEvent): boolean => {
        handleKeyDown({
            key: event.key,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            preventDefault: () => event.preventDefault(),
            nativeEvent: event,
        });
        return event.defaultPrevented;
    };

    const updateAutocompleteOverlayPosition = React.useCallback(() => {
        if (!isDesktopExpanded) {
            setAutocompleteOverlayPosition(null);
            return;
        }

        if (!showCommandAutocomplete && !showSkillAutocomplete && !showFileMention) {
            setAutocompleteOverlayPosition(null);
            return;
        }

        const textarea = textareaRef.current;
        const container = dropZoneRef.current;
        if (!textarea || !container) return;

        const cursor = textarea.selectionStart;
        const caret = textarea.getCaretCoords(cursor);
        if (!caret) return;

        const containerRect = container.getBoundingClientRect();

        // Caret coordinates are viewport-relative, so scroll offsets are already accounted for.
        const caretY = caret.top - containerRect.top;
        const caretX = caret.left - containerRect.left;

        const popupMargin = 8;
        const estimatedPopupHeight = 260;
        const spaceAbove = caretY - popupMargin;
        const spaceBelow = containerRect.height - caretY - popupMargin;
        const place: 'above' | 'below' = spaceBelow >= estimatedPopupHeight || spaceBelow >= spaceAbove ? 'below' : 'above';

        const desiredWidth = showFileMention ? 520 : showCommandAutocomplete ? 450 : 360;
        const clampedLeft = Math.max(
            popupMargin,
            Math.min(caretX - 24, containerRect.width - desiredWidth - popupMargin)
        );

        const maxHeight = Math.max(120, Math.min(estimatedPopupHeight, place === 'below' ? spaceBelow : spaceAbove));

        setAutocompleteOverlayPosition({
            top: place === 'below' ? caretY + 22 : caretY - 6,
            left: clampedLeft,
            place,
            maxHeight,
        });
    }, [
        isDesktopExpanded,
        showCommandAutocomplete,
        showFileMention,
        showSkillAutocomplete,
    ]);

    const handleComposerSelectionChange = () => {
        cursorPosRef.current = textareaRef.current?.selectionStart ?? 0;
        updateAutocompleteOverlayPosition();
    };

    React.useLayoutEffect(() => {
        updateAutocompleteOverlayPosition();
    }, [
        updateAutocompleteOverlayPosition,
        message,
        showCommandAutocomplete,
        showSkillAutocomplete,
        showFileMention,
        isDesktopExpanded,
    ]);

    React.useEffect(() => {
        if (!isDesktopExpanded) return;
        const onResize = () => updateAutocompleteOverlayPosition();
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, [isDesktopExpanded, updateAutocompleteOverlayPosition]);

    const startAbortIndicator = React.useCallback(() => {
        if (abortTimeoutRef.current) {
            clearTimeout(abortTimeoutRef.current);
            abortTimeoutRef.current = null;
        }

        setShowAbortStatus(true);

        abortTimeoutRef.current = setTimeout(() => {
            setShowAbortStatus(false);
            abortTimeoutRef.current = null;
        }, 1800);
    }, []);

    const handleAbort = React.useCallback(() => {
        clearAbortPrompt();
        startAbortIndicator();

        void abortCurrentOperation(currentSessionId || undefined);
    }, [abortCurrentOperation, clearAbortPrompt, currentSessionId, startAbortIndicator]);

    const handleCycleAgent = React.useCallback(() => {
        if (primaryAgents.length <= 1) return;

        const currentIndex = primaryAgents.findIndex(agent => agent.name === currentAgentName);
        const nextIndex = (currentIndex + 1) % primaryAgents.length;
        const nextAgent = primaryAgents[nextIndex];

        setAgent(nextAgent.name);

        if (currentSessionId) {
            saveSessionAgentSelection(currentSessionId, nextAgent.name);
        }
    }, [primaryAgents, currentAgentName, currentSessionId, setAgent, saveSessionAgentSelection]);

    React.useEffect(() => {
        const handleCyclePrimaryAgentEvent = () => {
            if (composerInteractionDisabled) {
                return;
            }
            handleCycleAgent();
        };

        window.addEventListener('openchamber:cycle-primary-agent', handleCyclePrimaryAgentEvent);
        return () => {
            window.removeEventListener('openchamber:cycle-primary-agent', handleCyclePrimaryAgentEvent);
        };
    }, [composerInteractionDisabled, handleCycleAgent]);

    // The composer grows with its content; only the max height (N lines + padding) is computed here.
    const adjustTextareaHeight = React.useCallback(() => {
        const root = textareaRef.current?.getRootElement();
        if (!root) {
            return;
        }

        if (isDesktopExpanded) {
            setComposerMaxHeight(null);
            return;
        }

        const view = root.ownerDocument?.defaultView;
        const computedStyle = view ? view.getComputedStyle(root) : null;
        const lineHeight = computedStyle ? parseFloat(computedStyle.lineHeight) : NaN;
        const paddingTop = computedStyle ? parseFloat(computedStyle.paddingTop) : NaN;
        const paddingBottom = computedStyle ? parseFloat(computedStyle.paddingBottom) : NaN;
        const fallbackLineHeight = 22;
        const fallbackPadding = 16;
        const paddingTotal = Number.isNaN(paddingTop) || Number.isNaN(paddingBottom)
            ? fallbackPadding
            : paddingTop + paddingBottom;
        const targetLineHeight = Number.isNaN(lineHeight) ? fallbackLineHeight : lineHeight;
        const maxHeight = targetLineHeight * MAX_VISIBLE_TEXTAREA_LINES + paddingTotal;

        setComposerMaxHeight((prev) => (prev === maxHeight ? prev : maxHeight));
    }, [isDesktopExpanded]);

    React.useLayoutEffect(() => {
        adjustTextareaHeight();
    }, [adjustTextareaHeight, message, isMobile]);

    const updateAutocompleteState = React.useCallback((value: string, cursorPosition: number) => {
        if (value.startsWith('/')) {
            const firstSpace = value.indexOf(' ');
            const firstNewline = value.indexOf('\n');
            const commandEnd = Math.min(
                firstSpace === -1 ? value.length : firstSpace,
                firstNewline === -1 ? value.length : firstNewline
            );

            if (cursorPosition <= commandEnd && firstSpace === -1) {
                const commandText = value.substring(1, commandEnd);
                setCommandQuery(commandText);
                setAutocompleteTab('commands');
                setShowCommandAutocomplete(true);
                setShowFileMention(false);
                setShowSkillAutocomplete(false);
                return;
            }
        }

        setShowCommandAutocomplete(false);

        const textBeforeCursor = value.substring(0, cursorPosition);

        const lastSlashSymbol = textBeforeCursor.lastIndexOf('/');
        if (lastSlashSymbol !== -1) {
            const charBefore = lastSlashSymbol > 0 ? textBeforeCursor[lastSlashSymbol - 1] : null;
            const textAfterSlash = textBeforeCursor.substring(lastSlashSymbol + 1);
            const hasSeparator = textAfterSlash.includes(' ') || textAfterSlash.includes('\n');
            const isWordBoundary = !charBefore || /\s/.test(charBefore);

            if (isWordBoundary && !hasSeparator) {
                setSkillQuery(textAfterSlash);
                setShowSkillAutocomplete(true);
                setShowFileMention(false);
                return;
            }
        }

        setShowSkillAutocomplete(false);
        setSkillQuery('');

        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
        if (lastAtSymbol !== -1) {
            const charBefore = lastAtSymbol > 0 ? textBeforeCursor[lastAtSymbol - 1] : null;
            const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);
            const isWordBoundary = !charBefore || /\s/.test(charBefore);
            if (isWordBoundary && !textAfterAt.includes(' ') && !textAfterAt.includes('\n')) {
                setMentionQuery(textAfterAt);
                setAutocompleteTab((current) => current === 'files' ? 'files' : 'agents');
                setShowFileMention(true);
            } else {
                setShowFileMention(false);
            }
        } else {
            setShowFileMention(false);
        }
    }, [setAutocompleteTab, setCommandQuery, setMentionQuery, setShowCommandAutocomplete, setShowFileMention, setShowSkillAutocomplete, setSkillQuery]);

    const applyAutocompletePrefix = React.useCallback((prefix: '/' | '@') => {
        const nextMessage = message.length === 0
            ? prefix
            : (message[0] === '/' || message[0] === '@')
                ? `${prefix}${message.slice(1)}`
                : `${prefix}${message}`;
        setMessage(nextMessage);
        requestAnimationFrame(() => {
            if (textareaRef.current) {
                const nextCursor = Math.min(nextMessage.length, textareaRef.current.value.length);
                textareaRef.current.selectionStart = nextCursor;
                textareaRef.current.selectionEnd = nextCursor;
            }
            adjustTextareaHeight();
            updateAutocompleteState(nextMessage, nextMessage.length);
        });
    }, [adjustTextareaHeight, message, setMessage, updateAutocompleteState]);

    const handleAutocompleteTabSelect = React.useCallback((tab: 'commands' | 'agents' | 'files') => {
        const textarea = textareaRef.current;
        if (isMobile && textarea) {
            try {
                textarea.focus({ preventScroll: true });
            } catch {
                textarea.focus();
            }
            const len = textarea.value.length;
            try {
                textarea.setSelectionRange(len, len);
            } catch {
                // ignored
            }
        }
        const cursorPosition = textarea?.selectionStart ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
        const nextMentionQuery = lastAtSymbol !== -1
            ? textBeforeCursor.substring(lastAtSymbol + 1).replace(/[\s\n].*$/, '')
            : '';

        setAutocompleteTab(tab);
        setCommandQuery('');
        if (tab === 'commands') {
            setMentionQuery('');
            applyAutocompletePrefix('/');
        }
        if (tab === 'agents') {
            setMentionQuery(nextMentionQuery);
            applyAutocompletePrefix('@');
        }
        if (tab === 'files') {
            setMentionQuery(nextMentionQuery);
            applyAutocompletePrefix('@');
        }
        setShowSkillAutocomplete(false);
        setShowCommandAutocomplete(tab === 'commands');
        setShowFileMention(tab === 'agents' || tab === 'files');
    }, [applyAutocompletePrefix, isMobile, message, setAutocompleteTab, setCommandQuery, setMentionQuery, setShowCommandAutocomplete, setShowFileMention, setShowSkillAutocomplete]);

    const handleOpenCommandMenu = React.useCallback(() => {
        if (!isMobile) {
            return;
        }
        const textarea = textareaRef.current;
        if (textarea) {
            try {
                textarea.focus({ preventScroll: true });
            } catch {
                textarea.focus();
            }
            const len = textarea.value.length;
            try {
                textarea.setSelectionRange(len, len);
            } catch {
                // ignored
            }
        }
        applyAutocompletePrefix('/');
        setCommandQuery('');
        setAutocompleteTab('commands');
        setShowCommandAutocomplete(true);
        setShowFileMention(false);
        setShowSkillAutocomplete(false);
    }, [applyAutocompletePrefix, isMobile, setAutocompleteTab, setCommandQuery, setShowCommandAutocomplete, setShowFileMention, setShowSkillAutocomplete]);

    const clearDropTextSuppression = React.useCallback(() => {
        suppressNextFileDropTextInsertRef.current = false;
        pendingDroppedAbsolutePathsRef.current = [];
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
            suppressNextFileDropTextInsertTimeoutRef.current = null;
        }
    }, []);

    const scheduleDropTextSuppressionExpiry = React.useCallback(() => {
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
        }
        suppressNextFileDropTextInsertTimeoutRef.current = setTimeout(() => {
            clearDropTextSuppression();
        }, 700);
    }, [clearDropTextSuppression]);

    const handleBeforeInput = React.useCallback((e: React.FormEvent<HTMLElement>) => {
        if (!isVSCodeRuntime() || !suppressNextFileDropTextInsertRef.current) {
            return;
        }

        const nativeInputEvent = e.nativeEvent as InputEvent | undefined;
        if (nativeInputEvent?.inputType === 'insertFromDrop') {
            e.preventDefault();
            clearDropTextSuppression();
        }
    }, [clearDropTextSuppression]);

    const handleTextChange = (value: string) => {
        if (isVSCodeRuntime() && suppressNextFileDropTextInsertRef.current) {
            const candidateAbsolutePaths = pendingDroppedAbsolutePathsRef.current;
            const isLikelyDropTextInsertion = candidateAbsolutePaths.some((path) => path.length > 0 && value.includes(path));

            if (isLikelyDropTextInsertion) {
                clearDropTextSuppression();
                // Revert the editor to the last known message (a textarea would do this via controlled value).
                textareaRef.current?.setValue(messageRef.current);
                return;
            }
        }

        const cursorPosition = textareaRef.current?.selectionStart ?? value.length;

        setMessage(value);
        adjustTextareaHeight();
        updateAutocompleteState(value, cursorPosition);
    };

    React.useEffect(() => {
        return () => {
            clearDropTextSuppression();
        };
    }, [clearDropTextSuppression]);

    const handlePaste = React.useCallback(async (e: React.ClipboardEvent<HTMLElement>) => {
        const fileMap = new Map<string, File>();

        Array.from(e.clipboardData.files || []).forEach(file => {
            if (file.type.startsWith('image/')) {
                fileMap.set(`${file.name}-${file.size}`, file);
            }
        });

        Array.from(e.clipboardData.items || []).forEach(item => {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    fileMap.set(`${file.name}-${file.size}`, file);
                }
            }
        });

        const imageFiles = Array.from(fileMap.values());
        if (imageFiles.length === 0) {
            return;
        }

        if (!currentSessionId && !newSessionDraftOpen) {
            return;
        }

        e.preventDefault();

        for (const file of imageFiles) {
            try {
                await addAttachedFile(file);
            } catch (error) {
                console.error('Clipboard image attach failed', error);
                toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.clipboardAttachFailed'));
            }
        }
    }, [addAttachedFile, currentSessionId, newSessionDraftOpen, t]);

    const handleFileSelect = (file: { name: string; path: string; relativePath?: string }) => {

        const cursorPosition = textareaRef.current?.selectionStart || 0;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
            ? file.relativePath.trim()
            : (toProjectRelativeMentionPath(file.path) || file.name);

        confirmedMentionsRef.current.add(mentionPath);

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = lastAtSymbol + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (textareaRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = cursorPosition + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        setShowFileMention(false);
        setMentionQuery('');

        textareaRef.current?.focus();
    };

    const handleAgentSelect = (agentName: string) => {
        const textarea = textareaRef.current;
        const cursorPosition = textarea?.selectionStart ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastAtSymbol + agentName.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (textareaRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = cursorPosition + agentName.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        setShowFileMention(false);
        setMentionQuery('');

        textareaRef.current?.focus();
    };

    const handleSkillSelect = (skillName: string) => {
        const textarea = textareaRef.current;
        const cursorPosition = textarea?.selectionStart ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastSlashSymbol = textBeforeCursor.lastIndexOf('/');

        if (lastSlashSymbol !== -1) {
            const newMessage =
                message.substring(0, lastSlashSymbol) +
                `/${skillName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastSlashSymbol + skillName.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        setShowSkillAutocomplete(false);
        setSkillQuery('');

        textareaRef.current?.focus();
    };

    const handleCommandSelect = (command: CommandInfo) => {

        setMessage(`/${command.name} `);

        if (textareaRef.current) {
            textareaRef.current.commandMetadata = command;
        }

        setShowCommandAutocomplete(false);
        setCommandQuery('');

        const refocus = () => {
            if (textareaRef.current) {
                try {
                    textareaRef.current.focus({ preventScroll: true });
                } catch {
                    textareaRef.current.focus();
                }
                textareaRef.current.setSelectionRange(textareaRef.current.value.length, textareaRef.current.value.length);
            }
        };

        requestAnimationFrame(() => {
            refocus();
            requestAnimationFrame(refocus);
        });
        setTimeout(refocus, 60);
    };

    React.useEffect(() => {

        if (currentSessionId && textareaRef.current && !isMobile) {
            textareaRef.current.focus();
        }
    }, [currentSessionId, isMobile]);

    React.useEffect(() => {
        if (!isMobile) {
            setMobileControlsOpen(false);
            setMobileControlsPanel(null);
        }
    }, [isMobile]);

    React.useEffect(() => {
        if (abortPromptSessionId && abortPromptSessionId !== currentSessionId) {
            clearAbortPrompt();
        }
    }, [abortPromptSessionId, currentSessionId, clearAbortPrompt]);

    React.useEffect(() => {
        if (!composerInteractionDisabled) {
            return;
        }

        setShowCommandAutocomplete(false);
        setShowSkillAutocomplete(false);
        setShowFileMention(false);
        setMobileControlsOpen(false);
        setMobileControlsPanel(null);
    }, [composerInteractionDisabled, setMobileControlsPanel]);

    React.useEffect(() => {
        canAcceptDropRef.current = Boolean(!composerInteractionDisabled && (currentSessionId || newSessionDraftOpen));
    }, [composerInteractionDisabled, currentSessionId, newSessionDraftOpen]);

    const hasDraggedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): boolean => {
        if (!dataTransfer) return false;
        if (dataTransfer.files && dataTransfer.files.length > 0) return true;
        if (dataTransfer.types) {
            const types = Array.from(dataTransfer.types);
            const lowerTypes = types.map((type) => type.toLowerCase());
            if (lowerTypes.includes('files')) return true;
            if (lowerTypes.includes('text/uri-list')) return true;
            if (lowerTypes.includes('codefiles')) return true;
            if (lowerTypes.includes('application/x-openchamber-file-path')) return true;
            if (lowerTypes.some((type) => type.includes('vnd.code.tree'))) return true;
        }

        for (const dataType of VS_CODE_DROP_DATA_TYPES) {
            let payload = '';
            try {
                payload = dataTransfer.getData(dataType);
            } catch {
                continue;
            }
            if (payload && parseDroppedFileReferences(payload).length > 0) {
                return true;
            }
        }

        return false;
    }, []);

    const collectDroppedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): File[] => {
        if (!dataTransfer) return [];

        const directFiles = Array.from(dataTransfer.files || []);
        if (directFiles.length > 0) {
            return directFiles;
        }

        const fromItems = Array.from(dataTransfer.items || [])
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));

        return fromItems;
    }, []);

    const collectDroppedFileUris = React.useCallback((dataTransfer: DataTransfer | null | undefined): string[] => {
        if (!dataTransfer || typeof dataTransfer.getData !== 'function') return [];

        const extracted = new Set<string>();

        for (const dataType of VS_CODE_DROP_DATA_TYPES) {
            let rawPayload = '';
            try {
                rawPayload = dataTransfer.getData(dataType);
            } catch {
                continue;
            }
            if (!rawPayload) {
                continue;
            }

            for (const candidate of parseDroppedFileReferences(rawPayload)) {
                extracted.add(candidate);
            }
        }

        return Array.from(extracted);
    }, []);

    const normalizeDroppedPath = React.useCallback((rawPath: string): string => {
        const input = rawPath.trim();
        if (!input.toLowerCase().startsWith('file://')) {
            return input;
        }

        try {
            let pathname = decodeURIComponent(new URL(input).pathname || '');
            if (/^\/[A-Za-z]:\//.test(pathname)) {
                pathname = pathname.slice(1);
            }
            return pathname || input;
        } catch {
            const stripped = input.replace(/^file:\/\//i, '');
            try {
                return decodeURIComponent(stripped);
            } catch {
                return stripped;
            }
        }
    }, []);

    const toProjectRelativeMentionPath = React.useCallback((absolutePath: string): string => {
        const normalizedAbsolutePath = absolutePath.replace(/\\/g, '/').trim();
        const normalizedRoot = (chatSearchDirectory || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!normalizedRoot) {
            return normalizedAbsolutePath;
        }
        if (normalizedAbsolutePath === normalizedRoot) {
            return normalizedAbsolutePath;
        }
        const rootWithSlash = `${normalizedRoot}/`;
        if (normalizedAbsolutePath.startsWith(rootWithSlash)) {
            return normalizedAbsolutePath.slice(rootWithSlash.length);
        }
        return normalizedAbsolutePath;
    }, [chatSearchDirectory]);

    const addVSCodeDroppedUrisAsMentions = React.useCallback((uris: string[]) => {
        if (uris.length === 0) return;

        const paths = uris
            .map((entry) => normalizeDroppedPath(entry))
            .map((entry) => toProjectRelativeMentionPath(entry))
            .map((entry) => entry.trim().replace(/^\.\//, ''))
            .filter((entry) => entry.length > 0);

        for (const p of paths) {
            confirmedMentionsRef.current.add(p);
        }

        const mentions = Array.from(new Set(paths.map((entry) => `@${entry}`)));

        if (mentions.length === 0) {
            return;
        }

        setPendingInputText(mentions.join(' '), 'append-inline');
        toast.success(t('chat.chatInput.toast.addedFileMentions', { count: mentions.length }));
    }, [normalizeDroppedPath, setPendingInputText, t, toProjectRelativeMentionPath]);

    const handleDragEnter = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current++;
        const isInternal = e.dataTransfer.types?.includes('application/x-openchamber-file-path') ?? false;
        if (isInternal !== isInternalDrag) {
            setIsInternalDrag(isInternal);
        }
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
        setNeedsShiftHint(!e.shiftKey);
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
        if (needsShiftHint !== !e.shiftKey) {
            setNeedsShiftHint(!e.shiftKey);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current--;
        if (dragEnterCountRef.current <= 0) {
            dragEnterCountRef.current = 0;
            setIsDragging(false);
            setNeedsShiftHint(false);
            setIsInternalDrag(false);
            clearDropTextSuppression();
        }
    };

    const handleDragEnd = () => {
        dragEnterCountRef.current = 0;
        setIsDragging(false);
        setNeedsShiftHint(false);
        setIsInternalDrag(false);
        clearDropTextSuppression();
    };

    // Safety net: never leave the drag overlays stuck if the drag ends outside the composer.
    React.useEffect(() => {
        if (!isDragging) return;
        const reset = () => {
            dragEnterCountRef.current = 0;
            setIsDragging(false);
            setNeedsShiftHint(false);
        };
        window.addEventListener('blur', reset);
        document.addEventListener('dragend', reset);
        document.addEventListener('drop', reset);
        return () => {
            window.removeEventListener('blur', reset);
            document.removeEventListener('dragend', reset);
            document.removeEventListener('drop', reset);
        };
    }, [isDragging]);

    const handleDrop = async (e: React.DragEvent) => {
        dragEnterCountRef.current = 0;
        const draggedFiles = hasDraggedFiles(e.dataTransfer);
        if (!draggedFiles) {
            clearDropTextSuppression();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        setNeedsShiftHint(false);

        if (!currentSessionId && !newSessionDraftOpen) return;

        // Internal drag: file tree → chat input (relative path as @mention)
        const internalPath = e.dataTransfer.getData('application/x-openchamber-file-path');
        if (internalPath && internalPath !== '.') {
            confirmedMentionsRef.current.add(internalPath);
            const mention = `@${internalPath}`;
            const textarea = textareaRef.current;
            const currentMessage = messageRef.current;
            if (textarea) {
                const pos = textarea.selectionStart ?? cursorPosRef.current;
                const end = textarea.selectionEnd ?? pos;
                const before = currentMessage.slice(0, pos);
                const after = currentMessage.slice(end);
                const needSpaceBefore = before.length > 0 && !/\s$/.test(before);
                const needSpaceAfter = after.length > 0 && !/^\s/.test(after);
                const insert = `${needSpaceBefore ? ' ' : ''}${mention}${needSpaceAfter ? ' ' : ''}`;
                const nextMessage = `${before}${insert}${after}`;
                setMessage(nextMessage);
                requestAnimationFrame(() => {
                    const cursorPos = pos + insert.length;
                    textarea.selectionStart = cursorPos;
                    textarea.selectionEnd = cursorPos;
                    cursorPosRef.current = cursorPos;
                    textarea.focus();
                });
            } else {
                setMessage((prev) => appendInlineText(prev, mention));
            }
            clearDropTextSuppression();
            return;
        }

        const droppedUris = collectDroppedFileUris(e.dataTransfer);
        if (droppedUris.length > 0) {
            pendingDroppedAbsolutePathsRef.current = droppedUris
                .map((entry) => normalizeDroppedPath(entry))
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);
            addVSCodeDroppedUrisAsMentions(droppedUris);
            clearDropTextSuppression();
            return;
        }

        const files = collectDroppedFiles(e.dataTransfer);

        if (files.length > 0) {
            for (const file of files) {
                try {
                    await addAttachedFile(file);
                } catch (error) {
                    console.error('File attach failed', error);
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.attachFileFailed'));
                }
            }
        }
        clearDropTextSuppression();
    };

    const handleDropCapture = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        // Prevent native textarea drop text insertion for all runtimes
        e.preventDefault();
        if (isVSCodeRuntime()) {
            suppressNextFileDropTextInsertRef.current = true;
            scheduleDropTextSuppressionExpiry();
        }
    };

    // Tauri desktop: handle native file drops via onDragDropEvent
    React.useEffect(() => {
        if (!isTauriShell()) return;
        let cancelled = false;
        let unlisten: (() => void) | null = null;

        void (async () => {
            try {
                const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                const webviewWindow = getCurrentWebviewWindow();
                const removeListener = await webviewWindow.onDragDropEvent(async (event) => {
                    if (!canAcceptDropRef.current) return;

                    const payload = (event as { payload?: unknown }).payload;
                    if (!payload || typeof payload !== 'object') return;

                    const typed = payload as { type?: string; paths?: string[]; position?: { x?: number; y?: number } };
                    const type = typed.type;
                    const x = typed.position?.x;
                    const y = typed.position?.y;

                    // Check if drop is inside the chat input area
                    const zone = dropZoneRef.current;
                    let inZone: boolean | null = null;
                    if (zone && typeof x === 'number' && typeof y === 'number') {
                        const rect = zone.getBoundingClientRect();
                        inZone = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
                        // Handle retina displays where Tauri might report physical pixels
                        if (!inZone && window.devicePixelRatio > 1) {
                            const sx = x / window.devicePixelRatio;
                            const sy = y / window.devicePixelRatio;
                            inZone = sx >= rect.left && sx <= rect.right && sy >= rect.top && sy <= rect.bottom;
                        }
                    }

                    if (type === 'enter' || type === 'over') {
                        if (inZone !== null) {
                            nativeDragInsideDropZoneRef.current = inZone;
                        }
                        setIsDragging(nativeDragInsideDropZoneRef.current);
                        return;
                    }
                    if (type === 'leave') {
                        nativeDragInsideDropZoneRef.current = false;
                        setIsDragging(false);
                        return;
                    }
                    if (type === 'drop') {
                        const shouldHandleDrop = inZone ?? nativeDragInsideDropZoneRef.current;
                        nativeDragInsideDropZoneRef.current = false;
                        setIsDragging(false);
                        if (!shouldHandleDrop) return;

                        const paths = Array.isArray(typed.paths)
                            ? typed.paths.filter((p): p is string => typeof p === 'string')
                            : [];
                        if (paths.length === 0) return;

                        for (const path of paths) {
                            try {
                                const normalizedPath = normalizeDroppedPath(path);
                                const fileName = normalizedPath.split(/[\\/]/).pop() || normalizedPath;
                                let file: File;

                                // In Tauri shell, dropped paths are local machine paths.
                                // Read bytes via native command to avoid workspace-bound /api/fs/raw restrictions.
                                if (isTauriShell()) {
                                    const { invoke } = await import('@tauri-apps/api/core');
                                    const result = await invoke<{ mime: string; base64: string }>('desktop_read_file', { path: normalizedPath });
                                    const byteCharacters = atob(result.base64);
                                    const byteNumbers = new Array(byteCharacters.length);
                                    for (let i = 0; i < byteCharacters.length; i++) {
                                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                                    }
                                    const byteArray = new Uint8Array(byteNumbers);
                                    const blob = new Blob([byteArray], { type: result.mime || 'application/octet-stream' });
                                    file = new File([blob], fileName, { type: result.mime || 'application/octet-stream' });
                                } else {
                                    const response = await fetch(`/api/fs/raw?path=${encodeURIComponent(normalizedPath)}`);
                                    if (!response.ok) {
                                        throw new Error(`Failed to read dropped file (${response.status})`);
                                    }
                                    const blob = await response.blob();
                                    file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
                                }

                                await addAttachedFile(file);
                            } catch (error) {
                                console.error('Failed to attach dropped file:', path, error);
                                toast.error(t('chat.chatInput.toast.attachNamedFailed', {
                                    name: path.split(/[\\/]/).pop() || t('chat.chatInput.fileFallback'),
                                }));
                            }
                        }
                    }
                });

                if (cancelled) {
                    removeListener();
                    return;
                }
                unlisten = removeListener;
            } catch (error) {
                if (!cancelled) {
                    console.warn('Failed to register Tauri drag-drop listener:', error);
                }
            }
        })();

        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, [addAttachedFile, normalizeDroppedPath, t]);

    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const attachFiles = React.useCallback(async (files: FileList | File[]) => {
        const list = Array.isArray(files) ? files : Array.from(files);

        for (const file of list) {
            try {
                await addAttachedFile(file);
            } catch (error) {
                console.error('File attach failed', error);
                toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.attachFileFailed'));
            }
        }
    }, [addAttachedFile, t]);

    const handleVSCodePickFiles = React.useCallback(async () => {
        try {
            const response = await fetch('/api/vscode/pick-files');
            const data = await response.json();
            const picked = Array.isArray(data?.files) ? data.files : [];
            const skipped = Array.isArray(data?.skipped) ? data.skipped : [];

            if (skipped.length > 0) {
                const summary = skipped
                    .map((s: { name?: string; reason?: string }) => `${s?.name || 'file'}: ${s?.reason || 'skipped'}`)
                    .join('\n');
                toast.error(t('chat.chatInput.toast.someFilesSkipped', { summary }));
            }

            const asFiles = picked
                .map((file: { name: string; mimeType?: string; dataUrl?: string }) => {
                    if (!file?.dataUrl) return null;
                    try {
                        const [meta, base64] = file.dataUrl.split(',');
                        const mime = file.mimeType || (meta?.match(/data:(.*);base64/)?.[1] || 'application/octet-stream');
                        if (!base64) return null;
                        const binary = atob(base64);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) {
                            bytes[i] = binary.charCodeAt(i);
                        }
                        const blob = new Blob([bytes], { type: mime });
                        return new File([blob], file.name || 'file', { type: mime });
                    } catch (err) {
                        console.error('Failed to decode VS Code picked file', err);
                        return null;
                    }
                })
                .filter(Boolean) as File[];

            if (asFiles.length > 0) {
                await attachFiles(asFiles);
            }
        } catch (error) {
            console.error('VS Code file pick failed', error);
            toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.vscodePickFailed'));
        }
    }, [attachFiles, t]);

    const handlePickLocalFiles = React.useCallback(() => {
        if (isVSCodeRuntime()) {
            void handleVSCodePickFiles();
            return;
        }
        fileInputRef.current?.click();
    }, [handleVSCodePickFiles]);

    const handleLocalFileSelect = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files) return;
        await attachFiles(files);
        event.target.value = '';
    }, [attachFiles]);

    const footerGapClass = 'gap-x-1.5 gap-y-0';
    const isVSCode = isVSCodeRuntime();
    const showDraftTargetSelectors = newSessionDraftOpen && !isVSCode;

    const selectedDraftProject = React.useMemo(() => {
        const explicit = newSessionDraft?.selectedProjectId
            ? projects.find((project) => project.id === newSessionDraft.selectedProjectId) ?? null
            : null;
        if (explicit) {
            return explicit;
        }

        const active = activeProjectId
            ? projects.find((project) => project.id === activeProjectId) ?? null
            : null;
        if (active) {
            return active;
        }

        return projects[0] ?? null;
    }, [activeProjectId, newSessionDraft?.selectedProjectId, projects]);

    const selectedDraftProjectPath = React.useMemo(
        () => normalizePath(selectedDraftProject?.path ?? null),
        [selectedDraftProject?.path],
    );

    const selectedDraftProjectBranches = useGitBranches(selectedDraftProjectPath);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const [isDiscoveringDraftBranches, setIsDiscoveringDraftBranches] = React.useState(false);

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProjectPath || !selectedDraftProject || !runtimeGit) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        if (selectedDraftProjectBranches?.all) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        let cancelled = false;
        setIsDiscoveringDraftBranches(true);

        void fetchBranches(selectedDraftProjectPath, runtimeGit)
            .finally(() => {
                if (!cancelled) {
                    setIsDiscoveringDraftBranches(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [fetchBranches, runtimeGit, selectedDraftProject, selectedDraftProjectBranches?.all, selectedDraftProjectPath, showDraftTargetSelectors]);

    const selectedDraftProjectCurrentBranch = selectedDraftProjectBranches?.current?.trim() ?? '';

    const projectRootBranchOption = React.useMemo(() => {
        if (!selectedDraftProject) {
            return null;
        }
        const value = normalizePath(selectedDraftProject.path);
        if (!value) {
            return null;
        }
        if (!selectedDraftProjectCurrentBranch) {
            return null;
        }
        return {
            value,
            label: selectedDraftProjectCurrentBranch,
        };
    }, [selectedDraftProject, selectedDraftProjectCurrentBranch]);

    const selectedDraftDirectory = React.useMemo(
        () => normalizePath(newSessionDraft?.directoryOverride ?? null) ?? selectedDraftProjectPath,
        [newSessionDraft?.directoryOverride, selectedDraftProjectPath],
    );

    const draftBranchItems = React.useMemo(() => {
        const baseItems: Array<{ value: string; label: string }> = [];
        if (projectRootBranchOption) {
            baseItems.push(projectRootBranchOption);
        }
        return baseItems;
    }, [projectRootBranchOption]);

    const selectedDraftBranchLabel = React.useMemo(() => {
        const selectedValue = selectedDraftDirectory ?? draftBranchItems[0]?.value ?? null;
        if (!selectedValue) {
            return null;
        }
        return draftBranchItems.find((item) => item.value === selectedValue)?.label ?? formatDirectoryName(selectedValue);
    }, [draftBranchItems, selectedDraftDirectory]);

    const hasPendingChanges = React.useMemo(() => {
        if (isGitRepo !== true || !currentGitStatus || currentGitStatus.isClean) {
            return false;
        }
        return extractGitChangedFiles(currentGitStatus.files, currentGitStatus.diffStats, currentDirectory).length > 0;
    }, [currentDirectory, currentGitStatus, isGitRepo]);

    const shouldShowDraftBranchSelector = React.useMemo(() => {
        if (isDiscoveringDraftBranches) {
            return false;
        }
        return Boolean(projectRootBranchOption);
    }, [isDiscoveringDraftBranches, projectRootBranchOption]);

    const handleDraftProjectChange = React.useCallback((projectId: string) => {
        const project = projects.find((entry) => entry.id === projectId);
        if (!project) {
            return;
        }
        if (activeProjectId !== projectId) {
            setActiveProjectIdOnly(projectId);
        }
        setNewSessionDraftTarget({
            projectId,
            directoryOverride: project.path,
        }, { force: true });
    }, [activeProjectId, projects, setActiveProjectIdOnly, setNewSessionDraftTarget]);

    const handleDraftDirectoryChange = React.useCallback((directory: string) => {
        if (!selectedDraftProject) {
            return;
        }
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: directory,
        }, { force: true });
    }, [selectedDraftProject, setNewSessionDraftTarget]);

    const renderProjectLabelWithIcon = React.useCallback((project: {
        id: string;
        path: string;
        label?: string;
        icon?: string | null;
        color?: string | null;
    }) => {
        const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
        const iconColor = getProjectIconColor(project.color);

        return (
            <span className="inline-flex min-w-0 items-center gap-1.5">
                {ProjectIcon ? (
                    <ProjectIcon className="h-3.5 w-3.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} />
                ) : (
                    <RiFolderLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" style={iconColor ? { color: iconColor } : undefined} />
                )}
                <span className="truncate">{getProjectDisplayLabel(project)}</span>
            </span>
        );
    }, []);

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProject || !selectedDraftDirectory) {
            return;
        }
        const valid = draftBranchItems.some((option) => option.value === selectedDraftDirectory);
        if (valid) {
            return;
        }
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: selectedDraftProject.path,
        });
    }, [draftBranchItems, selectedDraftDirectory, selectedDraftProject, setNewSessionDraftTarget, showDraftTargetSelectors]);

    const footerPaddingClass = isMobile ? 'px-1.5 py-1.5' : (isVSCode ? 'px-1.5 py-1' : 'px-2.5 py-1.5');
    const buttonSizeClass = isMobile ? 'h-8 w-8' : (isVSCode ? 'h-5 w-5' : 'h-6 w-6');
    const sendIconSizeClass = isMobile ? 'h-4 w-4' : (isVSCode ? 'h-3.5 w-3.5' : 'h-4 w-4');
    const stopIconSizeClass = isMobile ? 'h-6 w-6' : (isVSCode ? 'h-4 w-4' : 'h-5 w-5');
    const iconSizeClass = isMobile ? 'h-[18px] w-[18px]' : (isVSCode ? 'h-4 w-4' : 'h-[18px] w-[18px]');

    const iconButtonBaseClass = 'flex cursor-pointer items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed';
    const footerIconButtonClass = cn(iconButtonBaseClass, buttonSizeClass);
    React.useEffect(() => {
        const pendingAbortBanner = Boolean(abortPromptSessionId) && abortPromptSessionId === currentSessionId;
        if (!prevWasAbortedRef.current && pendingAbortBanner && !showAbortStatus) {
            startAbortIndicator();
            if (currentSessionId) {
                acknowledgeSessionAbort(currentSessionId);
            }
        }
        prevWasAbortedRef.current = pendingAbortBanner;
    }, [
        abortPromptSessionId,
        acknowledgeSessionAbort,
        currentSessionId,
        showAbortStatus,
        startAbortIndicator,
    ]);

    React.useEffect(() => {
        return () => {
            if (abortTimeoutRef.current) {
                clearTimeout(abortTimeoutRef.current);
                abortTimeoutRef.current = null;
            }
        };
    }, []);

    // Position of the open popup next to the caret in the expanded composer (undefined = default anchoring).
    const popupOverlayStyle = (maxWidth: number): React.CSSProperties | undefined => {
        if (!isDesktopExpanded || !autocompleteOverlayPosition) {
            return undefined;
        }
        return {
            left: `${autocompleteOverlayPosition.left}px`,
            top: `${autocompleteOverlayPosition.top}px`,
            bottom: 'auto',
            width: `min(${maxWidth}px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
            maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
            transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
        };
    };

    const hasOpenPopup = showCommandAutocomplete || showSkillAutocomplete || showFileMention;

    // Mirrors the popup's highlighted option to the textarea (aria-activedescendant).
    const [popupActiveOptionId, setPopupActiveOptionId] = React.useState<string | null>(null);
    const syncPopupActiveOption = React.useCallback(() => {
        const selected = document.querySelector<HTMLElement>(`#${COMPOSER_POPUP_ID} [aria-selected="true"]`);
        setPopupActiveOptionId(selected?.id || null);
    }, []);
    React.useEffect(() => {
        if (!hasOpenPopup) {
            setPopupActiveOptionId(null);
            return;
        }
        const frame = requestAnimationFrame(syncPopupActiveOption);
        return () => cancelAnimationFrame(frame);
    }, [hasOpenPopup, commandQuery, mentionQuery, skillQuery, message, syncPopupActiveOption]);

    return (
        <>
        <form
            onSubmit={(e) => { e.preventDefault(); handlePrimaryAction(); }}
            className={cn(
                "relative pt-0 pb-4",
                isDesktopExpanded && 'flex h-full min-h-0 flex-col pt-4',
                isMobile && (isKeyboardOpen ? 'ios-keyboard-safe-area' : 'bottom-safe-area')
            )}
            data-keyboard-avoid="none"
            style={isMobile && inputBarOffset > 0 && !isKeyboardOpen ? { marginBottom: `${inputBarOffset}px` } : undefined}
        >
            <div className={cn('chat-column relative overflow-visible', isDesktopExpanded && 'flex flex-1 min-h-0 flex-col')}>
                <ClaudeStatusBanner sessionId={currentSessionId} />
                <AttachedFilesList />
                <QueuedMessageChips
                    onEditMessage={handleQueuedMessageEdit}
                />
                {hasDrafts && (
                    <div className="pb-2">
                        <div
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border"
                            style={{
                                backgroundColor: currentTheme?.colors?.surface?.elevated,
                                borderColor: currentTheme?.colors?.interactive?.border,
                            }}
                        >
                            <span className="text-xs font-medium text-muted-foreground">{t('chat.chatInput.reviewComments')}</span>
                            <span className="text-xs font-semibold" style={{ color: currentTheme?.colors?.status?.info }}>
                                {draftCount}
                            </span>
                        </div>
                    </div>
                )}

                <MemoStatusRow
                    showAbortStatus={showAbortStatus}
                    showAssistantStatus={false}
                    showTodos
                    leftAccessory={newSessionDraftOpen || !hasPendingChanges ? null : <PendingChangesBar />}
                />
                {showDraftTargetSelectors && selectedDraftProject ? (
                    <div className="mb-1.5 flex min-w-0 items-center gap-1.5 px-0.5">
                        <Select
                            value={selectedDraftProject.id}
                            onValueChange={handleDraftProjectChange}
                        >
                            <SelectTrigger
                                size="sm"
                                className="h-7 min-w-0 w-fit max-w-[42vw] sm:max-w-[18rem] border-transparent bg-transparent px-1.5 hover:bg-transparent data-[popup-open]:bg-transparent"
                            >
                                <SelectValue>
                                    {renderProjectLabelWithIcon(selectedDraftProject)}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent fitContent>
                                {projects.map((project) => (
                                    <SelectItem key={project.id} value={project.id} className="max-w-[24rem] truncate">
                                        {renderProjectLabelWithIcon(project)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>

                        {shouldShowDraftBranchSelector ? (
                            <Select
                                value={selectedDraftDirectory ?? draftBranchItems[0]?.value ?? normalizePath(selectedDraftProject.path) ?? ''}
                                onValueChange={handleDraftDirectoryChange}
                            >
                                <SelectTrigger
                                    size="sm"
                                    className="h-7 min-w-0 w-fit max-w-[48vw] sm:max-w-[20rem] border-transparent bg-transparent px-1.5 hover:bg-transparent data-[popup-open]:bg-transparent"
                                >
                                    <SelectValue>
                                        {selectedDraftBranchLabel ?? t('chat.chatInput.branch')}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent fitContent>
                                    {projectRootBranchOption ? (
                                        <SelectGroup>
                                            <SelectLabel>{t('chat.chatInput.projectRoot')}</SelectLabel>
                                            <SelectItem key={projectRootBranchOption.value} value={projectRootBranchOption.value} className="max-w-[24rem] truncate">
                                                {projectRootBranchOption.label}
                                            </SelectItem>
                                        </SelectGroup>
                                    ) : null}
                                </SelectContent>
                            </Select>
                        ) : null}
                    </div>
                ) : null}
                {!composerInteractionDisabled ? <PendingAgentSwitchNotice /> : null}
                <div
                    className={cn(
                        "flex flex-col relative overflow-visible",
                        isDesktopExpanded && 'flex-1 min-h-0',
                        "border border-border/80",
                        "focus-within:ring-1",
                        'focus-within:ring-primary/50',
                        isDragging && "ring-2 ring-primary ring-offset-2",
                        composerInteractionDisabled && 'pointer-events-none opacity-60'
                    )}
                    style={{
                        borderRadius: chatInputRadius,
                        backgroundColor: currentTheme?.colors?.surface?.subtle,
                    }}
                    ref={dropZoneRef}
                    onDropCapture={handleDropCapture}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                >
                    <div
                        aria-hidden={!(isDragging && needsShiftHint)}
                        className={cn(
                            "pointer-events-none absolute inset-0 z-50 flex items-center justify-center gap-2",
                            "bg-background/80 text-muted-foreground backdrop-blur-sm",
                            "transition-opacity duration-150",
                            isDragging && needsShiftHint ? "opacity-100" : "opacity-0"
                        )}
                        style={{ borderRadius: chatInputRadius }}
                    >
                        <RiDragDropLine className={cn(iconSizeClass, 'text-current')} />
                        <span className="typography-ui-label">{t('chat.chatInput.drop.holdShift')}</span>
                    </div>
                    {isDragging && !needsShiftHint && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 rounded-xl">
                            <div className="text-center">
                                <div className="inline-flex justify-center">
                                    <button
                                        type="button"
                                        className={iconButtonBaseClass}
                                        onClick={() => handlePickLocalFiles()}
                                        title={t('chat.chatInput.actions.attachFiles')}
                                        aria-label={t('chat.chatInput.actions.attachFiles')}
                                    >
                                        <RiAttachment2 className={cn(iconSizeClass, 'text-current')} />
                                    </button>
                                </div>
                                <p className="mt-2 typography-ui-label text-muted-foreground">
                                    {isInternalDrag ? t('chat.chatInput.drop.insertMention') : t('chat.chatInput.drop.attachFiles')}
                                </p>
                            </div>
                        </div>
                    )}

                    {showCommandAutocomplete && (
                        <CommandAutocomplete
                            ref={commandRef}
                            searchQuery={commandQuery}
                            onCommandSelect={handleCommandSelect}
                            showTabs={isMobile}
                            activeTab={autocompleteTab}
                            onTabSelect={handleAutocompleteTabSelect}
                            onClose={() => setShowCommandAutocomplete(false)}
                            style={popupOverlayStyle(450)}
                        />
                    )}
                    { }
                    {showSkillAutocomplete && (
                        <SkillAutocomplete
                            ref={skillRef}
                            searchQuery={skillQuery}
                            onSkillSelect={handleSkillSelect}
                            onClose={() => setShowSkillAutocomplete(false)}
                            style={popupOverlayStyle(360)}
                        />
                    )}

                    {showFileMention && (

                        <FileMentionAutocomplete
                            ref={mentionRef}
                            searchQuery={mentionQuery}
                            onFileSelect={handleFileSelect}
                            onAgentSelect={handleAgentSelect}
                            showTabs={isMobile}
                            activeTab={autocompleteTab}
                            onTabSelect={handleAutocompleteTabSelect}
                            onClose={() => setShowFileMention(false)}
                            style={popupOverlayStyle(520)}
                        />
                    )}
                    <div className={cn("relative overflow-hidden", isDesktopExpanded && 'flex flex-1 min-h-0 flex-col')}>
                        <MinimalComposer
                            ref={textareaRef}
                            value={message}
                            onChange={handleTextChange}
                            onSend={handlePrimaryAction}
                            clearOnSend={false}
                            enterSends={!isMobile}
                            onKeyDown={handleComposerKeyDown}
                            onSelectionChange={handleComposerSelectionChange}
                            getMentionRanges={getMentionRanges}
                            placeholder={currentSessionId || newSessionDraftOpen
                                ? t('chat.chatInput.placeholder.chat')
                                : t('chat.chatInput.placeholder.selectSession')}
                            disabled={composerInteractionDisabled || (!currentSessionId && !newSessionDraftOpen)}
                            contentAttributes={{
                                'data-chat-input': 'true',
                                'aria-haspopup': hasOpenPopup ? 'listbox' : undefined,
                                'aria-expanded': hasOpenPopup ? true : undefined,
                                'aria-controls': hasOpenPopup ? COMPOSER_POPUP_ID : undefined,
                                'aria-activedescendant': hasOpenPopup ? popupActiveOptionId ?? undefined : undefined,
                                autocorrect: isMobile ? 'on' : 'off',
                                autocapitalize: isMobile ? 'sentences' : 'off',
                                spellcheck: isMobile || inputSpellcheckEnabled,
                            }}
                            rootProps={{
                                onBeforeInput: handleBeforeInput,
                                onPaste: handlePaste,
                                onDragEnter: handleDragEnter,
                                onDragOver: handleDragOver,
                                onDropCapture: handleDropCapture,
                                onDrop: handleDrop,
                                onDragEnd: handleDragEnd,
                                onKeyUp: updateAutocompleteOverlayPosition,
                                onClick: updateAutocompleteOverlayPosition,
                                onScroll: updateAutocompleteOverlayPosition,
                            }}
                            className={cn(
                                'block w-full min-h-[52px] bg-transparent px-3 text-foreground typography-markdown md:typography-ui-label relative z-10',
                                isDesktopExpanded
                                    ? 'h-full min-h-0 py-4'
                                    : isMobile
                                        ? 'py-2.5'
                                        : 'pt-4 pb-2',
                                isDesktopExpanded && 'flex-1 min-h-0',
                            )}
                            style={{
                                flex: isDesktopExpanded ? '1 1 auto' : 'none',
                                maxHeight: !isDesktopExpanded && composerMaxHeight ? `${composerMaxHeight}px` : isDesktopExpanded ? 'none' : undefined,
                                borderTopLeftRadius: chatInputRadius,
                                borderTopRightRadius: chatInputRadius,
                            }}
                        />
                    </div>
                    <div
                        className={cn(
                            'bg-transparent flex-shrink-0',
                            footerPaddingClass,
                            isMobile ? 'flex items-center gap-x-1.5' : cn('flex items-center justify-between', footerGapClass)
                        )}
                        style={{
                            borderBottomLeftRadius: chatInputRadius,
                            borderBottomRightRadius: chatInputRadius,
                        }}
                        data-chat-input-footer="true"
                    >
                        {isMobile ? (
                            <>
                                <div className="flex w-full items-center justify-between gap-x-1.5">
                                    <div className="flex items-center gap-x-1.5">
                                        <ComposerAttachmentControls
                                            isMobile={isMobile}
                                            isVSCode={isVSCode}
                                            footerIconButtonClass={footerIconButtonClass}
                                            iconSizeClass={iconSizeClass}
                                            fileInputRef={fileInputRef}
                                            handleLocalFileSelect={handleLocalFileSelect}
                                            handlePickLocalFiles={handlePickLocalFiles}
                                            handleOpenCommandMenu={handleOpenCommandMenu}
                                            onOpenSettings={onOpenSettings}
                                        />
                                        <PermissionModeSelector
                                            sessionId={currentSessionId}
                                            footerIconButtonClass={footerIconButtonClass}
                                            iconSizeClass={iconSizeClass}
                                            iconOnly
                                            disabled={composerInteractionDisabled}
                                        />
                                    </div>
                                    <div className="flex items-center min-w-0 gap-x-1 justify-end">
                                        <div className="flex items-center gap-x-1 min-w-0 max-w-[60vw] flex-shrink">
                                            <MemoMobileModelButton onOpenModel={handleOpenMobileControls} className="min-w-0 flex-shrink" />
                                            <MemoMobileAgentButton
                                                onOpenAgentPanel={handleOpenAgentPanel}
                                                onCycleAgent={handleCycleAgent}
                                                className="min-w-0 flex-shrink"
                                            />
                                        </div>
                                        <div className="flex items-center gap-x-1 flex-shrink-0">
                                            <ComposerActionButtons
                                                isMobile={isMobile}
                                                footerIconButtonClass={footerIconButtonClass}
                                                sendIconSizeClass={sendIconSizeClass}
                                                stopIconSizeClass={stopIconSizeClass}
                                                canSend={canSend}
                                                canAbort={canAbort}
                                                hasContent={!!hasContent}
                                                currentSessionId={currentSessionId}
                                                newSessionDraftOpen={newSessionDraftOpen}
                                                onPrimaryAction={handlePrimaryAction}
                                                onQueueMessage={handleQueueMessage}
                                                onAbort={handleAbort}
                                            />
                                        </div>
                                    </div>
                                </div>
                                <MemoModelControls
                                    className="hidden"
                                    mobilePanel={mobileControlsPanel}
                                    onMobilePanelChange={setMobileControlsPanel}
                                    onMobilePanelSelection={handleReturnToUnifiedControls}
                                    onAgentPanelSelection={() => setMobileControlsPanel(null)}
                                />
                                <MemoUnifiedControlsDrawer
                                    open={mobileControlsOpen}
                                    onClose={handleCloseMobileControls}
                                    onOpenModel={() => handleOpenMobilePanel('model')}
                                />
                            </>
                        ) : (
                            <>
                                <div className={cn("flex items-center flex-shrink-0", footerGapClass)}>
                                    <ComposerAttachmentControls
                                        isMobile={isMobile}
                                        isVSCode={isVSCode}
                                        footerIconButtonClass={footerIconButtonClass}
                                        iconSizeClass={iconSizeClass}
                                        fileInputRef={fileInputRef}
                                        handleLocalFileSelect={handleLocalFileSelect}
                                        handlePickLocalFiles={handlePickLocalFiles}
                                        handleOpenCommandMenu={handleOpenCommandMenu}
                                        onOpenSettings={onOpenSettings}
                                    />
                                    <FocusModeButton
                                        footerIconButtonClass={footerIconButtonClass}
                                        iconSizeClass={iconSizeClass}
                                        isExpandedInput={isExpandedInput}
                                        onToggle={handleToggleExpandedInput}
                                    />
                                    <PermissionModeSelector
                                        sessionId={currentSessionId}
                                        footerIconButtonClass={footerIconButtonClass}
                                        iconSizeClass={iconSizeClass}
                                        iconOnly={isVSCode}
                                        disabled={composerInteractionDisabled}
                                    />
                                </div>
                                <div className={cn('flex items-center flex-1 justify-end', footerGapClass, 'md:gap-x-3')}>
                                    <MemoModelControls className={cn('flex-1 min-w-0 justify-end')} />
                                    <ComposerActionButtons
                                        isMobile={isMobile}
                                        footerIconButtonClass={footerIconButtonClass}
                                        sendIconSizeClass={sendIconSizeClass}
                                        stopIconSizeClass={stopIconSizeClass}
                                        canSend={canSend}
                                        canAbort={canAbort}
                                        hasContent={!!hasContent}
                                        currentSessionId={currentSessionId}
                                        newSessionDraftOpen={newSessionDraftOpen}
                                        onPrimaryAction={handlePrimaryAction}
                                        onQueueMessage={handleQueueMessage}
                                        onAbort={handleAbort}
                                    />
                                </div>
                            </>
                        )}
                    </div>

                    {/* Mobile Session Status Bar - above input */}
                    {isMobile && <MobileSessionStatusBar />}
                </div>
            </div>
        </form>

        </>
    );
};

ChatInputComponent.displayName = 'ChatInput';

export const ChatInput = React.memo(ChatInputComponent);
