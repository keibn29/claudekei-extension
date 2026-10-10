/**
 * Persistence behind revert / redo (docs/REVERT_SPEC.md D5/D6): the revert marker of a session (workspaceState) and the
 * file copies taken before a real rewind (`<root>/<sessionId>/manifest.json` + numbered blobs), so `unrevert` can write
 * the head state back. No vscode imports; the file system is injectable for tests.
 */
import { promises as nodeFs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { KeyValueStore } from './ClaudeSessionManager';

/**
 * `uuid`: the reverted user message; `resumeAt`: transcript uuid the next send cuts at (null = revert to the first message).
 * `committed`: a send already made the revert permanent, but no process has announced the cut yet (`init`), so the next
 * spawn must still resume at `resumeAt` and a reload keeps the cut messages hidden. Cleared once a process emitted `init`.
 */
export type RevertMarker = { uuid: string; resumeAt: string | null; committed?: boolean };

export const REVERT_KEY = 'claudekei.revertMarkers';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const REVERT_CAP_BYTES = 100 * 1024 * 1024;

type Manifest = { files: Array<{ path: string; blob: string | null }> };

/** The subset of `fs/promises` the store uses. */
export type RevertFs = Pick<typeof nodeFs, 'mkdir' | 'readFile' | 'writeFile' | 'rename' | 'rm' | 'stat' | 'readdir' | 'unlink'>;

export class RevertStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly rootDir: string,
    private readonly fs: RevertFs = nodeFs,
    private readonly capBytes = REVERT_CAP_BYTES,
  ) {}

  private markers(): Record<string, RevertMarker> {
    return this.kv.get<Record<string, RevertMarker>>(REVERT_KEY, {});
  }

  private dir(id: string): string {
    // Session ids are UUIDs; the directory name must never escape the root.
    if (!SAFE_ID.test(id)) throw new Error(`Invalid session id: ${id}`);
    return join(this.rootDir, id);
  }

  get(id: string): RevertMarker | undefined {
    return this.markers()[id];
  }

  async set(id: string, marker: RevertMarker): Promise<void> {
    await this.kv.update(REVERT_KEY, { ...this.markers(), [id]: marker });
  }

  /** Keeps a committed marker (the cut is not in the transcript yet) but drops the /redo file copies. */
  async commit(id: string, marker: RevertMarker): Promise<void> {
    await this.kv.update(REVERT_KEY, { ...this.markers(), [id]: { ...marker, committed: true } });
    await this.fs.rm(this.dir(id), { recursive: true, force: true });
  }

  /** Removes the marker and rm -rf <root>/<id>. */
  async clear(id: string): Promise<void> {
    const markers = this.markers();
    if (markers[id]) {
      const { [id]: _removed, ...rest } = markers;
      await this.kv.update(REVERT_KEY, rest);
    }
    await this.fs.rm(this.dir(id), { recursive: true, force: true });
  }

  private async readManifest(id: string): Promise<Manifest> {
    try {
      const parsed = JSON.parse(await this.fs.readFile(join(this.dir(id), 'manifest.json'), 'utf8')) as Manifest;
      return Array.isArray(parsed.files) ? parsed : { files: [] };
    } catch {
      return { files: [] };
    }
  }

  /**
   * Adds the paths not yet in the manifest: blob = current bytes, or null when the file does not exist (the rewind
   * will create it). Every new path is stat-ed first; the cap is checked before anything is written.
   */
  async capture(id: string, absPaths: string[]): Promise<void> {
    const manifest = await this.readManifest(id);
    const known = new Set(manifest.files.map((f) => f.path));
    const fresh: Array<{ path: string; size: number | null }> = [];
    for (const path of new Set(absPaths)) {
      if (known.has(path)) continue;
      try {
        const stat = await this.fs.stat(path);
        if (!stat.isFile()) continue;
        fresh.push({ path, size: stat.size });
      } catch {
        fresh.push({ path, size: null });
      }
    }
    if (fresh.length === 0) return;

    let used = 0;
    for (const file of manifest.files) {
      if (file.blob === null) continue;
      try {
        used += (await this.fs.stat(join(this.dir(id), file.blob))).size;
      } catch {
        /* a missing blob counts as nothing */
      }
    }
    const added = fresh.reduce((sum, f) => sum + (f.size ?? 0), 0);
    if (used + added > this.capBytes) throw new Error('Too much file data to keep for /redo (over 100 MB). Nothing was changed.');

    await this.fs.mkdir(this.dir(id), { recursive: true });
    let next = manifest.files.length;
    const entries: Manifest['files'] = [];
    for (const file of fresh) {
      if (file.size === null) {
        entries.push({ path: file.path, blob: null });
        continue;
      }
      const blob = String(next++);
      await this.fs.writeFile(join(this.dir(id), blob), await this.fs.readFile(file.path));
      entries.push({ path: file.path, blob });
    }
    const manifestPath = join(this.dir(id), 'manifest.json');
    await this.fs.writeFile(`${manifestPath}.tmp`, JSON.stringify({ files: [...manifest.files, ...entries] }));
    await this.fs.rename(`${manifestPath}.tmp`, manifestPath);
  }

  /** For each entry: blob -> mkdir -p + write; null -> unlink if present. Returns the paths. */
  async restore(id: string): Promise<string[]> {
    const manifest = await this.readManifest(id);
    const paths: string[] = [];
    for (const file of manifest.files) {
      if (file.blob === null) {
        await this.fs.unlink(file.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      } else {
        await this.fs.mkdir(dirname(file.path), { recursive: true });
        await this.fs.writeFile(file.path, await this.fs.readFile(join(this.dir(id), file.blob)));
      }
      paths.push(file.path);
    }
    return paths;
  }

  /** Deletes the <root>/* directories that have no marker (leftovers of a crash or of a manual state reset). */
  async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await this.fs.readdir(this.rootDir);
    } catch {
      return;
    }
    const markers = this.markers();
    for (const name of names) {
      if (!markers[name]) await this.fs.rm(join(this.rootDir, name), { recursive: true, force: true });
    }
  }
}
