import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const launcher = path.join(repo, 'android/app/src/main/assets/runtime/lib/adev-next.js');
const serverEvents = path.join(
  repo,
  'android/app/src/main/assets/runtime/lib/adev-server-events.js',
);
const requireForTest = createRequire(import.meta.url);
const { launchNext, signalExitCode } = requireForTest(launcher);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const pid = child.pid;
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => (stdout += chunk));
    child.stderr?.on('data', chunk => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, pid, stdout, stderr }));
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-phase2-host-'));
try {
  const project = path.join(root, 'project');
  const nextDir = path.join(project, 'node_modules', 'next');
  const nextBin = path.join(nextDir, 'dist', 'bin', 'next.js');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(path.dirname(nextBin), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(
    nextBin,
    [
      "const fs=require('node:fs');",
      'const output=process.env.ADEV_FAKE_NEXT_OUT;',
      "if(output)fs.writeFileSync(output,JSON.stringify({pid:process.pid,ppid:process.ppid,args:process.argv.slice(2),ignore:process.env.NEXT_IGNORE_INCORRECT_LOCKFILE,telemetry:process.env.NEXT_TELEMETRY_DISABLED,nodePath:process.env.NODE_PATH}));",
      'const delay=Number(process.env.ADEV_FAKE_NEXT_DELAY_MS||0);',
      'const code=Number(process.env.ADEV_FAKE_NEXT_EXIT_CODE||0);',
      'if(delay>0)setTimeout(()=>process.exit(code),delay);else process.exitCode=code;',
      '',
    ].join('\n'),
  );

  function installFakeNext(version) {
    fs.writeFileSync(
      path.join(nextDir, 'package.json'),
      JSON.stringify({ name: 'next', version }),
    );
    const wasmManifest = path.join(
      cache,
      version,
      'node_modules',
      '@next',
      'swc-wasm-nodejs',
      'package.json',
    );
    fs.mkdirSync(path.dirname(wasmManifest), { recursive: true });
    fs.writeFileSync(
      wasmManifest,
      JSON.stringify({ name: '@next/swc-wasm-nodejs', version }),
    );
  }

  async function dryRun(version, args) {
    installFakeNext(version);
    const result = await run(
      process.execPath,
      [launcher, '--adev-dry-run', '--adev-diagnose', ...args],
      { cwd: project, env: { ...process.env, ADEV_NEXT_CACHE: cache } },
    );
    assert.equal(result.code, 0, result.stderr);
    const info = JSON.parse(result.stdout);
    assert.equal(info.nextVersion, version);
    return info;
  }

  const before = fs.readFileSync(path.join(project, 'package.json'), 'utf8');
  for (const version of ['13.2.4', '14.2.35', '15.5.2', '15.5.22', '16.2.12']) {
    const webpackSelector = version.startsWith('16.') ? ['--webpack'] : [];
    const defaultDev = await dryRun(version, []);
    assert.deepEqual(defaultDev.args, ['dev', ...webpackSelector]);
    assert.equal(defaultDev.manifestModified, false);
    assert.equal(defaultDev.lockfileModified, false);

    assert.deepEqual(
      (await dryRun(version, ['dev', '--turbopack', '--turbo', '-p', '3210'])).args,
      ['dev', ...webpackSelector, '-p', '3210'],
    );
    assert.deepEqual(
      (await dryRun(version, ['dev', '--webpack', '--webpack', '-p', '3210'])).args,
      ['dev', ...webpackSelector, '-p', '3210'],
    );
    assert.deepEqual(
      (await dryRun(version, ['build', '--turbo', '--webpack', '--webpack'])).args,
      ['build', ...webpackSelector],
    );

    const start = await dryRun(version, ['start', '--turbo', '--webpack', '-p', '3210']);
    assert.deepEqual(start.args, ['start', '--turbo', '--webpack', '-p', '3210']);
  }
  assert.equal(fs.readFileSync(path.join(project, 'package.json'), 'utf8'), before);

  fs.writeFileSync(
    path.join(nextDir, 'package.json'),
    JSON.stringify({ name: 'next', version: 'not-semver' }),
  );
  const malformed = await run(
    process.execPath,
    [launcher, '--adev-dry-run', 'dev'],
    { cwd: project, env: { ...process.env, ADEV_NEXT_CACHE: cache } },
  );
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /invalid metadata/);
  assert.match(malformed.stderr, /invalid version "not-semver"/);
  assert.match(malformed.stderr, /Reinstall Next\.js/);

  for (const version of ['13.2.4', '14.2.35', '15.5.22', '16.2.12']) {
    installFakeNext(version);
    const fakeNextOutput = path.join(root, `fake-next-${version}.json`);
    const direct = await run(process.execPath, [launcher, 'start', '-p', '3210'], {
      cwd: project,
      env: {
        ...process.env,
        ADEV_NEXT_CACHE: cache,
        ADEV_FAKE_NEXT_OUT: fakeNextOutput,
      },
    });
    assert.equal(direct.code, 0, direct.stderr);
    const directEnv = JSON.parse(fs.readFileSync(fakeNextOutput, 'utf8'));
    assert.notEqual(directEnv.pid, direct.pid, `${version} CLI ran inside its wrapper`);
    assert.equal(directEnv.ppid, direct.pid, `${version} CLI was not owned by its wrapper`);
    assert.deepEqual(directEnv.args, ['start', '-p', '3210']);
    assert.equal(directEnv.ignore, '1');
    assert.equal(directEnv.telemetry, '1');
    assert.ok(directEnv.nodePath.includes(path.join(cache, version, 'node_modules')));
  }

  installFakeNext('13.2.4');
  const ownedOutput = path.join(root, 'fake-next-owned.json');
  const owned = spawn(process.execPath, [launcher, 'dev'], {
    cwd: project,
    env: {
      ...process.env,
      ADEV_NEXT_CACHE: cache,
      ADEV_FAKE_NEXT_OUT: ownedOutput,
      ADEV_FAKE_NEXT_DELAY_MS: '750',
      ADEV_FAKE_NEXT_EXIT_CODE: '23',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ownedStderr = '';
  owned.stderr.on('data', chunk => (ownedStderr += chunk));
  const ownedExit = new Promise((resolve, reject) => {
    owned.once('error', reject);
    owned.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const readyDeadline = Date.now() + 5_000;
  while (!fs.existsSync(ownedOutput) && Date.now() < readyDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(fs.existsSync(ownedOutput), ownedStderr || 'owned Next fixture did not start');
  assert.equal(owned.exitCode, null, 'launcher exited before its long-lived Next CLI');
  const ownedEnv = JSON.parse(fs.readFileSync(ownedOutput, 'utf8'));
  assert.equal(ownedEnv.ppid, owned.pid);
  assert.notEqual(ownedEnv.pid, owned.pid);
  const ownedResult = await ownedExit;
  assert.deepEqual(ownedResult, { code: 23, signal: null });

  function mockChild() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.kill = signal => {
      child.signals.push(signal);
      return true;
    };
    return child;
  }

  const signalOwner = new EventEmitter();
  signalOwner.exitCode = undefined;
  const signalChild = mockChild();
  const signalCompletion = launchNext('/fake/next.js', ['dev'], {
    owner: signalOwner,
    spawn: () => signalChild,
    execPath: '/fake/node',
    cwd: project,
    env: {},
  });
  signalOwner.emit('SIGINT');
  signalOwner.emit('SIGTERM');
  assert.deepEqual(signalChild.signals, ['SIGINT', 'SIGTERM']);
  signalChild.signalCode = 'SIGTERM';
  signalChild.emit('exit', null, 'SIGTERM');
  await signalCompletion;
  assert.equal(signalOwner.exitCode, signalExitCode('SIGTERM'));
  assert.equal(signalOwner.listenerCount('SIGINT'), 0);
  assert.equal(signalOwner.listenerCount('SIGTERM'), 0);

  const exitingOwner = new EventEmitter();
  const orphanCandidate = mockChild();
  const orphanCompletion = launchNext('/fake/next.js', ['dev'], {
    owner: exitingOwner,
    spawn: () => orphanCandidate,
    execPath: '/fake/node',
    cwd: project,
    env: {},
  });
  exitingOwner.emit('exit', 1);
  assert.deepEqual(orphanCandidate.signals, ['SIGKILL']);
  orphanCandidate.signalCode = 'SIGKILL';
  orphanCandidate.emit('exit', null, 'SIGKILL');
  await orphanCompletion;

  const launcherSource = fs.readFileSync(launcher, 'utf8');
  assert.doesNotMatch(launcherSource, /require\(next\.bin\)/);
  assert.match(launcherSource, /stdio: 'inherit'/);

  const runtimeManager = fs.readFileSync(
    path.join(
      repo,
      'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
    ),
    'utf8',
  );
  assert.match(runtimeManager, /sb\.appendLine\("next\(\)[^\n]*nextLauncher\.absolutePath/);
  assert.match(runtimeManager, /writeScript\(\s*"next"[\s\S]*?nextLauncher\.absolutePath/);
  assert.match(runtimeManager, /"ADEV_NEXT_LAUNCHER" to File\(libDir, "adev-next\.js"\)/);

  const npmShell = fs.readFileSync(
    path.join(repo, 'android/app/src/main/cpp/adev_npm_shell.cpp'),
    'utf8',
  );
  assert.match(npmShell, /static void try_next_exec\(char \*\*argv\)/);
  assert.match(npmShell, /try_next_exec\(v\)/);
  assert.match(npmShell, /getenv\("ADEV_NEXT_LAUNCHER"\)/);

  const processManager = fs.readFileSync(
    path.join(
      repo,
      'android/app/src/main/java/com/mobileide/app/process/ProcessManager.kt',
    ),
    'utf8',
  );
  assert.match(processManager, /"next" -> if \(node\.exists\(\) && nextLauncher\.exists\(\)\)/);

  const child = spawn(
    process.execPath,
    [
      '--require',
      serverEvents,
      '-e',
      [
        "const http=require('node:http');",
        "const s=http.createServer((_q,r)=>r.end('ok',()=>s.close()));",
        "s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
      ].join(''),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let eventLog = '';
  child.stderr.on('data', chunk => (eventLog += chunk));
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
  });
  assert.ok(Number.isInteger(port) && port > 0);
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}`, response => {
      let data = '';
      response.on('data', chunk => (data += chunk));
      response.on('end', () => resolve(data));
    }).on('error', reject);
  });
  assert.equal(body, 'ok');
  await new Promise(resolve => child.once('close', resolve));
  assert.match(eventLog, /ADEV_SERVER_EVENT .*"event":"listening"/);
  assert.match(eventLog, /ADEV_SERVER_EVENT .*"event":"close"/);

  const registry = fs.readFileSync(
    path.join(
      repo,
      'android/app/src/main/java/com/mobileide/app/process/TaskRegistry.kt',
    ),
    'utf8',
  );
  assert.match(registry, /probeLoopback/);
  assert.match(registry, /PROC_OWNERSHIP/);
  assert.match(registry, /processGroupId/);

  const watcher = fs.readFileSync(
    path.join(
      repo,
      'android/app/src/main/java/com/mobileide/app/filesystem/RecursiveFileWatcher.kt',
    ),
    'utf8',
  );
  assert.match(watcher, /addTree/);
  assert.match(watcher, /IN_Q_OVERFLOW/);

  process.stdout.write('Phase 2 host tests passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
