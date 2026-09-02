#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const prefix = path.resolve(process.env.PREFIX || path.join(__dirname, '..'));
const runtimeRoot = path.resolve(process.env.ADEV_RUNTIME || prefix);
const glibcRoot = path.join(prefix, 'glibc');
const linuxRoot = path.join(prefix, 'linux');
const embeddedIndexPath = path.join(__dirname, 'adev-glibc.json');
const embeddedLinuxIndexPath = path.join(__dirname, 'adev-linux.json');
const defaultIndexUrl =
  'https://raw.githubusercontent.com/Asif2902/MobileIDE/master/release/adev-glibc-index.json';
const defaultLinuxIndexUrl =
  'https://raw.githubusercontent.com/Asif2902/MobileIDE/master/release/adev-linux-index.json';
const maxArchiveBytes = 64 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function assertRuntimePaths() {
  if (prefix !== runtimeRoot) {
    fail(`PREFIX (${prefix}) does not match ADEV_RUNTIME (${runtimeRoot})`);
  }
  if (!path.isAbsolute(prefix) || prefix === path.parse(prefix).root) {
    fail(`refusing unsafe ADEV runtime root: ${prefix}`);
  }
  if (path.dirname(glibcRoot) !== prefix || path.basename(glibcRoot) !== 'glibc') {
    fail(`refusing unsafe glibc runtime path: ${glibcRoot}`);
  }
  if (path.dirname(linuxRoot) !== prefix || path.basename(linuxRoot) !== 'linux') {
    fail(`refusing unsafe linux runtime path: ${linuxRoot}`);
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function architecture() {
  if (process.arch === 'arm64' || process.arch === 'aarch64') return 'aarch64';
  return process.arch;
}

function validateHttpsOrLoopback(url, label) {
  const parsed = new URL(url);
  const loopback =
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (parsed.protocol !== 'https:' && !loopback) {
    fail(`${label} must use HTTPS (loopback HTTP is test-only): ${url}`);
  }
  return parsed;
}

async function fetchBytes(url, label) {
  validateHttpsOrLoopback(url, label);
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {'user-agent': 'ADEV-runtime/1'},
  });
  if (!response.ok) fail(`${label} download failed: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxArchiveBytes) {
    fail(`${label} exceeds the ${maxArchiveBytes}-byte safety limit`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxArchiveBytes) {
    fail(`${label} exceeds the ${maxArchiveBytes}-byte safety limit`);
  }
  return bytes;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} is invalid: ${error.message}`);
  }
}

function validateIndex(index) {
  if (
    !index ||
    index.schemaVersion !== 1 ||
    index.id !== 'adev-glibc' ||
    index.channel !== 'stable' ||
    !index.packages ||
    typeof index.packages !== 'object'
  ) {
    fail('unsupported ADEV glibc release index');
  }
  return index;
}

async function loadIndex(allowRemote = true) {
  const fileOverride = process.env.ADEV_GLIBC_INDEX_FILE;
  if (fileOverride) return validateIndex(readJson(fileOverride, 'glibc release index'));

  const urlOverride = process.env.ADEV_GLIBC_INDEX_URL;
  const indexUrl = urlOverride || defaultIndexUrl;
  if (allowRemote) {
    try {
      return validateIndex(
        JSON.parse((await fetchBytes(indexUrl, 'glibc release index')).toString('utf8')),
      );
    } catch (error) {
      if (urlOverride) throw error;
      process.stderr.write(
        `ADEV glibc: remote index unavailable (${error.message}); using embedded index.\n`,
      );
    }
  }
  return validateIndex(readJson(embeddedIndexPath, 'embedded glibc release index'));
}

function packageFor(index) {
  const arch = architecture();
  const selected = index.packages[arch];
  if (!selected) {
    fail(`glibc runtime is not available for ${arch}; supported now: aarch64`);
  }
  if (
    typeof selected.version !== 'string' ||
    typeof selected.glibcVersion !== 'string' ||
    typeof selected.archive !== 'string' ||
    !/^[a-f0-9]{64}$/.test(selected.sha256 || '') ||
    !/^[a-f0-9]{64}$/.test(selected.requiredLoaderSha256 || '')
  ) {
    fail(`invalid ${arch} glibc package metadata`);
  }
  const api = Number(process.env.ANDROID__BUILD_VERSION_SDK || 0);
  if (api && selected.minAndroidApi && api < selected.minAndroidApi) {
    fail(`glibc ${selected.version} requires Android API ${selected.minAndroidApi}+`);
  }
  return selected;
}

function validateLinuxIndex(index) {
  if (
    !index ||
    index.schemaVersion !== 1 ||
    index.id !== 'adev-linux' ||
    index.channel !== 'stable' ||
    !index.packages ||
    typeof index.packages !== 'object'
  ) {
    fail('unsupported ADEV linux release index');
  }
  return index;
}

async function loadLinuxIndex(allowRemote = true) {
  const fileOverride = process.env.ADEV_LINUX_INDEX_FILE;
  if (fileOverride) return validateLinuxIndex(readJson(fileOverride, 'linux release index'));
  const urlOverride = process.env.ADEV_LINUX_INDEX_URL;
  const indexUrl = urlOverride || defaultLinuxIndexUrl;
  if (allowRemote) {
    try {
      return validateLinuxIndex(
        JSON.parse((await fetchBytes(indexUrl, 'linux release index')).toString('utf8')),
      );
    } catch (error) {
      if (urlOverride) throw error;
      process.stderr.write(
        `ADEV linux: remote index unavailable (${error.message}); using embedded index.\n`,
      );
    }
  }
  return validateLinuxIndex(readJson(embeddedLinuxIndexPath, 'embedded linux release index'));
}

