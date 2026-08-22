#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const network = process.argv.includes('--network');
const prefix = process.env.PREFIX;
const fixturesRoot = path.join(prefix, 'fixtures', 'phase1');
const npmCli = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const nodeGyp = path.join(
  prefix,
  'lib',
  'node_modules',
  'npm',
  'node_modules',
  'node-gyp',
  'bin',
  'node-gyp.js'
);
const workRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'adev-phase1-'));
const coreFixtures = ['napi-c', 'napi-cpp', 'v8'];
const networkFixtures = ['nan', 'prebuild-fallback', 'node-pre-gyp-fallback'];
const fixtures = network ? [...coreFixtures, ...networkFixtures] : coreFixtures;
const results = [];

function run(label, command, args, cwd, env = process.env) {
  const result = childProcess.spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 10 * 60 * 1000,
  });
  results.push({label, exitCode: result.status, error: result.error && result.error.message});
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${label} failed with exit ${result.status}`);
  }
  return result;
}

try {
  run('doctor', process.execPath, [path.join(prefix, 'lib', 'adev-doctor.js'), '--json'], prefix);
  if (network) {
    run(
      'doctor network self-test',
      process.execPath,
      [path.join(prefix, 'lib', 'adev-doctor.js'), '--json', '--self-test'],
      prefix,
    );
  }

  // A real isolated global npm install verifies the generic bin-link path.
  // The fixture deliberately uses the standard npm shebang and is executed by
  // command name; invoking it with `node <path>` would hide resolver failures.
  const globalCliSource = path.join(workRoot, 'global-cli-source');
  const globalPrefix = path.join(workRoot, 'global-prefix');
  fs.mkdirSync(globalCliSource);
  fs.writeFileSync(
    path.join(globalCliSource, 'package.json'),
    JSON.stringify({
      name: 'adev-global-cli-fixture',
      version: '1.0.0',
      bin: {'adev-global-cli-fixture': 'cli.js'},
    }),
  );
  fs.writeFileSync(
    path.join(globalCliSource, 'cli.js'),
    '#!/usr/bin/env node\nprocess.stdout.write("adev-global-cli-ok\\n");\n',
    {mode: 0o755},
  );
  run(
    'global npm CLI: install',
    process.execPath,
    [npmCli, 'install', '--global', '--prefix', globalPrefix, globalCliSource],
    workRoot,
  );
  const cliEnvironment = {
    ...process.env,
    PATH: `${path.join(globalPrefix, 'bin')}:${process.env.PATH}`,
  };
  const globalCli = run(
    'global npm CLI: env node shebang',
    'adev-global-cli-fixture',
    ['--help'],
    workRoot,
    cliEnvironment,
  );
  if (!globalCli.stdout.includes('adev-global-cli-ok')) {
    throw new Error('global npm CLI did not execute its Node entrypoint');
  }

  const pythonScript = path.join(workRoot, 'adev-python-shebang-fixture');
  fs.writeFileSync(
    pythonScript,
    '#!/usr/bin/env python\nprint("adev-python-shebang-ok")\n',
    {mode: 0o755},
  );
  const pythonShebang = run(
    'env python shebang',
    pythonScript,
    [],
    workRoot,
  );
  if (!pythonShebang.stdout.includes('adev-python-shebang-ok')) {
    throw new Error('env python shebang did not reach Python');
  }

  const systemShellScript = path.join(workRoot, 'adev-system-shell-fixture');
  fs.writeFileSync(
    systemShellScript,
    '#!/system/bin/sh\nprintf "adev-system-shell-ok\\n"\n',
    {mode: 0o755},
  );
  const systemShellShebang = run(
    'system shell shebang',
    systemShellScript,
    [],
    workRoot,
  );
  if (!systemShellShebang.stdout.includes('adev-system-shell-ok')) {
    throw new Error('system shell shebang did not reach /system/bin/sh');
  }

  run(
    'python subprocess shell',
    process.env.PYTHON,
    ['-c', 'import os; assert os.popen("printf adev-python-shell-ok").read() == "adev-python-shell-ok"'],
    workRoot,
  );

  for (const name of fixtures) {
    const source = path.join(fixturesRoot, name);
    const target = path.join(workRoot, name);
    fs.cpSync(source, target, {recursive: true});
    const fixturePackage = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));

    run(`${name}: npm install`, process.execPath, [npmCli, 'install', '--foreground-scripts'], target);
    run(`${name}: load after install`, process.execPath, ['test.js'], target);
    run(`${name}: npm rebuild`, process.execPath, [npmCli, 'rebuild', '--foreground-scripts'], target);
    run(`${name}: load after rebuild`, process.execPath, ['test.js'], target);
    run(`${name}: direct node-gyp`, process.execPath, [nodeGyp, 'rebuild'], target);
    run(`${name}: load after direct node-gyp`, process.execPath, ['test.js'], target);

    const consumer = path.join(workRoot, `${name}-consumer`);
    fs.mkdirSync(consumer);
    fs.writeFileSync(
      path.join(consumer, 'package.json'),
      JSON.stringify({name: `${name}-consumer`, private: true, version: '1.0.0'})
    );
    run(`${name}: consumer install`, process.execPath, [npmCli, 'install', target], consumer);
    run(`${name}: consumer uninstall`, process.execPath, [npmCli, 'uninstall', fixturePackage.name], consumer);
    run(`${name}: consumer reinstall`, process.execPath, [npmCli, 'install', target], consumer);
  }

  if (network) {
    // Exact packages from the connected-phone failure report. Keep this at the
    // platform layer: both packages must follow the same generic npm/node-gyp
    // path as every other native addon, with no package-specific workaround.
    const websocketNative = path.join(workRoot, 'websocket-native-dependencies');
    fs.mkdirSync(websocketNative);
    fs.writeFileSync(
      path.join(websocketNative, 'package.json'),
      JSON.stringify({
        name: 'adev-websocket-native-dependencies',
        private: true,
        version: '1.0.0',
        dependencies: {
          bufferutil: '4.1.0',
          'utf-8-validate': '5.0.10',
        },
      }),
    );
    const loadNativeDependencies = [
      '-e',
      "require('bufferutil');require('utf-8-validate');process.stdout.write('websocket-native-ok\\n')",
    ];
    run(
      'websocket native dependencies: npm install',
      process.execPath,
      [npmCli, 'install', '--foreground-scripts'],
      websocketNative,
    );
    run(
      'websocket native dependencies: load after install',
      process.execPath,
      loadNativeDependencies,
      websocketNative,
    );
    run(
      'websocket native dependencies: npm rebuild',
      process.execPath,
      [
        npmCli,
        'rebuild',
        'bufferutil',
        'utf-8-validate',
        '--foreground-scripts',
      ],
      websocketNative,
    );
    run(
      'websocket native dependencies: load after rebuild',
      process.execPath,
      loadNativeDependencies,
      websocketNative,
    );
    run(
      'websocket native dependencies: uninstall',
      process.execPath,
      [npmCli, 'uninstall', 'bufferutil', 'utf-8-validate'],
      websocketNative,
    );
    run(
      'websocket native dependencies: reinstall',
      process.execPath,
      [
        npmCli,
        'install',
        'bufferutil@4.1.0',
        'utf-8-validate@5.0.10',
        '--foreground-scripts',
      ],
      websocketNative,
    );
    run(
      'websocket native dependencies: load after reinstall',
      process.execPath,
      loadNativeDependencies,
      websocketNative,
    );
  }

  process.stdout.write(`${JSON.stringify({ok: true, network, results}, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.stderr.write(`${JSON.stringify({ok: false, network, results}, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(workRoot, {recursive: true, force: true});
}
