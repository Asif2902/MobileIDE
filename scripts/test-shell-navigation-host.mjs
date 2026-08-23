import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const runtimeManager = fs.readFileSync(
  path.join(
    repo,
    'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
  ),
  'utf8',
);

assert.match(
  runtimeManager,
  /private fun ensureWorkspaceHomeLink\(\)/,
  'Runtime initialization must expose the private workspace root from shell home',
);
assert.match(
  runtimeManager,
  /val link = File\(homeDir, "workspaces"\)/,
  'The documented ~/workspaces path must be created',
);
assert.match(
  runtimeManager,
  /Os\.symlink\(workspacesDir\.absolutePath, link\.absolutePath\)/,
  '~/workspaces must target the canonical private workspace root',
);
assert.match(
  runtimeManager,
  /else if \(link\.exists\(\)\)[\s\S]*?Preserving existing non-symlink shell path/,
  'A user-created ~/workspaces directory must never be overwritten',
);

const setupEnvironmentStart = runtimeManager.indexOf(
  'private fun setupEnvironment()',
);
const setupEnvironmentEnd = runtimeManager.indexOf(
  'private fun ensureWorkspaceHomeLink()',
);
assert.ok(setupEnvironmentStart >= 0, 'Could not locate runtime environment setup');
assert.ok(setupEnvironmentEnd > setupEnvironmentStart);
assert.match(
  runtimeManager.slice(setupEnvironmentStart, setupEnvironmentEnd),
  /ensureWorkspaceHomeLink\(\)/,
  'Fresh installations must expose ~/workspaces',
);

const refreshBindings = runtimeManager.match(
  /private fun refreshInstallPathBindings\(\)[\s\S]*?\n    }/,
)?.[0];
assert.ok(refreshBindings, 'Could not locate runtime upgrade refresh');
assert.match(
  refreshBindings,
  /ensureWorkspaceHomeLink\(\)/,
  'Existing installations must receive the shell navigation repair on upgrade',
);

process.stdout.write('Shell workspace navigation contract passed.\n');
