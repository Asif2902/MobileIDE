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

function run(label, command, args, cwd) {
  const result = childProcess.spawnSync(command, args, {
    cwd,
    env: process.env,
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
}

try {
  run('doctor', process.execPath, [path.join(prefix, 'lib', 'adev-doctor.js'), '--json'], prefix);
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

  process.stdout.write(`${JSON.stringify({ok: true, network, results}, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.stderr.write(`${JSON.stringify({ok: false, network, results}, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(workRoot, {recursive: true, force: true});
}
