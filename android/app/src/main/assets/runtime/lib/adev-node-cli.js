'use strict';

/**
 * Data-driven launcher for Node CLIs that need Android startup capabilities.
 *
 * Node flags have to be present before Node initializes; putting them in this
 * JavaScript process or appending another NODE_OPTIONS entry is too late and
 * can break Next.js worker re-serialization. RuntimeManager therefore starts
 * this file with the command's catalogued CLI flags while preserving the
 * existing NODE_OPTIONS value byte-for-byte.
 *
 * The same catalog also materializes verified Android Node-API addons into the
 * package locations their upstream loaders already support. Nothing fakes a
 * successful require: the real addon is copied atomically and then loaded by
 * the package's normal code.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const catalogPath = path.join(__dirname, 'adev-cli-compat.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const configuredPrefix = path.resolve(process.env.PREFIX || path.join(__dirname, '..'));
const prefix = fs.realpathSync(configuredPrefix);

function fail(message, code = 1) {
  process.stderr.write(`adev: ${message}\n`);
  process.exit(code);
}

function insidePrefix(candidate) {
  const resolved = fs.realpathSync(path.resolve(candidate));
  return resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`);
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function findPackageRoot(request, fromRoot) {
  const requireFromPackage = createRequire(path.join(fromRoot, 'package.json'));
  let resolved;
  try {
    resolved = requireFromPackage.resolve(`${request}/package.json`);
  } catch {
    resolved = requireFromPackage.resolve(request);
  }

  let cursor = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  while (cursor !== path.dirname(cursor)) {
    const manifestPath = path.join(cursor, 'package.json');
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name === request) return { root: cursor, manifest };
    }
    cursor = path.dirname(cursor);
  }
  throw new Error(`could not locate package root for ${request}`);
}

function locateCommandPackage(command) {
  const rule = catalog.commands[command];
  if (!rule) fail(`unknown compatible Node CLI: ${command}`, 64);

  const roots = [
    path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules'),
    path.join(prefix, 'lib', 'node_modules')
  ];
  for (const root of roots) {
    const candidate = path.join(root, ...rule.package.split('/'));
    const manifestPath = path.join(candidate, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== rule.package) continue;
    if (!rule.versions.includes(manifest.version)) {
      fail(`${rule.package}@${manifest.version} is not covered by this ADEV compatibility pack`);
    }
    return { rule, root: fs.realpathSync(candidate), manifest };
  }
  fail(`${rule.package} is not installed; install it with npm first`, 127);
}

function materializeAddon(ownerRoot, addon) {
  let dependency;
  try {
    dependency = findPackageRoot(addon.package, ownerRoot);
  } catch (error) {
    process.stderr.write(`adev: ${addon.package}@${addon.version} is unavailable: ${error.message}\n`);
    return;
  }
  if (dependency.manifest.version !== addon.version) {
    process.stderr.write(
      `adev: ${addon.package}@${dependency.manifest.version} has no verified Android addon ` +
      `(available: ${addon.version})\n`
    );
    return;
  }

  const dependencyRoot = fs.realpathSync(dependency.root);
  const source = path.resolve(__dirname, addon.source);
  const target = path.resolve(dependencyRoot, addon.target);
  if (!insidePrefix(dependencyRoot) || !target.startsWith(`${dependencyRoot}${path.sep}`)) {
    throw new Error(`refusing native-addon write outside the private ADEV runtime: ${target}`);
  }
  if (!fs.existsSync(source) || sha256(source) !== addon.sha256) {
    throw new Error(`verified ${addon.package} Android addon is missing or corrupt`);
  }
  if (fs.existsSync(target) && sha256(target) === addon.sha256) return;

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.adev-${process.pid}`;
  try {
    fs.copyFileSync(source, temporary);
    fs.chmodSync(temporary, 0o755);
    if (sha256(temporary) !== addon.sha256) throw new Error('copy verification failed');
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or never created */ }
  }
}

async function main() {
  if (process.platform !== 'android' || process.arch !== 'arm64') {
    fail(`CLI compatibility pack supports android-arm64, got ${process.platform}-${process.arch}`);
  }
  const command = process.argv[2];
  const args = process.argv.slice(3);
  const selected = locateCommandPackage(command);

  for (const addon of catalog.nativeAddons) materializeAddon(selected.root, addon);

  const entry = path.resolve(selected.root, selected.rule.bin);
  if (!entry.startsWith(`${selected.root}${path.sep}`) || !fs.existsSync(entry)) {
    fail(`invalid ${command} entry point: ${entry}`);
  }
  process.argv = [process.execPath, entry, ...args];
  await import(pathToFileURL(entry).href);
}

main().catch(error => fail(error && (error.stack || error.message) || String(error)));
