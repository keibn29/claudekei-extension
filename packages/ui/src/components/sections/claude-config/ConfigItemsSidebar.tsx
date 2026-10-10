import React from 'react';
import { RiAddLine, RiSearchLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SidebarGroup } from '@/components/sections/shared/SidebarGroup';
import { useI18n } from '@/lib/i18n';
import type { ConfigItem, ConfigItemKind, ConfigScope } from '@/lib/claude/types';
import { selectItems, useClaudeConfigStore } from '@/stores/useClaudeConfigStore';
import { KIND_KEYS, groupItems } from './configFields';

export interface ConfigItemsSidebarProps {
  kind: ConfigItemKind;
  onItemSelect?: () => void;
}

const Badge: React.FC<{ tone?: 'muted' | 'error' | 'primary'; children: React.ReactNode }> = ({ tone = 'muted', children }) => (
  <span
    className={
      'typography-micro flex-shrink-0 rounded border px-1 pb-px leading-none ' +
      (tone === 'error'
        ? 'border-[var(--status-error-border)] bg-[var(--status-error-background)] text-[var(--status-error)]'
        : tone === 'primary'
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-border/50 bg-muted text-muted-foreground')
    }
  >
    {children}
  </span>
);

/** Agents / commands / skills list: Project, User and per-plugin groups with search and a "New" menu. */
export const ConfigItemsSidebar: React.FC<ConfigItemsSidebarProps> = ({ kind, onItemSelect }) => {
  const { t } = useI18n();
  const items = useClaudeConfigStore(React.useMemo(() => selectItems(kind), [kind]));
  const selected = useClaudeConfigStore((state) => state.selected[kind]);
  const loading = useClaudeConfigStore((state) => state.loading);
  const error = useClaudeConfigStore((state) => state.error);
  const hasSnapshot = useClaudeConfigStore((state) => state.snapshot !== null);
  const select = useClaudeConfigStore((state) => state.select);
  const load = useClaudeConfigStore((state) => state.load);
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    void load();
  }, [load]);

  const groups = React.useMemo(() => groupItems(items, query), [items, query]);
  const draftScope = selected && 'draft' in selected ? selected.draft : null;
  const selectedPath = selected && 'path' in selected ? selected.path : null;
  const total = groups.project.length + groups.user.length + groups.plugins.reduce((sum, group) => sum + group.items.length, 0);

  const handleNew = (scope: ConfigScope) => {
    select(kind, { draft: scope });
    onItemSelect?.();
  };

  const renderItem = (item: ConfigItem) => {
    const metadata = [item.group, item.description].filter(Boolean).join(' · ');
    return (
      <SettingsSidebarItem
        key={item.path}
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{item.name}</span>
            {item.shadowed ? <Badge>{t('claudeConfig.badge.overridden')}</Badge> : null}
            {item.error ? <Badge tone="error">{t('claudeConfig.badge.error')}</Badge> : null}
          </span>
        }
        metadata={metadata || undefined}
        selected={selectedPath === item.path}
        onSelect={() => {
          select(kind, { path: item.path });
          onItemSelect?.();
        }}
      />
    );
  };

  const draftRow = (scope: ConfigScope) =>
    draftScope === scope ? (
      <SettingsSidebarItem
        key={`draft-${scope}`}
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate italic">{t('claudeConfig.editor.newTitle', { kind: t(KIND_KEYS[kind].singular) })}</span>
            <Badge tone="primary">{t('claudeConfig.badge.draft')}</Badge>
          </span>
        }
        selected
        onSelect={onItemSelect ?? (() => {})}
      />
    ) : null;

  const sectionLabel = (label: string) => (
    <div className="px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
  );

  const header = (
    <div className="flex items-center gap-1.5 border-b px-3 py-2">
      <div className="relative min-w-0 flex-1">
        <RiSearchLine className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('claudeConfig.sidebar.search')}
          aria-label={t('claudeConfig.sidebar.search')}
          className="h-7 pl-7"
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-7 flex-shrink-0 gap-1 px-2 text-muted-foreground">
            <RiAddLine className="size-4" />
            {t('claudeConfig.sidebar.new')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-fit min-w-40">
          <DropdownMenuItem onClick={() => handleNew('user')}>{t('claudeConfig.sidebar.newUser')}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleNew('project')}>{t('claudeConfig.sidebar.newProject')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  let body: React.ReactNode;
  if (!hasSnapshot && loading) {
    body = <p className="px-2 py-3 typography-meta text-muted-foreground">{t('claudeConfig.sidebar.loading')}</p>;
  } else if (!hasSnapshot && error) {
    body = (
      <div className="space-y-2 px-2 py-3">
        <p className="typography-meta text-[var(--status-error)]">{t('claudeConfig.sidebar.loadFailed')}</p>
        <p className="typography-micro text-muted-foreground">{error}</p>
        <Button type="button" size="xs" variant="outline" className="!font-normal" onClick={() => void load(true)}>
          {t('claudeConfig.sidebar.retry')}
        </Button>
      </div>
    );
  } else if (total === 0 && !draftScope) {
    body = (
      <p className="px-2 py-3 typography-meta text-muted-foreground">
        {query ? t('claudeConfig.sidebar.noMatches') : t(KIND_KEYS[kind].empty)}
      </p>
    );
  } else {
    body = (
      <>
        {groups.project.length > 0 || draftScope === 'project' ? (
          <>
            {sectionLabel(t('claudeConfig.group.project'))}
            {draftRow('project')}
            {groups.project.map(renderItem)}
          </>
        ) : null}
        {groups.user.length > 0 || draftScope === 'user' ? (
          <>
            {sectionLabel(t('claudeConfig.group.user'))}
            {draftRow('user')}
            {groups.user.map(renderItem)}
          </>
        ) : null}
        {groups.plugins.map((group) =>
          query ? (
            <React.Fragment key={group.plugin}>
              {sectionLabel(t('claudeConfig.group.plugin', { name: group.plugin }))}
              {group.items.map(renderItem)}
            </React.Fragment>
          ) : (
            <div key={group.plugin} className="pt-2">
              <SidebarGroup
                label={t('claudeConfig.group.plugin', { name: group.plugin })}
                count={group.items.length}
                storageKey={`claude-${kind}`}
                defaultExpanded={false}
              >
                {group.items.map(renderItem)}
              </SidebarGroup>
            </div>
          ),
        )}
      </>
    );
  }

  return <SettingsSidebarLayout header={header}>{body}</SettingsSidebarLayout>;
};
