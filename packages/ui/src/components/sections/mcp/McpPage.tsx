import React from 'react';
import { RiDeleteBinLine, RiExternalLinkLine, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { MCP_STATUS_KEYS, useMcpToggle } from '@/components/mcp/mcpStatus';
import { McpStatusDot } from '@/components/mcp/McpStatusDot';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { McpServerInfo, McpServerScope } from '@/lib/claude/types';
import { useClaudeConfigStore } from '@/stores/useClaudeConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import {
  configFromForm,
  formFromConfig,
  isMcpFormDirty,
  validateMcpForm,
  type McpFormState,
  type McpTransportType,
} from './mcpForm';

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mb-1 px-1">
    <h3 className="typography-ui-header font-medium text-foreground">{children}</h3>
  </div>
);

const FieldRow: React.FC<{ label: string; hint?: string; error?: string; required?: boolean; children: React.ReactNode }> = ({
  label,
  hint,
  error,
  required,
  children,
}) => (
  <div className="py-1.5">
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="typography-ui-label text-foreground">
        {label}
        {required ? <span className="ml-0.5 text-[var(--status-error)]">*</span> : null}
      </span>
      {hint ? <span className="typography-micro text-muted-foreground">{hint}</span> : null}
    </div>
    <div className="mt-1.5">{children}</div>
    {error ? <p className="mt-1 typography-micro text-[var(--status-error)]">{error}</p> : null}
  </div>
);

