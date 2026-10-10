import React from 'react';
import { RiDeleteBinLine, RiExternalLinkLine, RiFileLine, RiRobot2Line } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
import { useCatalog } from '@/components/chat/hooks/useComposerModel';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ConfigField, ConfigItemDetail, ConfigItemKind, ConfigScope } from '@/lib/claude/types';
import { useClaudeConfigStore } from '@/stores/useClaudeConfigStore';
import {
  AGENT_COLOR_VARS,
  COLOR_OPTIONS,
  EFFORT_OPTIONS,
  KIND_KEYS,
  UNSET_VALUE,
  buildModelOptions,
  emptyFormState,
  errorText,
  fieldSpecsFor,
  formStateFromDetail,
  isFormDirty,
  locationLabel,
  nextFreeName,
  normalizeNameInput,
  validateDraft,
  visibleOtherKeys,
  type FieldSpec,
  type FormState,
} from './configFields';

export interface ConfigItemEditorProps {
  kind: ConfigItemKind;
}

type Option = { value: string; label: string; swatch?: string };

const SectionTitle: React.FC<{ children: React.ReactNode; action?: React.ReactNode }> = ({ children, action }) => (
  <div className="mb-1 flex items-center gap-2 px-1">
    <h3 className="typography-ui-header font-medium text-foreground">{children}</h3>
    {action}
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

/** Select over a closed option list; an empty stored value shows as the "unset" option. */
const OptionSelect: React.FC<{
  value: string;
  options: Option[];
  unsetLabel?: string;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
}> = ({ value, options, unsetLabel, disabled, ariaLabel, onChange }) => {
  const all: Option[] = unsetLabel ? [{ value: UNSET_VALUE, label: unsetLabel }, ...options] : options;
  const current = value === '' && unsetLabel ? UNSET_VALUE : value;
  const active = all.find((option) => option.value === current);
  const swatch = (option?: Option) =>
    option?.swatch ? (
      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: `var(${option.swatch})` }} />
    ) : null;
  return (
    <Select
      value={current}
      disabled={disabled}
      onValueChange={(next) => onChange(next === UNSET_VALUE ? '' : next)}
    >
      <SelectTrigger className="w-full max-w-xs gap-1.5" aria-label={ariaLabel}>
        <SelectValue>
          <span className="flex min-w-0 items-center gap-1.5">
            {swatch(active)}
            <span className="truncate">{active?.label ?? current}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {all.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex items-center gap-1.5">
              {swatch(option)}
              {option.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

type FormProps = {
  kind: ConfigItemKind;
  /** Existing item (edit) or null (create). */
  detail: ConfigItemDetail | null;
  initialScope: ConfigScope;
};

const ItemForm: React.FC<FormProps> = ({ kind, detail, initialScope }) => {
  const { t } = useI18n();
  const runtimeApis = useRuntimeAPIs();
  const catalog = useCatalog();
  const snapshotItems = useClaudeConfigStore((state) => state.snapshot?.items);
  const claudekeiFiles = useClaudeConfigStore((state) => state.snapshot?.claudekeiFiles);
  const save = useClaudeConfigStore((state) => state.save);
  const remove = useClaudeConfigStore((state) => state.remove);

  const isCreate = detail === null;
  const readOnly = !isCreate && (detail.source === 'plugin' || Boolean(detail.error));
  const baseline = React.useMemo<FormState>(() => (detail ? formStateFromDetail(detail) : emptyFormState(kind)), [detail, kind]);

  const [scope, setScope] = React.useState<ConfigScope>(initialScope);
  const [name, setName] = React.useState(() =>
    detail
      ? detail.name
      : nextFreeName(
          `new-${kind}`,
          (snapshotItems ?? []).filter((item) => item.kind === kind && item.source === initialScope).map((item) => item.name),
        ),
  );
  const [form, setForm] = React.useState<FormState>(baseline);
  const [touched, setTouched] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  // Follow reloads of the same item (after save, plugin toggle) as long as there are no unsaved edits.
  const previousBaseline = React.useRef(baseline);
  React.useEffect(() => {
    if (previousBaseline.current !== baseline) {
      if (!isFormDirty(form, previousBaseline.current)) setForm(baseline);
      previousBaseline.current = baseline;
    }
  }, [baseline, form]);

  const specs = fieldSpecsFor(kind);
  const errors = validateDraft(kind, name, form.fields, { checkName: isCreate });
  const dirty = isFormDirty(form, baseline);
  const canSave = !readOnly && !saving && Object.keys(errors).length === 0 && (isCreate || dirty);
  const kindLabel = t(KIND_KEYS[kind].singular);

  const setField = (field: ConfigField, value: string) =>
    setForm((current) => ({ ...current, fields: { ...current.fields, [field]: value } }));

  const openFile = (path: string) => {
    if (!runtimeApis?.editor) {
      toast.error(t('claudeConfig.toast.openFailed'));
      return;
    }
    void runtimeApis.editor.openFile(path).catch(() => toast.error(t('claudeConfig.toast.openFailed')));
  };

  const handleSave = async () => {
    setTouched(true);
    if (!canSave) return;
    setSaving(true);
    try {
      await save({ kind, scope: detail?.source === 'project' || detail?.source === 'user' ? detail.source : scope, name, create: isCreate, fields: form.fields, body: form.body });
      toast.success(t(isCreate ? 'claudeConfig.toast.created' : 'claudeConfig.toast.saved', { name }));
    } catch (error) {
      toast.error(t('claudeConfig.toast.saveFailed', { error: errorText(error) }));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    setDeleting(true);
    try {
      await remove(detail.path);
      toast.success(t('claudeConfig.toast.deleted', { name: detail.name }));
      setDeleteOpen(false);
    } catch (error) {
      toast.error(t('claudeConfig.toast.deleteFailed', { error: errorText(error) }));
    } finally {
      setDeleting(false);
    }
  };

  const effectiveScope: ConfigScope | 'plugin' = detail ? detail.source : scope;
  const subtitle =
    effectiveScope === 'plugin'
      ? t('claudeConfig.editor.location.plugin', { plugin: detail?.plugin?.split('@')[0] ?? '' })
      : t(effectiveScope === 'user' ? 'claudeConfig.editor.location.user' : 'claudeConfig.editor.location.project', {
          path: locationLabel(effectiveScope, kind),
        });

  const preset = kind === 'agent' && detail ? catalog?.primaryAgents.find((agent) => agent.name === detail.name) : undefined;
  const claudekeiFile = claudekeiFiles?.find((file) => file.scope === 'project' && file.exists) ?? claudekeiFiles?.find((file) => file.scope === 'user');

  const renderControl = (spec: FieldSpec) => {
    const value = form.fields[spec.field] ?? '';
    const label = t(spec.label);
    if (spec.input === 'textarea') {
      return (
        <Textarea
          value={value}
          disabled={readOnly}
          onChange={(event) => setField(spec.field, event.target.value)}
          placeholder={spec.placeholder ? t(spec.placeholder) : undefined}
          rows={2}
          aria-label={label}
          className="w-full resize-none min-h-[60px] max-h-32 bg-transparent"
        />
      );
    }
    if (spec.input === 'model') {
      const options = buildModelOptions(catalog?.models ?? [], value, kind === 'agent' ? t('claudeConfig.field.model.inherit') : null);
      return (
        <OptionSelect
          value={kind === 'agent' && value === '' ? 'inherit' : value}
          options={options}
          unsetLabel={kind === 'command' ? t('claudeConfig.field.model.inherit') : undefined}
          disabled={readOnly}
          ariaLabel={label}
          onChange={(next) => setField(spec.field, next)}
        />
      );
    }
    if (spec.input === 'effort') {
      return (
        <OptionSelect
          value={value}
          options={EFFORT_OPTIONS.map((level) => ({ value: level, label: level }))}
          unsetLabel={t('claudeConfig.field.effort.default')}
          disabled={readOnly}
          ariaLabel={label}
          onChange={(next) => setField(spec.field, next)}
        />
      );
    }
    if (spec.input === 'color') {
      const options: Option[] = COLOR_OPTIONS.map((color) => ({ value: color, label: color, swatch: AGENT_COLOR_VARS[color] }));
      if (value && !COLOR_OPTIONS.includes(value)) options.push({ value, label: value });
      return (
        <OptionSelect
          value={value}
          options={options}
          unsetLabel={t('claudeConfig.field.color.none')}
          disabled={readOnly}
          ariaLabel={label}
          onChange={(next) => setField(spec.field, next)}
        />
      );
    }
    return (
      <Input
        value={value}
        disabled={readOnly}
        onChange={(event) => setField(spec.field, event.target.value)}
        placeholder={spec.placeholder ? t(spec.placeholder) : undefined}
        aria-label={label}
        className="h-8 w-full"
      />
    );
  };

  const nameError =
    touched || name.length > 0
      ? errors.name === 'invalidName'
        ? t('claudeConfig.field.name.invalid')
        : errors.name === 'required' && touched
          ? t('claudeConfig.field.name.required')
          : undefined
      : undefined;

  const skillFiles = kind === 'skill' ? detail?.files ?? [] : [];
  const skillDir = detail ? detail.path.replace(/[\\/]SKILL\.md$/i, '') : '';

  return (
    <SettingsPageLayout className="space-y-0">
      <div className="mb-4 min-w-0">
        <h2 className="typography-ui-header truncate font-semibold text-foreground">
          {detail ? detail.name : t('claudeConfig.editor.newTitle', { kind: kindLabel })}
        </h2>
        <p className="typography-meta truncate text-muted-foreground">{subtitle}</p>
      </div>

      {readOnly && detail?.source === 'plugin' ? (
        <p className="mb-3 typography-meta text-muted-foreground">{t('claudeConfig.editor.pluginReadOnly')}</p>
      ) : null}
      {detail?.shadowed ? (
        <p className="mb-3 typography-meta text-[var(--status-warning)]">{t('claudeConfig.editor.shadowed', { kind: kindLabel })}</p>
      ) : null}
      {detail?.error ? (
        <div className="mb-3 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2">
          <p className="typography-meta break-words text-[var(--status-error)]">{t('claudeConfig.editor.parseError', { error: detail.error })}</p>
        </div>
      ) : null}
      {preset ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/60 px-3 py-2">
          <RiRobot2Line className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="typography-meta min-w-0 flex-1 text-muted-foreground">
            {t('claudeConfig.editor.preset', {
              model: preset.defaultModel ?? t('claudeConfig.editor.presetDefault'),
              effort: preset.defaultEffort ?? t('claudeConfig.editor.presetDefault'),
            })}
          </span>
          {claudekeiFile ? (
            <Button type="button" size="xs" variant="outline" className="!font-normal" onClick={() => openFile(claudekeiFile.path)}>
              {t('claudeConfig.editor.openClaudekeiConfig')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {detail?.error ? null : (
        <>
      <div className="mb-6">
        <SectionTitle>{t('claudeConfig.editor.section.details')}</SectionTitle>
        <section className="space-y-0 px-2 pb-2">
          {isCreate ? (
            <>
              <FieldRow label={t('claudeConfig.field.name.label')} hint={t('claudeConfig.field.name.hint')} error={nameError} required>
                <Input
                  value={name}
                  onChange={(event) => {
                    setTouched(true);
                    setName(normalizeNameInput(event.target.value));
                  }}
                  placeholder={t('claudeConfig.field.name.placeholder', { kind: kindLabel })}
                  aria-label={t('claudeConfig.field.name.label')}
                  className="h-8 w-full max-w-xs"
                />
              </FieldRow>
              <FieldRow label={t('claudeConfig.field.scope.label')}>
                <OptionSelect
                  value={scope}
                  options={[
                    { value: 'user', label: t('claudeConfig.field.scope.user') },
                    { value: 'project', label: t('claudeConfig.field.scope.project') },
                  ]}
                  ariaLabel={t('claudeConfig.field.scope.label')}
                  onChange={(next) => setScope(next === 'project' ? 'project' : 'user')}
                />
              </FieldRow>
            </>
          ) : null}
          {specs.map((spec) => (
            <FieldRow
              key={spec.field}
              label={t(spec.label)}
              hint={t(spec.hint)}
              required={spec.required}
              error={touched && errors[spec.field] ? t('claudeConfig.field.required') : undefined}
            >
              {renderControl(spec)}
            </FieldRow>
          ))}
        </section>
      </div>

      <div className="mb-6">
        <SectionTitle>{t(KIND_KEYS[kind].body)}</SectionTitle>
        <section className="px-2 pb-2">
          <Textarea
            value={form.body}
            disabled={readOnly}
            onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))}
            placeholder={t(KIND_KEYS[kind].bodyPlaceholder)}
            aria-label={t(KIND_KEYS[kind].body)}
            className="min-h-[220px] max-h-[60vh] font-mono typography-meta"
          />
        </section>
      </div>

      {kind === 'skill' && detail ? (
        <div className="mb-6">
          <SectionTitle>{t('claudeConfig.editor.section.files')}</SectionTitle>
          <section className="px-2 pb-2">
            {skillFiles.length === 0 ? (
              <p className="py-1.5 typography-meta text-muted-foreground">{t('claudeConfig.editor.filesEmpty')}</p>
            ) : (
              <div className="divide-y divide-[var(--surface-subtle)]">
                {skillFiles.map((file) => (
                  <div key={file} className="flex items-center gap-2 py-1.5">
                    <RiFileLine className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="typography-ui-label min-w-0 flex-1 truncate text-foreground" title={file}>{file}</span>
                    <Button type="button" size="xs" variant="ghost" className="!font-normal" onClick={() => openFile(`${skillDir}/${file}`)}>
                      {t('claudeConfig.action.open')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}

        </>
      )}

      {detail && !readOnly && visibleOtherKeys(detail.otherKeys).length > 0 ? (
        <p className="mb-3 px-1 typography-micro text-muted-foreground">
          {t('claudeConfig.editor.otherKeys', { keys: visibleOtherKeys(detail.otherKeys).join(', ') })}
        </p>
      ) : null}

      <div className={cn('flex flex-wrap items-center gap-2 px-2 py-1')}>
        {!readOnly ? (
          <Button type="button" size="xs" className="!font-normal" disabled={!canSave} onClick={() => void handleSave()}>
            {saving ? t('claudeConfig.action.saving') : isCreate ? t('claudeConfig.action.create') : t('claudeConfig.action.save')}
          </Button>
        ) : null}
        {detail ? (
          <Button type="button" size="xs" variant="outline" className="gap-1 !font-normal" onClick={() => openFile(detail.path)}>
            <RiExternalLinkLine className="h-3.5 w-3.5" />
            {t('claudeConfig.action.openInEditor')}
          </Button>
        ) : null}
        {detail && !readOnly ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto gap-1 !font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
            onClick={() => setDeleteOpen(true)}
          >
            <RiDeleteBinLine className="h-3.5 w-3.5" />
            {t('claudeConfig.action.delete')}
          </Button>
        ) : null}
      </div>
      {!readOnly ? <p className="px-3 pt-2 typography-micro text-muted-foreground">{t('claudeConfig.editor.sessionsHint')}</p> : null}

      <Dialog open={deleteOpen} onOpenChange={(open) => { if (!open && !deleting) setDeleteOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('claudeConfig.deleteDialog.title', { kind: kindLabel })}</DialogTitle>
            <DialogDescription>{t('claudeConfig.deleteDialog.description', { name: detail?.name ?? '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              {t('claudeConfig.action.cancel')}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {t('claudeConfig.action.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
};

/** Draft counter so "New" twice in a row resets the form (the selection object changes identity). */
const draftIds = new WeakMap<object, number>();
let nextDraftId = 1;
const draftKey = (selection: object): number => {
  let id = draftIds.get(selection);
  if (!id) {
    id = nextDraftId++;
    draftIds.set(selection, id);
  }
  return id;
};

/** Field-table form for one agent / command / skill: edit, create (draft) or read-only for plugin items. */
export const ConfigItemEditor: React.FC<ConfigItemEditorProps> = ({ kind }) => {
  const { t } = useI18n();
  const selected = useClaudeConfigStore((state) => state.selected[kind]);
  const detail = useClaudeConfigStore((state) => state.detail);
  const detailLoading = useClaudeConfigStore((state) => state.detailLoading);
  const detailError = useClaudeConfigStore((state) => state.detailError);
  const openDetail = useClaudeConfigStore((state) => state.openDetail);
  const selectedPath = selected && 'path' in selected ? selected.path : null;

  // The detail is shared by all kinds, so another page may have replaced it: reload when it is not ours.
  // Never retries after a failure (detailError), so a failing read cannot loop.
  React.useEffect(() => {
    if (selectedPath && detail?.path !== selectedPath && !detailLoading && !detailError) {
      void openDetail(selectedPath);
    }
  }, [selectedPath, detail?.path, detailLoading, detailError, openDetail]);

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center text-muted-foreground">
          <p className="typography-body">{t(KIND_KEYS[kind].selectPrompt)}</p>
          <p className="typography-meta mt-1 opacity-75">{t('claudeConfig.selectHint')}</p>
        </div>
      </div>
    );
  }

  if ('draft' in selected) {
    return <ItemForm key={`draft-${draftKey(selected)}`} kind={kind} detail={null} initialScope={selected.draft} />;
  }

  if (detailError && (!detail || detail.path !== selected.path)) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="space-y-2 text-center">
          <p className="typography-ui-label text-[var(--status-error)]">{t('claudeConfig.editor.loadFailed')}</p>
          <p className="typography-micro break-words text-muted-foreground">{detailError}</p>
          <Button type="button" size="xs" variant="outline" className="!font-normal" onClick={() => void openDetail(selected.path)}>
            {t('claudeConfig.sidebar.retry')}
          </Button>
        </div>
      </div>
    );
  }

  if (detailLoading && (!detail || detail.path !== selected.path)) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="typography-body text-muted-foreground">{t('claudeConfig.editor.loading')}</p>
      </div>
    );
  }

  if (!detail || detail.path !== selected.path) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="typography-body text-muted-foreground">{t('claudeConfig.editor.loading')}</p>
      </div>
    );
  }

  return <ItemForm key={detail.path} kind={kind} detail={detail} initialScope={detail.source === 'project' ? 'project' : 'user'} />;
};
