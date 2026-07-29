import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'runtime');
const preload = path.join(runtime, 'lib', 'adev-runtime-policy.js');
const resolver = path.join(runtime, 'lib', 'adev-package-resolver.js');
const doctorScript = path.join(runtime, 'lib', 'adev-doctor.js');
const originalPlatform = process.platform;

function run(script, args = [], env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {...process.env, PREFIX: runtime, ...env},
  });
}

const preloadProbe = spawnSync(
  process.execPath,
  ['--require', preload, '-p', 'JSON.stringify([process.platform,process.adevRuntimeCapabilities.globalPlatformSpoof])'],
  {encoding: 'utf8', env: {...process.env, PREFIX: runtime}},
);
assert.equal(preloadProbe.status, 0, preloadProbe.stderr);
assert.deepEqual(JSON.parse(preloadProbe.stdout), [originalPlatform, false]);

const doctor = run(doctorScript, ['--json']);
const doctorReport = JSON.parse(doctor.stdout);
assert.equal(doctorReport.schemaVersion, 4);
assert.equal(doctorReport.environment.globalPlatformSpoof, false);
assert.equal(doctorReport.runtimeDistribution.signatureVerified, true);
assert.deepEqual(doctorReport.packageResolution.resolutionOrder, [
  'android-bionic',
  'verified-static-or-musl',
  'source-build',
  'unsupported',
]);

const androidCandidates = path.join(os.tmpdir(), `adev-android-candidates-${process.pid}.json`);
fs.writeFileSync(androidCandidates, JSON.stringify([
  {platform: 'android', libc: 'bionic', arch: process.arch, url: 'fixture://android'},
]));
const android = run(resolver, [
  '--package', 'fixture-addon',
  '--version', '1.0.0',
  '--candidates', androidCandidates,
  '--json',
]);
assert.equal(android.status, 0, android.stderr);
assert.equal(JSON.parse(android.stdout).decision, 'android-bionic');

const source = run(
  resolver,
  ['--package', 'fixture-source', '--version', '1.0.0', '--json'],
  {PYTHON: '/fixture/python', MAKE: '/fixture/make', CC: '/fixture/clang', CXX: '/fixture/clang++'},
);
assert.equal(source.status, 0, source.stderr);
assert.equal(JSON.parse(source.stdout).decision, 'source-build');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-policy-test-'));
try {
  const policyFile = path.join(temp, 'policy.json');
  const candidatesFile = path.join(temp, 'candidates.json');
  const artifact = {
    platform: 'linux',
    libc: 'musl',
    arch: process.arch,
    url: 'fixture://verified-musl',
    sha256: 'abc123',
  };
  fs.writeFileSync(policyFile, JSON.stringify({
    resolutionOrder: ['android-bionic', 'verified-static-or-musl', 'source-build', 'unsupported'],
    verifiedLinuxArtifacts: [{
      package: 'fixture-musl',
      version: '1.0.0',
      arch: process.arch,
      url: artifact.url,
      sha256: artifact.sha256,
    }],
    sourceBuild: {enabled: false},
  }));
  fs.writeFileSync(candidatesFile, JSON.stringify([artifact]));
  const musl = run(
    resolver,
    [
      '--package', 'fixture-musl',
      '--version', '1.0.0',
      '--candidates', candidatesFile,
      '--json',
    ],
    {ADEV_PACKAGE_POLICY_FILE: policyFile},
  );
  assert.equal(musl.status, 0, musl.stderr);
  assert.equal(JSON.parse(musl.stdout).decision, 'verified-static-or-musl');

  fs.writeFileSync(policyFile, JSON.stringify({
    resolutionOrder: ['android-bionic', 'source-build', 'unsupported'],
    verifiedLinuxArtifacts: [],
    sourceBuild: {enabled: false},
    unsupportedMessage: 'fixture unsupported',
  }));
  const unsupported = run(
    resolver,
    ['--package', 'fixture-unsupported', '--version', '1.0.0', '--json'],
    {ADEV_PACKAGE_POLICY_FILE: policyFile},
  );
  assert.equal(unsupported.status, 2);
  assert.equal(JSON.parse(unsupported.stdout).decision, 'unsupported');
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
  fs.rmSync(androidCandidates, {force: true});
}

process.stdout.write('runtime capability policy tests passed\n');