function linuxPackageFor(index) {
  const arch = architecture();
  const selected = index.packages[arch];
  if (!selected) fail(`linux execution runtime is not available for ${arch}; supported now: aarch64`);
  if (
    typeof selected.version !== 'string' ||
    selected.backend !== 'qemu-aarch64' ||
    typeof selected.backendVersion !== 'string' ||
    typeof selected.archive !== 'string' ||
    !/^[a-f0-9]{64}$/.test(selected.sha256 || '')
  ) {
    fail(`invalid ${arch} linux package metadata`);
  }
  const api = Number(process.env.ANDROID__BUILD_VERSION_SDK || 0);
  if (api && selected.minAndroidApi && api < selected.minAndroidApi) {
    fail(`linux ${selected.version} requires Android API ${selected.minAndroidApi}+`);
  }
  return selected;
}

function nativeLoader(selected) {
  const configured = process.env.MOBILEIDE_GLIBC_LOADER;
  if (
    !configured ||
    !path.isAbsolute(configured) ||
    !fs.existsSync(configured) ||
    !fs.statSync(configured).isFile()
  ) {
    fail(
      'This ADEV APK does not contain the executable glibc anchor. Update ADEV before installing the optional runtime.',
    );
  }
  const actual = sha256File(configured);
  if (actual !== selected.requiredLoaderSha256) {
    fail(
      `ADEV glibc loader mismatch: pack requires ${selected.requiredLoaderSha256}, ` +
        `APK provides ${actual}. Update ADEV instead of mixing loader versions.`,
    );
  }
  return configured;
}

function nativeLauncher(loader) {
  const configured = process.env.MOBILEIDE_GLIBC_LAUNCHER;
  if (
    !configured ||
    !path.isAbsolute(configured) ||
    !fs.existsSync(configured) ||
    !fs.statSync(configured).isFile() ||
    path.dirname(fs.realpathSync(configured)) !== path.dirname(fs.realpathSync(loader))
  ) {
    fail('This ADEV APK does not contain the executable glibc compatibility launcher.');
  }
  return configured;
}

function tarCommand(args, options = {}) {
  const busybox = process.env.MOBILEIDE_BUSYBOX;
  const command = busybox && fs.existsSync(busybox) ? busybox : 'tar';
  const commandArgs = command === busybox ? ['tar', ...args] : args;
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    fail(
      `archive operation failed: ${
        result.error?.message || String(result.stderr || result.stdout).trim()
      }`,
    );
  }
  return result.stdout || '';
}

function validateArchive(archive) {
  const entries = tarCommand(['-tzf', archive])
    .split(/\r?\n/)
    .filter(Boolean);
  if (!entries.length) fail('glibc archive is empty');
  for (const raw of entries) {
    const entry = raw.replace(/^\.\//, '');
    const normalizedEntry = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const segments = normalizedEntry.split('/');
    if (
      raw.includes('\\') ||
      path.posix.isAbsolute(normalizedEntry) ||
      segments.includes('..') ||
      segments.includes('') ||
      (normalizedEntry !== 'glibc' && !normalizedEntry.startsWith('glibc/'))
    ) {
      fail(`unsafe path in glibc archive: ${raw}`);
    }
  }
  for (const required of [
    'glibc/manifest.json',
    'glibc/bin/getconf',
    'glibc/lib/libc.so.6',
  ]) {
    if (!entries.some(entry => entry.replace(/^\.\//, '') === required)) {
      fail(`glibc archive is missing ${required}`);
    }
  }
}

function validateLinuxArchive(archive) {
  const entries = tarCommand(['-tzf', archive]).split(/\r?\n/).filter(Boolean);
  if (!entries.length) fail('linux archive is empty');
  for (const raw of entries) {
    const entry = raw.replace(/^\.\//, '');
    const normalizedEntry = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const segments = normalizedEntry.split('/');
    if (
      raw.includes('\\') || path.posix.isAbsolute(normalizedEntry) ||
      segments.includes('..') || segments.includes('') ||
      (normalizedEntry !== 'linux' && !normalizedEntry.startsWith('linux/'))
    ) {
      fail(`unsafe path in linux archive: ${raw}`);
    }
  }
  for (const required of [
    'linux/manifest.json',
    'linux/bin/qemu-aarch64',
    'linux/probes/static-aarch64',
    'linux/probes/busybox-static',
    'linux/probes/openssl',
    'linux/rootfs/lib/ld-musl-aarch64.so.1',
    'linux/rootfs/usr/lib/libssl.so.3',
    'linux/rootfs/usr/lib/libcrypto.so.3',
    'linux/rootfs/etc/ssl/openssl.cnf',
  ]) {
    if (!entries.some(entry => entry.replace(/^\.\//, '') === required)) {
      fail(`linux archive is missing ${required}`);
    }
  }
}

function normalizeLinuxTree(root) {
  fs.chmodSync(root, 0o755);
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const full = path.join(root, entry.name);
    const metadata = fs.lstatSync(full);
    if (metadata.isSymbolicLink()) fail(`linux archive contains a symlink: ${full}`);
    if (metadata.isDirectory()) {
      fs.chmodSync(full, 0o755);
      normalizeLinuxTree(full);
    } else if (metadata.isFile()) {
      const executable = full.includes(`${path.sep}bin${path.sep}`) ||
        full.includes(`${path.sep}probes${path.sep}`) ||
        full.includes(`${path.sep}rootfs${path.sep}lib${path.sep}ld-`);
      fs.chmodSync(full, executable ? 0o755 : 0o644);
    } else {
      fail(`linux archive contains an unsupported file type: ${full}`);
    }
  }
}

function verifyLinuxPayload(root, selected, expectedArchitecture = architecture()) {
  const manifest = readJson(path.join(root, 'manifest.json'), 'linux pack manifest');
  if (
    manifest.schemaVersion !== 1 || manifest.id !== 'adev-linux' ||
    manifest.version !== selected.version || manifest.architecture !== expectedArchitecture ||
    manifest.backend?.name !== selected.backend ||
    manifest.backend?.version !== selected.backendVersion
  ) {
    fail('linux pack manifest does not match its release index');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail('linux pack has no file inventory');
  }
  let inventoriedBytes = 0;
  const expectedFiles = new Set(['manifest.json']);
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      fail('linux pack has malformed file inventory');
    }
    const relative = path.posix.normalize(entry.path);
    if (relative.startsWith('../') || path.posix.isAbsolute(relative)) {
      fail(`unsafe linux inventory path: ${entry.path}`);
    }
    const file = path.join(root, ...relative.split('/'));
    if (!fs.statSync(file).isFile()) fail(`linux pack is missing ${entry.path}`);
    const actualBytes = fs.statSync(file).size;
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== actualBytes) {
      fail(`linux payload size mismatch for ${entry.path}`);
    }
    if (sha256File(file) !== entry.sha256) {
      fail(`linux payload checksum mismatch for ${entry.path}`);
    }
    inventoriedBytes += actualBytes;
    expectedFiles.add(relative);
  }
  if (inventoriedBytes !== manifest.installedBytes ||
      (selected.installedBytes && inventoriedBytes !== selected.installedBytes)) {
    fail('linux payload installed-size total does not match its release index');
  }
  const actualFiles = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile()) actualFiles.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }
  collect(root);
  for (const file of actualFiles) {
    if (!expectedFiles.has(file)) fail(`linux pack contains an unowned file: ${file}`);
  }
  if (actualFiles.length !== expectedFiles.size) {
    fail('linux pack inventory is incomplete');
  }
  return manifest;
}

