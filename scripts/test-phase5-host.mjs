import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file));
const text = file => read(file).toString('utf8');
const json = file => JSON.parse(text(file));

const version = json('version.json');
const packageJson = json('package.json');
const packageLock = json('package-lock.json');
const policy = json('release/release-policy.json');
const auditBoundary = json('release/development-audit-boundary.json');
const runtimeLock = json(
  'android/app/src/main/assets/runtime/runtime-lock.json',
);
const appBuild = text('android/app/build.gradle');
const settings = text('android/settings.gradle');
const workflow = text('.github/workflows/android-compatibility.yml');
const instrumentation = text(
  'android/app/src/androidTest/java/com/mobileide/app/CompatibilityInstrumentationTest.kt',
);

assert.equal(packageJson.version, version.versionName);
assert.equal(packageLock.version, version.versionName);
assert.equal(packageLock.packages[''].version, version.versionName);
assert.match(appBuild, /new JsonSlurper\(\)\.parse\(versionFile\)/);
assert.match(appBuild, /versionCode \(releaseVersion\.versionCode as Integer\)/);
assert.match(appBuild, /versionName releaseVersion\.versionName as String/);
assert.match(appBuild, /ADEV_RUNTIME_VERSION/);
assert.equal(runtimeLock.runtimeVersion, version.runtimeVersion);
assert.match(text('RELEASE_NOTES.md'), new RegExp(version.versionName));

assert.match(settings, /JavaVersion\.VERSION_17/);
assert.match(appBuild, /ADEV_RELEASE_STORE_FILE/);
assert.match(appBuild, /ADEV_RELEASE_CERT_SHA256|ADEV_RELEASE_KEY_ALIAS/);
const releaseBuildType =
  appBuild.match(/buildTypes \{[\s\S]*?release \{([\s\S]*?)minifyEnabled/)?.[1] ??
  '';
assert.doesNotMatch(
  releaseBuildType,
  /signingConfig signingConfigs\.debug/,
);
assert.match(appBuild, /Production release signing is not configured/);
assert.match(appBuild, /pruneRuntimeNativeLibs/);
assert.match(
  text('scripts/prune-runtime-owned.mjs'),
  /Refusing to prune from an invalid runtime lock signature/,
);

assert.deepEqual(policy.abis, ['arm64-v8a', 'x86_64']);
assert.equal(policy.targetSdk, 36);
assert.equal(policy.pageAlignment, 16384);
assert.equal(policy.jdkMajor, 17);
assert.equal(policy.security.forbidDebugReleaseCertificate, true);
assert.ok(policy.requiredApkEntries.includes('assets/runtime/lib/adev-phase5-test.js'));
for (const requiredRuntimeEntry of [
  'assets/runtime/lib/adev-busybox.json',
  'assets/runtime/lib/adev-nano.json',
  'assets/runtime/lib/adev-ripgrep.json',
  'assets/runtime/etc/nanorc.termux',
  'assets/runtime/share/nano/javascript.nanorc',
  'assets/runtime/share/licenses/ripgrep/copyright',
  'assets/runtime/share/licenses/ripgrep/LICENSE-MIT',
  'assets/runtime/share/terminfo/x/xterm-256color',
  'lib/arm64-v8a/libbin_adev_busybox.so',
  'lib/arm64-v8a/libbin_busybox.so',
  'lib/arm64-v8a/liblib_libbusybox_so_1_38_0.so',
  'lib/arm64-v8a/libbin_nano.so',
  'lib/arm64-v8a/libbin_rg.so',
  'lib/arm64-v8a/libbin_adev_xdg_open.so',
]) {
  assert.ok(
    policy.requiredApkEntries.includes(requiredRuntimeEntry),
    `Release policy is missing ${requiredRuntimeEntry}`,
  );
}
assert.deepEqual(auditBoundary.observed, {
  moderate: 0,
  high: 8,
  total: 8,
});
assert.equal(policy.security.productionAuditMaximum.high, 8);
assert.match(
  auditBoundary.releaseDecision,
  /two exact image-size advisories/,
);
assert.deepEqual(auditBoundary.productionException.advisories, [
  'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
  'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
]);
assert.equal(packageJson.overrides.nanoid, '3.3.18');
assert.match(packageJson.scripts.postinstall, /apply-image-size-security-patch/);
assert.match(packageJson.scripts['audit:production'], /audit-production/);
assert.match(text('jest.config.js'), /roots: \['<rootDir>\/__tests__'\]/);
assert.match(text('scripts/run-eslint.mjs'), /ESLINT_USE_FLAT_CONFIG: 'false'/);

for (const api of [29, 34, 35, 36]) {
  assert.match(workflow, new RegExp(`\\b${api}\\b`));
}
assert.match(workflow, /x86_64/);
assert.match(workflow, /android-arm64/);
assert.match(workflow, /pagesize-16k/);
assert.match(workflow, /git lfs pull/);
assert.match(workflow, /assembleRelease bundleRelease/);
assert.match(workflow, /npm run audit:production/);
assert.match(workflow, /cmake;3\.31\.6/);
assert.match(instrumentation, /bundledDeveloperRuntimePassesOfflineDeviceMatrix/);
assert.match(instrumentation, /bundledDeveloperRuntimePassesNetworkFrameworkMatrix/);
assert.match(instrumentation, /adevNetwork/);
assert.match(instrumentation, /requestedPrivateProjectPassesNpmInstallAndNativeRebuild/);
assert.match(instrumentation, /adevProject/);
assert.match(instrumentation, /bufferutil/);
assert.match(instrumentation, /utf-8-validate/);
assert.match(instrumentation, /adev-phase5-test\.js/);
assert.match(instrumentation, /RuntimeManager\(context\)/);

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
assert.ok(
  fs.statSync('release/third-party-licenses.json', {throwIfNoEntry: false}),
  'Run npm run licenses before the Phase 5 host gate.',
);

process.stdout.write(
  'Phase 5 host policy checks passed: version, JDK, test isolation, signing, security, CI/device matrices, lock signature, and license gates.\n',
);
