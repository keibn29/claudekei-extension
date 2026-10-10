export type SessionCreateRequest = {
  parentID?: string | null;
  projectId?: string | null;
};

type CreateListener = (request: SessionCreateRequest) => void;
type DirectoryListener = () => void;
type GitRefreshHint = { directory: string };
type GitRefreshListener = (hint: GitRefreshHint) => void;

const createListeners = new Set<CreateListener>();
const directoryListeners = new Set<DirectoryListener>();
const gitRefreshListeners = new Set<GitRefreshListener>();

export const sessionEvents = {
  onCreateRequest(listener: CreateListener) {
    createListeners.add(listener);
    return () => {
      createListeners.delete(listener);
    };
  },
  requestCreate(payload?: SessionCreateRequest) {
    const request = payload ?? {};
    createListeners.forEach((listener) => listener(request));
  },
  onDirectoryRequest(listener: DirectoryListener) {
    directoryListeners.add(listener);
    return () => {
      directoryListeners.delete(listener);
    };
  },
  requestDirectoryDialog() {
    directoryListeners.forEach((listener) => listener());
  },
  onGitRefreshHint(listener: GitRefreshListener) {
    gitRefreshListeners.add(listener);
    return () => {
      gitRefreshListeners.delete(listener);
    };
  },
  requestGitRefresh(hint: GitRefreshHint) {
    if (!hint.directory.trim()) {
      return;
    }
    gitRefreshListeners.forEach((listener) => listener(hint));
  },
};