function normalizeTree(root) {
  fs.chmodSync(root, 0o755);
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const full = path.join(root, entry.name);
    const metadata = fs.lstatSync(full);
    if (metadata.isSymbolicLink()) fail(`runtime archive contains a symlink: ${full}`);
    if (metadata.isDirectory()) {
      fs.chmodSync(full, 0o755);
      normalizeTree(full);
    } else if (metadata.isFile()) {
      fs.chmodSync(full, full.endsWith(`${path.sep}bin${path.sep}getconf`) ? 0o755 : 0o644);
    } else {
      fail(`runtime archive contains an unsupported file type: ${full}`);
    }
  }
}

function verifyPayload(root, selected) {
  const manifest = readJson(path.join(root, 'manifest.json'), 'glibc pack manifest');
  if (
    manifest.schemaVersion !== 1 ||
    manifest.id !== 'adev-glibc' ||
    manifest.version !== selected.version ||
    manifest.glibcVersion !== selected.glibcVersion ||
    manifest.architecture !== architecture()
  ) {
    fail('glibc pack manifest does not match its release index');
  }
  if (manifest.loader?.sha256 !== selected.requiredLoaderSha256) {
    fail('glibc pack loader contract does not match the release index');
  }
  for (const entry of manifest.files || []) {
    if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      fail('glibc pack has malformed file inventory');
    }
    const relative = path.posix.normalize(entry.path);
    if (relative.startsWith('../') || path.posix.isAbsolute(relative)) {
      fail(`unsafe glibc inventory path: ${entry.path}`);
    }
    const file = path.join(root, ...relative.split('/'));
    if (!fs.statSync(file).isFile()) fail(`glibc pack is missing ${entry.path}`);
    const actual = sha256File(file);
    if (actual !== entry.sha256) {
      fail(`glibc payload checksum mismatch for ${entry.path}`);
    }
  }
  return manifest;
}

function safeRemove(target) {
  const resolved = path.resolve(target);
  const allowed =
    resolved === glibcRoot ||
    (path.dirname(resolved) === path.join(prefix, 'tmp') &&
      path.basename(resolved).startsWith('adev-glibc-'));
  if (!allowed) fail(`refusing to remove path outside the glibc runtime: ${resolved}`);
  fs.rmSync(resolved, {recursive: true, force: true});
}

function safeRemoveLinux(target) {
  const resolved = path.resolve(target);
  const allowed =
    resolved === linuxRoot ||
    (path.dirname(resolved) === path.join(prefix, 'tmp') &&
      path.basename(resolved).startsWith('adev-linux-'));
  if (!allowed) fail(`refusing to remove path outside the linux runtime: ${resolved}`);
  fs.rmSync(resolved, {recursive: true, force: true});
}

