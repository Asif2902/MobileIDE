import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
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
assert.match(launcher, /execv\(runtime\.c_str\(\)/);
assert.match(launcher, /\/system\/bin\/linker64|ANDROID_ROOT/);
assert.match(launcher, /LD_PRELOAD/);
assert.match(launcher, /OPENTUI_LIB_PATH/);
assert.match(launcher, /BUN_TMPDIR/);
assert.match(launcher, /SQLITE_TMPDIR/);
assert.match(launcher, /BUN_SELF_EXE/);
assert.match(launcher, /TERMUX_EXEC__PROC_SELF_EXE/);
assert.match(launcher, /setenv\("ANDROID_ROOT", "\/system", 1\)/);
assert.match(launcher, /setenv\("TERMUX_VERSION", "adev-opencode", 1\)/);
assert.match(launcher, /TERMUX__PREFIX__TMP_DIR/);
assert.match(launcher, /TERMUX_APP__DATA_DIR/);
assert.match(launcher, /private_tmp/);
assert.match(launcher, /path == "\/tmp"/);
assert.match(launcher, /W_OK \| X_OK/);
assert.match(launcher, /Linux\/glibc binary will not be substituted/);
assert.match(launcher, /requested_version/);
assert.match(launcher, /equals\(argv\[index\], "-v"\)/);
assert.match(launcher, /const_cast<char\*>\("--version"\)/);
assert.match(launcher, /requested_debug_paths/);
assert.match(launcher, /unsupported_mode/);
assert.match(launcher, /available upstream Android Bun\/OpenTUI payloads abort/);
const runtimeManager = text(
  'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
);
assert.match(
  runtimeManager,
  /writeScript\(\s*"opencode",\s*"#!\/system\/bin\/sh\\nexec/,
  'OpenCode must have a real PATH trampoline for child processes',
);

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
