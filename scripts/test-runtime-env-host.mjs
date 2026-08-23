import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

/**
 * Host regression suite for the A Dev Studio runtime environment contract and
 * the Android Next.js SWC compatibility layer.
 *
 * These are the two pieces that used to be re-derived per tool, which is how
 * different ADEV processes ended up with different HOME, PREFIX, TMPDIR, XDG
 * and TLS values, and how Next.js build workers ended up unable to see the
 * WebAssembly compiler the CLI had already found.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const requireForTest = createRequire(import.meta.url);

const environment = read(
  'android/app/src/main/java/com/mobileide/app/runtime/AdevEnvironment.kt',
);
const runtimeManager = read(
  'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
);
const nativeEnv = read('android/app/src/main/cpp/adev_runtime_env.c');
const execCompat = read('android/app/src/main/cpp/adev_exec_compat.c');
const cmake = read('android/app/src/main/cpp/CMakeLists.txt');
const preload = read(
  'android/app/src/main/assets/runtime/lib/adev-node-preload.js',
);

// ---------------------------------------------------------------------------
// One authority publishes the whole contract.
// ---------------------------------------------------------------------------

for (const variable of [
  'ADEV_RUNTIME',
  'PREFIX',
  'HOME',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'LD_LIBRARY_PATH',
  'NODE_PATH',
  'SHELL',
  'ADEV_PYTHON_SHELL',
  'MOBILEIDE_ROOT',
  'MOBILEIDE_NATIVE_LIB',
  'MOBILEIDE_WORKSPACES',
]) {
  assert.match(
    environment,
    new RegExp(`"${variable}" to `),
    `${variable} must be defined by AdevEnvironment`,
  );
}

// TLS trust is part of the contract, and verification is never disabled.
for (const variable of [
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO',
  'PIP_CERT',
]) {
  assert.match(
    environment,
    new RegExp(`values\\["${variable}"\\]`),
    `${variable} must be part of the TLS contract`,
  );
}
for (const source of [environment, runtimeManager, preload]) {
  assert.doesNotMatch(source, /NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.doesNotMatch(source, /_create_unverified_context|CERT_NONE/);
  assert.doesNotMatch(source, /rejectUnauthorized\s*[:=]\s*false/);
}

// RuntimeManager consumes the contract instead of restating it.
assert.match(runtimeManager, /env\.putAll\(adevEnv\.contract\(\)\)/);
for (const variable of [
  'HOME',
  'PATH',
  'PREFIX',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'LD_LIBRARY_PATH',
  'NODE_PATH',
  'SSL_CERT_FILE',
]) {
  assert.doesNotMatch(
    runtimeManager,
    new RegExp(`"${variable}" to `),
    `${variable} must come from AdevEnvironment, not a second definition`,
  );
}

// Every directory the contract promises is created before it is advertised.
assert.match(environment, /fun ensureDirectories\(\)/);
for (const directory of [
  'configHome',
  'dataHome',
  'stateHome',
  'homeCacheDir',
  'shimDir',
  'tmpDir',
  'cacheDir',
]) {
  assert.match(
    environment,
    new RegExp(`\\b${directory}\\b`),
    `${directory} must be part of the created directory set`,
  );
}
assert.match(runtimeManager, /adevEnv\.ensureDirectories\(\)/);
assert.match(runtimeManager, /adevEnv\.writeContractFiles\(\)/);

// ---------------------------------------------------------------------------
// Install locations are discovered, never hard-coded.
// ---------------------------------------------------------------------------

const sources = [
  'android/app/src/main/java/com/mobileide/app/runtime/AdevEnvironment.kt',
  'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
  'android/app/src/main/cpp/adev_runtime_env.c',
  'android/app/src/main/cpp/adev_exec_compat.c',
  'android/app/src/main/cpp/adev_opencode.cpp',
  'android/app/src/main/assets/runtime/lib/adev-next.js',
  'android/app/src/main/assets/runtime/lib/adev-next-swc.js',
  'android/app/src/main/assets/runtime/lib/adev-node-preload.js',
];
/** Drop comments so prose about these paths is not mistaken for code. */
const withoutComments = source =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '');