function replaceSymlink(link, target) {
  try {
    fs.rmSync(link, {force: true});
  } catch {}
  fs.symlinkSync(target, link);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function ensureCompatibilityFiles() {
  const tls = path.join(prefix, 'etc', 'tls');
  const caBundle = path.join(prefix, 'etc', 'ssl', 'certs', 'ca-bundle.crt');
  const expectedCa = path.join(tls, 'cert.pem');
  fs.mkdirSync(tls, {recursive: true, mode: 0o755});
  if (!fs.existsSync(expectedCa) && fs.existsSync(caBundle)) {
    replaceSymlink(expectedCa, path.relative(tls, caBundle));
  }

  const resolver = path.join(prefix, 'etc', 'resolv.conf');
  if (!fs.existsSync(resolver)) {
    const configured = String(process.env.ADEV_DNS_SERVERS || '')
      .split(/[\s,]+/)
      .filter(value => /^[0-9a-f:.]+$/i.test(value));
    fs.writeFileSync(
      resolver,
      '# Generated by ADEV from Android LinkProperties.\n' +
        `${configured.map(server => `nameserver ${server}`).join('\n')}\n` +
        'options timeout:2 attempts:2\n',
      {mode: 0o644},
    );
  }

  const glibcEtc = path.join(glibcRoot, 'etc');
  if (fs.existsSync(path.join(glibcRoot, 'manifest.json'))) {
    fs.mkdirSync(glibcEtc, {recursive: true, mode: 0o755});
    fs.writeFileSync(
      path.join(glibcEtc, 'nsswitch.conf'),
      'hosts: files dns\nnetworks: files dns\n',
      {mode: 0o644},
    );
    fs.writeFileSync(
      path.join(glibcEtc, 'hosts'),
      '127.0.0.1 localhost\n::1 ip6-localhost ip6-loopback\n',
      {mode: 0o644},
    );
    fs.writeFileSync(path.join(glibcEtc, 'host.conf'), 'multi on\n', {mode: 0o644});
    fs.copyFileSync(resolver, path.join(glibcEtc, 'resolv.conf'));
    fs.chmodSync(path.join(glibcEtc, 'resolv.conf'), 0o644);
  }
}

function ensureLinuxCompatibilityFiles(root = linuxRoot) {
  if (!fs.existsSync(path.join(root, 'manifest.json'))) return;
  const guestEtc = path.join(root, 'rootfs', 'etc');
  fs.mkdirSync(path.join(guestEtc, 'ssl', 'certs'), {recursive: true, mode: 0o755});
  fs.writeFileSync(
    path.join(guestEtc, 'hosts'),
    '127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n',
    {mode: 0o644},
  );
  fs.writeFileSync(
    path.join(guestEtc, 'nsswitch.conf'),
    'hosts: files dns\nnetworks: files dns\n',
    {mode: 0o644},
  );
  const resolver = path.join(prefix, 'etc', 'resolv.conf');
  if (fs.existsSync(resolver)) fs.copyFileSync(resolver, path.join(guestEtc, 'resolv.conf'));
  const caBundle = path.join(prefix, 'etc', 'ssl', 'certs', 'ca-bundle.crt');
  if (fs.existsSync(caBundle) && fs.statSync(caBundle).size > 0) {
    for (const relative of ['ssl/certs/ca-certificates.crt', 'ssl/cert.pem']) {
      fs.copyFileSync(caBundle, path.join(guestEtc, relative));
    }
  }
}

function installLoaderLinks(root, loader, launcher) {
  const lib = path.join(root, 'lib');
  const loaderLink = path.join(lib, 'ld-linux-aarch64.so.1');
  replaceSymlink(loaderLink, launcher);
  const bin = path.join(root, 'bin');
  replaceSymlink(path.join(bin, 'ld.so'), '../lib/ld-linux-aarch64.so.1');
  const runner = path.join(bin, 'glibc-run');
  fs.writeFileSync(
    runner,
    '#!/system/bin/sh\n' +
      `ADEV_GLIBC_ROOT=${shellQuote(root)}\n` +
      'unset LD_PRELOAD\n' +
      'export ADEV_ENV_AUTOFILL=0\n' +
      'export LD_LIBRARY_PATH="$ADEV_GLIBC_ROOT/lib"\n' +
      'export GCONV_PATH="$ADEV_GLIBC_ROOT/lib/gconv"\n' +
      'if [ "$#" -eq 0 ]; then echo "usage: glibc-run <program> [args...]" >&2; exit 64; fi\n' +
      'ADEV_GLIBC_PROGRAM="$1"\n' +
      'shift\n' +
      'case "$ADEV_GLIBC_PROGRAM" in\n' +
      '  */*) ;;\n' +
      '  *)\n' +
      '    if [ -f "$ADEV_GLIBC_ROOT/bin/$ADEV_GLIBC_PROGRAM" ]; then\n' +
      '      ADEV_GLIBC_PROGRAM="$ADEV_GLIBC_ROOT/bin/$ADEV_GLIBC_PROGRAM"\n' +
      '    else\n' +
      '      ADEV_GLIBC_PROGRAM="$(command -v "$ADEV_GLIBC_PROGRAM")" || exit 127\n' +
      '    fi\n' +
      '    ;;\n' +
      'esac\n' +
      `exec ${shellQuote(launcher)} ` +
      '--library-path "$ADEV_GLIBC_ROOT/lib" "$ADEV_GLIBC_PROGRAM" "$@"\n',
    {mode: 0o755},
  );
  fs.chmodSync(runner, 0o755);
}

function cleanGlibcEnvironment(root) {
  const environment = {...process.env};
  delete environment.LD_PRELOAD;
  environment.ADEV_ENV_AUTOFILL = '0';
  environment.LD_LIBRARY_PATH = path.join(root, 'lib');
  environment.GCONV_PATH = path.join(root, 'lib', 'gconv');
  environment.ADEV_GLIBC_ROOT = root;
  return environment;
}

function smokeTest(root, expectedVersion, launcher) {
  const getconf = path.join(root, 'bin', 'getconf');
  const result = spawnSync(
    launcher,
    ['--library-path', path.join(root, 'lib'), getconf, 'GNU_LIBC_VERSION'],
    {encoding: 'utf8', env: cleanGlibcEnvironment(root)},
  );
  if (result.error || result.status !== 0) {
    fail(
      `glibc loader self-test failed: ${
        result.error?.message || String(result.stderr || result.stdout).trim()
      }`,
    );
  }
  const output = String(result.stdout).trim();
  if (!output.includes(expectedVersion.split('-')[0])) {
    fail(`glibc loader reported an unexpected version: ${output}`);
  }
  return output;
}

function readInstalled() {
  const manifestPath = path.join(glibcRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest.id === 'adev-glibc' ? manifest : null;
  } catch {
    return null;
  }
}

function readLinuxInstalled() {
  const manifestPath = path.join(linuxRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest.id === 'adev-linux' ? manifest : null;
  } catch {
    return null;
  }
}

function installLinuxRunner() {
  const runner = path.join(linuxRoot, 'bin', 'linux-run');
  const nativeLibrary = process.env.MOBILEIDE_NATIVE_LIB || '';
  const hostCompat = path.join(nativeLibrary, 'liblib_adev_linux_compat.so');
  fs.writeFileSync(
    runner,
    '#!/system/bin/sh\n' +
      'ADEV_LINUX_ROOT="${PREFIX}/linux"\n' +
      'if [ "$#" -eq 0 ]; then echo "usage: linux-run <linux-arm64-program> [args...]" >&2; exit 64; fi\n' +
      `ADEV_LINUX_HOST_COMPAT=${shellQuote(hostCompat)}\n` +
      'if [ ! -f "$ADEV_LINUX_HOST_COMPAT" ]; then echo "ADEV linux host compatibility bridge is missing; update the ADEV APK" >&2; exit 69; fi\n' +
      'export LD_LIBRARY_PATH="$ADEV_LINUX_ROOT/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\n' +
      'export LD_PRELOAD="$ADEV_LINUX_HOST_COMPAT"\n' +
      'export ADEV_LINUX_BACKEND_ACTIVE=1\n' +
      'exec "$ADEV_LINUX_ROOT/bin/qemu-aarch64" -U LD_PRELOAD -U LD_LIBRARY_PATH ' +
      '-L "$ADEV_LINUX_ROOT/rootfs" "$@"\n',
    {mode: 0o755},
  );
  fs.chmodSync(runner, 0o755);
}

function linuxEnvironment(root) {
  const environment = {
    ...process.env,
    LD_LIBRARY_PATH: [path.join(root, 'lib'), process.env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(':'),
    ADEV_LINUX_BACKEND_ACTIVE: '1',
  };
  const hostCompat = path.join(
    process.env.MOBILEIDE_NATIVE_LIB || '',
    'liblib_adev_linux_compat.so',
  );
  if (fs.existsSync(hostCompat)) environment.LD_PRELOAD = hostCompat;
  return environment;
}

function smokeTestLinux(root, expectedVersion) {
  const emulator = path.join(root, 'bin', 'qemu-aarch64');
  const version = spawnSync(emulator, ['--version'], {
    encoding: 'utf8',
    env: linuxEnvironment(root),
  });
  if (version.error || version.status !== 0) {
    fail(
      `linux backend self-test failed: ${
        version.error?.message || String(version.stderr || version.stdout).trim()
      }`,
    );
  }
  const versionOutput = String(version.stdout || version.stderr).trim();
  if (!versionOutput.includes(expectedVersion)) {
    fail(`linux backend reported an unexpected version: ${versionOutput}`);
  }
  const probe = spawnSync(
    emulator,
    [
      '-U', 'LD_PRELOAD', '-U', 'LD_LIBRARY_PATH',
      path.join(root, 'probes', 'static-aarch64'),
    ],
    {encoding: 'utf8', env: linuxEnvironment(root)},
  );
  if (probe.error || probe.status !== 0 || String(probe.stdout).trim() !== 'adev-linux-static-ok') {
    fail(
      `linux static-ELF self-test failed: ${
        probe.error?.message || String(probe.stderr || probe.stdout).trim()
      }`,
    );
  }
  return `QEMU ${expectedVersion}; static ARM64 ELF ok`;
}

async function installOrUpdateLinux(mode) {
  assertRuntimePaths();
  const index = await loadLinuxIndex(true);
  const selected = linuxPackageFor(index);
  const current = readLinuxInstalled();
  if (mode === 'update' && current?.version === selected.version) {
    installLinuxRunner();
    ensureLinuxCompatibilityFiles();
    const report = smokeTestLinux(linuxRoot, selected.backendVersion);
    process.stdout.write(`linux runtime ${current.version} is current (${report}).\n`);
    return;
  }

  fs.mkdirSync(path.join(prefix, 'tmp'), {recursive: true, mode: 0o700});
  const operationRoot = fs.mkdtempSync(path.join(prefix, 'tmp', 'adev-linux-'));
  const archive = path.join(operationRoot, 'runtime.tar.gz');
  let backup = null;
  let stagedInstalled = false;
  try {
    const localArchive = process.env.ADEV_LINUX_ARCHIVE_FILE;
    const bytes = localArchive
      ? fs.readFileSync(localArchive)
      : await fetchBytes(selected.archive, 'linux runtime');
    if (selected.bytes && bytes.length !== selected.bytes) {
      fail(`linux archive size mismatch: expected ${selected.bytes}, got ${bytes.length}`);
    }
    const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== selected.sha256) {
      fail(`linux archive SHA-256 mismatch: expected ${selected.sha256}, got ${actualHash}`);
    }
    fs.writeFileSync(archive, bytes, {mode: 0o600});
    validateLinuxArchive(archive);
    tarCommand(['-xzf', archive, '-C', operationRoot]);
    const staged = path.join(operationRoot, 'linux');
    normalizeLinuxTree(staged);
    verifyLinuxPayload(staged, selected);
    if (fs.existsSync(linuxRoot)) {
      backup = path.join(prefix, 'tmp', `adev-linux-backup-${process.pid}`);
      if (fs.existsSync(backup)) safeRemoveLinux(backup);
      fs.renameSync(linuxRoot, backup);
    }
    fs.renameSync(staged, linuxRoot);
    stagedInstalled = true;
    installLinuxRunner();
    ensureLinuxCompatibilityFiles();
    const report = smokeTestLinux(linuxRoot, selected.backendVersion);
    if (backup) safeRemoveLinux(backup);
    backup = null;
    process.stdout.write(
      `Installed ADEV linux runtime ${selected.version} (${report}) for ${architecture()}.\n` +
        'Static Linux ARM64 and musl executables are now selected automatically.\n',
    );
  } catch (error) {
    if (stagedInstalled && fs.existsSync(linuxRoot)) safeRemoveLinux(linuxRoot);
    if (backup && fs.existsSync(backup)) fs.renameSync(backup, linuxRoot);
    throw error;
  } finally {
    safeRemoveLinux(operationRoot);
  }
}

function removeLinux() {
  assertRuntimePaths();
  if (!fs.existsSync(linuxRoot)) {
    process.stdout.write('linux runtime is not installed.\n');
    return;
  }
  safeRemoveLinux(linuxRoot);
  process.stdout.write('Removed the optional ADEV linux runtime. Bionic and glibc runtimes unchanged.\n');
}

async function installOrUpdate(mode) {
  assertRuntimePaths();
  const index = await loadIndex(true);
  const selected = packageFor(index);
  const loader = nativeLoader(selected);
  const launcher = nativeLauncher(loader);
  const current = readInstalled();
  if (mode === 'update' && current?.version === selected.version) {
    installLoaderLinks(glibcRoot, loader, launcher);
    ensureCompatibilityFiles();
    const report = smokeTest(glibcRoot, selected.glibcVersion, launcher);
    process.stdout.write(`glibc ${current.glibcVersion} runtime ${current.version} is current (${report}).\n`);
    return;
  }

  fs.mkdirSync(path.join(prefix, 'tmp'), {recursive: true, mode: 0o700});
  const operationRoot = fs.mkdtempSync(path.join(prefix, 'tmp', 'adev-glibc-'));
  const archive = path.join(operationRoot, 'runtime.tar.gz');
  let backup = null;
  let stagedInstalled = false;
  try {
    const localArchive = process.env.ADEV_GLIBC_ARCHIVE_FILE;
    const bytes = localArchive
      ? fs.readFileSync(localArchive)
      : await fetchBytes(selected.archive, 'glibc runtime');
    if (selected.bytes && bytes.length !== selected.bytes) {
      fail(`glibc archive size mismatch: expected ${selected.bytes}, got ${bytes.length}`);
    }
    const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== selected.sha256) {
      fail(`glibc archive SHA-256 mismatch: expected ${selected.sha256}, got ${actualHash}`);
    }
    fs.writeFileSync(archive, bytes, {mode: 0o600});
    validateArchive(archive);
    tarCommand(['-xzf', archive, '-C', operationRoot]);
    const staged = path.join(operationRoot, 'glibc');
    normalizeTree(staged);
    verifyPayload(staged, selected);

    if (fs.existsSync(glibcRoot)) {
      backup = path.join(prefix, 'tmp', `adev-glibc-backup-${process.pid}`);
      if (fs.existsSync(backup)) safeRemove(backup);
      fs.renameSync(glibcRoot, backup);
    }
    fs.renameSync(staged, glibcRoot);
    stagedInstalled = true;
    installLoaderLinks(glibcRoot, loader, launcher);
    ensureCompatibilityFiles();
    const report = smokeTest(glibcRoot, selected.glibcVersion, launcher);
    if (backup) safeRemove(backup);
    backup = null;
    process.stdout.write(
      `Installed ADEV glibc runtime ${selected.version} (${report}) for ${architecture()}.\n` +
        `Loader: ${path.join(glibcRoot, 'lib', 'ld-linux-aarch64.so.1')}\n` +
        `Run Linux ARM64 glibc tools with: glibc-run <program> [args...]\n`,
    );
  } catch (error) {
    if (stagedInstalled && fs.existsSync(glibcRoot)) safeRemove(glibcRoot);
    if (backup && fs.existsSync(backup)) {
      fs.renameSync(backup, glibcRoot);
    }
    throw error;
  } finally {
    safeRemove(operationRoot);
  }
}

