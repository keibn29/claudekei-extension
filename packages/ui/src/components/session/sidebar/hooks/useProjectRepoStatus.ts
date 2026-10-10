import React from 'react';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

type Project = { id: string; path: string; normalizedPath: string };

type Args = {
  normalizedProjects: Project[];
  gitRepoStatus: Map<string, { isGitRepo: boolean | null; branch: string | null }>;
  setProjectRepoStatus: React.Dispatch<React.SetStateAction<Map<string, boolean | null>>>;
  setProjectRootBranches: React.Dispatch<React.SetStateAction<Map<string, string>>>;
};

export const useProjectRepoStatus = (args: Args): void => {
  const {
    normalizedProjects,
    gitRepoStatus,
    setProjectRepoStatus,
    setProjectRootBranches,
  } = args;

  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);

  // Derive repo status from centralized Git store
  React.useEffect(() => {
    if (!git || normalizedProjects.length === 0) {
      setProjectRepoStatus(new Map());
      return;
    }

    // Trigger ensureStatus for each project to populate store
    normalizedProjects.forEach((project) => {
      void ensureStatus(project.normalizedPath, git);
    });
  }, [normalizedProjects, git, ensureStatus, setProjectRepoStatus]);

  // Read isGitRepo from the store-populated state
  React.useEffect(() => {
    const next = new Map<string, boolean | null>();
    normalizedProjects.forEach((project) => {
      next.set(project.id, gitRepoStatus.get(project.normalizedPath)?.isGitRepo ?? null);
    });
    setProjectRepoStatus(next);
  }, [normalizedProjects, gitRepoStatus, setProjectRepoStatus]);

  // The project root branch is the branch the project directory itself has checked out.
  React.useEffect(() => {
    setProjectRootBranches((prev) => {
      const next = new Map(prev);
      normalizedProjects.forEach((project) => {
        const branch = gitRepoStatus.get(project.normalizedPath)?.branch;
        if (branch) {
          next.set(project.id, branch);
        }
      });
      return next;
    });
  }, [normalizedProjects, gitRepoStatus, setProjectRootBranches]);
};
