#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const network = process.argv.includes('--network') || process.argv.includes('--full');
const prefix = process.env.PREFIX;
const npmCli = process.env.ADEV_NPM_CLI;
const nextLauncher = process.env.ADEV_NEXT_LAUNCHER;
const root = path.join(
  prefix || process.cwd(),
  'workspaces',
  `.adev-phase2-${Date.now()}`,
);

function log(message) {
  process.stdout.write(`[phase2] ${message}\n`);
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function runNode(script, args, cwd, env = {}) {
  return childProcess.spawn(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function command(args, cwd) {
  const result = childProcess.spawnSync(process.execPath, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  assert.equal(result.status, 0, `command failed: node ${args.join(' ')}`);
}

async function waitHttp(port, expected, timeout = 90_000, pathname = '/') {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const body = await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}${pathname}`, response => {
          let data = '';
          response.on('data', chunk => (data += chunk));
          response.on('end', () => resolve(data));
        });
        request.setTimeout(2_000, () => request.destroy(new Error('timeout')));
        request.on('error', reject);
      });
      if (!expected || body.includes(expected)) return body;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`port ${port} did not serve ${expected}: ${lastError || 'unexpected body'}`);
}

function isOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const closed = () => resolve(false);
    socket.once('error', closed);
    socket.once('timeout', () => {
      socket.destroy();
      closed();
    });
  });
}

async function stop(child, port) {
  if (child.exitCode == null) child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await isOpen(port))) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await isOpen(port), false, `port ${port} remained open after stop`);
}

function forward(child) {
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
}

async function testPlainNode() {
  const file = path.join(root, 'node', 'server.js');
  write(
    file,
    "require('node:http').createServer((_q,r)=>r.end('plain-node-ok')).listen(3341,'127.0.0.1');\n",
  );
  const child = runNode(file, [], path.dirname(file));
  forward(child);
  await waitHttp(3341, 'plain-node-ok');
  await stop(child, 3341);
  log('plain Node start/probe/stop/cleanup passed');
}

function npmInstall(cwd) {
  assert.ok(npmCli && fs.existsSync(npmCli), 'bundled npm CLI missing');
  command([npmCli, 'install', '--no-audit', '--no-fund'], cwd);
}

async function testExpress() {
  const dir = path.join(root, 'express');
  write(
    path.join(dir, 'package.json'),
    JSON.stringify({ private: true, dependencies: { express: '5.1.0' } }),
  );
  write(
    path.join(dir, 'server.js'),
    "const e=require('express');const a=e();a.get('/',(_q,r)=>r.send('express-ok'));a.listen(3342,'127.0.0.1');\n",
  );
  npmInstall(dir);
  const child = runNode(path.join(dir, 'server.js'), [], dir);
  forward(child);
  await waitHttp(3342, 'express-ok');
  await stop(child, 3342);
  log('Express passed');
}

async function testVite() {
  const dir = path.join(root, 'vite');
  write(
    path.join(dir, 'package.json'),
    JSON.stringify({ private: true, devDependencies: { vite: '7.1.7' } }),
  );
  write(path.join(dir, 'index.html'), '<script type="module" src="/src/main.js"></script>');
  write(path.join(dir, 'src/main.js'), "document.body.textContent='vite-one';\n");
  npmInstall(dir);
  const vite = require.resolve('vite/bin/vite.js', { paths: [dir] });
  const child = runNode(vite, ['--host', '127.0.0.1', '--port', '3343'], dir);
  forward(child);
  await waitHttp(3343, '/src/main.js');
  await waitHttp(3343, 'vite-one', 90_000, '/src/main.js');
  write(path.join(dir, 'src/main.js'), "document.body.textContent='vite-two';\n");
  await waitHttp(3343, 'vite-two', 90_000, '/src/main.js');
  await stop(child, 3343);
  log('Vite nested edit/HMR watcher passed');
}

function nextFiles(dir, router, message) {
  if (router === 'app') {
    write(path.join(dir, 'app/message.js'), `export default ${JSON.stringify(message)};\n`);
    write(
      path.join(dir, 'app/page.js'),
      "import message from './message';export default function Page(){return <main>{message}</main>}\n",
    );
    write(
      path.join(dir, 'app/layout.js'),
      "export default function Layout({children}){return <html><body>{children}</body></html>}\n",
    );
  } else {
    write(path.join(dir, 'pages/message.js'), `export default ${JSON.stringify(message)};\n`);
    write(
      path.join(dir, 'pages/index.js'),
      "import message from './message';export default function Page(){return <main>{message}</main>}\n",
    );
  }
}

async function testNext(version, router, port) {
  const dir = path.join(root, `next-${version}-${router}`);
  write(
    path.join(dir, 'package.json'),
    JSON.stringify({
      private: true,
      scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
      dependencies: { next: version, react: '19.2.0', 'react-dom': '19.2.0' },
    }),
  );
  nextFiles(dir, router, `${version}-${router}-one`);
  npmInstall(dir);
  assert.ok(nextLauncher && fs.existsSync(nextLauncher), 'Android Next launcher missing');
  command([nextLauncher, '--adev-prepare-only'], dir);

  const packageBefore = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  const lockBefore = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8');
  const throughNpm = router === 'pages';
  let child = throughNpm
    ? runNode(
        npmCli,
        ['run', 'dev', '--', '-H', '127.0.0.1', '-p', String(port)],
        dir,
      )
    : runNode(
        nextLauncher,
        ['dev', '-H', '127.0.0.1', '-p', String(port)],
        dir,
      );
  forward(child);
  await waitHttp(port, `${version}-${router}-one`, 180_000);
  assert.equal(
    child.exitCode,
    null,
    `Next.js ${version} ${router} launcher exited while its dev server was still active`,
  );
  nextFiles(dir, router, `${version}-${router}-two`);
  await waitHttp(port, `${version}-${router}-two`, 120_000);
  await stop(child, port);

  if (throughNpm) command([npmCli, 'run', 'build'], dir);
  else command([nextLauncher, 'build'], dir);
  child = throughNpm
    ? runNode(
        npmCli,
        ['run', 'start', '--', '-H', '127.0.0.1', '-p', String(port)],
        dir,
      )
    : runNode(
        nextLauncher,
        ['start', '-H', '127.0.0.1', '-p', String(port)],
        dir,
      );
  forward(child);
  await waitHttp(port, `${version}-${router}-two`, 120_000);
  await stop(child, port);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), packageBefore);
  assert.equal(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), lockBefore);
  log(`Next.js ${version} ${router} dev/HMR/build/start passed`);
}

(async () => {
  fs.mkdirSync(root, { recursive: true });
  try {
    await testPlainNode();
    if (network) {
      await testExpress();
      await testVite();
      await testNext('15.5.22', 'app', 3351);
      await testNext('15.5.22', 'pages', 3352);
      await testNext('16.2.12', 'app', 3361);
      await testNext('16.2.12', 'pages', 3362);
    } else {
      log('network/framework matrix skipped; rerun adev-phase2-test --network');
    }
    log('PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