function removeGlibc() {
  assertRuntimePaths();
  if (!fs.existsSync(glibcRoot)) {
    process.stdout.write('glibc runtime is not installed.\n');
    return;
  }
  safeRemove(glibcRoot);
  process.stdout.write('Removed the optional ADEV glibc runtime. Bionic runtime unchanged.\n');
}

function componentState(name) {
  const native = process.env.MOBILEIDE_NATIVE_LIB || '';
  const candidates = {
    node: [process.env.MOBILEIDE_NODE, native && path.join(native, 'libbin_node.so')],
    python: [process.env.PYTHON],
    git: [process.env.MOBILEIDE_GIT, native && path.join(native, 'libbin_git.so')],
  }[name];
  return candidates.some(candidate => candidate && fs.existsSync(candidate));
}

function listRuntimes(json) {
  const installed = readInstalled();
  const linuxInstalled = readLinuxInstalled();
  const runtimes = [
    {id: 'node', installed: componentState('node'), delivery: 'base-apk'},
    {id: 'python', installed: componentState('python'), delivery: 'base-apk'},
    {id: 'git', installed: componentState('git'), delivery: 'base-apk'},
    {
      id: 'glibc',
      installed: Boolean(installed),
      delivery: 'optional-download',
      version: installed?.version || null,
      glibcVersion: installed?.glibcVersion || null,
    },
    {
      id: 'linux',
      installed: Boolean(linuxInstalled),
      delivery: 'optional-download',
      version: linuxInstalled?.version || null,
      backend: linuxInstalled?.backend?.name || null,
      backendVersion: linuxInstalled?.backend?.version || null,
    },
  ];
  if (json) {
    process.stdout.write(`${JSON.stringify({schemaVersion: 1, runtimes}, null, 2)}\n`);
    return;
  }
  for (const runtime of runtimes) {
    const detail = runtime.glibcVersion ||
      (runtime.backend && runtime.backendVersion
        ? `${runtime.backend} ${runtime.backendVersion}`
        : null);
    const suffix = detail ? ` (${detail})` : '';
    process.stdout.write(
      `${runtime.id.padEnd(10)} ${runtime.installed ? 'installed' : 'not installed'}${suffix}\n`,
    );
  }
}