const OptionSelect: React.FC<{
  value: string;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  onChange: (value: string) => void;
}> = ({ value, options, ariaLabel, onChange }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger className="w-full max-w-xs gap-1.5" aria-label={ariaLabel}>
      <SelectValue>
        <span className="truncate">{options.find((option) => option.value === value)?.label ?? value}</span>
      </SelectValue>
    </SelectTrigger>
    <SelectContent align="start">
      {options.map((option) => (
        <SelectItem key={option.value} value={option.value}>
          {option.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const originLabelKey = (origin: string) =>
  ['user', 'local', 'project', 'plugin', 'claudeai', 'managed'].includes(origin)
    ? (`claudeMcp.origin.${origin}` as 'claudeMcp.origin.user')
    : null;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type McpFormProps = {
  /** Existing server, or null while creating one. */
  server: McpServerInfo | null;
};

const McpForm: React.FC<McpFormProps> = ({ server }) => {
  const { t } = useI18n();
  const runtimeApis = useRuntimeAPIs();
  const save = useMcpStore((state) => state.save);
  const remove = useMcpStore((state) => state.remove);
  const toggleSupported = useMcpStore((state) => state.toggleSupported);
  const snapshotError = useMcpStore((state) => state.snapshot?.error);
  const refresh = useMcpStore((state) => state.refresh);
  const loading = useMcpStore((state) => state.loading);
  const toggle = useMcpToggle();

  const isCreate = server === null;
  const scope: McpServerScope | undefined = server?.scope;
  const readOnly = !isCreate && scope === undefined;
  const baseline = React.useMemo<McpFormState>(() => formFromConfig(server?.config), [server?.config]);

  const [name, setName] = React.useState('');
  const [createScope, setCreateScope] = React.useState<'user' | 'local'>('user');
  const [form, setForm] = React.useState<McpFormState>(baseline);
  const [touched, setTouched] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  // Follow reloads of the same server as long as there are no unsaved edits.
  const previousBaseline = React.useRef(baseline);
  React.useEffect(() => {
    if (previousBaseline.current !== baseline) {
      if (!isMcpFormDirty(form, previousBaseline.current)) setForm(baseline);
      previousBaseline.current = baseline;
    }
  }, [baseline, form]);

  const errors = validateMcpForm(form, isCreate ? name : null);
  const dirty = isMcpFormDirty(form, baseline);
  const canSave = !readOnly && !saving && Object.keys(errors).length === 0 && (isCreate || dirty);

  const setField = <K extends keyof McpFormState>(field: K, value: McpFormState[K]) =>
    setForm((current) => ({ ...current, [field]: value }));

  const openMcpJson = async () => {
    try {
      const configStore = useClaudeConfigStore.getState();
      if (!configStore.snapshot) await configStore.load();
      const path = useClaudeConfigStore.getState().snapshot?.projectMcpFile.path;
      if (!path || !runtimeApis?.editor) throw new Error('unavailable');
      await runtimeApis.editor.openFile(path);
    } catch {
      toast.error(t('claudeMcp.toast.openFailed'));
    }
  };

  const handleSave = async () => {
    setTouched(true);
    if (!canSave) return;
    setSaving(true);
    try {
      await save(isCreate ? name : server.name, isCreate ? createScope : (scope as McpServerScope), configFromForm(form), isCreate);
      toast.success(t(isCreate ? 'claudeMcp.toast.created' : 'claudeMcp.toast.saved', { name: isCreate ? name : server.name }));
    } catch (error) {
      toast.error(t('claudeMcp.toast.saveFailed', { error: errorText(error) }));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!server || !scope) return;
    setDeleting(true);
    try {
      await remove(server.name, scope);
      toast.success(t('claudeMcp.toast.deleted', { name: server.name }));
      setDeleteOpen(false);
    } catch (error) {
      toast.error(t('claudeMcp.toast.deleteFailed', { error: errorText(error) }));
    } finally {
      setDeleting(false);
    }
  };

  const originKey = server ? originLabelKey(server.origin) : null;
  const originText = server ? (originKey ? t(originKey) : server.origin) : '';
  const subtitle = !server
    ? t('claudeMcp.page.sessionsHint')
    : t(readOnly ? 'claudeMcp.page.subtitle.readOnly' : 'claudeMcp.page.subtitle.scope', { origin: originText });
  const textareaClass = 'min-h-[72px] max-h-48 w-full font-mono typography-meta';

  const typeOptions: Array<{ value: McpTransportType; label: string }> = [
    { value: 'stdio', label: t('claudeMcp.field.type.stdio') },
    { value: 'http', label: t('claudeMcp.field.type.http') },
    { value: 'sse', label: t('claudeMcp.field.type.sse') },
  ];

  const statusLabel = server ? t(MCP_STATUS_KEYS[server.status]) : '';

  return (
    <SettingsPageLayout className="space-y-0">
      <div className="mb-4 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="typography-ui-header truncate font-semibold text-foreground" title={server?.name}>
            {server ? server.name : t('claudeMcp.page.newTitle')}
          </h2>
          <p className="typography-meta truncate text-muted-foreground">{subtitle}</p>
        </div>
        {server ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="flex-shrink-0 gap-1 !font-normal"
            disabled={loading}
            onClick={() => void refresh(true)}
          >
            <RiRefreshLine className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {t('claudeMcp.action.refresh')}
          </Button>
        ) : null}
      </div>

      {snapshotError ? (
        <div className="mb-3 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2">
          <p className="typography-meta break-words text-[var(--status-error)]">{t('claudeMcp.page.snapshotError', { error: snapshotError })}</p>
        </div>
      ) : null}

      {server ? (
        <div className="mb-4 rounded-lg border border-border/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <McpStatusDot status={server.status} label={statusLabel} />
            <span className="typography-ui-label min-w-0 flex-1 truncate text-foreground">{statusLabel}</span>
            {server.serverInfo ? (
              <span className="typography-micro flex-shrink-0 text-muted-foreground">
                {server.serverInfo.name} {server.serverInfo.version}
              </span>
            ) : null}
          </div>
          {server.status === 'connected' ? (
            <p className="mt-1 typography-micro text-muted-foreground">{t('claudeMcp.status.tools', { count: server.toolCount })}</p>
          ) : null}
          {server.status === 'needs-auth' ? (
            <p className="mt-1 typography-meta text-[var(--status-warning)]">{t('claudeMcp.page.needsAuthHint')}</p>
          ) : null}
          {server.error ? (
            <p className="mt-1 break-words typography-meta text-[var(--status-error)]">{t('claudeMcp.page.serverError', { error: server.error })}</p>
          ) : null}
          <div className="mt-2 flex items-center gap-2 border-t border-border/40 pt-2">
            <div className="min-w-0 flex-1">
              <div className="typography-ui-label text-foreground">{t('claudeMcp.page.enabled')}</div>
              <div className="typography-micro text-muted-foreground">
                {toggleSupported ? t('claudeMcp.page.enabledHint') : t('claudeMcp.toggleUnsupported')}
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
        </div>
      ) : null}

      {readOnly ? (
        <p className="mb-3 typography-meta text-muted-foreground">{t('claudeMcp.page.readOnlyNote')}</p>
      ) : (
        <div className="mb-6">
          <SectionTitle>{t('claudeMcp.section.details')}</SectionTitle>
          <section className="space-y-0 px-2 pb-2">
            {isCreate ? (
              <>
                <FieldRow
                  label={t('claudeMcp.field.name.label')}
                  hint={t('claudeMcp.field.name.hint')}
                  required
                  error={touched || name ? (errors.name ? t('claudeMcp.field.name.invalid') : undefined) : undefined}
                >
                  <Input
                    value={name}
                    onChange={(event) => {
                      setTouched(true);
                      setName(event.target.value.trim());
                    }}
                    placeholder={t('claudeMcp.field.name.placeholder')}
                    aria-label={t('claudeMcp.field.name.label')}
                    className="h-8 w-full max-w-xs"
                  />
                </FieldRow>
                <FieldRow label={t('claudeMcp.field.scope.label')} hint={t('claudeMcp.field.scope.hint')}>
                  <OptionSelect
                    value={createScope}
                    options={[
                      { value: 'user', label: t('claudeMcp.field.scope.user') },
                      { value: 'local', label: t('claudeMcp.field.scope.local') },
                    ]}
                    ariaLabel={t('claudeMcp.field.scope.label')}
                    onChange={(next) => setCreateScope(next === 'local' ? 'local' : 'user')}
                  />
                </FieldRow>
              </>
            ) : null}

            <FieldRow label={t('claudeMcp.field.type.label')}>
              <OptionSelect
                value={form.type}
                options={typeOptions}
                ariaLabel={t('claudeMcp.field.type.label')}
                onChange={(next) => setField('type', next === 'http' || next === 'sse' ? next : 'stdio')}
              />
            </FieldRow>

            {form.type === 'stdio' ? (
              <>
                <FieldRow
                  label={t('claudeMcp.field.command.label')}
                  required
                  error={touched && errors.command ? t('claudeMcp.field.command.required') : undefined}
                >
                  <Input
                    value={form.command}
                    onChange={(event) => setField('command', event.target.value)}
                    placeholder={t('claudeMcp.field.command.placeholder')}
                    aria-label={t('claudeMcp.field.command.label')}
                    className="h-8 w-full font-mono"
                  />
                </FieldRow>
                <FieldRow label={t('claudeMcp.field.args.label')} hint={t('claudeMcp.field.args.hint')}>
                  <Textarea
                    value={form.args}
                    onChange={(event) => setField('args', event.target.value)}
                    placeholder={t('claudeMcp.field.args.placeholder')}
                    aria-label={t('claudeMcp.field.args.label')}
                    className={textareaClass}
                  />
                </FieldRow>
                <FieldRow
                  label={t('claudeMcp.field.env.label')}
                  hint={t('claudeMcp.field.env.hint')}
                  error={errors.env ? t('claudeMcp.field.env.invalid', { line: errors.env }) : undefined}
                >
                  <Textarea
                    value={form.env}
                    onChange={(event) => setField('env', event.target.value)}
                    placeholder={t('claudeMcp.field.env.placeholder')}
                    aria-label={t('claudeMcp.field.env.label')}
                    className={textareaClass}
                  />
                </FieldRow>
              </>
            ) : (
              <>
                <FieldRow
                  label={t('claudeMcp.field.url.label')}
                  required
                  error={(touched || form.url) && errors.url ? t('claudeMcp.field.url.invalid') : undefined}
                >
                  <Input
                    value={form.url}
                    onChange={(event) => setField('url', event.target.value)}
                    placeholder={t('claudeMcp.field.url.placeholder')}
                    aria-label={t('claudeMcp.field.url.label')}
                    className="h-8 w-full font-mono"
                  />
                </FieldRow>
                <FieldRow
                  label={t('claudeMcp.field.headers.label')}
                  hint={t('claudeMcp.field.headers.hint')}
                  error={errors.headers ? t('claudeMcp.field.headers.invalid', { line: errors.headers }) : undefined}
                >
                  <Textarea
                    value={form.headers}
                    onChange={(event) => setField('headers', event.target.value)}
                    placeholder={t('claudeMcp.field.headers.placeholder')}
                    aria-label={t('claudeMcp.field.headers.label')}
                    className={textareaClass}
                  />
                </FieldRow>
              </>
            )}
          </section>
        </div>
      )}

      {scope === 'project' ? <p className="mb-3 px-1 typography-micro text-muted-foreground">{t('claudeMcp.page.projectNote')}</p> : null}

      <div className="flex flex-wrap items-center gap-2 px-2 py-1">
        {!readOnly ? (
          <Button type="button" size="xs" className="!font-normal" disabled={!canSave} onClick={() => void handleSave()}>
            {saving ? t('claudeMcp.action.saving') : isCreate ? t('claudeMcp.action.create') : t('claudeMcp.action.save')}
          </Button>
        ) : null}
        {!readOnly ? (
          <Button type="button" size="xs" variant="outline" className="gap-1 !font-normal" onClick={() => void openMcpJson()}>
            <RiExternalLinkLine className="h-3.5 w-3.5" />
            {t('claudeMcp.action.openMcpJson')}
          </Button>
        ) : null}
        {server && !readOnly ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto gap-1 !font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
            onClick={() => setDeleteOpen(true)}
          >
            <RiDeleteBinLine className="h-3.5 w-3.5" />
            {t('claudeMcp.action.delete')}
          </Button>
        ) : null}
      </div>
      {!readOnly ? <p className="px-3 pt-2 typography-micro text-muted-foreground">{t('claudeMcp.page.sessionsHint')}</p> : null}

      <Dialog open={deleteOpen} onOpenChange={(open) => { if (!open && !deleting) setDeleteOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('claudeMcp.deleteDialog.title')}</DialogTitle>
            <DialogDescription>{t('claudeMcp.deleteDialog.description', { name: server?.name ?? '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              {t('claudeMcp.action.cancel')}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {t('claudeMcp.action.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
};

/** MCP server editor: create, edit (user / local / project servers) or inspect read-only (plugin, claude.ai, managed). */
export const McpPage: React.FC = () => {
  const { t } = useI18n();
  const selected = useMcpStore((state) => state.selected);
  const server = useMcpStore((state) =>
    state.selected && state.selected !== 'new' ? state.snapshot?.servers.find((entry) => entry.name === state.selected) ?? null : null,
  );
  const hasSnapshot = useMcpStore((state) => state.snapshot !== null);

  if (selected === 'new') return <McpForm key="new" server={null} />;
  if (selected && server) return <McpForm key={server.name} server={server} />;

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="text-center text-muted-foreground">
        <p className="typography-body">{selected && hasSnapshot ? t('claudeMcp.page.notFound') : t('claudeMcp.page.selectPrompt')}</p>
        <p className="typography-meta mt-1 opacity-75">{t('claudeMcp.page.selectHint')}</p>
      </div>
    </div>
  );
};
