import React from 'react';
import { RiExternalLinkLine, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { errorText, formatRelativeTime } from '@/components/sections/claude-config/configFields';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import type { MarketplaceInfo, PluginInfo } from '@/lib/claude/types';
import { useClaudeConfigStore } from '@/stores/useClaudeConfigStore';

const CLAUDEKEI_PLUGIN_ID = 'claudekei@claudekei';

const ScopeBadge: React.FC<{ scope: PluginInfo['scope'] }> = ({ scope }) => {
  const { t } = useI18n();
  const label =
    scope === 'user'
      ? t('claudeConfig.plugins.scope.user')
      : scope === 'project'
        ? t('claudeConfig.plugins.scope.project')
        : t('claudeConfig.plugins.scope.local');
  return (
    <span className="typography-micro flex-shrink-0 rounded border border-border/50 bg-muted px-1 pb-px leading-none text-muted-foreground">
      {label}
    </span>
  );
};

type PluginRowProps = {
  plugin: PluginInfo;
  pending: boolean;
  onToggle: (plugin: PluginInfo, enabled: boolean) => void;
  onOpenFile: (path: string) => void;
};

const PluginRow: React.FC<PluginRowProps> = ({ plugin, pending, onToggle, onOpenFile }) => {
  const { t } = useI18n();
  const claudekeiFiles = useClaudeConfigStore((state) => state.snapshot?.claudekeiFiles);
  const configFiles = plugin.id === CLAUDEKEI_PLUGIN_ID ? claudekeiFiles ?? [] : [];
  const userFile = configFiles.find((file) => file.scope === 'user');
  const projectFile = configFiles.find((file) => file.scope === 'project' && file.exists);

  return (
    <div className="py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="typography-ui-label truncate text-foreground">{plugin.name}</span>
            <ScopeBadge scope={plugin.scope} />
          </div>
          <div className="typography-micro truncate text-muted-foreground/70">
            @{plugin.marketplace}
            {plugin.version ? ` · ${t('claudeConfig.plugins.version', { version: plugin.version })}` : ''}
          </div>
        </div>
        <Switch
          checked={plugin.enabled}
          disabled={pending}
          onCheckedChange={(checked) => onToggle(plugin, checked)}
          aria-label={t('claudeConfig.plugins.enabledAria', { name: plugin.name })}
          className="mt-0.5"
        />
      </div>
      {plugin.description ? (
        <p className="mt-1 line-clamp-2 typography-micro text-muted-foreground">{plugin.description}</p>
      ) : null}
      {configFiles.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {userFile ? (
            <Button type="button" size="xs" variant="outline" className="gap-1 !font-normal" onClick={() => onOpenFile(userFile.path)}>
              <RiExternalLinkLine className="h-3 w-3" />
              {t('claudeConfig.editor.openUserConfig')}
            </Button>
          ) : null}
          {projectFile ? (
            <Button type="button" size="xs" variant="outline" className="gap-1 !font-normal" onClick={() => onOpenFile(projectFile.path)}>
              <RiExternalLinkLine className="h-3 w-3" />
              {t('claudeConfig.editor.openProjectConfig')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const MarketplaceRow: React.FC<{ marketplace: MarketplaceInfo; now: number }> = ({ marketplace, now }) => {
  const { t, locale } = useI18n();
  return (
    <div className="py-2">
      <div className="typography-ui-label truncate text-foreground">{marketplace.name}</div>
      <div className="typography-micro truncate font-mono text-muted-foreground/70" title={marketplace.source}>{marketplace.source}</div>
      {marketplace.lastUpdated ? (
        <div className="typography-micro text-muted-foreground/60">
          {t('claudeConfig.plugins.updated', { time: formatRelativeTime(marketplace.lastUpdated, now, locale) })}
        </div>
      ) : null}
    </div>
  );
};

/** Installed Claude Code plugins: enable / disable, marketplaces (read-only) and a config reload. */
export const PluginPage: React.FC = () => {
  const { t } = useI18n();
  const runtimeApis = useRuntimeAPIs();
  const snapshot = useClaudeConfigStore((state) => state.snapshot);
  const loading = useClaudeConfigStore((state) => state.loading);
  const error = useClaudeConfigStore((state) => state.error);
  const load = useClaudeConfigStore((state) => state.load);
  const setPluginEnabled = useClaudeConfigStore((state) => state.setPluginEnabled);
  const reloadClaude = useClaudeConfigStore((state) => state.reloadClaude);
  const [pending, setPending] = React.useState<ReadonlySet<string>>(new Set());
  const [reloading, setReloading] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    void load();
    setNow(Date.now());
  }, [load]);

  const plugins = snapshot?.plugins;
  const sortedPlugins = React.useMemo(
    () => [...(plugins ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [plugins],
  );

  const handleToggle = async (plugin: PluginInfo, enabled: boolean) => {
    setPending((current) => new Set(current).add(plugin.id));
    try {
      await setPluginEnabled(plugin.id, enabled);
    } catch (toggleError) {
      toast.error(t('claudeConfig.plugins.toggleFailed', { name: plugin.name, error: errorText(toggleError) }));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(plugin.id);
        return next;
      });
    }
  };

  const handleReload = async () => {
    setReloading(true);
    try {
      await reloadClaude();
      setNow(Date.now());
      toast.success(t('claudeConfig.plugins.reloaded'));
    } catch (reloadError) {
      toast.error(t('claudeConfig.plugins.reloadFailed', { error: errorText(reloadError) }));
    } finally {
      setReloading(false);
    }
  };

  const handleOpenFile = (path: string) => {
    if (!runtimeApis?.editor) {
      toast.error(t('claudeConfig.toast.openFailed'));
      return;
    }
    void runtimeApis.editor.openFile(path).catch(() => toast.error(t('claudeConfig.toast.openFailed')));
  };

  let installed: React.ReactNode;
  if (!snapshot && loading) {
    installed = <p className="py-6 text-center typography-ui-label text-muted-foreground">{t('claudeConfig.plugins.loading')}</p>;
  } else if (!snapshot && error) {
    installed = (
      <div className="space-y-2 py-6 text-center">
        <p className="typography-ui-label text-[var(--status-error)]">{t('claudeConfig.plugins.loadFailed')}</p>
        <p className="typography-micro text-muted-foreground">{error}</p>
        <Button type="button" size="xs" variant="outline" className="!font-normal" onClick={() => void load(true)}>
          {t('claudeConfig.plugins.retry')}
        </Button>
      </div>
    );
  } else if (sortedPlugins.length === 0) {
    installed = (
      <div className="py-6 text-center text-muted-foreground">
        <p className="typography-ui-label font-medium">{t('claudeConfig.plugins.empty')}</p>
        <p className="typography-meta mt-1 opacity-75">{t('claudeConfig.plugins.emptyHint')}</p>
      </div>
    );
  } else {
    installed = (
      <div className="divide-y divide-[var(--surface-subtle)]">
        {sortedPlugins.map((plugin) => (
          <PluginRow
            key={plugin.id}
            plugin={plugin}
            pending={pending.has(plugin.id)}
            onToggle={(target, enabled) => void handleToggle(target, enabled)}
            onOpenFile={handleOpenFile}
          />
        ))}
      </div>
    );
  }

  return (
    <SettingsPageLayout className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="typography-ui-header font-semibold text-foreground">{t('claudeConfig.plugins.title')}</h2>
          <p className="typography-meta mt-1 text-muted-foreground">{t('claudeConfig.plugins.description')}</p>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="flex-shrink-0 gap-1 !font-normal"
          disabled={reloading}
          onClick={() => void handleReload()}
        >
          <RiRefreshLine className={reloading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          {reloading ? t('claudeConfig.plugins.reloading') : t('claudeConfig.plugins.reload')}
        </Button>
      </div>

      <section>
        <h3 className="mb-1 px-1 typography-ui-header font-medium text-foreground">{t('claudeConfig.plugins.installed')}</h3>
        <div className="px-2">{installed}</div>
        <p className="mt-2 px-3 typography-micro text-muted-foreground">{t('claudeConfig.plugins.sessionsHint')}</p>
      </section>

      <section>
        <h3 className="mb-1 px-1 typography-ui-header font-medium text-foreground">{t('claudeConfig.plugins.marketplaces')}</h3>
        <div className="px-2">
          {snapshot && snapshot.marketplaces.length > 0 ? (
            <div className="divide-y divide-[var(--surface-subtle)]">
              {snapshot.marketplaces.map((marketplace) => (
                <MarketplaceRow key={marketplace.name} marketplace={marketplace} now={now} />
              ))}
            </div>
          ) : snapshot ? (
            <p className="py-3 typography-meta text-muted-foreground">{t('claudeConfig.plugins.marketplacesEmpty')}</p>
          ) : null}
        </div>
      </section>

      <p className="px-1 typography-micro text-muted-foreground">{t('claudeConfig.plugins.footnote')}</p>
    </SettingsPageLayout>
  );
};
