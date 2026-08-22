import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeManager = fs.readFileSync(
  path.join(
    root,
    'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
  ),
  'utf8',
);
const match = runtimeManager.match(
  /writeScript\(\s*"\.adev-workspace-guard",\s*"""([\s\S]*?)"""\.trimIndent\(\)/,
);
assert.ok(match, 'generated shared-workspace guard was not found');

const sourceLines = match[1]
  .replaceAll("${'$'}", '$')
  .replace(/^\r?\n/, '')
  .split(/\r?\n/);
const indentation = Math.min(
  ...sourceLines.filter(line => line.trim()).map(line => line.match(/^\s*/)[0].length),
);
const guard = `${sourceLines.map(line => line.slice(indentation)).join('\n')}\n`;
assert.match(guard, /pwd -P/);
assert.match(guard, /return 73/);
assert.match(guard, /symbolic links/);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-workspace-policy-'));
const guardPath = path.join(temporary, 'guard.sh');
try {
  fs.writeFileSync(guardPath, guard);
  const bash = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe')
    ? 'C:/Program Files/Git/bin/bash.exe'
    : 'bash';
  const syntax = spawnSync(bash, ['-n'], {encoding: 'utf8', input: guard});
  assert.equal(syntax.status, 0, syntax.error?.message || syntax.stderr || syntax.stdout || 'shell syntax failed');

  const matrix = spawnSync(
    bash,
    [],
    {
      cwd: temporary,
      encoding: 'utf8',
      input: [
        guard,
        'pwd() { printf "%s\\n" "$ADEV_TEST_PWD"; }',
        'ADEV_TEST_PWD=/storage/emulated/0/Download/app',
        'adev_guard npm install >/dev/null 2>message; [ $? -eq 73 ]',
        'grep -q "Import this project into the ADEV workspace" message',
        'adev_guard npm --version',
        'adev_guard git status',
        'adev_guard git checkout main >/dev/null 2>&1; [ $? -eq 73 ]',
        'adev_guard native --version',
        'ADEV_TEST_PWD=/data/user/0/com.mobileide.app/files/runtime/workspaces/app',
        'adev_guard npm install',
      ].join('\n'),
    },
  );
  assert.equal(matrix.status, 0, matrix.error?.message || matrix.stderr || matrix.stdout || 'policy matrix failed');
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}

console.log('Shared-workspace policy host tests passed.');
