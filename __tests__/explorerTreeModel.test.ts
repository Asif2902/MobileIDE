import type {FileEntry} from '../src/native';
import {flattenVisibleTree, getFileVisual} from '../src/components/explorer/treeModel';
import fs from 'fs';
import path from 'path';

const entry = (filePath: string, isDirectory: boolean): FileEntry => ({
  path: filePath,
  name: filePath.split('/').pop() || filePath,
  isDirectory,
  size: 0,
  modifiedTime: 1,
  isHidden: filePath.split('/').pop()?.startsWith('.') || false,
});

describe('Explorer tree model', () => {
  it('sorts folders first and only flattens expanded descendants', () => {
    const folder = entry('/workspace/src', true);
    const file = entry('/workspace/package.json', false);
    const child = entry('/workspace/src/index.ts', false);
    const tree = new Map<string, FileEntry[]>([[folder.path, [child]]]);

    expect(flattenVisibleTree([file, folder], tree, new Set()).map(item => item.entry.path)).toEqual([
      folder.path,
      file.path,
    ]);
    expect(flattenVisibleTree([file, folder], tree, new Set([folder.path]))).toEqual([
      {entry: folder, depth: 0},
      {entry: child, depth: 1},
      {entry: file, depth: 0},
    ]);
  });

  it('protects the UI from cyclic provider entries', () => {
    const folder = entry('/workspace/src', true);
    const tree = new Map<string, FileEntry[]>([[folder.path, [folder]]]);

    expect(flattenVisibleTree([folder], tree, new Set([folder.path]))).toHaveLength(1);
  });

  it('uses stable file-type badges including dotfiles', () => {
    expect(getFileVisual('app.ts').label).toBe('TS');
    expect(getFileVisual('.env').label).toBe('ENV');
    expect(getFileVisual('README').label).toBe('');
  });

  it('keeps the portrait action row compact without consuming the file-tree height', () => {
    const explorerSource = fs.readFileSync(
      path.join(__dirname, '..', 'src/components/explorer/FileExplorer.tsx'),
      'utf8',
    );
    expect(explorerSource).toContain('style={styles.workspaceActions}');
    expect(explorerSource).toMatch(
      /workspaceActions:\s*\{[\s\S]*?flexDirection:\s*'row',[\s\S]*?minHeight:\s*42/,
    );
  });
});
