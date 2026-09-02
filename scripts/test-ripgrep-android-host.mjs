import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromRoot = value => path.join(root, value);
const json = value => JSON.parse(fs.readFileSync(fromRoot(value), 'utf8'));
const sha256 = value =>
  crypto.createHash('sha256').update(fs.readFileSync(fromRoot(value))).digest('hex');

const manifestPath = 'android/app/src/main/assets/runtime/lib/adev-ripgrep.json';
const binaryPath = 'android/app/src/main/jniLibs/arm64-v8a/libbin_rg.so';
const pcrePath = 'android/app/src/main/jniLibs/arm64-v8a/liblib_libpcre2_8_so.so';
const manifest = json(manifestPath);
const nativeMap = json('android/app/src/main/assets/runtime/native-map.json');
const lock = json('android/app/src/main/assets/runtime/runtime-lock.json');

assert.equal(manifest.package, 'ripgrep');
assert.equal(manifest.version, '15.2.0');
assert.equal(manifest.platform, 'android-bionic');
assert.deepEqual(manifest.supportedAbis, ['arm64-v8a']);
assert.equal(nativeMap['bin/rg'], 'libbin_rg.so');
assert.equal(nativeMap['lib/libpcre2-8.so'], 'liblib_libpcre2_8_so.so');
assert.equal(fs.statSync(fromRoot(binaryPath)).size, 4868920);
assert.equal(sha256(binaryPath), manifest.components[0].sha256);
assert.equal(sha256(pcrePath), manifest.dependencies[0].sha256);
assert.equal(manifest.dependencies[0].version, '10.47');
const pcreBytes = fs.readFileSync(fromRoot(pcrePath));
assert.ok(pcreBytes.includes(Buffer.from('PCRE2_10.47')));
assert.ok(pcreBytes.includes(Buffer.from('10.47 2025-10-21')));
for (const component of manifest.components.filter(item => item.runtimePath)) {
  const relative = `android/app/src/main/assets/runtime/${component.runtimePath}`;
  assert.equal(fs.statSync(fromRoot(relative)).size, component.bytes);
  assert.equal(sha256(relative), component.sha256);
}
assert.equal(lock.ripgrep.sha256, sha256(manifestPath));
assert.equal(lock.ripgrep.version, manifest.version);
assert.ok(
  lock.abis['arm64-v8a'].nativeFiles.some(
    file =>
      file.packagedName === 'libbin_rg.so' &&
      file.sha256 === manifest.components[0].sha256 &&
      file.runtimePaths.includes('bin/rg'),
  ),
);
assert.ok(
  !fs.existsSync(fromRoot('android/app/src/main/jniLibs/x86_64/libbin_rg.so')),
  'x86_64 must remain an explicit capability boundary until a verified payload exists',
);

const bytes = fs.readFileSync(fromRoot(binaryPath));
assert.equal(bytes[0], 0x7f);
assert.equal(bytes.subarray(1, 4).toString('ascii'), 'ELF');
assert.equal(bytes.readUInt16LE(18), 183);
for (const marker of ['/system/bin/linker64', 'libpcre2-8.so', 'libdl.so', 'libc.so']) {
  assert.ok(bytes.includes(Buffer.from(marker)), `missing ELF marker: ${marker}`);
}

const fetchScript = fs.readFileSync(fromRoot('scripts/fetch-ripgrep-android.ps1'), 'utf8');
const runtimeManager = fs.readFileSync(
  fromRoot('android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt'),
  'utf8',
);
const nativeLauncher = fs.readFileSync(
  fromRoot('android/app/src/main/cpp/adev_env.cpp'),
  'utf8',
);
assert.match(fetchScript, /ripgrep_15\.2\.0_aarch64\.deb/);
assert.match(fetchScript, /38e28bc297000517b24702568a483eca7dc3323eb6bdccc9033f031776bdcc6c/);
assert.match(fetchScript, /Assert-AndroidElf64Aarch64/);
assert.match(runtimeManager, /val ripgrep = File\(nativeLibDir, "libbin_rg\.so"\)/);
assert.match(runtimeManager, /writeScript\("rg", "#!\/system\/bin\/sh\\nexec/);
assert.match(runtimeManager, /export MOBILEIDE_RG=/);
assert.match(runtimeManager, /"rg" to File\(nativeLibDir, "libbin_rg\.so"\)\.isFile/);
assert.match(nativeLauncher, /std::strcmp\(base, "rg"\) == 0/);
assert.match(nativeLauncher, /sibling\("libbin_rg\.so"\)/);
assert.match(
  manifest.runtime.openCodePolicy,
  /ADEV_OPENCODE_RG.*before.*desktop/i,
);

process.stdout.write(
  'ripgrep Android host checks passed: pinned Termux ARM64/Bionic ELF, PCRE2 closure, PATH ownership, and signed runtime lock.\n',
);