for (const relative of sources) {
  const source = withoutComments(read(relative));
  assert.doesNotMatch(
    source,
    // A bare "/data/app/" prefix used to *detect* stale bindings is fine;
    // an actual install path with an identifier in it is not.
    /["'`]\/data\/app\/[^"'`]/,
    `${relative} must not embed an APK install path; those change on reinstall`,
  );
  // Naming the Termux prefix is fine when the code is *detecting or repairing*
  // it. It is not fine as a value something would fall back to.
  const repair = /replace\(|strcmp\(|strstr\(|indexOf\(|startsWith\(|packagedPrefix|== 0/;
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (!/["'`]\/data\/(?:data|user\/0)\/com\.termux/.test(line)) return;
    const window = lines.slice(Math.max(0, index - 2), index + 1).join('\n');
    assert.ok(
      repair.test(window),
      `${relative}:${index + 1} defaults to a Termux installation: ${line.trim()}`,
    );
  });
}
assert.match(environment, /nativeLibDir/);
assert.match(nativeEnv, /readlink\("\/proc\/self\/exe"/);
assert.match(nativeEnv, /a Java identifier and therefore never contains/);

// ---------------------------------------------------------------------------
// The native recovery layer repairs, but never overrides, an environment.
// ---------------------------------------------------------------------------

assert.match(nativeEnv, /void adev_runtime_env_apply\(void\)/);
assert.match(nativeEnv, /ADEV_ENV_AUTOFILL/);
assert.match(nativeEnv, /static void adev_merge_path\(const char \*contract_path\)/);
assert.match(
  nativeEnv,
  /if \(existing == NULL \|\| existing\[0\] == '\\0' \|\| adev_is_stale\(existing\)\) \{\s*\n\s*setenv\(name, value, 1\);/,
  'only missing or stale values may be replaced',
);
assert.match(nativeEnv, /strstr\(value, "\/com\.termux\/"\)/);
assert.match(execCompat, /__attribute__\(\(constructor\)\)/);
assert.match(execCompat, /adev_runtime_env_apply\(\);/);
assert.match(cmake, /add_library\(adev_exec_compat SHARED adev_exec_compat\.c adev_runtime_env\.c\)/);
for (const target of ['adev_npm_shell', 'adev_busybox', 'adev_make', 'adev_opencode']) {
  assert.match(
    cmake,
    new RegExp(`add_executable\\(${target} ${target}\\.cpp adev_runtime_env\\.c\\)`),
    `${target} must be able to recover the runtime contract`,
  );
}

// The published shell contract is safe to source repeatedly and keeps caller
// PATH additions such as npm's node_modules/.bin.
assert.match(environment, /adev_env_default\(\) \{/);
assert.match(environment, /adev_path_prepend\(\) \{/);
assert.match(environment, /Reverse order: the first contract entry ends up first on PATH/);

// ---------------------------------------------------------------------------
// NODE_OPTIONS carries exactly one --require.
// ---------------------------------------------------------------------------

const nodeOptions = environment.match(/"NODE_OPTIONS"\] = "([^"]*)"/);
assert.ok(nodeOptions, 'AdevEnvironment must own NODE_OPTIONS');
assert.equal(
  nodeOptions[1].match(/--require/g).length,
  1,
  'Next.js collapses repeated NODE_OPTIONS values, so only one --require is safe',
);
assert.match(preload, /adev-runtime-policy\.js/);
assert.match(preload, /adev-server-events\.js/);
assert.match(preload, /adev-next-swc\.js/);
assert.match(preload, /installNextSwcHooks/);
assert.match(preload, /setDefaultResultOrder/);
assert.match(preload, /ipv4first/);

const listenCompat = requireForTest(
  path.join(root, 'android/app/src/main/assets/runtime/lib/adev-listen-compat.js'),
);
const dual = listenCompat.normalizeListenArgs([3000, '0.0.0.0']);
assert.equal(dual.passthrough, undefined);
assert.equal(dual.options.host, '::');
assert.equal(dual.options.ipv6Only, false);
assert.equal(dual.options.port, 3000);
assert.equal(listenCompat.normalizeListenArgs([5173, 'localhost']).options.host, '::');
assert.equal(
  listenCompat.normalizeListenArgs([{port: 8080, host: '0.0.0.0'}]).options.ipv6Only,
  false,
);
assert.equal(
  listenCompat.normalizeListenArgs([{path: '/tmp/adev.sock'}]).passthrough,
  true,
);
assert.equal(
  listenCompat.normalizeListenArgs([443, 'example.com']).options.host,
  'example.com',
);
const serverEvents = read(
  'android/app/src/main/assets/runtime/lib/adev-server-events.js',
);
assert.match(serverEvents, /applyNormalizedListen/);
assert.doesNotMatch(runtimeManager, /--require \$\{it\.absolutePath\}/);

// ---------------------------------------------------------------------------
// Next.js SWC compatibility layer.
// ---------------------------------------------------------------------------

const swc = requireForTest(
  path.join(root, 'android/app/src/main/assets/runtime/lib/adev-next-swc.js'),
);
assert.equal(swc.SPECIFIER, '@next/swc-wasm-nodejs');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-next-swc-'));
try {
  const cache = path.join(fixture, 'cache');
  const project = path.join(fixture, 'project');
  const nextDir = path.join(project, 'node_modules', 'next');
  fs.mkdirSync(nextDir, {recursive: true});
  const manifest = path.join(project, 'package.json');
  fs.writeFileSync(manifest, '{"private":true}\n');
  process.env.ADEV_NEXT_CACHE = cache;

  const installNext = version =>
    fs.writeFileSync(
      path.join(nextDir, 'package.json'),
      JSON.stringify({name: 'next', version}),
    );
  const installCachedWasm = version => {
    const dir = swc.cachedPackageDir(version);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({name: '@next/swc-wasm-nodejs', version, main: 'wasm.js'}),
    );
    fs.writeFileSync(path.join(dir, 'wasm.js'), 'module.exports = {};\n');
    return dir;
  };

  // The cache keeps the scoped package structure. A flat `swc-wasm-nodejs`
  // directory does not resolve for either of Next's two load paths.
  for (const version of ['13.5.11', '14.2.35', '15.5.23']) {
    const cached = installCachedWasm(version);
    assert.equal(
      path.relative(swc.cacheRoot(version), cached).split(path.sep).join('/'),
      'node_modules/@next/swc-wasm-nodejs',
    );
    assert.equal(swc.ensureCached(version, {allowDownload: false}), cached);
  }

  // Nothing is fetched when the exact version is not cached and the network is
  // not allowed; the compatibility layer reports instead of guessing.
  assert.equal(swc.ensureCached('99.0.0', {allowDownload: false}), null);

  // Vercel does not publish a WASM compiler for every Next release — the 14.2
  // line stops at 14.2.33 — so an exact-only policy would make next@14.2.35
  // unrunnable on Android. Fall back to the nearest published build, and never
  // silently: `exact` records what happened.
  const published = [
    '13.5.10',
    '13.5.11',
    '14.2.32',
    '14.2.33',
    '15.5.16',
    '15.5.18',
    '15.5.23',
  ];
  const resolveWith = version =>
    swc.resolveCompilerVersion(version, {publishedVersions: published});
  assert.deepEqual(resolveWith('15.5.23'), {version: '15.5.23', exact: true});
  assert.deepEqual(resolveWith('14.2.35'), {
    version: '14.2.33',
    exact: false,
    requested: '14.2.35',
  });
  assert.deepEqual(resolveWith('15.5.17'), {
    version: '15.5.16',
    exact: false,
    requested: '15.5.17',
  });
  // Below every published build in the line: take the lowest rather than
  // crossing into another minor.
  assert.equal(resolveWith('14.2.1').version, '14.2.32');
  // No published build for the minor at all: stay within the major.
  assert.equal(resolveWith('14.9.9').version, '14.2.33');
  // An offline device cannot enumerate versions; it must not invent one.
  assert.deepEqual(
    swc.resolveCompilerVersion('14.2.35', {publishedVersions: []}),
    {version: '14.2.35', exact: true},
  );
  assert.equal(swc.compareVersions('14.2.9', '14.2.10') < 0, true);

  const quiet = {allowDownload: false, quiet: true};
  installNext('15.5.23');
  const targets = swc.projectTargets(project, swc.resolveNext(project));
  assert.deepEqual(
    targets.map(target => path.relative(project, target).split(path.sep).join('/')),
    [
      'node_modules/@next/swc-wasm-nodejs',
      'node_modules/next/wasm/@next/swc-wasm-nodejs',
    ],
  );

  const prepared = swc.prepare(project, quiet);
  assert.equal(prepared.ok, true, prepared.reason);
  assert.equal(prepared.version, '15.5.23');
  assert.deepEqual(prepared.published, targets);
  for (const target of targets) {
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version,
      '15.5.23',
    );
  }
  // The project's own dependency declarations are untouched.
  assert.equal(fs.readFileSync(manifest, 'utf8'), '{"private":true}\n');
  assert.equal(fs.existsSync(path.join(project, 'package-lock.json')), false);

  // Bare specifier resolution — the path Next actually takes on Android —
  // now works from the project root.
  const projectRequire = createRequire(path.join(project, 'index.js'));
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        projectRequire.resolve('@next/swc-wasm-nodejs/package.json'),
        'utf8',
      ),
    ).version,
    '15.5.23',
  );

  // Upgrading Next replaces ADEV's own mapping, including a copied one.
  installNext('14.2.35');
  const upgraded = swc.prepare(project, quiet);
  assert.equal(upgraded.ok, true, upgraded.reason);
  for (const target of targets) {
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version,
      '14.2.35',
    );
  }

  // A package the user installed themselves is never replaced or deleted.
  const owned = path.join(project, 'node_modules', '@next', 'swc-wasm-nodejs');
  fs.rmSync(owned, {recursive: true, force: true});
  fs.mkdirSync(owned, {recursive: true});
  fs.writeFileSync(
    path.join(owned, 'package.json'),
    JSON.stringify({name: '@next/swc-wasm-nodejs', version: '13.5.11'}),
  );
  installNext('15.5.23');
  swc.prepare(project, quiet);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(owned, 'package.json'), 'utf8')).version,
    '13.5.11',
    "a user-installed compiler keeps the project's version",
  );
} finally {
  delete process.env.ADEV_NEXT_CACHE;
  fs.rmSync(fixture, {recursive: true, force: true});
}

