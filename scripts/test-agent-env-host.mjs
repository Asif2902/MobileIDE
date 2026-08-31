import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const runtimeManagerPath = path.join(
  repo,
  'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
);
const processManager = fs.readFileSync(
  path.join(
    repo,
    'android/app/src/main/java/com/mobileide/app/process/ProcessManager.kt',
  ),
  'utf8',
);
const processLauncher = fs.readFileSync(
  path.join(
    repo,
    'android/app/src/main/java/com/mobileide/app/process/AdevProcessLauncher.kt',
  ),
  'utf8',
);
const ptyManager = fs.readFileSync(
  path.join(
    repo,
    'android/app/src/main/java/com/mobileide/app/pty/PtySessionManager.kt',
  ),
  'utf8',
);
const nativeLauncher = fs.readFileSync(
  path.join(repo, 'android/app/src/main/cpp/adev_env.cpp'),
  'utf8',
);
const gitNativeModule = fs.readFileSync(
  path.join(
    repo,
    'android/app/src/main/java/com/mobileide/app/modules/GitNativeModule.kt',
  ),
  'utf8',
);
const runtimeManager = fs.readFileSync(runtimeManagerPath, 'utf8');

assert.match(processLauncher, /--adev-run-v1/);
assert.match(processManager, /processLauncher\.command\(command, args\)/);
assert.match(processManager, /processLauncher\.environment\(workingDir\.absolutePath\)/);
assert.match(ptyManager, /processLauncher\.interactiveShell\(\)/);
assert.match(gitNativeModule, /AdevProcessLauncher\(runtime\)/);
assert.match(gitNativeModule, /launcher\.command\("git", arguments\)/);
assert.doesNotMatch(gitNativeModule, /ProcessBuilder\(listOf\(executable\.absolutePath\)/);
assert.match(nativeLauncher, /run_adev_command/);
for (const command of ['bash', 'node', 'npm', 'git', 'python']) {
  assert.match(nativeLauncher, new RegExp(`"${command}"`));
}
assert.match(runtimeManager, /File\(binDir, name\), File\(adevEnv\.shimDir, name\)/);

const ensurepipRoots = fs
  .readdirSync(path.join(repo, 'android/app/src/main/assets/runtime/lib'))
  .filter(name => /^python\d+\.\d+$/.test(name));
assert.ok(ensurepipRoots.length > 0, 'Packaged Python stdlib is missing');
for (const pythonHome of ensurepipRoots) {
  const ensurepip = path.join(
    repo,
    'android/app/src/main/assets/runtime/lib',
    pythonHome,
    'ensurepip',
  );
  if (!fs.existsSync(ensurepip)) continue;
  const source = fs.readFileSync(path.join(ensurepip, '__init__.py'), 'utf8');
  const version = source.match(/^_PIP_VERSION\s*=\s*["']([^"']+)["']/m)?.[1];
  assert.ok(version, `${pythonHome} does not publish its ensurepip pip version`);
  const transport = path.join(ensurepip, 'adev-bundled');
  const wheels = fs.existsSync(transport)
    ? fs.readdirSync(transport).filter(name => name.endsWith('.whl'))
    : [];
  assert.deepEqual(wheels, [`pip-${version}-py3-none-any.whl`]);
}
assert.match(runtimeManager, /File\(ensurepip, "_bundled"\)/);

function decodeKotlinString(fragment) {
  return fragment
    .replace(/\\"/g, '"')
    .replace(/\\\$/g, '$')
    .replace(/\\\\/g, '\\');
}

function generatedAgentLine(source, prefix) {
  const appendLines = source.matchAll(
    /agentEnv\.appendLine\("((?:[^"\\]|\\.)*)"\)/g,
  );
  for (const match of appendLines) {
    const decoded = decodeKotlinString(match[1]);
    if (decoded.startsWith(prefix)) {
      return decoded;
    }
  }
  assert.fail(`Missing generated agent environment line: ${prefix}`);
}

