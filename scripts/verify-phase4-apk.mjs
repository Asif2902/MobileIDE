import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apk = path.resolve(
  process.argv[2] ??
    path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk'),
);
assert.ok(fs.existsSync(apk), `APK not found: ${apk}`);

const sdk =
  process.env.ANDROID_SDK_ROOT ??
  process.env.ANDROID_HOME ??
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? '', 'Android/Sdk')
    : path.join(os.homedir(), 'Android/Sdk'));
const executable = name =>
  `${name}${process.platform === 'win32' ? '.exe' : ''}`;
const tool = (...segments) => {
  const candidate = path.join(sdk, ...segments);
  assert.ok(
    fs.existsSync(candidate),
    `Android SDK tool not found: ${candidate}`,
  );
  return candidate;
};
const zipalign = tool('build-tools', '36.0.0', executable('zipalign'));
const aapt2 = tool('build-tools', '36.0.0', executable('aapt2'));
const prebuiltRoot = tool(
  'ndk',
  '29.0.14206865',
  'toolchains',
  'llvm',
  'prebuilt',
);
const prebuilt = fs
  .readdirSync(prebuiltRoot, {withFileTypes: true})
  .find(entry =>
    fs.existsSync(
      path.join(prebuiltRoot, entry.name, 'bin', executable('llvm-readelf')),
    ),
  );
assert.ok(prebuilt, `NDK readelf prebuilt not found under ${prebuiltRoot}`);
const readelf = path.join(
  prebuiltRoot,
  prebuilt.name,
  'bin',
  executable('llvm-readelf'),
);
const jarCandidate = process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', executable('jar'))
  : null;
const jar = jarCandidate && fs.existsSync(jarCandidate) ? jarCandidate : 'jar';
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });

const entries = run(jar, ['tf', apk]).trim().split(/\r?\n/);
const required = [
  'lib/arm64-v8a/libappmodules.so',
  'lib/arm64-v8a/libbin_adev_npm_shell.so',
  'lib/arm64-v8a/libbin_adev_git_credential.so',
  'lib/arm64-v8a/libbin_opencode.so',
  'lib/arm64-v8a/libbin_opencode_runtime.so',
  'lib/arm64-v8a/liblib_opencode_opentui.so',
  'lib/arm64-v8a/liblib_opencode_tagfix.so',
  'lib/x86_64/libappmodules.so',
  'lib/x86_64/libbin_adev_npm_shell.so',
  'lib/x86_64/libbin_adev_git_credential.so',
  'lib/x86_64/libbin_opencode.so',
  'assets/runtime/runtime-lock.json',
  'assets/runtime/runtime-lock.pub.pem',
  'assets/runtime/runtime-lock.sig',
  'assets/runtime/lib/adev-opencode.json',
  'assets/runtime/lib/adev-phase4-test.js',
  'assets/runtime/lib/adev-phase5-test.js',
];
for (const entry of required) {
  assert.ok(entries.includes(entry), `APK entry is missing: ${entry}`);
}
const abis = [
  ...new Set(
    entries
      .filter(entry => entry.startsWith('lib/') && entry.endsWith('.so'))
      .map(entry => entry.split('/')[1]),
  ),
].sort();
assert.deepEqual(abis, ['arm64-v8a', 'x86_64']);

