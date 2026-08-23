#!/usr/bin/env node
'use strict';

/**
 * Android Next.js launcher.
 *
 * - resolves Next from the current project (never silently runs a global copy)
 * - makes the exact matching @next/swc-wasm-nodejs resolvable from the project,
 *   backed by an ADEV-managed cache (see adev-next-swc.js)
 * - selects the version-appropriate webpack CLI form for `next dev`/`next build`
 * - runs the project's own CLI as an owned child with real stdio and signals
 * - surfaces published security advisories for the installed version without
 *   ever changing the project's dependencies
 *
 * The project's package.json and lockfile are never modified.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const Module = require('node:module');
const swc = require('./adev-next-swc.js');

const ADVISORY_TTL_MS = 24 * 60 * 60 * 1000;

function fail(message, details) {
  process.stderr.write(`adev-next: ${message}\n`);
  if (details) process.stderr.write(`${details}\n`);
  process.exitCode = 1;
}

function findProject(start) {
  return swc.findProject(start);
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
 * Report published advisories for the installed Next.js version.
 *
 * Dependency ownership belongs to the project: ADEV states what npm's security
 * metadata says and stops there. It never edits package.json, never installs a
 * different version, and never refuses to run a version that works.
 *
 * Best effort by construction — an offline device, a proxy or a slow network
 * produces silence, not a warning and not a delay.
 */
async function reportAdvisories(version, options = {}) {
  if (process.env.ADEV_NEXT_ADVISORIES === '0') return null;
  const cacheFile = path.join(swc.cacheRoot(version), 'advisories.json');
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.version === version && Date.now() - cached.checkedAt < ADVISORY_TTL_MS) {
      printAdvisories(version, cached.advisories, options);
      return cached.advisories;
    }
  } catch {
    // No usable cache entry; fall through to a fresh lookup.
  }

  let advisories;
  try {
    advisories = await fetchAdvisories(version, options);
  } catch {
    return null;
  }
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ version, checkedAt: Date.now(), advisories }),
    );
  } catch {
    // A read-only cache only costs us the next lookup.
  }
  printAdvisories(version, advisories, options);
  return advisories;
}

function fetchAdvisories(version, options = {}) {
  const https = require('node:https');
  const registry =
    options.registry ||
    process.env.ADEV_NPM_REGISTRY ||
    'https://registry.npmjs.org';
  const body = JSON.stringify({ next: [version] });
  return new Promise((resolve, reject) => {
    const request = https.request(
      `${registry.replace(/\/+$/, '')}/-/npm/v1/security/advisories/bulk`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: options.timeoutMs || 5000,
      },
      response => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`advisory lookup returned ${response.statusCode}`));
          return;
        }
        let payload = '';
        response.setEncoding('utf8');
        response.on('data', chunk => (payload += chunk));
        response.on('end', () => {
          try {
            const parsed = JSON.parse(payload);
            resolve(Array.isArray(parsed.next) ? parsed.next : []);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('advisory lookup timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

function printAdvisories(version, advisories, options = {}) {
  if (!Array.isArray(advisories) || advisories.length === 0) return;
  const out = options.stderr || process.stderr;
  out.write(
    `adev-next: npm reports ${advisories.length} advisor${advisories.length === 1 ? 'y' : 'ies'} for next@${version}:\n`,
  );
  for (const advisory of advisories) {
    out.write(
      `  - [${advisory.severity || 'unknown'}] ${advisory.title || 'advisory'}` +
        `${advisory.vulnerable_versions ? ` (affects ${advisory.vulnerable_versions})` : ''}\n`,
    );
  }
  out.write(
    '  This is your project\'s dependency: A Dev Studio has not changed it. ' +
      'Update Next.js yourself when you are ready.\n',
  );
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

  // A dry run inspects what would happen and touches nothing at all — not the
  // manifest, not the lockfile, not node_modules.
  const prepared = dryRun
    ? {
        ok: Boolean(swc.ensureCached(next.version, { allowDownload: false })),
        compilerVersion: next.version,
        cache: swc.cacheRoot(next.version),
        packageDir: swc.cachedPackageDir(next.version),
        published: [],
      }
    : swc.prepare(project, { next, allowDownload: true });

  if (!prepared.ok && !dryRun) {
    fail(
      `Could not make the Next.js ${next.version} WebAssembly compiler available.`,
      'Android has no native SWC binding, so A Dev Studio uses ' +
        `@next/swc-wasm-nodejs@${next.version}. Check the network and retry; ` +
        'the project was not modified.',
    );
    return;
  }

  const cache = prepared.cache || swc.cacheRoot(next.version);
  const cacheModules = path.join(cache, 'node_modules');
  process.env.NODE_PATH = [cacheModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  process.env.NEXT_IGNORE_INCORRECT_LOCKFILE = '1';
  process.env.NEXT_TELEMETRY_DISABLED = process.env.NEXT_TELEMETRY_DISABLED || '1';
  process.env.ADEV_NEXT_SWC_WASM = path.join(prepared.packageDir, 'package.json');
  Module._initPaths();

  const launchedArgs = withWebpack(args.length ? args : ['dev'], next.major);
  if (diagnostic || dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          project,
          nextVersion: next.version,
          nextBin: next.bin,
          // The compiler version can differ from the Next version when Vercel
          // published no WASM build for that exact release.
          compilerVersion: prepared.compilerVersion,
          wasmPackage: path.join(prepared.packageDir, 'package.json'),
          cache,
          args: launchedArgs,
          // The compiler mapping lives entirely inside node_modules. The
          // dependency declarations the project owns are never touched.
          manifestModified: false,
          lockfileModified: false,
          compilerMapping: prepared.published,
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (prepareOnly || dryRun) return;

  // Concurrent with startup, never gating it.
  void reportAdvisories(next.version);

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

module.exports = {
  fetchAdvisories,
  findProject,
  launchNext,
  parseNextMajor,
  printAdvisories,
  reportAdvisories,
  signalExitCode,
  withWebpack,
};
