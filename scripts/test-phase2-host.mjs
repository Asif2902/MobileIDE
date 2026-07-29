import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const launcher = path.join(repo, 'android/app/src/main/assets/runtime/lib/adev-next.js');
const serverEvents = path.join(
  repo,
  'android/app/src/main/assets/runtime/lib/adev-server-events.js',
);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => (stdout += chunk));
    child.stderr?.on('data', chunk => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-phase2-host-'));
try {
  const project = path.join(root, 'project');
  const nextDir = path.join(project, 'node_modules', 'next');
  const nextBin = path.join(nextDir, 'dist', 'bin', 'next.js');
  const cache = path.join(root, 'cache');
  const wasmManifest = path.join(
    cache,
    '15.5.22',
    'node_modules',
    '@next',
    'swc-wasm-nodejs',
    'package.json',
  );
  fs.mkdirSync(path.dirname(nextBin), { recursive: true });
  fs.mkdirSync(path.dirname(wasmManifest), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(
    path.join(nextDir, 'package.json'),
    JSON.stringify({ name: 'next', version: '15.5.22' }),
  );
  fs.writeFileSync(
    nextBin,
    "require('node:fs').writeFileSync(process.env.ADEV_FAKE_NEXT_OUT, JSON.stringify({ignore:process.env.NEXT_IGNORE_INCORRECT_LOCKFILE,telemetry:process.env.NEXT_TELEMETRY_DISABLED,nodePath:process.env.NODE_PATH}));\n",
  );
  fs.writeFileSync(
    wasmManifest,
    JSON.stringify({ name: '@next/swc-wasm-nodejs', version: '15.5.22' }),
  );

  const before = fs.readFileSync(path.join(project, 'package.json'), 'utf8');
  const dev = await run(
    process.execPath,
    [launcher, '--adev-dry-run', '--adev-diagnose', 'dev', '-p', '3210'],
    { cwd: project, env: { ...process.env, ADEV_NEXT_CACHE: cache } },
  );
  assert.equal(dev.code, 0, dev.stderr);
  const devInfo = JSON.parse(dev.stdout);
  assert.equal(devInfo.nextVersion, '15.5.22');
  assert.deepEqual(devInfo.args, ['dev', '--webpack', '-p', '3210']);
  assert.equal(devInfo.projectModified, false);

  const turbo = await run(
    process.execPath,
    [launcher, '--adev-dry-run', 'dev', '--turbopack', '-p', '3210'],
    { cwd: project, env: { ...process.env, ADEV_NEXT_CACHE: cache } },
  );
  assert.deepEqual(JSON.parse(turbo.stdout).args, ['dev', '--webpack', '-p', '3210']);

  const build = await run(
    process.execPath,
    [launcher, '--adev-dry-run', 'build'],
    { cwd: project, env: { ...process.env, ADEV_NEXT_CACHE: cache } },
  );
  assert.deepEqual(JSON.parse(build.stdout).args, ['build', '--webpack']);

  const start = await run(
    process.execPath,
    [launcher, '--adev-dry-run', 'start', '-p', '3210'],
    { cwd: project, env: { ...process.env, ADEV_NEXT_CACHE: cache } },
  );
  assert.deepEqual(JSON.parse(start.stdout).args, ['start', '-p', '3210']);
  assert.equal(fs.readFileSync(path.join(project, 'package.json'), 'utf8'), before);

  const fakeNextOutput = path.join(root, 'fake-next-output.json');
  const direct = await run(process.execPath, [launcher, 'start'], {
    cwd: project,
    env: {
      ...process.env,
      ADEV_NEXT_CACHE: cache,
      ADEV_FAKE_NEXT_OUT: fakeNextOutput,
    },
  });
  assert.equal(direct.code, 0, direct.stderr);
  const directEnv = JSON.parse(fs.readFileSync(fakeNextOutput, 'utf8'));
  assert.equal(directEnv.ignore, '1');
  assert.equal(directEnv.telemetry, '1');
  assert.ok(directEnv.nodePath.includes(path.join(cache, '15.5.22', 'node_modules')));

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
