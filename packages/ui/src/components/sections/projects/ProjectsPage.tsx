import React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { PROJECT_COLORS, PROJECT_ICONS, PROJECT_COLOR_MAP as COLOR_MAP } from '@/lib/projectMeta';
import { RiCloseLine } from '@remixicon/react';
import { ProjectActionsSection } from '@/components/sections/projects/ProjectActionsSection';
import { useI18n } from '@/lib/i18n';

export const ProjectsPage: React.FC = () => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);

  const selectedProject = React.useMemo(() => {
    if (!selectedId) return null;
    return projects.find((p) => p.id === selectedId) ?? null;
  }, [projects, selectedId]);

  React.useEffect(() => {
    if (projects.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && projects.some((p) => p.id === selectedId)) {
      return;
    }
    setSelectedId(projects[0].id);
  }, [projects, selectedId, setSelectedId]);

  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState<string | null>(null);
  const [color, setColor] = React.useState<string | null>(null);

  const selectedProjectRef = React.useMemo(() => {
    if (!selectedProject) {
      return null;
    }
    return { id: selectedProject.id, path: selectedProject.path };
  }, [selectedProject]);

  React.useEffect(() => {
    if (!selectedProject) {
      setName('');
      setIcon(null);
      setColor(null);
      return;
    }
    setName(selectedProject.label ?? '');
    setIcon(selectedProject.icon ?? null);
    setColor(selectedProject.color ?? null);
  }, [selectedProject]);

  const hasChanges = Boolean(selectedProject) && (
    name.trim() !== (selectedProject?.label ?? '').trim()
    || icon !== (selectedProject?.icon ?? null)
    || color !== (selectedProject?.color ?? null)
  );

  const handleSave = React.useCallback(() => {
    if (!selectedProject) return;

    updateProjectMeta(selectedProject.id, {
      label: name.trim(),
      icon,
      color,
    });
  }, [color, icon, name, selectedProject, updateProjectMeta]);

  const currentColorVar = color ? (COLOR_MAP[color] ?? null) : null;
  if (!selectedProject) {
    return (
      <ScrollableOverlay outerClassName="h-full" className="w-full">
        <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
          <p className="typography-meta text-muted-foreground">{t('settings.projects.page.empty.noProjects')}</p>
        </div>
      </ScrollableOverlay>
    );
  }
  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full bg-background">
      <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
        
        {/* Top Header & Actions */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {selectedProject.label ?? t('settings.projects.page.title.default')}
            </h2>
            <p className="typography-meta text-muted-foreground truncate" title={selectedProject.path}>
              {selectedProject.path}
            </p>
          </div>
        </div>

        {/* Identity Controls */}
        <div className="mb-8">
          <section className="px-2 pb-2 pt-0 space-y-0.5">
            
            {/* Name */}
            <div className="py-1.5">
              <div className="flex min-w-0 flex-col">
                <span className="typography-ui-label text-foreground">{t('settings.projects.page.field.projectName')}</span>
              </div>
              <div className="mt-1.5 flex min-w-0 items-center gap-2">
                <Input 
                  value={name} 
                  onChange={(e) => setName(e.target.value)} 
                  placeholder={t('settings.projects.page.field.projectNamePlaceholder')} 
                  className="h-7 min-w-0 w-full sm:max-w-[19rem]" 
                />
              </div>
            </div>

            {/* Color */}
            <div className="py-1.5">
              <div className="flex min-w-0 flex-col">
                <span className="typography-ui-label text-foreground">{t('settings.projects.page.field.accentColor')}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setColor(null)}
                  className={cn(
                    'h-7 w-7 rounded-md border transition-colors flex items-center justify-center',
                    color === null
                      ? 'border-2 border-foreground bg-[var(--primary-base)]/10'
                      : 'border-border/40 hover:border-border hover:bg-[var(--surface-muted)]'
                  )}
                  title={t('settings.projects.page.field.none')}
                >
                  <RiCloseLine className="h-4 w-4 text-muted-foreground" />
                </button>
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setColor(c.key)}
                    className={cn(
                      'h-7 w-7 rounded-md border transition-colors',
                      color === c.key
                        ? 'border-2 border-foreground ring-1 ring-[var(--primary-base)]/40'
                        : 'border-transparent hover:border-border/70'
                    )}
                    style={{ backgroundColor: c.cssVar }}
                    title={c.label}
                  />
                ))}
              </div>
            </div>

            {/* Icon */}
            <div className="py-1.5">
              <div className="flex min-w-0 flex-col">
                <span className="typography-ui-label text-foreground">{t('settings.projects.page.field.projectIcon')}</span>
              </div>
              <div className="mt-1.5 flex max-w-[22rem] flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIcon(null)}
                  className={cn(
                    'h-7 w-7 rounded-md border transition-colors flex items-center justify-center',
                    icon === null
                      ? 'border-2 border-foreground bg-[var(--primary-base)]/10'
                      : 'border-border/40 hover:border-border hover:bg-[var(--surface-muted)]'
                  )}
                  title={t('settings.projects.page.field.none')}
                >
                  <RiCloseLine className="h-4 w-4 text-muted-foreground" />
                </button>
                {PROJECT_ICONS.map((i) => {
                  const IconComponent = i.Icon;
                  return (
                    <button
                      key={i.key}
                      type="button"
                      onClick={() => setIcon(i.key)}
                      className={cn(
                        'h-7 w-7 rounded-md border transition-colors flex items-center justify-center',
                        icon === i.key
                          ? 'border-2 border-foreground bg-[var(--primary-base)]/10'
                          : 'border-transparent hover:border-border hover:bg-[var(--surface-muted)]'
                      )}
                      title={i.label}
                    >
                      <IconComponent className="w-4 h-4" style={currentColorVar && icon === i.key ? { color: currentColorVar } : undefined} />
                    </button>
                  );
                })}
              </div>
            </div>

          </section>
          
          <div className="mt-0.5 px-2 py-1">
            <Button
              onClick={handleSave}
              disabled={!hasChanges || name.trim().length === 0}
              size="xs"
              className="!font-normal"
            >
              {t('settings.common.actions.saveChanges')}
            </Button>
          </div>
        </div>

        {/* Project Actions Group */}
        <div className="mb-8">
          <section className="px-2 pb-2 pt-0">
            {selectedProjectRef && <ProjectActionsSection projectRef={selectedProjectRef} />}
          </section>
        </div>

      </div>
    </ScrollableOverlay>
  );
};
