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

function run(script, args = [], env = {}, cwd = undefined) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {...process.env, PREFIX: runtime, ...env},
    cwd,
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
assert.equal(doctorReport.schemaVersion, 5);
assert.equal(doctorReport.environment.globalPlatformSpoof, false);
assert.equal(doctorReport.runtimeDistribution.signatureVerified, true);
assert.equal(doctorReport.opencode.ready, false);
assert.equal(doctorReport.opencode.launcherReady, false);
assert.equal(doctorReport.opencode.diagnosticsNative, false);
assert.equal(doctorReport.opencode.payloadPresent, false);
assert.equal(doctorReport.opencode.tempRemapPresent, false);
assert.equal(doctorReport.opencode.runtimeLaunchReady, false);
assert.equal(doctorReport.opencode.deviceCertified, false);
assert.equal(doctorReport.opencode.functionalModesReady, false);
assert.deepEqual(doctorReport.opencode.diagnosticAbis, ['arm64-v8a']);
assert.equal(doctorReport.opencode.capabilities.interactiveTui, false);
assert.equal(doctorReport.opencode.capabilities.agentRun, false);
assert.match(doctorReport.opencode.boundary, /Android|ABI|payload/i);
assert.deepEqual(doctorReport.packageResolution.resolutionOrder, [
  'android-bionic',
  'verified-static-or-musl',
  'source-build',
  'unsupported',
]);
assert.match(doctorReport.cliGuidance.npmRun, /package\.json script/);
assert.match(doctorReport.cliGuidance.directJavaScript, /node index\.js/);
assert.match(doctorReport.cliGuidance.git, /git status/);
assert.match(doctorReport.cliGuidance.ssh, /ssh user@host/);
assert.match(doctorReport.cliGuidance.opencode, /process-scoped \/tmp remap/);

const projectFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-project-guide-'));
try {
  fs.writeFileSync(
    path.join(projectFixture, 'package.json'),
    `${JSON.stringify({name: 'parent', engines: {node: '1.x', npm: '1.x'}})}\n`,
  );
  fs.writeFileSync(path.join(projectFixture, 'index.js'), 'process.exit(0);\n');
  const frontend = path.join(projectFixture, 'AchMarket', 'frontend');
  fs.mkdirSync(frontend, {recursive: true});
  fs.writeFileSync(
    path.join(frontend, 'package.json'),
    `${JSON.stringify({name: 'frontend', scripts: {dev: 'vite', build: 'vite build'}})}\n`,
  );

  const projectDoctor = run(doctorScript, ['--json'], {}, projectFixture);
  const projectReport = JSON.parse(projectDoctor.stdout);
  assert.equal(projectReport.project.manifest.name, 'parent');
  assert.deepEqual(projectReport.project.manifest.scripts, []);
  assert.deepEqual(projectReport.project.directEntries, ['index.js']);
  assert.equal(projectReport.project.manifest.engines.node, '1.x');
  assert.equal(projectReport.project.engineCompatibility.node, false);
  assert.equal(projectReport.project.engineCompatibility.npm, false);
  assert.ok(
    projectReport.project.nestedProjects.some(
      item => item.relativePath === 'AchMarket/frontend' && item.scripts.includes('dev'),
    ),
  );
  assert.ok(projectReport.project.suggestedCommands.includes(
    'node index.js  # run the file directly; npm run index.js needs a declared script',
  ));
  assert.ok(projectReport.project.suggestedCommands.includes(
    'cd "AchMarket/frontend" && npm run dev',
  ));
  assert.ok(!projectReport.project.suggestedCommands.includes('npm run index.js'));
  assert.equal(
    projectReport.project.npmLifecycleSecurity.reviewPending,
    'npm approve-scripts --allow-scripts-pending',
  );

  const projectDoctorText = run(doctorScript, [], {}, projectFixture);
  assert.match(projectDoctorText.stdout, /Nested Node projects: AchMarket\/frontend \[build, dev\]/);
  assert.match(projectDoctorText.stdout, /Try: node index\.js/);
  assert.match(projectDoctorText.stdout, /Try: cd "AchMarket\/frontend" && npm run dev/);
  assert.match(projectDoctorText.stdout, /Engine mismatch: project requires Node 1\.x/);
  assert.doesNotMatch(projectDoctorText.stdout, /Try: npm run index\.js/);
  assert.match(projectDoctorText.stdout, /approve only reviewed package versions/);
} finally {
  fs.rmSync(projectFixture, {recursive: true, force: true});
}

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
