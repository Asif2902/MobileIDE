import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative));
const text = relative => read(relative).toString('utf8');
const json = relative => JSON.parse(text(relative));
const sha256 = file =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const manifestPath =
  'android/app/src/main/assets/runtime/lib/adev-opencode.json';
const manifest = json(manifestPath);
const lock = json('android/app/src/main/assets/runtime/runtime-lock.json');
assert.equal(manifest.version, '1.17.9');
assert.equal(manifest.platform, 'android-bionic');
assert.deepEqual(manifest.supportedAbis, ['arm64-v8a']);
assert.match(manifest.unsupportedAbis.x86_64, /No verified Android\/Bionic/);
assert.equal(manifest.runtime.interpreter, '/system/bin/linker64');
assert.equal(manifest.runtime.pie, true);
assert.equal(manifest.runtime.minimumLoadAlignment, 16384);
assert.equal(manifest.runtime.globalLinuxSpoof, false);
assert.match(manifest.capabilities.interactiveTui, /unsupported/i);
assert.match(manifest.capabilities.agentRun, /unsupported/i);
assert.match(manifest.capabilities.serve, /unsupported/i);
assert.match(manifest.capabilities.web, /unsupported/i);
assert.match(manifest.capabilities.policy, /no Linux\/glibc binary/i);
assert.equal(
  lock.openCode.sha256,
  crypto.createHash('sha256').update(read(manifestPath)).digest('hex'),
);

const arm64 = path.join(
  root,
  'android/app/src/main/jniLibs/arm64-v8a',
);
for (const component of manifest.components) {
  const file = path.join(arm64, component.packagedName);
  assert.ok(fs.existsSync(file), `${component.packagedName} is missing`);
  assert.equal(sha256(file), component.sha256);
}
assert.ok(fs.existsSync(path.join(arm64, 'libbin_opencode.so')));
assert.ok(
  fs.existsSync(
    path.join(
      root,
      'android/app/src/main/jniLibs/x86_64/libbin_opencode.so',
    ),
  ),
);
assert.ok(
  !fs.existsSync(
    path.join(
      root,
      'android/app/src/main/jniLibs/x86_64/libbin_opencode_runtime.so',
    ),
  ),
);

