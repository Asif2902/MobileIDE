'use strict';

/**
 * Next.js SWC compatibility for Android.
 *
 * Next ships a native SWC binding per platform. `aarch64-linux-android` is one
 * of Next's own `knownDefaultWasmFallbackTriples`. Next 15 honours that list
 * and loads `@next/swc-wasm-nodejs` first. Next 14.x does not: it still
 * requires `experimental.useWasmBinary`, then tries to download
 * `@next/swc-android-arm64`, which has never been published. The 404 leaves
 * `loadBindings()` unsettled and `next dev` accepts TCP without ever answering
 * HTTP. The preload therefore rewrites the Next 14 condition to Next 15's.
 *
 * The catch is how Next resolves it: `await import('@next/swc-wasm-nodejs')`.
 * That is a bare ESM specifier, and Node's ESM resolver walks `node_modules`
 * directories upward from the importing file. It ignores `NODE_PATH`, which is
 * why prepending an external cache to NODE_PATH made the main CLI look healthy
 * while dev and build workers still failed to find the compiler.
 *
 * So the package bytes live once in an ADEV-managed cache, and each project gets
 * a `node_modules/@next/swc-wasm-nodejs` entry pointing at that cache. Plain
 * filesystem resolution then works identically for the CLI, dev workers, build
 * workers and any other child process, on every Next version, with no user
 * action and without touching package.json or the lockfile.
 */

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const SCOPE = '@next';
const PACKAGE = 'swc-wasm-nodejs';
const SPECIFIER = `${SCOPE}/${PACKAGE}`;

/** Walk up from `start` to the nearest directory holding a package.json. */
function findProject(start) {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

/**
 * The runtime root, resolved from the environment contract and falling back to
 * this file's own location. Never a hard-coded install path.
 */
function runtimeRoot() {
  const configured = process.env.ADEV_RUNTIME || process.env.PREFIX;
  if (configured && fs.existsSync(configured)) return configured;
  // lib/adev-next-swc.js -> lib -> runtime
  return path.dirname(__dirname);
}

/** The ADEV-managed cache directory for one exact Next version. */
function cacheRoot(version) {
  const base =
    process.env.ADEV_NEXT_CACHE || path.join(runtimeRoot(), 'cache', 'next-swc');
  return path.join(base, version);
}

function cachedPackageDir(version) {
  return path.join(cacheRoot(version), 'node_modules', SCOPE, PACKAGE);
}

function readVersion(packageDir) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
    ).version;
  } catch {
    return null;
  }
}

/** Resolve the project's own Next.js installation. */
function resolveNext(project) {
  let manifestPath;
  try {
    manifestPath = require.resolve('next/package.json', {paths: [project]});
  } catch {
    return null;
  }
  const packageDir = path.dirname(manifestPath);
  const version = readVersion(packageDir);
  if (!version) return null;
  return {version, packageDir, manifestPath};
}

/**
 * Locate the bundled npm CLI without depending on PREFIX being set.
 *
 * `adev-next` used to report "bundled npm CLI unavailable" whenever a caller
 * reached it with PREFIX missing, even though the CLI sits at a fixed offset
 * from this file. Self-location first, environment second.
 */
