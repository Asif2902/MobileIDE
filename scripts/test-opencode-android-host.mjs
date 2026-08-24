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

const manifestPath = 'android/app/src/main/assets/runtime/lib/adev-opencode.json';
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
assert.match(manifest.runtime.tempPathPolicy, /app-private XDG cache temp/);
assert.match(manifest.runtime.heapPointerTaggingPolicy, /API 29\/30/);
assert.match(manifest.runtime.preloadOrder, /upstream tagfix/);
for (const capability of [
  'version',
  'help',
  'debugPaths',
  'interactiveTui',
  'agentRun',
  'serve',
  'web',
]) {
  assert.match(manifest.capabilities[capability], /device retest required/i);
  assert.doesNotMatch(manifest.capabilities[capability], /unsupported/i);
}
assert.match(manifest.capabilities.policy, /Android\/Bionic payload/);
assert.match(manifest.deviceGate, /version, help, debug paths, run help/);
assert.equal(
  lock.openCode.sha256,
  crypto.createHash('sha256').update(read(manifestPath)).digest('hex'),
);

const arm64 = path.join(root, 'android/app/src/main/jniLibs/arm64-v8a');
const x86 = path.join(root, 'android/app/src/main/jniLibs/x86_64');
for (const component of manifest.components) {
  const file = path.join(arm64, component.packagedName);
  assert.ok(fs.existsSync(file), `${component.packagedName} is missing`);
  assert.equal(sha256(file), component.sha256);
}
for (const abiRoot of [arm64, x86]) {
  assert.ok(fs.existsSync(path.join(abiRoot, 'libbin_opencode.so')));
  assert.ok(fs.existsSync(path.join(abiRoot, 'liblib_adev_opencode_compat.so')));
}
assert.ok(!fs.existsSync(path.join(x86, 'libbin_opencode_runtime.so')));