run(zipalign, ['-c', '-P', '16', '-v', '4', apk]);
const badging = run(aapt2, ['dump', 'badging', apk]);
assert.match(badging, /compileSdkVersion='36'/);
assert.match(badging, /targetSdkVersion:'36'/);
assert.match(badging, /minSdkVersion:'29'/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobileide-phase4-apk-'));
try {
  run(
    jar,
    [
      'xf',
      apk,
      'lib',
      'assets/runtime/runtime-lock.json',
      'assets/runtime/runtime-lock.pub.pem',
      'assets/runtime/runtime-lock.sig',
      'assets/runtime/native-map.json',
    ],
    {cwd: temp},
  );

  const runtime = path.join(temp, 'assets/runtime');
  const lockBytes = fs.readFileSync(path.join(runtime, 'runtime-lock.json'));
  assert.equal(
    crypto.verify(
      null,
      lockBytes,
      fs.readFileSync(path.join(runtime, 'runtime-lock.pub.pem')),
      fs.readFileSync(path.join(runtime, 'runtime-lock.sig')),
    ),
    true,
    'Packaged runtime-lock signature is invalid',
  );

  const nativeFiles = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.so')) nativeFiles.push(file);
    }
  };
  visit(path.join(temp, 'lib'));

  let relocatableObjects = 0;
  let minimumAlignment = Number.MAX_SAFE_INTEGER;
  const failures = [];
  const dynamicEntries = [];
  for (const file of nativeFiles) {
    const output = run(readelf, ['-hlW', file]);
    const alignments = output
      .split(/\r?\n/)
      .filter(line => /^\s*LOAD/.test(line))
      .map(line => Number.parseInt(line.trim().split(/\s+/).at(-1), 16));
    if (alignments.length === 0 && /^\s*Type:\s+REL\b/m.test(output)) {
      relocatableObjects++;
      continue;
    }
    if (alignments.length === 0) {
      failures.push(`${path.basename(file)}: no LOAD segments`);
      continue;
    }
    const fileMinimum = Math.min(...alignments);
    minimumAlignment = Math.min(minimumAlignment, fileMinimum);
    if (fileMinimum < 0x4000) {
      failures.push(
        `${path.basename(file)}: LOAD alignment 0x${fileMinimum.toString(16)}`,
      );
    }
    dynamicEntries.push({file, dynamic: run(readelf, ['-dW', file])});
  }
  assert.deepEqual(failures, []);

  const availableLibraries = new Set(
    nativeFiles.map(file => path.basename(file)),
  );
  const nativeMap = JSON.parse(
    fs.readFileSync(path.join(runtime, 'native-map.json'), 'utf8'),
  );
  const packagedNames = new Set(
    nativeFiles.map(file => path.basename(file)),
  );
  for (const [runtimePath, packagedName] of Object.entries(nativeMap)) {
    if (packagedNames.has(packagedName)) {
      availableLibraries.add(path.posix.basename(runtimePath));
    }
  }
  for (const {dynamic} of dynamicEntries) {
    const soname = dynamic.match(/\(SONAME\).*\[([^\]]+)\]/)?.[1];
    if (soname) availableLibraries.add(soname);
  }
  const androidSystemLibraries = new Set([
    'libEGL.so',
    'libGLESv2.so',
    'libOpenSLES.so',
    'libaaudio.so',
    'libandroid.so',
    'libc.so',
    'libdl.so',
    'libjnigraphics.so',
    'liblog.so',
    'libm.so',
    'libmediandk.so',
    'libnativewindow.so',
    'libvulkan.so',
    'libz.so',
  ]);
  const missingDependencies = [];
  for (const {file, dynamic} of dynamicEntries) {
    for (const match of dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)) {
      const needed = match[1];
      if (
        !availableLibraries.has(needed) &&
        !androidSystemLibraries.has(needed)
      ) {
        missingDependencies.push(`${path.basename(file)} -> ${needed}`);
      }
    }
  }
  assert.deepEqual(
    missingDependencies,
    [],
    'Packaged ELF dependency closure is incomplete',
  );

  const bytes = fs.statSync(apk).size;
  const sha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(apk))
    .digest('hex');
  process.stdout.write(
    `Phase 4 APK checks passed: ${abis.join('+')}, ${
      nativeFiles.length
    } ELF files (${relocatableObjects} relocatable), minimum LOAD alignment 0x${minimumAlignment.toString(
      16,
    )}, ${bytes} bytes, SHA-256 ${sha256.toUpperCase()}.\n`,
  );
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