function existingShells() {
  const candidates =
    process.platform === 'win32'
      ? [
          process.env.ADEV_POSIX_SH,
          process.env.SHELL,
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/bin/sh.exe'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/usr/bin/sh.exe'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/usr/bin/bash.exe'),
        ]
      : [process.env.ADEV_POSIX_SH, process.env.SHELL, '/bin/sh', '/bin/bash'];
  return [...new Set(candidates.filter(Boolean))].filter(candidate =>
    path.isAbsolute(candidate) ? fs.existsSync(candidate) : true,
  );
}

function shellPath(file) {
  return process.platform === 'win32' ? file.replaceAll('\\', '/') : file;
}

function run(shell, args, env) {
  return spawnSync(shell, args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
}

const source = fs.readFileSync(runtimeManagerPath, 'utf8');
const lines = [
  generatedAgentLine(source, 'adev_node_options='),
  // One --require only: Next.js joins repeated NODE_OPTIONS values for the same
  // option with a space when it re-serialises them for its workers.
  generatedAgentLine(source, 'case "$adev_node_options" in *adev-node-preload.js*'),
  generatedAgentLine(source, 'export NODE_OPTIONS='),
  generatedAgentLine(source, 'unset adev_node_options'),
];
const generatedSnippet = `${lines.join('\n')}\n`;

assert.equal(lines[0], 'adev_node_options="${NODE_OPTIONS:-}"');
assert.doesNotMatch(generatedSnippet, /\$\{'\$'\}/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-agent-env-host-'));
try {
  const envFile = path.join(root, '.adev-agent-env');
  fs.writeFileSync(envFile, generatedSnippet);
  const portableEnvFile = shellPath(envFile);
  const shells = existingShells();
  assert.ok(shells.length > 0, 'A POSIX shell is required for the agent-env test');

  for (const shell of shells) {
    const baseEnv = { ...process.env, PREFIX: '/adev-test-prefix-with-no-assets' };
    delete baseEnv.NODE_OPTIONS;
    delete baseEnv.BASH_ENV;

    const syntax = run(shell, ['-n', portableEnvFile], baseEnv);
    assert.equal(
      syntax.status,
      0,
      `${shell} rejected generated agent env syntax:\n${syntax.stderr}`,
    );

    const empty = run(
      shell,
      [
        '-c',
        '. "$1"; printf "%s" "${NODE_OPTIONS+x}:$NODE_OPTIONS"',
        'adev-agent-env-test',
        portableEnvFile,
      ],
      baseEnv,
    );
    assert.equal(empty.status, 0, `${shell} could not source agent env:\n${empty.stderr}`);
    assert.equal(empty.stdout, 'x:');

    const original = '--trace-warnings --max-old-space-size=512';
    const preserved = run(
      shell,
      ['-c', '. "$1"; printf "%s" "$NODE_OPTIONS"', 'adev-agent-env-test', portableEnvFile],
      { ...baseEnv, NODE_OPTIONS: original },
    );
    assert.equal(
      preserved.status,
      0,
      `${shell} could not preserve NODE_OPTIONS:\n${preserved.stderr}`,
    );
    assert.equal(preserved.stdout, original);

    if (/bash(?:\.exe)?$/i.test(shell)) {
      const bashEnv = run(shell, ['-c', 'printf "%s" "$NODE_OPTIONS"'], {
        ...baseEnv,
        BASH_ENV: portableEnvFile,
        NODE_OPTIONS: original,
      });
      assert.equal(
        bashEnv.status,
        0,
        `${shell} could not auto-load BASH_ENV:\n${bashEnv.stderr}`,
      );
      assert.equal(bashEnv.stdout, original);
    }
  }

  process.stdout.write(
    `Agent environment shell tests passed (${shells
      .map(shell => path.basename(shell))
      .join(', ')}).\n`,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