function inspectElfForDoctor(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const header = Buffer.alloc(64);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length ||
        !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        header[4] !== 2 || header[5] !== 1) return null;
    const type = header.readUInt16LE(16);
    const machine = header.readUInt16LE(18);
    const programOffset = Number(header.readBigUInt64LE(32));
    const programSize = header.readUInt16LE(54);
    const programCount = header.readUInt16LE(56);
    if (![2, 3].includes(type) || programSize < 56 || programCount < 1 || programCount > 1024) {
      return {type, machine, interpreter: null, kind: 'invalid'};
    }
    let interpreter = null;
    let executable = false;
    const program = Buffer.alloc(programSize);
    for (let index = 0; index < programCount; index += 1) {
      if (fs.readSync(
        descriptor,
        program,
        0,
        program.length,
        programOffset + index * programSize,
      ) !== program.length) return {type, machine, interpreter: null, kind: 'invalid'};
      const programType = program.readUInt32LE(0);
      if (programType === 1 && (program.readUInt32LE(4) & 1)) executable = true;
      if (programType !== 3) continue;
      const offset = Number(program.readBigUInt64LE(8));
      const bytes = Number(program.readBigUInt64LE(32));
      if (bytes < 2 || bytes > 4096) return {type, machine, interpreter: null, kind: 'invalid'};
      const value = Buffer.alloc(bytes);
      if (fs.readSync(descriptor, value, 0, bytes, offset) !== bytes || value.at(-1) !== 0) {
        return {type, machine, interpreter: null, kind: 'invalid'};
      }
      interpreter = value.subarray(0, -1).toString('utf8');
    }
    const kind = !executable || machine !== 183
      ? 'unsupported'
      : interpreter === null
        ? 'static'
        : interpreter.includes('/system/bin/linker')
          ? 'android'
          : interpreter.includes('ld-musl-')
            ? 'musl'
            : interpreter.includes('ld-linux') || interpreter.includes('/glibc/')
              ? 'glibc'
              : 'other';
    return {
      type,
      typeName: type === 2 ? 'ET_EXEC' : type === 3 ? 'ET_DYN' : `ET_${type}`,
      machine,
      architecture: machine === 183 ? 'aarch64' : `machine-${machine}`,
      interpreter,
      kind,
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function resolveExecutable(command) {
  if (!command) return null;
  if (command.includes('/')) {
    const absolute = path.resolve(command);
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? absolute : null;
  }
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function diagnosticText(value, limit = 1200) {
  const text = String(value || '').replaceAll('\0', '').trim();
  return text.length <= limit ? text : `${text.slice(-limit)}\n[output truncated]`;
}

function processResult(result, startedAt) {
  const stderr = String(result.stderr || '');
  const stdout = String(result.stdout || '');
  const unknownSyscalls = [...stderr.matchAll(/Unknown syscall\s+(\d+)/g)]
    .map(match => Number(match[1]))
    .filter((value, index, values) => values.indexOf(value) === index);
  const tracedSignals = [...stderr.matchAll(/---\s+SIG([A-Z0-9]+)/g)]
    .map(match => `SIG${match[1]}`)
    .filter((value, index, values) => values.indexOf(value) === index);
  return {
    ok: !result.error && result.status === 0,
    status: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal || tracedSignals.at(-1) || null,
    error: result.error?.message || null,
    durationMs: Date.now() - startedAt,
    unknownSyscalls,
    tracedSignals,
    output: diagnosticText(stdout || stderr),
  };
}

function runLinuxGuest(executable, args, {trace = false, timeout = 20000, input} = {}) {
  const emulator = path.join(linuxRoot, 'bin', 'qemu-aarch64');
  const rootfs = path.join(linuxRoot, 'rootfs');
  const commandArgs = [
    '-U', 'LD_PRELOAD', '-U', 'LD_LIBRARY_PATH', '-L', rootfs,
    ...(trace ? ['-strace'] : []),
    executable,
    ...args,
  ];
  const startedAt = Date.now();
  const result = spawnSync(emulator, commandArgs, {
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 2 * 1024 * 1024,
    input,
    env: {
      ...linuxEnvironment(linuxRoot),
      ADEV_LINUX_BACKEND_ACTIVE: '1',
      SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
      CURL_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt',
    },
  });
  return processResult(result, startedAt);
}

function linuxBackendFor(elf) {
  if (!elf) return 'script-or-non-ELF';
  if (elf.kind === 'android') return 'android-bionic';
  if (elf.kind === 'glibc') return 'optional-glibc-loader';
  if (['static', 'musl', 'other'].includes(elf.kind)) return 'optional-qemu-linux-user';
  return 'unsupported';
}

function parseNameservers(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(line => /^\s*nameserver\s+(\S+)/.exec(line)?.[1])
      .filter(Boolean);
  } catch {
    return [];
  }
}

function runtimeDoctor(arguments_) {
  assertRuntimePaths();
  const json = arguments_.includes('--json');
  const trace = arguments_.includes('--trace');
  const separator = arguments_.indexOf('--');
  const commandArguments = separator >= 0 ? arguments_.slice(separator + 1) : [];
  const optionsEnd = separator >= 0 ? separator : arguments_.length;
  const targetName = arguments_.slice(0, optionsEnd).find(value => !value.startsWith('-')) || null;
  const target = resolveExecutable(targetName);
  const elf = target ? inspectElfForDoctor(target) : null;
  const installed = readLinuxInstalled();
  const rootfs = path.join(linuxRoot, 'rootfs');
  const resolver = path.join(rootfs, 'etc', 'resolv.conf');
  const hosts = path.join(rootfs, 'etc', 'hosts');
  const caBundle = path.join(rootfs, 'etc', 'ssl', 'certs', 'ca-certificates.crt');
  const busybox = path.join(linuxRoot, 'probes', 'busybox-static');
  const openssl = path.join(linuxRoot, 'probes', 'openssl');
  const staticProbe = path.join(linuxRoot, 'probes', 'static-aarch64');
  const canProbe = Boolean(installed) && fs.existsSync(busybox) && fs.existsSync(openssl);
  const unavailable = reason => ({ok: false, status: null, signal: null, error: reason});

  const probes = canProbe ? {
    execution: runLinuxGuest(staticProbe, []),
    dns: runLinuxGuest(busybox, ['nslookup', 'example.com'], {timeout: 15000}),
    tcp: runLinuxGuest(busybox, ['nc', '-z', '-w', '10', 'example.com', '443'], {timeout: 15000}),
    tls: runLinuxGuest(
      openssl,
      [
        's_client', '-connect', 'example.com:443', '-servername', 'example.com',
        '-verify_hostname', 'example.com', '-verify_return_error',
        '-CAfile', '/etc/ssl/certs/ca-certificates.crt', '-brief', '-no_ign_eof',
      ],
      {timeout: 20000, input: ''},
    ),
  } : {
    execution: unavailable('install with: adev runtime install linux'),
    dns: unavailable('Linux diagnostic probe is not installed'),
    tcp: unavailable('Linux diagnostic probe is not installed'),
    tls: unavailable('Linux diagnostic probe is not installed'),
  };
  let targetTrace = null;
  if (trace) {
    const traceTarget = target || (fs.existsSync(staticProbe) ? staticProbe : null);
    if (!traceTarget) {
      targetTrace = unavailable(targetName ? `executable not found: ${targetName}` : 'no trace target');
    } else if (!elf && target) {
      targetTrace = unavailable('trace target is not a directly executable ELF');
    } else if (target && !['static', 'musl', 'other'].includes(elf.kind)) {
      targetTrace = unavailable(`trace is available for QEMU Linux guests, selected ${linuxBackendFor(elf)}`);
    } else {
      targetTrace = runLinuxGuest(traceTarget, commandArguments, {trace: true, timeout: 20000});
    }
  }
  const report = {
    schemaVersion: 1,
    android: {
      architecture: architecture(),
      api: Number(process.env.ANDROID__BUILD_VERSION_SDK || 0) || null,
      kernel: `${os.type()} ${os.release()}`,
    },
    runtime: {
      installed: Boolean(installed),
      version: installed?.version || null,
      backend: installed?.backend || null,
      installCommand: installed ? null : 'adev runtime install linux',
    },
    binary: targetName ? {
      requested: targetName,
      path: target,
      found: Boolean(target),
      ...(elf || {}),
      backendSelected: target ? linuxBackendFor(elf) : 'not-found',
    } : null,
    guest: {
      rootfs,
      resolver,
      dnsSource: process.env.ADEV_DNS_SOURCE || 'unknown',
      upstreamDnsServers: String(process.env.ADEV_DNS_UPSTREAM_SERVERS || '')
        .split(',')
        .filter(Boolean),
      dnsServers: parseNameservers(resolver),
      hostsAvailable: fs.existsSync(hosts),
      caBundle,
      caBundleAvailable: fs.existsSync(caBundle) && fs.statSync(caBundle).size > 0,
    },
    probes,
    trace: targetTrace,
  };
  report.ok = Boolean(installed) && report.guest.dnsServers.length > 0 &&
    report.guest.hostsAvailable && report.guest.caBundleAvailable &&
    Object.values(probes).every(probe => probe.ok);
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const state = value => value ? 'PASS' : 'FAIL';
    process.stdout.write(
      `ADEV Linux runtime doctor: ${state(report.ok)}\n` +
      `  Runtime: ${installed ? `${installed.version} (${installed.backend.name} ${installed.backend.version})` : 'not installed'}\n` +
      `  Android: ${report.android.architecture}, API ${report.android.api || 'unknown'}, ${report.android.kernel}\n` +
      (report.binary
        ? `  Binary: ${report.binary.path || 'not found'}; ${report.binary.typeName || 'non-ELF'}; ` +
          `${report.binary.kind || 'unknown'}; backend=${report.binary.backendSelected}\n`
        : '') +
      `  DNS config: ${state(report.guest.dnsServers.length > 0)} ` +
        `(${report.guest.dnsServers.join(', ') || 'no DNS servers published'}; ` +
        `source=${report.guest.dnsSource})\n` +
      `  Hosts: ${state(report.guest.hostsAvailable)}\n` +
      `  CA bundle: ${state(report.guest.caBundleAvailable)}\n` +
      `  Guest execution: ${state(probes.execution.ok)}${probes.execution.signal ? ` (${probes.execution.signal})` : ''}\n` +
      `  DNS lookup: ${state(probes.dns.ok)}\n` +
      `  TCP connect: ${state(probes.tcp.ok)}\n` +
      `  TLS/CA HTTPS: ${state(probes.tls.ok)}\n`,
    );
    if (!installed) process.stdout.write('  Install: adev runtime install linux\n');
    for (const [name, probe] of Object.entries(probes)) {
      if (!probe.ok) process.stdout.write(`  ${name} error: ${probe.error || probe.output || `exit ${probe.status}`}\n`);
    }
    if (targetTrace) {
      process.stdout.write(
        `  Trace: status=${targetTrace.status} signal=${targetTrace.signal || 'none'} ` +
        `unknown-syscalls=${(targetTrace.unknownSyscalls || []).join(',') || 'none'}\n`,
      );
      if (targetTrace.output) process.stdout.write(`${targetTrace.output}\n`);
    }
  }
  if (!report.ok) process.exitCode = 1;
  return report;
}