const launcher = text('android/app/src/main/cpp/adev_opencode.cpp');
const launcherTemplate = text(
  'android/app/src/main/cpp/adev_opencode_version.h.in',
);
const cmake = text('android/app/src/main/cpp/CMakeLists.txt');
const gradle = text('android/app/build.gradle');
assert.match(launcher, /#include "adev_opencode_version\.h"/);
assert.doesNotMatch(launcher, /1\.17\.9/);
assert.match(launcherTemplate, /@ADEV_OPENCODE_VERSION@/);
assert.match(cmake, /ADEV_OPENCODE_VERSION/);
assert.match(cmake, /configure_file\(/);
assert.match(gradle, /new JsonSlurper\(\)\.parse\(openCodeManifestFile\)/);
assert.match(
  gradle,
  /-DADEV_OPENCODE_VERSION=\$\{openCodeManifest\.version\}/,
);
assert.doesNotMatch(launcher, /execv\(|libbin_opencode_runtime|LD_PRELOAD/);
assert.match(launcher, /TERMUX__PREFIX__TMP_DIR/);
assert.match(launcher, /TERMUX_APP__DATA_DIR/);
assert.match(launcher, /private_tmp/);
assert.match(launcher, /path == "\/tmp"/);
assert.match(launcher, /Linux\/glibc binary will not be substituted/);
assert.match(launcher, /requested_version/);
assert.match(launcher, /print_version/);
assert.match(launcher, /requested_debug_paths/);
assert.match(launcher, /print_debug_paths/);
assert.match(launcher, /unsupported_mode/);
assert.match(launcher, /available upstream Android Bun\/OpenTUI payloads abort/);
assert.match(launcher, /ADEV_OPENCODE_HOST_TEST/);
assert.match(launcher, /XDG_DATA_HOME/);
assert.match(launcher, /XDG_CONFIG_HOME/);
assert.match(launcher, /XDG_CACHE_HOME/);
assert.match(launcher, /XDG_STATE_HOME/);
assert.match(launcher, /XDG_RUNTIME_DIR/);
const runtimeManager = text(
  'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
);
assert.match(
  runtimeManager,
  /writeScript\(\s*"opencode",\s*"#!\/system\/bin\/sh\\nexec/,
  'OpenCode must have a real PATH trampoline for child processes',
);
assert.match(runtimeManager, /"opencode" to openCodeLauncher\.isFile/);
assert.match(runtimeManager, /"opencode-native-diagnostics"/);
assert.match(runtimeManager, /"opencode-payload-arm64"/);

const compilerCandidates = process.platform === 'win32'
  ? ['g++', 'clang++']
  : ['c++', 'g++', 'clang++'];
const compiler = compilerCandidates.find(candidate => {
  const result = spawnSync(candidate, ['--version'], {encoding: 'utf8'});
  return result.status === 0;
});
assert.ok(compiler, 'A host C++ compiler is required for OpenCode launcher tests');

const hostFixture = fs.mkdtempSync(
  path.join(os.tmpdir(), 'adev-opencode-launcher-'),
);
try {
  const generatedHeader = path.join(hostFixture, 'adev_opencode_version.h');
  const hostBinary = path.join(
    hostFixture,
    process.platform === 'win32' ? 'opencode-host.exe' : 'opencode-host',
  );
  fs.writeFileSync(
    generatedHeader,
    `#pragma once\n#define ADEV_OPENCODE_VERSION ${JSON.stringify(manifest.version)}\n`,
  );
  execFileSync(
    compiler,
    [
      '-std=c++17',
      '-DADEV_OPENCODE_HOST_TEST',
      `-I${hostFixture}`,
      path.join(root, 'android/app/src/main/cpp/adev_opencode.cpp'),
      '-o',
      hostBinary,
    ],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
  );

  const privateRoot = path.join(hostFixture, 'private');
  const home = path.join(privateRoot, 'home');
  const prefix = path.join(privateRoot, 'runtime');
  const privateTmp = path.join(prefix, 'tmp');
  fs.mkdirSync(home, {recursive: true});
  fs.mkdirSync(privateTmp, {recursive: true});
  const launcherEnvironment = {
    ...process.env,
    ADEV_OPENCODE_TEST_PRIVATE_ROOT: privateRoot,
    HOME: home,
    PREFIX: prefix,
    TERMUX__PREFIX__TMP_DIR: privateTmp,
    TMPDIR: '/tmp',
    TMP: '/tmp',
    TEMP: '/tmp',
    BUN_TMPDIR: '/tmp',
    XDG_DATA_HOME: '/tmp',
    XDG_CONFIG_HOME: '/tmp',
    XDG_CACHE_HOME: '/tmp',
    XDG_STATE_HOME: '/tmp',
    XDG_RUNTIME_DIR: '/tmp',
  };
  const runLauncher = args => spawnSync(hostBinary, args, {
    encoding: 'utf8',
    env: launcherEnvironment,
  });
  const launchFailure = result =>
    result.stderr || result.error?.message || `launcher exited ${result.status}`;

  for (const alias of [['--version'], ['-v']]) {
    const result = runLauncher(alias);
    assert.equal(result.status, 0, launchFailure(result));
    assert.equal(result.stdout.trim(), manifest.version);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Bun|\/tmp/);
  }
  for (const alias of [['--help'], ['-h'], ['help']]) {
    const result = runLauncher(alias);
    assert.equal(result.status, 0, launchFailure(result));
    assert.match(result.stdout, /Native diagnostics/);
  }

  const debugPaths = runLauncher(['debug', 'paths']);
  assert.equal(debugPaths.status, 0, launchFailure(debugPaths));
  const reportedPaths = Object.fromEntries(
    debugPaths.stdout.trim().split(/\r?\n/).map(line => line.split(/=(.*)/s).slice(0, 2)),
  );
  assert.deepEqual(Object.keys(reportedPaths), [
    'home',
    'xdg_data_home',
    'xdg_config_home',
    'xdg_cache_home',
    'xdg_state_home',
    'xdg_runtime_dir',
    'temp',
  ]);
  const normalizedPrivateRoot = path.resolve(privateRoot).toLowerCase();
  for (const [name, value] of Object.entries(reportedPaths)) {
    assert.ok(
      path.resolve(value).toLowerCase().startsWith(`${normalizedPrivateRoot}${path.sep}`),
      `${name} escaped the app-private test root: ${value}`,
    );
    assert.notEqual(value, '/tmp');
  }
  assert.equal(path.resolve(reportedPaths.temp), path.resolve(privateTmp));

  for (const unsupported of [[], ['run'], ['serve'], ['agent'], ['web']]) {
    const result = runLauncher(unsupported);
    assert.equal(result.status, 69, launchFailure(result));
    assert.match(result.stderr, /unavailable on the verified Android\/Bionic runtime/);
    assert.doesNotMatch(result.stdout, /Bun/);
  }
} finally {
  fs.rmSync(hostFixture, {recursive: true, force: true});
}

const sdk =
  process.env.ANDROID_SDK_ROOT ??
  process.env.ANDROID_HOME ??
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? '', 'Android/Sdk')
    : path.join(os.homedir(), 'Android/Sdk'));
const executable = name =>
  `${name}${process.platform === 'win32' ? '.exe' : ''}`;
const prebuiltRoot = path.join(
  sdk,
  'ndk',
  '29.0.14206865',
  'toolchains',
  'llvm',
  'prebuilt',
);
const prebuilt = fs.readdirSync(prebuiltRoot, {withFileTypes: true}).find(
  entry =>
    fs.existsSync(
      path.join(prebuiltRoot, entry.name, 'bin', executable('llvm-readelf')),
    ),
);
assert.ok(prebuilt, `NDK r29 llvm-readelf is missing under ${prebuiltRoot}`);
const readelf = path.join(
  prebuiltRoot,
  prebuilt.name,
  'bin',
  executable('llvm-readelf'),
);
const elfFiles = [
  path.join(arm64, 'libbin_opencode.so'),
  ...manifest.components.map(component =>
    path.join(arm64, component.packagedName),
  ),
];
for (const file of elfFiles) {
  const output = execFileSync(readelf, ['-hlWd', file], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const alignments = output
    .split(/\r?\n/)
    .filter(line => /^\s*LOAD/.test(line))
    .map(line => Number.parseInt(line.trim().split(/\s+/).at(-1), 16));
  assert.ok(alignments.length > 0, `${path.basename(file)} has no LOAD segments`);
  assert.ok(
    Math.min(...alignments) >= 0x4000,
    `${path.basename(file)} is not 16 KiB aligned`,
  );
}
const runtimeHeaders = execFileSync(
  readelf,
  ['-hlWd', path.join(arm64, 'libbin_opencode_runtime.so')],
  {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
);
assert.match(runtimeHeaders, /Requesting program interpreter: \/system\/bin\/linker64/);
assert.match(runtimeHeaders, /FLAGS_1\).*\bPIE\b/);
assert.doesNotMatch(runtimeHeaders, /ld-linux|GLIBC_/);

process.stdout.write(
  'OpenCode Android host checks passed: pinned ARM64/Bionic payload, launcher, hashes, PIE, and 16 KiB ELF alignment.\n',
);
