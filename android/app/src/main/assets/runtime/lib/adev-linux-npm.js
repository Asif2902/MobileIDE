#!/usr/bin/env node
'use strict';

/*
 * npm correctly reports Android/Bionic, but that means it omits optional
 * Linux payload packages even when the user explicitly installed ADEV's
 * Linux-user runtime. Repair only portable CLI companions: exact, declared
 * optional aliases ending in linux-arm64/aarch64, owned by a package with a
 * command-line entry point, containing real ARM64 executables and no .node
 * addons. This avoids a global OS spoof that would break Next, sharp and other
 * in-process native Node modules.
 */
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const prefix = path.resolve(process.env.PREFIX || path.join(__dirname, '..'));
const node = process.env.MOBILEIDE_NODE || process.execPath;
const npmCli = path.join(prefix, 'lib/node_modules/npm/bin/npm-cli.js');
const linuxManifest = path.join(prefix, 'linux/manifest.json');
const glibcManifest = path.join(prefix, 'glibc/manifest.json');
const args = process.argv.slice(2);

function installAction() {
  let skip = false;
  for (const value of args) {
    if (skip) { skip = false; continue; }
    if (['--prefix', '--workspace', '--registry', '--cache', '--userconfig', '-C'].includes(value)) {
      skip = true;
      continue;
    }
    if (value.startsWith('-')) continue;
    return ['install', 'i', 'add', 'ci'].includes(value);
  }
  return false;
}

function globalInstall() {
  return args.some(value => value === '-g' || value === '--global' || value === '--location=global');
}

function immediatePackages(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.')) continue;
    const entry = path.join(root, name);
    if (!fs.statSync(entry).isDirectory()) continue;
    if (name.startsWith('@')) {
      for (const child of fs.readdirSync(entry)) {
        const packageRoot = path.join(entry, child);
        if (fs.statSync(packageRoot).isDirectory()) result.push(packageRoot);
      }
    } else {
      result.push(entry);
    }
  }
  return result;
}

function readPackage(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }
  catch { return null; }
}

function dependencyPath(root, name) {
  return path.join(root, ...name.split('/'));
}

function targetFromAlias(spec) {
  const match = /^npm:(@[^/]+\/[^@]+|[^@/]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
  return match ? {name: match[1], version: match[2]} : null;
}

function inspectElf(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) return null;
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        header[4] !== 2 || header[5] !== 1) return null;
    const type = header.readUInt16LE(16);
    const machine = header.readUInt16LE(18);
    if (![2, 3].includes(type) || machine !== 183) return null;
    const phoff = Number(header.readBigUInt64LE(32));
    const phsize = header.readUInt16LE(54);
    const phnum = header.readUInt16LE(56);
    if (phsize < 56 || phnum === 0 || phnum > 1024) return null;
    let interpreter = null;
    let executableLoad = false;
    const program = Buffer.alloc(phsize);
    for (let index = 0; index < phnum; index += 1) {
      if (fs.readSync(descriptor, program, 0, phsize, phoff + index * phsize) !== phsize) return null;
      const kind = program.readUInt32LE(0);
      if (kind === 1 && (program.readUInt32LE(4) & 1)) executableLoad = true;
      if (kind !== 3) continue;
      const offset = Number(program.readBigUInt64LE(8));
      const size = Number(program.readBigUInt64LE(32));
      if (size < 2 || size > 4096) return null;
      const bytes = Buffer.alloc(size);
      if (fs.readSync(descriptor, bytes, 0, size, offset) !== size || bytes.at(-1) !== 0) return null;
      interpreter = bytes.subarray(0, -1).toString('utf8');
    }
    if (!executableLoad) return null;
    const kind = interpreter === null
      ? 'static'
      : interpreter.includes('ld-musl-')
        ? 'musl'
        : interpreter.includes('ld-linux')
          ? 'glibc'
          : interpreter.includes('/system/bin/linker')
            ? 'android'
            : 'other';
    return {type, machine, interpreter, kind};
  } finally {
    fs.closeSync(descriptor);
  }
}

function inspectPayload(root) {
  const executableFiles = [];
  let nativeAddon = false;
  let visited = 0;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (++visited > 50000) throw new Error('payload contains too many files');
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        if (entry.name.endsWith('.node')) nativeAddon = true;
        const elf = inspectElf(file);
        if (elf) executableFiles.push({file, ...elf});
      }
    }
  }
  walk(root);
  return {executableFiles, nativeAddon};
}

