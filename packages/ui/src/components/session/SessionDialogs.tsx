import React from 'react';
import { toast } from '@/components/ui';

import { DirectoryExplorerDialog } from './DirectoryExplorerDialog';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import { isDesktopLocalOriginActive, isTauriShell } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { useI18n } from '@/lib/i18n';

export const SessionDialogs: React.FC = () => {
    const { t } = useI18n();
    const [isDirectoryDialogOpen, setIsDirectoryDialogOpen] = React.useState(false);
    const [hasShownInitialDirectoryPrompt, setHasShownInitialDirectoryPrompt] = React.useState(false);

    const isHomeReady = useDirectoryStore((s) => s.isHomeReady);
    const projects = useProjectsStore((s) => s.projects);
    const addProject = useProjectsStore((s) => s.addProject);
    const { requestAccess, startAccessing } = useFileSystemAccess();

    React.useEffect(() => {
        if (hasShownInitialDirectoryPrompt || !isHomeReady || projects.length > 0) {
            return;
        }

        setHasShownInitialDirectoryPrompt(true);

        if (isTauriShell() && isDesktopLocalOriginActive()) {
            requestAccess('')
                .then(async (result) => {
                    if (!result.success || !result.path) {
                        if (result.error && result.error !== 'Directory selection cancelled') {
                            toast.error(t('sessions.sidebar.sessionDialogs.directory.errorSelectTitle'), {
                                description: result.error,
                            });
                        }
                        return;
                    }

                    const accessResult = await startAccessing(result.path);
                    if (!accessResult.success) {
                        toast.error(t('sessions.sidebar.sessionDialogs.directory.errorOpenTitle'), {
                            description: accessResult.error || t('sessions.sidebar.sessionDialogs.directory.errorOpenDescription'),
                        });
                        return;
                    }

                    const added = addProject(result.path, { id: result.projectId });
                    if (!added) {
                        toast.error(t('sessions.sidebar.sessionDialogs.directory.errorAddProjectTitle'), {
                            description: t('sessions.sidebar.sessionDialogs.directory.errorAddProjectDescription'),
                        });
                    }
                })
                .catch((error) => {
                    console.error('Desktop: Error selecting directory:', error);
                    toast.error(t('sessions.sidebar.sessionDialogs.directory.errorSelectTitle'));
                });
            return;
        }

        setIsDirectoryDialogOpen(true);
    }, [
        addProject,
        hasShownInitialDirectoryPrompt,
        isHomeReady,
        projects.length,
        requestAccess,
        startAccessing,
        t,
    ]);

    React.useEffect(() => {
        return sessionEvents.onDirectoryRequest(() => {
            setIsDirectoryDialogOpen(true);
        });
    }, []);

    return (
        <DirectoryExplorerDialog
            open={isDirectoryDialogOpen}
            onOpenChange={setIsDirectoryDialogOpen}
        />
    );
};
