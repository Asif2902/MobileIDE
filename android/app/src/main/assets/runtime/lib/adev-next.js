#!/usr/bin/env node
'use strict';

/**
 * Android Next.js launcher.
 *
 * - resolves Next from the current project (never silently runs a global copy)
 * - caches the exact matching @next/swc-wasm-nodejs package outside the project
 * - prepends that cache to NODE_PATH
 * - selects the version-appropriate webpack CLI form for `next dev` and
 *   `next build`
 *
 * No package.json, lockfile, or node_modules file in the user project is
 * modified.
 */
const fs = require('node:fs');
const os = require('node:os');
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

function parseNextMajor(version) {
  const semver =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const match = typeof version === 'string' ? semver.exec(version) : null;
  if (!match) {
    throw new Error(
      `Next.js reported invalid version ${JSON.stringify(version)}; expected a complete semantic version such as 15.5.22.`,
    );
  }

  const major = Number(match[1]);
  if (!Number.isSafeInteger(major)) {
    throw new Error(`Next.js reported an out-of-range major version in ${JSON.stringify(version)}.`);
  }
  return major;
}

function resolveNext(project) {
  let packageJson;
  try {
    packageJson = require.resolve('next/package.json', { paths: [project] });
  } catch (error) {
    fail(
      'Next.js is not installed in this project.',
      `Run npm install in ${project}, then retry. ${error.message}`,
    );
    return null;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    return {
      version: manifest.version,
      major: parseNextMajor(manifest.version),
      packageDir: path.dirname(packageJson),
      bin: require.resolve('next/dist/bin/next', { paths: [project] }),
    };
  } catch (error) {
    fail(
      'The local Next.js installation has invalid metadata.',
      `${error.message} Reinstall Next.js in ${project}, then retry.`,
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

function withWebpack(args, major) {
  const subcommand = args[0];
  if (subcommand === 'dev' || subcommand === 'build') {
    if (!Number.isSafeInteger(major) || major < 0) {
      throw new Error('A validated Next.js major version is required for dev/build selection.');
    }

    const selectors = new Set(['--turbopack', '--turbo', '--webpack']);
    const compatibleArgs = args.slice(1).filter(arg => !selectors.has(arg));

    // Next 15 and earlier already default to webpack and reject --webpack.
    // Next 16 defaults to Turbopack and exposes --webpack as the supported
    // opt-out. Rebuild the selector list so conflicting or duplicate flags
    // can never reach the project CLI.
    return major < 16
      ? [subcommand, ...compatibleArgs]
      : [subcommand, '--webpack', ...compatibleArgs];
  }
  return args;
}

function signalExitCode(signal) {
  const number = os.constants.signals[signal];
  return Number.isInteger(number) ? 128 + number : 1;
}

/**
 * Run the project CLI as an owned child instead of requiring it into this
 * wrapper. Next versions are then free to call process.exit(), replace signal
 * handlers, or fork their own dev worker without taking over the ADEV task
 * owner. The child remains in the caller's process group so TaskRegistry can
 * still terminate the complete tree.
 */
function launchNext(nextBin, args, options = {}) {
  const owner = options.owner || process;
  const spawn = options.spawn || childProcess.spawn;
  const child = spawn(options.execPath || process.execPath, [nextBin, ...args], {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: 'inherit',
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const childIsRunning = () => child.exitCode === null && child.signalCode === null;
    const forward = signal => {
      if (!settled && childIsRunning()) {
        try {
          child.kill(signal);
        } catch (error) {
          process.stderr.write(`adev-next: could not forward ${signal}: ${error.message}\n`);
        }
      }
    };
    const forwardSigint = () => forward('SIGINT');
    const forwardSigterm = () => forward('SIGTERM');
    const terminateOnOwnerExit = () => {
      if (!settled && childIsRunning()) {
        try {
          child.kill('SIGKILL');
        } catch {
          // The child may have exited between the state check and kill().
        }
      }
    };
    const cleanup = () => {
      owner.removeListener('SIGINT', forwardSigint);
      owner.removeListener('SIGTERM', forwardSigterm);
      owner.removeListener('exit', terminateOnOwnerExit);
    };

    owner.on('SIGINT', forwardSigint);
    owner.on('SIGTERM', forwardSigterm);
    owner.once('exit', terminateOnOwnerExit);

    child.once('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      owner.exitCode = code === null ? signalExitCode(signal) : code;
      resolve({ code, signal });
    });
  });
}

async function main() {
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

  const launchedArgs = withWebpack(args.length ? args : ['dev'], next.major);
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

  try {
    await launchNext(next.bin, launchedArgs);
  } catch (error) {
    fail(
      `Could not launch Next.js ${next.version}.`,
      `${error.message} The project was not modified.`,
    );
  }
}

if (require.main === module) {
  void main();
}

module.exports = { findProject, parseNextMajor, withWebpack, signalExitCode, launchNext };