function validPlatformPackage(pkg) {
  const os = Array.isArray(pkg?.os) ? pkg.os : pkg?.os ? [pkg.os] : [];
  const cpu = Array.isArray(pkg?.cpu) ? pkg.cpu : pkg?.cpu ? [pkg.cpu] : [];
  const libc = Array.isArray(pkg?.libc) ? pkg.libc : pkg?.libc ? [pkg.libc] : [];
  return os.includes('linux') && cpu.includes('arm64') &&
    (libc.length === 0 || libc.some(value => value === 'musl' || value === 'glibc'));
}

function removeInstalled(root, binRoot) {
  try {
    if (fs.existsSync(binRoot)) {
      for (const entry of fs.readdirSync(binRoot)) {
        const link = path.join(binRoot, entry);
        let target;
        try {
          if (!fs.lstatSync(link).isSymbolicLink()) continue;
          target = path.resolve(binRoot, fs.readlinkSync(link));
        } catch { continue; }
        if (target === root || target.startsWith(`${root}${path.sep}`)) fs.rmSync(link, {force: true});
      }
    }
  } catch {}
  try { fs.rmSync(root, {recursive: true, force: true}); } catch {}
}

function main() {
  if (!installAction() || !fs.existsSync(linuxManifest) || !fs.existsSync(npmCli)) return;
  const isGlobal = globalInstall();
  const globalPrefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX ||
    path.join(process.env.HOME || path.join(prefix, 'home'), '.npm-global');
  const nodeModules = isGlobal
    ? path.join(globalPrefix, 'lib/node_modules')
    : path.join(process.cwd(), 'node_modules');
  const commandBin = isGlobal ? path.join(globalPrefix, 'bin') : path.join(nodeModules, '.bin');
  for (const parentRoot of immediatePackages(nodeModules)) {
    const parent = readPackage(parentRoot);
    if (!parent || !parent.bin || !parent.optionalDependencies) continue;
    for (const [alias, spec] of Object.entries(parent.optionalDependencies)) {
      if (!/(?:^|\/)[^/]+-linux-(?:arm64|aarch64)$/.test(alias)) continue;
      const target = targetFromAlias(spec);
      if (!target) continue;
      const installedRoot = dependencyPath(nodeModules, alias);
      if (fs.existsSync(path.join(installedRoot, 'package.json'))) continue;
      const installSpec = `${alias}@${spec}`;
      const installArgs = [
        npmCli,
        'install',
        '--ignore-scripts',
        '--no-save',
        '--package-lock=false',
        '--os=linux',
        '--cpu=arm64',
        // This exact dependency is platform-gated as a top-level package;
        // npm applies --os/--cpu only to optional nodes. Bypass that one check,
        // then enforce the stricter ADEV ELF/.node validation below.
        '--force',
      ];
      if (isGlobal) installArgs.push('--global', '--prefix', globalPrefix);
      installArgs.push(installSpec);
      process.stderr.write(`ADEV linux: resolving portable CLI payload ${alias}...\n`);
      const install = spawnSync(node, installArgs, {
        cwd: isGlobal ? prefix : process.cwd(),
        env: {...process.env, ADEV_LINUX_NPM_REENTRY: '1'},
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'pipe'],
      });
      if (install.error || install.status !== 0) {
        removeInstalled(installedRoot, commandBin);
        process.stderr.write(
          `ADEV linux: ${alias} was not installed: ${install.error?.message || String(install.stderr).trim()}\n`,
        );
        continue;
      }
      const installed = readPackage(installedRoot);
      let payload;
      try { payload = inspectPayload(installedRoot); }
      catch (error) {
        removeInstalled(installedRoot, commandBin);
        process.stderr.write(`ADEV linux: rejected ${alias}: ${error.message}\n`);
        continue;
      }
      const kinds = new Set(payload.executableFiles.map(file => file.kind));
      const needsGlibc = kinds.has('glibc');
      const supported = validPlatformPackage(installed) && !payload.nativeAddon &&
        payload.executableFiles.length > 0 && !kinds.has('android') && !kinds.has('other') &&
        (!needsGlibc || fs.existsSync(glibcManifest));
      if (!supported) {
        removeInstalled(installedRoot, commandBin);
        const reason = payload.nativeAddon
          ? 'contains an in-process .node addon'
          : needsGlibc && !fs.existsSync(glibcManifest)
            ? 'requires `adev runtime install glibc`'
            : 'does not contain a compatible standalone ARM64 ELF';
        process.stderr.write(`ADEV linux: rejected ${alias}: ${reason}.\n`);
        continue;
      }
      for (const executable of payload.executableFiles) fs.chmodSync(executable.file, 0o755);
      process.stderr.write(
        `ADEV linux: installed ${alias}@${target.version} (${[...kinds].join('/')}).\n`,
      );
    }
  }
}

if (process.env.ADEV_LINUX_NPM_REENTRY !== '1') main();

module.exports = {targetFromAlias, inspectElf, inspectPayload, validPlatformPackage};
