import type {FileEntry} from '../../native';

export interface VisibleTreeEntry {
  entry: FileEntry;
  depth: number;
}

export const flattenVisibleTree = (
  entries: FileEntry[],
  fileTree: Map<string, FileEntry[]>,
  expandedFolders: Set<string>,
): VisibleTreeEntry[] => {
  const visible: VisibleTreeEntry[] = [];
  const visited = new Set<string>();
  const append = (siblings: FileEntry[], depth: number) => {
    if (depth > 64) return;
    [...siblings]
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, {numeric: true, sensitivity: 'base'});
      })
      .forEach(entry => {
        if (visited.has(entry.path)) return;
        visited.add(entry.path);
        visible.push({entry, depth});
        if (entry.isDirectory && expandedFolders.has(entry.path)) {
          append(fileTree.get(entry.path) || [], depth + 1);
        }
      });
  };
  append(entries, 0);
  return visible;
};

const TYPE_COLORS: Record<string, string> = {
  js: '#f7df1e', jsx: '#61dafb', ts: '#3178c6', tsx: '#61dafb',
  json: '#d4d4d4', md: '#82aaff', html: '#e34c26', css: '#563d7c',
  py: '#4b8bbe', sh: '#89e051', yml: '#cb171e', yaml: '#cb171e',
  java: '#b07219', kt: '#a97bff', c: '#a8b9cc', cpp: '#f34b7d',
  png: '#c084fc', jpg: '#c084fc', jpeg: '#c084fc', gif: '#c084fc',
};

export const getFileVisual = (name: string): {label: string; color: string} => {
  if (name === '.env' || name.startsWith('.env.')) return {label: 'ENV', color: '#eab308'};
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : '';
  return {
    label: extension ? extension.slice(0, 3).toUpperCase() : '',
    color: TYPE_COLORS[extension] || '#9ca3af',
  };
};