const launcher = text('android/app/src/main/cpp/adev_opencode.cpp');
const compat = text('android/app/src/main/cpp/adev_opencode_compat.c');
const launcherTemplate = text('android/app/src/main/cpp/adev_opencode_version.h.in');
const cmake = text('android/app/src/main/cpp/CMakeLists.txt');
const gradle = text('android/app/build.gradle');
const androidManifest = text('android/app/src/main/AndroidManifest.xml');
const externalUrlBroker = text(
  'android/app/src/main/java/com/mobileide/app/runtime/ExternalUrlBroker.kt',
);
const xdgOpenHelper = text('android/app/src/main/cpp/adev_xdg_open.cpp');
assert.match(launcher, /#include "adev_opencode_version\.h"/);
assert.doesNotMatch(launcher, /1\.17\.9/);
assert.match(launcherTemplate, /@ADEV_OPENCODE_VERSION@/);
assert.match(cmake, /add_library\(adev_opencode_compat SHARED/);
assert.match(cmake, /OUTPUT_NAME "lib_adev_opencode_compat"/);
assert.match(gradle, /liblib_adev_opencode_compat\.so/);
assert.match(launcher, /execv\(runtime\.c_str\(\), forwarded\.data\(\)\)/);
assert.match(launcher, /syscall\(SYS_execve, runtime\.c_str\(\), forwarded\.data\(\), environ\)/);
assert.match(launcher, /--adev-runtime-env-test/);
assert.match(launcher, /lib\/adev-runtime-env-test\.js/);
assert.match(launcher, /syscall\(SYS_execve, node\.c_str\(\), test_arguments\.data\(\), environ\)/);
assert.match(launcher, /libbin_opencode_runtime\.so/);
assert.match(launcher, /liblib_opencode_tagfix\.so/);
assert.match(launcher, /liblib_adev_opencode_compat\.so/);
assert.match(launcher, /OPENTUI_LIB_PATH/);
assert.match(launcher, /ADEV_OPENCODE_TMPDIR/);
assert.match(launcher, /BUN_TMPDIR/);
assert.match(launcher, /\{"SHELL", "\/system\/bin\/sh"\}/);
assert.match(launcher, /\{"ADEV_PYTHON_SHELL", "\/system\/bin\/sh"\}/);
assert.match(launcher, /ADEV_OPENCODE_RG/);
assert.match(launcher, /ADEV_OPENCODE_XDG_OPEN/);
// The launcher must not re-derive the XDG base directories: they are part of
// the one runtime environment contract every ADEV process shares.
for (const variable of [
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
]) {
  assert.doesNotMatch(
    launcher,
    new RegExp(`\{"${variable}",`),
    `${variable} must come from the shared runtime contract, not the OpenCode launcher`,
  );
}
assert.match(launcher, /adev_runtime_env_apply\(\);/);
assert.match(launcher, /ADEV_CONFIG_HOME/);
assert.match(launcher, /MOBILEIDE_WORKSPACES/);
assert.match(launcher, /\{"HOME", workspace_home\}/);
assert.match(
  launcher,
  /\{"GIT_CONFIG_GLOBAL", join_path\(config_home, "\.gitconfig"\)\}/,
);
assert.match(launcher, /TERMUX_EXEC__PROC_SELF_EXE/);
assert.doesNotMatch(launcher, /unsupported_mode|unsafe modes|abort in native code/);
assert.match(compat, /strncmp\(path, "\/tmp", 4\)/);
assert.match(compat, /mkdir\(const char \*path/);
assert.match(compat, /openat\(int directory_fd/);
assert.match(compat, /realpath\(const char \*path/);
assert.match(compat, /Never let a virtual \/tmp\/\.\.\/ path escape/);
assert.match(compat, /dlsym\(RTLD_DEFAULT, "android_mallopt"\)/);
assert.match(compat, /ADEV_M_SET_HEAP_TAGGING_LEVEL = 8/);
assert.match(compat, /ADEV_M_BIONIC_SET_HEAP_TAGGING_LEVEL = -204/);
assert.match(androidManifest, /android:allowNativeHeapPointerTagging="false"/);
assert.match(externalUrlBroker, /CAPABILITY_FILE_NAME = "\.adev-url-opener-v1"/);
assert.match(externalUrlBroker, /Os\.chmod\(capabilityFile\.absolutePath, 0x180\)/);
assert.match(externalUrlBroker, /OsConstants\.O_EXCL/);
assert.match(externalUrlBroker, /OsConstants\.O_NOFOLLOW/);
assert.match(externalUrlBroker, /Os\.rename\(temporary\.absolutePath, capabilityFile\.absolutePath\)/);
assert.match(xdgOpenHelper, /O_NOFOLLOW/);
assert.match(xdgOpenHelper, /metadata\.st_uid != geteuid\(\)/);
assert.match(xdgOpenHelper, /metadata\.st_nlink != 1/);
assert.match(xdgOpenHelper, /S_IRWXG \| S_IRWXO/);
assert.match(xdgOpenHelper, /--capability-file/);

const runtimeManager = text(
  'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
);
assert.match(
  runtimeManager,
  /writeScript\(\s*"opencode",\s*"#!\/system\/bin\/sh\\nexec/,
  'OpenCode must have a real PATH trampoline for child processes',
);
assert.match(runtimeManager, /"opencode-temp-remap" to openCodeCompat\.isFile/);
assert.match(runtimeManager, /"opencode-runtime-ready" to openCodeRuntimeReady/);
assert.match(runtimeManager, /"opencode-device-certified" to false/);
assert.match(runtimeManager, /"opencode-interactive" to openCodeRuntimeReady/);
assert.match(runtimeManager, /"ADEV_OPENCODE_RG" to File\(nativeLibDir, "libbin_rg\.so"\)/);
assert.match(
  runtimeManager,
  /"ADEV_OPENCODE_XDG_OPEN" to\s*File\(nativeLibDir, "libbin_adev_xdg_open\.so"\)/,
);
assert.match(runtimeManager, /RUNTIME_NATIVE_LIBRARY_DIR_FILE/);
assert.match(
  runtimeManager,
  /marker\.readText\(\)\.trim\(\) != nativeLibDir\.absolutePath/,
  'APK reinstall must invalidate wrappers bound to the prior randomized nativeLibraryDir',
);
assert.match(runtimeManager, /refreshInstallPathBindings\(\)/);
assert.match(runtimeManager, /writeNativeLibraryDirBinding\(\)/);
assert.match(runtimeManager, /File\(binDir, "opencode"\)/);
assert.match(runtimeManager, /File\(homeDir, "\.adev-agent-env"\)/);
assert.match(
  runtimeManager,
  /Generated runtime executable bindings are incomplete/,
  'The install-path marker must only be written after generated bindings validate',
);

const compilerCandidates = process.platform === 'win32'
  ? ['g++', 'clang++']
  : ['c++', 'g++', 'clang++'];
const compiler = compilerCandidates.find(candidate =>
  spawnSync(candidate, ['--version'], {encoding: 'utf8'}).status === 0,
);
const cCompilerCandidates = process.platform === 'win32'
  ? ['gcc', 'clang']
  : ['cc', 'gcc', 'clang'];
const cCompiler = cCompilerCandidates.find(candidate =>
  spawnSync(candidate, ['--version'], {encoding: 'utf8'}).status === 0,
);
assert.ok(compiler, 'A host C++ compiler is required for OpenCode launcher tests');
assert.ok(cCompiler, 'A host C compiler is required for OpenCode remap tests');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-opencode-launcher-'));
try {
  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  const generatedHeader = path.join(fixture, 'adev_opencode_version.h');
  const hostLauncher = path.join(fixture, `opencode-host${executableSuffix}`);
  const mapTest = path.join(fixture, `opencode-map${executableSuffix}`);
  fs.writeFileSync(
    generatedHeader,
    `#pragma once\n#define ADEV_OPENCODE_VERSION ${JSON.stringify(manifest.version)}\n`,
  );
  execFileSync(
    compiler,
    [
      '-std=c++17',
      '-DADEV_OPENCODE_HOST_TEST',
      `-I${fixture}`,
      path.join(root, 'android/app/src/main/cpp/adev_opencode.cpp'),
      '-o',
      hostLauncher,
    ],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
  );
  execFileSync(
    cCompiler,
    [
      '-std=c17',
      '-DADEV_OPENCODE_COMPAT_MAP_TEST',
      path.join(root, 'android/app/src/main/cpp/adev_opencode_compat.c'),
      '-o',
      mapTest,
    ],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
  );

  const mapResult = spawnSync(
    mapTest,
    ['/tmp', '/tmp/session/file', '/tmp/../escape', '/tmpx', '/project'],
    {
      encoding: 'utf8',
      env: {...process.env, ADEV_OPENCODE_TMPDIR: '/data/user/0/test/files/runtime/tmp'},
    },
  );
  assert.equal(mapResult.status, 0, mapResult.stderr);
  assert.deepEqual(mapResult.stdout.trim().split(/\r?\n/), [
    '1|/data/user/0/test/files/runtime/tmp|0',
    '1|/data/user/0/test/files/runtime/tmp/session/file|0',
    '-1|/tmp/../escape|1',
    '0|/tmpx|0',
    '0|/project|0',
  ]);

  const privateRoot = path.join(fixture, 'private');
  const home = path.join(privateRoot, 'home');
  const workspaces = path.join(privateRoot, 'workspaces');
  const prefix = path.join(privateRoot, 'runtime');
  const privateTmp = path.join(prefix, 'tmp');
  const nativeDir = path.join(privateRoot, 'native');
  fs.mkdirSync(home, {recursive: true});
  fs.mkdirSync(workspaces, {recursive: true});
  fs.mkdirSync(privateTmp, {recursive: true});
  fs.mkdirSync(nativeDir, {recursive: true});

  const payloadSource = path.join(fixture, 'payload.cpp');
  const payload = path.join(nativeDir, 'libbin_opencode_runtime.so');
  fs.writeFileSync(
    payloadSource,
    `#include <cstdio>\n#include <cstdlib>\nint main(int argc, char** argv) {\n` +
      `  const char* names[] = {"HOME","ADEV_CONFIG_HOME","MOBILEIDE_WORKSPACES","GIT_CONFIG_GLOBAL","XDG_DATA_HOME","XDG_CONFIG_HOME","XDG_CACHE_HOME","XDG_STATE_HOME","XDG_RUNTIME_DIR","TMPDIR","TMP","TEMP","BUN_TMPDIR","ADEV_OPENCODE_TMPDIR","ADEV_OPENCODE_RG","ADEV_OPENCODE_XDG_OPEN","ADEV_URL_OPENER_PORT","ADEV_URL_OPENER_SESSION","SHELL","OPENTUI_LIB_PATH","LD_LIBRARY_PATH","LD_PRELOAD","BUN_SELF_EXE","TERMUX_EXEC__PROC_SELF_EXE"};\n` +
      `  for (const char* name : names) std::printf("env:%s=%s\\n", name, std::getenv(name) ? std::getenv(name) : "");\n` +
      `  for (int i = 0; i < argc; ++i) std::printf("arg:%d=%s\\n", i, argv[i]);\n` +
      `  return (argc == 2 && std::string(argv[1]) == "exit23") ? 23 : 0;\n}\n`,
  );
  execFileSync(
    compiler,
    ['-std=c++17', payloadSource, '-include', 'string', '-o', payload],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
  );
  for (const name of [
    'liblib_opencode_tagfix.so',
    'liblib_adev_opencode_compat.so',
    'liblib_opencode_opentui.so',
    'libbin_rg.so',
    'libbin_adev_xdg_open.so',
  ]) {
    fs.writeFileSync(path.join(nativeDir, name), 'host-test-placeholder', {mode: 0o755});
  }

  const launcherEnvironment = {
    ...process.env,
    ADEV_OPENCODE_TEST_PRIVATE_ROOT: privateRoot,
    ADEV_OPENCODE_TEST_NATIVE_DIR: nativeDir,
    HOME: home,
    ADEV_CONFIG_HOME: home,
    MOBILEIDE_WORKSPACES: workspaces,
    PREFIX: prefix,
    TERMUX__PREFIX__TMP_DIR: privateTmp,
    TMPDIR: '/tmp',
    TMP: '/tmp',
    TEMP: '/tmp',
    BUN_TMPDIR: '/tmp',
    // The XDG base directories belong to the shared runtime contract the app
    // publishes; the launcher must pass them through untouched instead of
    // re-deriving its own, which is how OpenCode's children used to end up
    // with different cache and configuration roots from the terminal's.
    XDG_CACHE_HOME: path.join(prefix, 'cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_RUNTIME_DIR: privateTmp,
    ADEV_URL_OPENER_PORT: '41234',
    ADEV_URL_OPENER_SESSION: 'host-test-url-session',
    LD_PRELOAD: 'inherited-termux-exec.so',
  };
  const runLauncher = args => spawnSync(hostLauncher, args, {
    encoding: 'utf8',
    env: launcherEnvironment,
  });
  const launchFailure = result =>
    result.stderr || result.error?.message || `launcher exited ${result.status}`;

  const doctor = runLauncher(['--adev-launcher-doctor']);
  assert.equal(doctor.status, 0, launchFailure(doctor));
  assert.match(doctor.stdout, new RegExp(`launcher_version=${manifest.version}`));
  assert.match(doctor.stdout, /liblib_adev_opencode_compat\.so/);
  assert.match(doctor.stdout, /ripgrep=.*libbin_rg\.so/);
  assert.match(doctor.stdout, /xdg_open=.*libbin_adev_xdg_open\.so/);
  assert.match(doctor.stdout, /url_opener_port=41234/);
  assert.match(doctor.stdout, /url_opener_session=present/);
  assert.ok(
    doctor.stdout.replaceAll('\\', '/').includes(
      `config_home=${home.replaceAll('\\', '/')}`,
    ),
  );
  assert.ok(
    doctor.stdout.replaceAll('\\', '/').includes(
      `workspace_home=${workspaces.replaceAll('\\', '/')}`,
    ),
  );
  assert.doesNotMatch(doctor.stdout, /temp=\/tmp(?:\r?\n|$)/);

  for (const args of [
    [],
    ['--version'],
    ['-v'],
    ['--help'],
    ['debug', 'paths'],
    ['run', '--help'],
    ['run', 'hello'],
    ['serve'],
    ['web'],
  ]) {
    const result = runLauncher(args);
    assert.equal(result.status, 0, launchFailure(result));
    for (const variable of [
      'TMPDIR',
      'TMP',
      'TEMP',
      'BUN_TMPDIR',
      'ADEV_OPENCODE_TMPDIR',
    ]) {
      assert.match(result.stdout, new RegExp(`env:${variable}=`));
      assert.doesNotMatch(result.stdout, new RegExp(`env:${variable}=/tmp(?:\\r?\\n|$)`));
    }
    assert.match(result.stdout, /env:OPENTUI_LIB_PATH=.*liblib_opencode_opentui\.so/);
    assert.match(result.stdout, /env:ADEV_OPENCODE_RG=.*libbin_rg\.so/);
    assert.match(result.stdout, /env:ADEV_OPENCODE_XDG_OPEN=.*libbin_adev_xdg_open\.so/);
    assert.match(result.stdout, /env:ADEV_URL_OPENER_PORT=41234/);
    assert.match(result.stdout, /env:ADEV_URL_OPENER_SESSION=host-test-url-session/);
    assert.match(result.stdout, /env:SHELL=\/system\/bin\/sh/);
    const normalizedOutput = result.stdout.replaceAll('\\', '/');
    assert.ok(
      normalizedOutput.includes(`env:HOME=${workspaces.replaceAll('\\', '/')}`),
    );
    assert.ok(
      normalizedOutput.includes(`env:ADEV_CONFIG_HOME=${home.replaceAll('\\', '/')}`),
    );
    assert.ok(
      normalizedOutput.includes(
        `env:GIT_CONFIG_GLOBAL=${home.replaceAll('\\', '/')}/.gitconfig`,
      ),
    );
    for (const [variable, expected] of [
      ['XDG_DATA_HOME', path.join(home, '.local/share')],
      ['XDG_CONFIG_HOME', path.join(home, '.config')],
      ['XDG_CACHE_HOME', path.join(prefix, 'cache')],
      ['XDG_STATE_HOME', path.join(home, '.local/state')],
      ['XDG_RUNTIME_DIR', privateTmp],
    ]) {
      // Inherited from the runtime contract, verbatim.
      assert.ok(
        normalizedOutput.includes(
          `env:${variable}=${expected.replaceAll('\\', '/')}`,
        ),
        `${variable} was not passed through unchanged`,
      );
      // OpenCode reports the workspace root as its HOME; caches and
      // configuration must never follow it there.
      assert.ok(
        !normalizedOutput.includes(
          `env:${variable}=${workspaces.replaceAll('\\', '/')}/`,
        ),
      );
    }
    assert.match(
      result.stdout,
      /env:LD_PRELOAD=.*liblib_opencode_tagfix\.so:.*liblib_adev_opencode_compat\.so:inherited-termux-exec\.so/,
    );
    args.forEach((argument, index) => {
      assert.match(result.stdout, new RegExp(`arg:${index + 1}=${argument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    });
  }

  const preservedExit = runLauncher(['exit23']);
  assert.equal(preservedExit.status, 23, launchFailure(preservedExit));
} finally {
  fs.rmSync(fixture, {recursive: true, force: true});
}

const sdk =
  process.env.ANDROID_SDK_ROOT ??
  process.env.ANDROID_HOME ??
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? '', 'Android/Sdk')
    : path.join(os.homedir(), 'Android/Sdk'));
const executable = name => `${name}${process.platform === 'win32' ? '.exe' : ''}`;
const prebuiltRoot = path.join(
  sdk,
  'ndk',
  '29.0.14206865',
  'toolchains',
  'llvm',
  'prebuilt',
);
const prebuilt = fs.readdirSync(prebuiltRoot, {withFileTypes: true}).find(entry =>
  fs.existsSync(path.join(prebuiltRoot, entry.name, 'bin', executable('llvm-readelf'))),
);
assert.ok(prebuilt, `NDK r29 llvm-readelf is missing under ${prebuiltRoot}`);
const readelf = path.join(prebuiltRoot, prebuilt.name, 'bin', executable('llvm-readelf'));
const compatElf = path.join(arm64, 'liblib_adev_opencode_compat.so');
const elfFiles = [
  path.join(arm64, 'libbin_opencode.so'),
  compatElf,
  ...manifest.components.map(component => path.join(arm64, component.packagedName)),
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
const compatSymbols = execFileSync(readelf, ['-Ws', compatElf], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
for (const symbol of ['mkdir', 'mkdirat', 'open', 'openat', 'stat', 'realpath']) {
  assert.match(compatSymbols, new RegExp(`\\b${symbol}\\b`));
}
const runtimeHeaders = execFileSync(
  readelf,
  ['-hlWd', path.join(arm64, 'libbin_opencode_runtime.so')],
  {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
);
assert.match(runtimeHeaders, /Requesting program interpreter: \/system\/bin\/linker64/);
assert.match(runtimeHeaders, /FLAGS_1\).*\bPIE\b/);
assert.doesNotMatch(runtimeHeaders, /ld-linux|GLIBC_/);
const runtimePayload = read(
  'android/app/src/main/jniLibs/arm64-v8a/libbin_opencode_runtime.so',
);
assert.ok(runtimePayload.includes(Buffer.from('ADEV_OPENCODE_RG')));
assert.ok(runtimePayload.includes(Buffer.from('Bun.env.ADEV_OPENCODE_RG')));
assert.ok(runtimePayload.includes(Buffer.from('dirname(process.execPath)')));
assert.ok(runtimePayload.includes(Buffer.from('Bun.spawn([sibling')));
assert.ok(runtimePayload.includes(Buffer.from('--capability-file')));
assert.ok(runtimePayload.includes(Buffer.from('.adev-url-opener-v1')));
assert.ok(runtimePayload.includes(Buffer.from('@opentui/core-linux-arm64')));
assert.ok(!runtimePayload.includes(Buffer.from('@opentui/core-linux-x64')));
const runtimeSymbols = execFileSync(
  readelf,
  ['-Ws', path.join(arm64, 'libbin_opencode_runtime.so')],
  {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
);
assert.match(runtimeSymbols, /\bmkdir@LIBC\b/);

process.stdout.write(
  'OpenCode Android host checks passed: pinned payload, real-mode forwarding, private /tmp remap, preload contract, hashes, PIE, and 16 KiB ELF alignment.\n',
);