function npmCli() {
  const candidates = [
    path.join(__dirname, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(runtimeRoot(), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  if (process.env.ADEV_NPM_CLI) candidates.unshift(process.env.ADEV_NPM_CLI);
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    return require.resolve('npm/bin/npm-cli.js');
  } catch {
    return null;
  }
}

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_TTL_MS = 24 * 60 * 60 * 1000;

function compareVersions(left, right) {
  const a = STABLE.exec(left);
  const b = STABLE.exec(right);
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Published stable versions of the WASM compiler, cached for a day. */
function publishedVersions(options = {}) {
  const cacheFile = path.join(
    process.env.ADEV_NEXT_CACHE || path.join(runtimeRoot(), 'cache', 'next-swc'),
    'published-versions.json',
  );
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (Date.now() - cached.checkedAt < VERSION_TTL_MS) return cached.versions;
  } catch {
    // No usable cache entry.
  }
  const npm = npmCli();
  if (!npm) return [];
  const result = childProcess.spawnSync(
    process.execPath,
    [npm, 'view', SPECIFIER, 'versions', '--json'],
    {
      encoding: 'utf8',
      env: {...process.env, ADEV_NEXT_SWC_PREPARING: '1'},
      timeout: options.timeoutMs || 60000,
    },
  );
  if (result.status !== 0 || !result.stdout) return [];
  let versions;
  try {
    versions = JSON.parse(result.stdout).filter(version => STABLE.test(version));
  } catch {
    return [];
  }
  versions.sort(compareVersions);
  try {
    fs.mkdirSync(path.dirname(cacheFile), {recursive: true});
    fs.writeFileSync(cacheFile, JSON.stringify({checkedAt: Date.now(), versions}));
  } catch {
    // A read-only cache only costs us the next lookup.
  }
  return versions;
}

/**
 * Pick the compiler version to use for `nextVersion`.
 *
 * Vercel does not publish `@next/swc-wasm-nodejs` for every Next release: the
 * 14.2 line stops at 14.2.33, so next@14.2.34 and 14.2.35 have no matching
 * build at all — Next's own on-demand download fails there for the same reason.
 * Rather than refuse to run a version the project legitimately chose, fall back
 * to the nearest published build in the same minor line, then the same major,
 * and say exactly what was substituted.
 */
function resolveCompilerVersion(nextVersion, options = {}) {
  if (!STABLE.test(nextVersion)) return {version: nextVersion, exact: true};
  const versions = options.publishedVersions || publishedVersions(options);
  if (versions.length === 0) return {version: nextVersion, exact: true};
  if (versions.includes(nextVersion)) return {version: nextVersion, exact: true};

  const [major, minor] = nextVersion.split('.');
  const sameMinor = versions.filter(v => v.startsWith(`${major}.${minor}.`));
  const sameMajor = versions.filter(v => v.startsWith(`${major}.`));
  const highestAtOrBelow = candidates => {
    const eligible = candidates.filter(v => compareVersions(v, nextVersion) <= 0);
    return eligible.length > 0 ? eligible[eligible.length - 1] : null;
  };
  const chosen =
    highestAtOrBelow(sameMinor) ||
    (sameMinor.length > 0 ? sameMinor[0] : null) ||
    highestAtOrBelow(sameMajor) ||
    (sameMajor.length > 0 ? sameMajor[sameMajor.length - 1] : null);
  if (!chosen) return {version: nextVersion, exact: true};
  return {version: chosen, exact: false, requested: nextVersion};
}

/**
 * Ensure a matching WASM compiler is in the ADEV cache. Returns the package
 * directory, or null when it is not cached and could not be fetched.
 */
function ensureCached(version, options = {}) {
  const packageDir = cachedPackageDir(version);
  if (readVersion(packageDir) === version) return packageDir;
  if (!options.allowDownload) return null;

  const npm = npmCli();
  if (!npm) {
    report(options, 'adev-next: the bundled npm CLI could not be located.\n');
    return null;
  }
  const cache = cacheRoot(version);
  fs.mkdirSync(cache, {recursive: true});
  report(options, `adev-next: caching ${SPECIFIER}@${version} for Android…\n`);

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
      `${SPECIFIER}@${version}`,
    ],
    {
      stdio: options.quiet ? 'ignore' : 'inherit',
      env: {...process.env, ADEV_NEXT_SWC_PREPARING: '1'},
    },
  );
  if (result.error || result.status !== 0) return null;
  return readVersion(packageDir) === version ? packageDir : null;
}

function report(options, message) {
  if (options.quiet) return;
  process.stderr.write(message);
}

/** True when `target` is already the intended destination of `link`. */
function pointsAt(link, target) {
  try {
    return fs.realpathSync(link) === fs.realpathSync(target);
  } catch {
    return false;
  }
}

/**
 * Marker written into a copied mapping.
 *
 * A symlink is self-evidently ADEV's. A copy is not, so it is stamped: without
 * this, the next version bump would see a plain directory, assume the project
 * owns it and refuse to replace its own stale copy.
 */