function usage() {
  process.stdout.write(
    'ADEV runtime manager\n\n' +
      '  adev runtime list [--json]\n' +
      '  adev runtime doctor [binary] [--json] [--trace] [-- args...]\n' +
      '  adev runtime install glibc\n' +
      '  adev runtime update glibc\n' +
      '  adev runtime remove glibc\n' +
      '  adev install glibc              (alias)\n' +
      '  adev runtime install linux\n' +
      '  adev runtime update linux\n' +
      '  adev runtime remove linux\n' +
      '  adev install linux              (alias)\n' +
      '  glibc-run <dynamic-glibc-arm64-program> [args...]\n' +
      '  linux-run <static-or-musl-arm64-program> [args...]\n',
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  if (args[0] === 'install' && ['glibc', 'linux'].includes(args[1])) {
    if (args[1] === 'linux') await installOrUpdateLinux('install');
    else await installOrUpdate('install');
    return;
  }
  if (args[0] !== 'runtime') fail(`unknown command: ${args.join(' ')}`);
  const action = args[1] || 'list';
  if (action === 'list') {
    listRuntimes(args.includes('--json'));
    return;
  }
  if (action === 'doctor') {
    runtimeDoctor(args.slice(2));
    return;
  }
  const target = args[2];
  if (!['install', 'update', 'remove'].includes(action) || !['glibc', 'linux'].includes(target)) {
    fail(`unknown runtime command: ${args.slice(1).join(' ')}`);
  }
  if (target === 'linux') {
    if (action === 'remove') removeLinux();
    else await installOrUpdateLinux(action);
  } else if (action === 'remove') removeGlibc();
  else await installOrUpdate(action);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`ADEV runtime: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  architecture,
  validateIndex,
  packageFor,
  validateArchive,
  verifyPayload,
  readInstalled,
  validateLinuxIndex,
  linuxPackageFor,
  validateLinuxArchive,
  verifyLinuxPayload,
  readLinuxInstalled,
  inspectElfForDoctor,
  runtimeDoctor,
  ensureLinuxCompatibilityFiles,
};