// Next 14.x requires experimental.useWasmBinary before it will load WASM on
// Android, then 404s on @next/swc-android-arm64 and hangs. The preload rewrites
// that loader to Next 15's WASM-first condition, which already works on device.
const next14Loader =
  'const knownDefaultWasmFallbackTriples = ["aarch64-linux-android"];\n' +
  'const shouldLoadWasmFallbackFirst = !disableWasmFallback && unsupportedPlatform && useWasmBinary || isWebContainer;';
const next15Loader =
  'const knownDefaultWasmFallbackTriples = ["aarch64-linux-android"];\n' +
  'const shouldLoadWasmFallbackFirst = !disableWasmFallback && useWasmBinary || unsupportedPlatform || isWebContainer;';
const rewritten14 = swc.preferAndroidWasmLoader(next14Loader);
assert.match(rewritten14, /\|\|\s*unsupportedPlatform/);
assert.doesNotMatch(rewritten14, /unsupportedPlatform\s*&&\s*useWasmBinary/);
assert.equal(swc.preferAndroidWasmLoader(next15Loader), next15Loader);
assert.equal(swc.preferAndroidWasmLoader('const x = 1;'), 'const x = 1;');
assert.equal(swc.preferAndroidWasmLoader(rewritten14), rewritten14);

// The launcher self-locates npm rather than depending on PREFIX being present.
const nextSwcSource = read('android/app/src/main/assets/runtime/lib/adev-next-swc.js');
assert.match(nextSwcSource, /path\.join\(__dirname, 'node_modules', 'npm', 'bin', 'npm-cli\.js'\)/);
assert.match(nextSwcSource, /Self-location first, environment second/);
assert.match(nextSwcSource, /function preferAndroidWasmLoader\(/);
assert.match(nextSwcSource, /function installNextSwcHooks\(/);
assert.match(nextSwcSource, /Module\.prototype\._compile/);
// Next's download-swc exports are getter-only. Assigning them throws
// `Cannot set property downloadNativeNextSwc of #<Object> which has only a
// getter` and Next never starts. The WASM-first rewrite is enough.
assert.doesNotMatch(nextSwcSource, /downloadNativeNextSwc\s*=/);

// Advisories are surfaced, never acted on.
const nextLauncher = read('android/app/src/main/assets/runtime/lib/adev-next.js');
assert.match(nextLauncher, /async function reportAdvisories\(/);
assert.match(nextLauncher, /manifestModified: false/);
assert.match(nextLauncher, /lockfileModified: false/);
assert.doesNotMatch(nextLauncher, /writeFileSync\([^)]*package\.json/);
assert.match(nextLauncher, /void reportAdvisories\(next\.version\)/);

// The non-interactive agent bootstrap must not re-add the preloads the contract
// already carries: three --require flags would be as fatal to a Next worker as
// two were.
const agentPreload = runtimeManager.match(
  /adev_node_options=[\s\S]*?unset adev_node_options/,
);
assert.ok(agentPreload, 'the agent bootstrap must manage NODE_OPTIONS');
assert.equal(
  (agentPreload[0].match(/--require/g) || []).length,
  1,
  'the agent bootstrap may contribute at most one --require',
);
assert.match(agentPreload[0], /adev-node-preload\.js/);

// BusyBox applet wrappers must distinguish "could not run" from "ran and
// reported a non-zero result": `grep` with no match and `diff` with a
// difference are ordinary outcomes, not reasons to re-run the command.
assert.match(runtimeManager, /adev_applet\(\) \{/);
assert.match(runtimeManager, /adev_applet_status\\" -ge 126/);
assert.doesNotMatch(runtimeManager, /2>\/dev\/null \|\| \/system\/bin\//);

// Runtime readiness must notice new packaged JavaScript, not just new native
// libraries: the shell helpers, the Next launcher and the device suite all ship
// as assets in the same APK.
assert.match(runtimeManager, /BuildConfig\.VERSION_CODE/);
assert.match(
  runtimeManager,
  /nativeMap:\$\{BuildConfig\.VERSION_CODE\}:\$\{BuildConfig\.VERSION_NAME\}/,
);

process.stdout.write('Runtime environment + Next SWC host suite passed.\n');
