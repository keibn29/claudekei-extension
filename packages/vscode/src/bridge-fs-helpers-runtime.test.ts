import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root = '';

mock.module('vscode', () => {
  const uri = (fsPath: string) => ({ fsPath });
  return {
    Uri: { file: uri, joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    FileType: { File: 1, Directory: 2 },
    RelativePattern: class {},
    workspace: {
      workspaceFolders: [{ uri: uri(os.tmpdir()) }],
      findFiles: async () => [],
      fs: {
        readDirectory: async (dir: { fsPath: string }) =>
          fs.readdirSync(dir.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1]),
      },
    },
  };
});

describe('searchDirectory directory mode', () => {
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-dir-')));
    fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'components'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'components', 'get_chrome_authenticator.xaml'), '');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test('returns only matching directories, never files', async () => {
    const { searchDirectory } = await import('./bridge-fs-helpers-runtime');
    const dirs = await searchDirectory(root, 'components', 20, false, false, 'directory');
    expect(dirs.map((d) => d.relativePath)).toEqual(['src/components']);

    const none = await searchDirectory(root, 'get_chrome_authenticator.xaml', 20, false, false, 'directory');
    expect(none).toEqual([]);
  });
});
