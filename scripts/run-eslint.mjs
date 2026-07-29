import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
const result = spawnSync(
  process.execPath,
  [
    eslint,
    'App.tsx',
    'index.js',
    'src',
    '__tests__',
    'jest.setup.js',
    '--ext',
    '.js,.jsx,.ts,.tsx',
    '--max-warnings',
    '20',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {...process.env, ESLINT_USE_FLAT_CONFIG: 'false'},
  },
);

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
