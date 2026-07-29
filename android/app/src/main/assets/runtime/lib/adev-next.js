#!/usr/bin/env node
'use strict';

/**
 * Android Next.js launcher.
 *
 * - resolves Next from the current project (never silently runs a global copy)
 * - caches the exact matching @next/swc-wasm-nodejs package outside the project
 * - prepends that cache to NODE_PATH
 * - selects webpack for `next dev` and `next build`
 *
 * No package.json, lockfile, or node_modules file in the user project is
 * modified.
 */
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const Module = require('node:module');

function fail(message, details) {
  process.stderr.write(`adev-next: ${message}\n`);
  if (details) process.stderr.write(`${details}\n`);
  process.exitCode = 1;
}

function findProject(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function resolveNext(project) {
  try {
    const packageJson = require.resolve('next/package.json', { paths: [project] });
    const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    return {
      version: manifest.version,
      packageDir: path.dirname(packageJson),
      bin: require.resolve('next/dist/bin/next', { paths: [project] }),
    };
  } catch (error) {
    fail(
      'Next.js is not installed in this project.',
      `Run npm install in ${project}, then retry. ${error.message}`,
    );
    return null;
  }
}

function cacheRoot(version) {
  const base =
    process.env.ADEV_NEXT_CACHE ||
    path.join(process.env.PREFIX || path.dirname(process.execPath), 'cache', 'next-swc');
  return path.join(base, version);
}

function wasmPackage(cache) {
  return path.join(cache, 'node_modules', '@next', 'swc-wasm-nodejs', 'package.json');
}

function npmCli() {
  if (process.env.ADEV_NPM_CLI && fs.existsSync(process.env.ADEV_NPM_CLI)) {
    return process.env.ADEV_NPM_CLI;
  }
  const prefix = process.env.PREFIX;
  if (prefix) {
    const bundled = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(bundled)) return bundled;
  }
  try {
    return require.resolve('npm/bin/npm-cli.js');
  } catch {
    return null;
  }
}

function prepareWasm(version, cache, options = {}) {
  const manifestPath = wasmPackage(cache);
  if (fs.existsSync(manifestPath)) {
    try {
      const installed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
      if (installed === version) return manifestPath;
    } catch {
      // A partial cache is repaired by the exact install below.
    }
  }

  const npm = npmCli();
  if (!npm) {
    fail('The bundled npm CLI is unavailable; cannot prepare the Next.js WASM compiler.');
    return null;
  }

  fs.mkdirSync(cache, { recursive: true });
  process.stderr.write(`adev-next: caching @next/swc-wasm-nodejs@${version}…\n`);
  if (options.dryRun) return manifestPath;

  const result = childProcess.spawnSync(
    process.execPath,
    [
      npm,
      'install',
      '--prefix',
      cache,
      '--no-save',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `@next/swc-wasm-nodejs@${version}`,
    ],
    { stdio: 'inherit', env: process.env },
  );
  if (result.error || result.status !== 0 || !fs.existsSync(manifestPath)) {
    fail(
      `Could not cache @next/swc-wasm-nodejs@${version}.`,
      'Check the network or warm the A Dev Studio npm cache, then retry. The project was not modified.',
    );
    return null;
  }
  return manifestPath;
}

function withWebpack(args) {
  const subcommand = args[0];
  if (subcommand === 'dev' || subcommand === 'build') {
    const compatibleArgs = args.filter(arg => arg !== '--turbopack' && arg !== '--turbo');
    if (!compatibleArgs.includes('--webpack')) {
      return [subcommand, '--webpack', ...compatibleArgs.slice(1)];
    }
    return compatibleArgs;
  }
  return args;
}

function main() {
  const rawArgs = process.argv.slice(2);
  const diagnostic = rawArgs.includes('--adev-diagnose');
  const prepareOnly = rawArgs.includes('--adev-prepare-only');
  const dryRun = rawArgs.includes('--adev-dry-run');
  const args = rawArgs.filter(
    arg => !['--adev-diagnose', '--adev-prepare-only', '--adev-dry-run'].includes(arg),
  );
  const project = findProject(process.cwd());
  const next = resolveNext(project);
  if (!next) return;

  const cache = cacheRoot(next.version);
  const wasm = prepareWasm(next.version, cache, { dryRun });
  if (!wasm) return;

  const cacheModules = path.join(cache, 'node_modules');
  process.env.NODE_PATH = [cacheModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  process.env.NEXT_DISABLE_SWC_NATIVE = '1';
  process.env.NEXT_IGNORE_INCORRECT_LOCKFILE = '1';
  process.env.NEXT_TELEMETRY_DISABLED = process.env.NEXT_TELEMETRY_DISABLED || '1';
  process.env.ADEV_NEXT_SWC_WASM = wasm;
  Module._initPaths();

  const launchedArgs = withWebpack(args.length ? args : ['dev']);
  if (diagnostic || dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          project,
          nextVersion: next.version,
          nextBin: next.bin,
          wasmPackage: wasm,
          cache,
          args: launchedArgs,
          projectModified: false,
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (prepareOnly || dryRun) return;

  process.argv = [process.execPath, next.bin, ...launchedArgs];
  require(next.bin);
}

main();

module.exports = { findProject, withWebpack };