const MANAGED_MARKER = '.adev-managed';

function isAdevManaged(destination) {
  try {
    if (fs.lstatSync(destination).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(destination, MANAGED_MARKER));
}

/**
 * Publish `packageDir` at `destination`, preferring a symlink and copying only
 * when the filesystem refuses one.
 */
function publish(destination, packageDir, options) {
  if (pointsAt(destination, packageDir)) return true;
  const wanted = readVersion(packageDir);
  fs.mkdirSync(path.dirname(destination), {recursive: true});

  let existing = null;
  try {
    existing = fs.lstatSync(destination);
  } catch {
    // Nothing there yet.
  }
  if (existing) {
    const installed = readVersion(destination);
    if (installed === wanted) return true;
    // A real directory ADEV did not create belongs to the project: a user who
    // installed the package explicitly keeps ownership of it.
    if (existing.isDirectory() && !isAdevManaged(destination)) {
      report(
        options,
        `adev-next: leaving the project's own ${SPECIFIER}@${installed} in place.\n`,
      );
      return false;
    }
    fs.rmSync(destination, {recursive: true, force: true});
  }

  try {
    fs.symlinkSync(packageDir, destination, 'dir');
    return true;
  } catch (error) {
    report(
      options,
      `adev-next: symlinks are unavailable here (${error.code}); copying the compiler instead.\n`,
    );
  }
  try {
    fs.cpSync(packageDir, destination, {recursive: true});
    fs.writeFileSync(
      path.join(destination, MANAGED_MARKER),
      `A Dev Studio Android SWC mapping for ${SPECIFIER}@${wanted}.\n` +
        'Created automatically because this filesystem does not support symlinks.\n',
    );
    return true;
  } catch (error) {
    report(options, `adev-next: could not publish ${SPECIFIER}: ${error.message}\n`);
    return false;
  }
}

/**
 * The two locations Next can load the WASM compiler from:
 *
 *  - `<project>/node_modules/@next/swc-wasm-nodejs` for the bare specifier Next
 *    tries first on Android. This is the one that matters.
 *  - `<project>/node_modules/next/wasm/@next/swc-wasm-nodejs` for the
 *    exact-path fallback Next uses after its own on-demand download. Providing
 *    it means that path is satisfied offline as well.
 *
 * Both keep the scoped `@next/` directory level; a flat `swc-wasm-nodejs`
 * directory does not resolve.
 */
function projectTargets(project, nextInfo) {
  const targets = [path.join(project, 'node_modules', SCOPE, PACKAGE)];
  if (nextInfo) {
    targets.push(path.join(nextInfo.packageDir, 'wasm', SCOPE, PACKAGE));
  }
  return targets;
}

/**
 * Make the matching WASM compiler resolvable from `project`.
 *
 * Returns a result object rather than throwing: a compatibility layer must
 * never be the reason a build fails to start.
 */
function prepare(project, options = {}) {
  const nextInfo = options.next || resolveNext(project);
  if (!nextInfo) return {ok: false, reason: 'next-not-installed'};

  // Prefer an exact match that is already cached, then whatever the published
  // set actually offers for this Next version. Consulting the (day-cached)
  // version list before downloading avoids re-attempting an install that can
  // never succeed for a Next release Vercel shipped no WASM build for.
  let compilerVersion = nextInfo.version;
  let packageDir = ensureCached(compilerVersion, {allowDownload: false});
  if (!packageDir) {
    const resolved = resolveCompilerVersion(nextInfo.version, options);
    compilerVersion = resolved.version;
    if (!resolved.exact) {
      report(
        options,
        `adev-next: next@${nextInfo.version} has no published ${SPECIFIER} build; ` +
          `using ${compilerVersion}, the nearest published Android compiler.\n`,
      );
    }
    packageDir =
      ensureCached(compilerVersion, {allowDownload: false}) ||
      ensureCached(compilerVersion, options);
  }
  if (!packageDir) {
    return {ok: false, reason: 'wasm-unavailable', version: nextInfo.version};
  }

  const published = [];
  for (const destination of projectTargets(project, nextInfo)) {
    if (publish(destination, packageDir, options)) published.push(destination);
  }
  return {
    ok: published.length > 0,
    reason: published.length > 0 ? 'ready' : 'publish-failed',
    version: nextInfo.version,
    compilerVersion,
    cache: cacheRoot(compilerVersion),
    packageDir,
    published,
  };
}

/**
 * Next 15's WASM-first condition. Next 14.x instead requires
 * `unsupportedPlatform && useWasmBinary`, so a stock Android project never
 * takes the WASM path.
 */
const NEXT15_WASM_FIRST =
  '!disableWasmFallback && useWasmBinary || unsupportedPlatform || isWebContainer';

/**
 * Rewrite Next's SWC loader so Android always tries WASM before a native
 * download. Idempotent, and a no-op on loaders that already match Next 15.
 */
function preferAndroidWasmLoader(source) {
  if (
    typeof source !== 'string' ||
    !source.includes('knownDefaultWasmFallbackTriples') ||
    !source.includes('shouldLoadWasmFallbackFirst')
  ) {
    return source;
  }
  return source.replace(
    /const shouldLoadWasmFallbackFirst = ([^;]+);/,
    (full, expression) => {
      if (
        /\|\|\s*unsupportedPlatform\b/.test(expression) &&
        !/\bunsupportedPlatform\s*&&/.test(expression)
      ) {
        return full;
      }
      return `const shouldLoadWasmFallbackFirst = ${NEXT15_WASM_FIRST};`;
    },
  );
}

let hooksInstalled = false;

/**
 * Install process-wide hooks so every Node process — the Next CLI, `next-server`
 * and the webpack workers — sees the WASM-first loader. Mapping the package
 * into node_modules is not enough on Next 14: the loader never asks for it.
 */
function installNextSwcHooks() {
  if (hooksInstalled) return;
  if (process.env.ADEV_NEXT_SWC_PREPARING === '1') return;
  hooksInstalled = true;

  const Module = require('node:module');
  const originalCompile = Module.prototype._compile;
  Module.prototype._compile = function compileWithAndroidSwc(content, filename) {
    if (typeof content === 'string') {
      try {
        content = preferAndroidWasmLoader(content);
      } catch {
        // A rewrite failure must not take down an otherwise healthy process.
      }
    }
    return originalCompile.call(this, content, filename);
  };
}

/**
 * Preload hook. Runs inside every Node process ADEV starts, so it must cost
 * almost nothing unless this process really is a Next.js CLI.
 */
function bootstrap() {
  if (process.env.ADEV_NEXT_SWC_PREPARING === '1') return;
  if (process.env.ADEV_NEXT_SWC_AUTOPREPARE === '0') return;
  const entry = process.argv[1];
  if (!entry) return;
  const name = path.basename(entry);
  if (name !== 'next' && name !== 'next.js') return;
  if (!entry.includes(`${path.sep}node_modules${path.sep}`)) return;

  try {
    const project = findProject(process.cwd());
    const nextInfo = resolveNext(project);
    if (!nextInfo) return;
    // Already the exact match (the user installed it, or a previous run linked
    // it): do no work and touch nothing. Any other state goes through prepare,
    // which is idempotent and re-uses an existing correct mapping.
    try {
      const linked = path.dirname(
        require.resolve(`${SPECIFIER}/package.json`, {paths: [project]}),
      );
      if (readVersion(linked) === nextInfo.version) return;
    } catch {
      // Not resolvable yet — that is exactly the case this exists for.
    }
    prepare(project, {next: nextInfo, allowDownload: true});
  } catch {
    // Never block Next from starting; it reports its own load failure.
  }
}

module.exports = {
  SPECIFIER,
  bootstrap,
  cacheRoot,
  compareVersions,
  publishedVersions,
  resolveCompilerVersion,
  cachedPackageDir,
  ensureCached,
  findProject,
  installNextSwcHooks,
  npmCli,
  preferAndroidWasmLoader,
  prepare,
  projectTargets,
  resolveNext,
  runtimeRoot,
};
