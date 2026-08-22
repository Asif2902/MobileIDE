import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file));
const text = file => read(file).toString('utf8');
const lock = JSON.parse(
  text('android/app/src/main/assets/runtime/runtime-lock.json'),
);
const version = JSON.parse(text('version.json'));

assert.equal(lock.runtimeVersion, version.runtimeVersion);
assert.equal(lock.compileApi, 36);
assert.equal(lock.targetApi, 36);
assert.equal(lock.pageAlignment, 16384);
assert.equal(lock.abis['arm64-v8a'].delivery, 'base-apk');
assert.equal(lock.abis['arm64-v8a'].developerRuntime, 'bundled');
assert.equal(
  lock.abis.x86_64.delivery,
  'base-apk-plus-signed-runtime-feature-pack',
);
assert.equal(lock.abis.x86_64.developerRuntime, 'signed-android-feature-pack');
assert.ok(lock.abis['arm64-v8a'].nativeFiles.length >= 194);
assert.ok(lock.abis.x86_64.nativeFiles.length >= 3);
for (const [abi, policy] of Object.entries(lock.abis)) {
  for (const entry of policy.nativeFiles) {
    const file = path.join(
      root,
      'android/app/src/main/jniLibs',
      abi,
      entry.packagedName,
    );
    assert.ok(fs.existsSync(file), `${abi}/${entry.packagedName} is missing`);
    assert.equal(fs.statSync(file).size, entry.bytes);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      entry.sha256,
      `${abi}/${entry.packagedName} differs from the signed runtime lock`,
    );
  }
}

const publicKey = crypto.createPublicKey(
  text('android/app/src/main/assets/runtime/runtime-lock.pub.pem'),
);
assert.equal(
  crypto.verify(
    null,
    read('android/app/src/main/assets/runtime/runtime-lock.json'),
    publicKey,
    read('android/app/src/main/assets/runtime/runtime-lock.sig'),
  ),
  true,
);

const build = text('android/build.gradle');
const appBuild = text('android/app/build.gradle');
const appCmake = text('android/app/src/main/jni/CMakeLists.txt');
const helperCmake = text('android/app/src/main/cpp/CMakeLists.txt');
const makeLauncher = text('android/app/src/main/cpp/adev_make.cpp');
const linkerLauncher = text('android/app/src/main/cpp/adev_ld_lld.cpp');
const busyboxLauncher = text('android/app/src/main/cpp/adev_busybox.cpp');
const assetIgnorePattern =
  appBuild.match(/ignoreAssetsPattern\s*=\s*"([^"]+)"/)?.[1] ?? '';
assert.match(build, /compileSdkVersion = 36/);
assert.match(build, /targetSdkVersion = 36/);
assert.match(build, /ndkVersion = "29\.0\.14206865"/);
assert.match(appBuild, /path "src\/main\/jni\/CMakeLists\.txt"/);
assert.match(appBuild, /version "3\.31\.6"/);
assert.match(appBuild, /ignoreAssetsPattern\s*=/);
assert.doesNotMatch(
  assetIgnorePattern,
  /<dir>_\*/,
  'AAPT must not omit underscore-prefixed Python/libc++ directories',
);
assert.ok(
  !assetIgnorePattern.split(':').includes('.*'),
  'AAPT must not omit package-manager .bin directories or dotfiles',
);
assert.match(
  appCmake,
  /include\(\$\{REACT_ANDROID_DIR\}\/cmake-utils\/ReactNative-application\.cmake\)/,
);
assert.match(appCmake, /add_subdirectory\([^)]*cpp/);
assert.match(helperCmake, /add_executable\(adev_make adev_make\.cpp\)/);
assert.match(helperCmake, /add_executable\(adev_ld_lld adev_ld_lld\.cpp\)/);
assert.match(helperCmake, /add_executable\(adev_busybox adev_busybox\.cpp\)/);
assert.match(busyboxLauncher, /control_mode/);
assert.match(
  busyboxLauncher,
  /control_mode \? "busybox" : \(android_w \? "uptime" : argv\[1\]\)/,
);
assert.match(appBuild, /libbin_adev_busybox\.so/);
assert.match(appBuild, /libbin_adev_ld_lld\.so/);
assert.match(makeLauncher, /SHELL=/);
assert.match(makeLauncher, /libbin_make\.so/);
assert.match(makeLauncher, /\/system\/bin\/sh/);
assert.match(makeLauncher, /CONFIG_SHELL/);
assert.doesNotMatch(makeLauncher, /const std::string bundled_bash/);
assert.match(linkerLauncher, /libbin_lld\.so/);
assert.match(linkerLauncher, /const_cast<char\*>\("ld\.lld"\)/);
assert.match(linkerLauncher, /execv\(runtime\.c_str\(\)/);
assert.match(
  text('scripts/verify-phase4-apk.mjs'),
  /lib\/arm64-v8a\/libappmodules\.so/,
);
assert.match(text('android/gradle.properties'), /arm64-v8a,x86_64/);
assert.match(text('package.json'), /"react-native": "0\.86\.2"/);
assert.match(
  text('android/app/src/main/assets/terminal/index.html'),
  /if \(line\.isWrapped && logicalLine !== null\)/,
);
assert.doesNotMatch(
  text(
    'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
  ),
  /PS1='adev:\\\\\$\{'/,
  'The fallback-shell prompt must expand its current-directory expression',
);
assert.match(
  text(
    'android/app/src/main/java/com/mobileide/app/modules/StorageNativeModule.kt',
  ),
  /importWorkspaceToPrivate/,
);
assert.match(
  text(
    'android/app/src/main/java/com/mobileide/app/modules/StorageNativeModule.kt',
  ),
  /Files\.isSymbolicLink/,
);
assert.match(
  text(
    'android/app/src/main/java/com/mobileide/app/modules/StorageNativeModule.kt',
  ),
  /deleteRecursively\(\)/,
);
assert.match(
  text(
    'android/app/src/main/java/com/mobileide/app/modules/StorageNativeModule.kt',
  ),
  /renameTo\(destination\)/,
);

process.stdout.write(
  'Phase 4 host policy checks passed: API 36, RN 0.86, signed runtime lock, ABI feature boundary, and private workspace import.\n',
);
