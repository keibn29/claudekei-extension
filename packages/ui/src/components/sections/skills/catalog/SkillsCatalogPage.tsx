import React from 'react';
import { RiAlertLine, RiDownloadLine, RiLoader4Line, RiSearchLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { claudeClient } from '@/lib/claude/client';
import type { ConfigScope, SkillCatalogItem } from '@/lib/claude/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useClaudeConfigStore } from '@/stores/useClaudeConfigStore';

const DEFAULT_SOURCE = 'anthropics/skills';

type ScanResult = { source: string; items: SkillCatalogItem[] };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const InstalledBadge: React.FC<{ scopes: ConfigScope[] }> = ({ scopes }) => {
  const { t } = useI18n();
  if (scopes.length === 0) return null;
  const label =
    scopes.length > 1
      ? t('claudeSkillsCatalog.badge.installedBoth')
      : scopes[0] === 'user'
        ? t('claudeSkillsCatalog.badge.installedUser')
        : t('claudeSkillsCatalog.badge.installedProject');
  return (
    <span className="typography-micro flex-shrink-0 rounded border border-border/50 bg-muted px-1 pb-px leading-none text-muted-foreground">
      {label}
    </span>
  );
};

type SkillRowProps = {
  item: SkillCatalogItem;
  checked: boolean;
  onToggle: (dir: string, checked: boolean) => void;
};

const SkillRow = React.memo(function SkillRow({ item, checked, onToggle }: SkillRowProps) {
  const { t } = useI18n();
  const disabled = !item.installable;
  return (
    <li
      className={cn('flex items-start gap-2.5 px-3 py-2', disabled && 'opacity-70')}
      data-skill-dir={item.dir}
    >
      <div className="pt-0.5">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onChange={(next) => onToggle(item.dir, next)}
          ariaLabel={t('claudeSkillsCatalog.list.selectAria', { name: item.name })}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="typography-ui-label min-w-0 truncate text-foreground" title={item.dir}>{item.name}</span>
          <InstalledBadge scopes={item.installed} />
        </div>
        {item.description ? (
          <p className="typography-micro line-clamp-2 text-muted-foreground">{item.description}</p>
        ) : null}
        {disabled ? (
          <p className="typography-micro mt-0.5 flex items-start gap-1 text-[var(--status-warning)]">
            <RiAlertLine className="mt-px h-3 w-3 flex-shrink-0" aria-hidden="true" />
            <span>{item.warning ?? t('claudeSkillsCatalog.notInstallable')}</span>
          </p>
        ) : null}
      </div>
    </li>
  );
});

/** Scans a public git repository for skills and installs the selected ones (all state is local to the page). */
export const SkillsCatalogPage: React.FC = () => {
  const { t } = useI18n();
  const [sourceInput, setSourceInput] = React.useState(DEFAULT_SOURCE);
  const [result, setResult] = React.useState<ScanResult | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [scope, setScope] = React.useState<ConfigScope>('user');
  const [overwrite, setOverwrite] = React.useState(false);
  const [installing, setInstalling] = React.useState(false);

  const installable = React.useMemo(() => (result?.items ?? []).filter((item) => item.installable), [result]);
  const allSelected = installable.length > 0 && installable.every((item) => selected.has(item.dir));
  const someSelected = selected.size > 0 && !allSelected;

  const scan = async (refresh: boolean) => {
    const source = sourceInput.trim() || DEFAULT_SOURCE;
    setScanning(true);
    setScanError(null);
    try {
      const next = await claudeClient.skillsCatalog(source, refresh);
      setResult(next);
      setSelected(new Set());
    } catch (error) {
      setScanError(errorText(error));
    } finally {
      setScanning(false);
    }
  };

  const handleScan = () => {
    // Scanning the source that is already listed asks the host to bypass its cache.
    void scan(result !== null && result.source === (sourceInput.trim() || DEFAULT_SOURCE));
  };

  const handleToggle = React.useCallback((dir: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(dir);
      else next.delete(dir);
      return next;
    });
  }, []);

  const handleToggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(installable.map((item) => item.dir)) : new Set());
  };

  const handleInstall = async () => {
    if (!result || selected.size === 0) return;
    setInstalling(true);
    try {
      const response = await claudeClient.installSkills(result.source, [...selected], scope, overwrite);
      if (response.installed.length > 0) {
        toast.success(
          t('claudeSkillsCatalog.result.installed', { count: response.installed.length, names: response.installed.join(', ') }),
        );
      } else if (response.skipped.length === 0) {
        toast.info(t('claudeSkillsCatalog.result.nothing'));
      }
      for (const skipped of response.skipped) {
        toast.warning(t('claudeSkillsCatalog.result.skipped', { name: skipped.name, reason: skipped.reason }));
      }
      setSelected(new Set());
      // The installed badges come from the scan, and Skills / autocompletes read the config snapshot.
      void useClaudeConfigStore.getState().load(true);
      void claudeClient
        .skillsCatalog(result.source, false)
        .then((next) => setResult(next))
        .catch(() => undefined);
    } catch (error) {
      toast.error(t('claudeSkillsCatalog.result.failed', { error: errorText(error) }));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <SettingsPageLayout>
      <section className="space-y-2">
        <div className="px-1">
          <h2 className="typography-ui-header font-semibold text-foreground">{t('claudeSkillsCatalog.title')}</h2>
          <p className="typography-meta text-muted-foreground">{t('claudeSkillsCatalog.description')}</p>
        </div>
        <div className="space-y-1 px-1">
          <label htmlFor="skills-catalog-source" className="typography-micro uppercase tracking-wide text-muted-foreground/80">
            {t('claudeSkillsCatalog.source.label')}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="skills-catalog-source"
              value={sourceInput}
              onChange={(event) => setSourceInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !scanning) {
                  event.preventDefault();
                  handleScan();
                }
              }}
              placeholder={t('claudeSkillsCatalog.source.placeholder')}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="min-w-0 flex-1 font-mono"
            />
            <Button type="button" size="sm" className="flex-shrink-0 gap-1.5" disabled={scanning} onClick={handleScan}>
              {scanning ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiSearchLine className="h-4 w-4" />}
              {scanning ? t('claudeSkillsCatalog.scanning') : t('claudeSkillsCatalog.scan')}
            </Button>
          </div>
          <p className="typography-micro text-muted-foreground/70">{t('claudeSkillsCatalog.source.hint')}</p>
        </div>
        {scanError ? (
          <div className="typography-meta rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 text-[var(--status-error)]" role="alert">
            {t('claudeSkillsCatalog.scanFailed', { error: scanError })}
          </div>
        ) : null}
      </section>

      <section>
        {result === null ? (
          scanning ? null : <p className="typography-meta px-1 text-muted-foreground">{t('claudeSkillsCatalog.empty.idle')}</p>
        ) : result.items.length === 0 ? (
          <p className="typography-meta px-1 text-muted-foreground">{t('claudeSkillsCatalog.empty.none', { source: result.source })}</p>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <h3 className="typography-ui-header min-w-0 truncate font-medium text-foreground" title={result.source}>
                {t('claudeSkillsCatalog.list.heading', { source: result.source })}
              </h3>
              <label className="flex flex-shrink-0 cursor-pointer items-center gap-1.5">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  disabled={installable.length === 0}
                  onChange={handleToggleAll}
                  ariaLabel={t('claudeSkillsCatalog.list.selectAllAria')}
                />
                <span className="typography-micro text-muted-foreground">{t('claudeSkillsCatalog.list.selectAll')}</span>
              </label>
            </div>
            <ul className={cn('divide-y divide-border/40 rounded-lg border border-border/40 bg-[var(--surface-elevated)]', scanning && 'opacity-60')}>
              {result.items.map((item) => (
                <SkillRow key={item.dir} item={item} checked={selected.has(item.dir)} onToggle={handleToggle} />
              ))}
            </ul>
          </>
        )}
      </section>

      {result && result.items.length > 0 ? (
        <section className="space-y-2 rounded-lg border border-border/40 bg-[var(--surface-elevated)] p-3" data-skills-install-footer>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="typography-meta flex-shrink-0 text-muted-foreground">{t('claudeSkillsCatalog.footer.scope')}</span>
              <Select value={scope} onValueChange={(next) => setScope(next as ConfigScope)} disabled={installing}>
                <SelectTrigger className="w-auto min-w-0 gap-1.5" aria-label={t('claudeSkillsCatalog.footer.scope')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="user">{t('claudeSkillsCatalog.footer.scopeUser')}</SelectItem>
                  <SelectItem value="project">{t('claudeSkillsCatalog.footer.scopeProject')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex cursor-pointer items-center gap-1.5">
              <Checkbox checked={overwrite} disabled={installing} onChange={setOverwrite} ariaLabel={t('claudeSkillsCatalog.footer.overwrite')} />
              <span className="typography-meta text-foreground">{t('claudeSkillsCatalog.footer.overwrite')}</span>
            </label>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="typography-micro text-muted-foreground">{t('claudeSkillsCatalog.list.selected', { count: selected.size })}</span>
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={installing || selected.size === 0}
              onClick={() => void handleInstall()}
            >
              {installing ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiDownloadLine className="h-4 w-4" />}
              {installing
                ? t('claudeSkillsCatalog.footer.installing')
                : selected.size > 0
                  ? t('claudeSkillsCatalog.footer.installCount', { count: selected.size })
                  : t('claudeSkillsCatalog.footer.install')}
            </Button>
          </div>
        </section>
      ) : null}
    </SettingsPageLayout>
  );
};
