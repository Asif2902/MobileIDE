#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const prefix = path.resolve(process.env.PREFIX || path.join(__dirname, '..'));
const runtimeRoot = path.resolve(process.env.ADEV_RUNTIME || prefix);
const glibcRoot = path.join(prefix, 'glibc');
const embeddedIndexPath = path.join(__dirname, 'adev-glibc.json');
const defaultIndexUrl =
  'https://raw.githubusercontent.com/Asif2902/MobileIDE/master/release/adev-glibc-index.json';
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
    const servers = configured.length ? configured : ['1.1.1.1', '8.8.8.8'];
    fs.writeFileSync(
      resolver,
      `${servers.map(server => `nameserver ${server}`).join('\n')}\noptions timeout:2 attempts:2\n`,
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
  ];
  if (json) {
    process.stdout.write(`${JSON.stringify({schemaVersion: 1, runtimes}, null, 2)}\n`);
    return;
  }
  for (const runtime of runtimes) {
    const suffix = runtime.glibcVersion ? ` (${runtime.glibcVersion})` : '';
    process.stdout.write(
      `${runtime.id.padEnd(10)} ${runtime.installed ? 'installed' : 'not installed'}${suffix}\n`,
    );
  }
}

function usage() {
  process.stdout.write(
    'ADEV runtime manager\n\n' +
      '  adev runtime list [--json]\n' +
      '  adev runtime install glibc\n' +
      '  adev runtime update glibc\n' +
      '  adev runtime remove glibc\n' +
      '  adev install glibc              (alias)\n' +
      '  glibc-run <linux-arm64-program> [args...]\n',
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  if (args[0] === 'install' && args[1] === 'glibc') {
    await installOrUpdate('install');
    return;
  }
  if (args[0] !== 'runtime') fail(`unknown command: ${args.join(' ')}`);
  const action = args[1] || 'list';
  if (action === 'list') {
    listRuntimes(args.includes('--json'));
    return;
  }
  if (!['install', 'update', 'remove'].includes(action) || args[2] !== 'glibc') {
    fail(`unknown runtime command: ${args.slice(1).join(' ')}`);
  }
  if (action === 'remove') removeGlibc();
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
};
