#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const prefix = process.env.PREFIX || path.resolve(__dirname, '..');
const lockPath =
  process.env.ADEV_PACKAGE_MANAGER_LOCK ||
  path.join(prefix, 'lib', 'adev-package-managers.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const requested = process.argv[2];
const cliArgs = process.argv.slice(3);

function readDeclaration(start) {
  let current = path.resolve(start);
  const boundary = path.parse(current).root;
  while (true) {
    const manifest = path.join(current, 'package.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (typeof parsed.packageManager === 'string') {
        const match = /^(pnpm|yarn)@([^+\s]+)(?:\+.*)?$/.exec(parsed.packageManager.trim());
        if (match) {
          return {
            name: match[1],
            version: match[2],
            raw: parsed.packageManager,
            manifest,
          };
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === boundary) break;
    current = path.dirname(current);
  }
  return null;
}

function managerStatus(name, cwd = process.cwd()) {
  const bundled = lock.managers[name] || null;
  const declaration = readDeclaration(cwd);
  const selectedVersion =
    declaration && declaration.name === name ? declaration.version : bundled && bundled.version;
  const bundledMatch = Boolean(bundled && selectedVersion === bundled.version);
  return {
    name,
    selectedVersion: selectedVersion || null,
    bundledVersion: bundled && bundled.version,
    declaration,
    source: bundledMatch
      ? declaration
        ? 'project-packageManager+bundled-offline'
        : 'bundled-offline-default'
      : declaration
        ? 'project-packageManager+corepack-network'
        : 'corepack-default',
    offlineReady: bundledMatch,
    networkAllowed:
      process.env.COREPACK_ENABLE_NETWORK !== '0' && process.env.ADEV_OFFLINE !== '1',
  };
}

function runNode(entrypoint, args) {
  const result = childProcess.spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`ADEV package-manager launch failed: ${result.error.message}\n`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

function verifyAssets(assets) {
  for (const [relativePath, expected] of Object.entries(assets || {})) {
    const asset = path.join(prefix, 'lib', relativePath);
    if (!fs.existsSync(asset)) throw new Error(`verified package-manager asset missing: ${asset}`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
    if (actual !== expected) {
      throw new Error(`package-manager asset integrity mismatch: ${relativePath}`);
    }
  }
}

function runCorepack(args) {
  const corepack = path.join(prefix, 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js');
  if (!fs.existsSync(corepack)) {
    process.stderr.write('ADEV Corepack payload is missing from the runtime.\n');
    return 1;
  }
  verifyAssets(lock.corepack.assets);
  return runNode(corepack, args);
}

if (requested === '--status' || requested === '--json') {
  const status = {
    schemaVersion: 1,
    corepack: {
      version: lock.corepack.version,
      ready: fs.existsSync(
        path.join(prefix, 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js')
      ),
    },
    pnpm: managerStatus('pnpm'),
    yarn: managerStatus('yarn'),
  };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exit(0);
}

if (requested === 'corepack') {
  process.exit(runCorepack(cliArgs));
}

if (requested !== 'pnpm' && requested !== 'yarn') {
  process.stderr.write('Usage: adev-package-manager <corepack|pnpm|yarn|--status> [...args]\n');
  process.exit(64);
}

const status = managerStatus(requested);
const bundled = lock.managers[requested];
if (status.offlineReady && bundled) {
  verifyAssets(bundled.assets);
  const entrypoint = path.join(prefix, 'lib', bundled.entrypoint);
  if (!fs.existsSync(entrypoint)) {
    process.stderr.write(
      `ADEV ${requested}@${bundled.version} offline payload is missing: ${entrypoint}\n`
    );
    process.exit(1);
  }
  process.exit(runNode(entrypoint, cliArgs));
}

if (!status.networkAllowed) {
  process.stderr.write(
    `ADEV offline cache contains ${requested}@${bundled.version}, but this project requests ` +
      `${status.selectedVersion || 'an unresolved version'}. Connect once to let verified ` +
      'Corepack cache that exact version, or update packageManager to the bundled version.\n'
  );
  process.exit(69);
}

process.exit(runCorepack([requested, ...cliArgs]));

module.exports = { readDeclaration, managerStatus };
