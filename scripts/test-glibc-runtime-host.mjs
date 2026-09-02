import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const indexPath = path.join(root, 'release', 'adev-glibc-index.json');
const embeddedIndexPath = path.join(
  root,
  'android/app/src/main/assets/runtime/lib/adev-glibc.json',
);
const cliPath = path.join(
  root,
  'android/app/src/main/assets/runtime/lib/adev-runtime-cli.js',
);
const loaderArchivePath = path.join(
  root,
  'android/app/src/main/prebuilt/arm64-v8a/libbin_adev_glibc_ld.so.gz',
);
const launcherPaths = [
  ['arm64-v8a', 183],
  ['x86_64', 62],
].map(([abi, machine]) => ({
  abi,
  machine,
  path: path.join(
    root,
    'android/app/src/main/jniLibs',
    abi,
    'libbin_adev_glibc_loader.so',
  ),
}));

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const embeddedIndex = JSON.parse(fs.readFileSync(embeddedIndexPath, 'utf8'));
assert.deepEqual(embeddedIndex, index);
assert.equal(index.schemaVersion, 1);
assert.equal(index.id, 'adev-glibc');
assert.equal(index.channel, 'stable');

const selected = index.packages.aarch64;
assert.equal(selected.version, '1.0.1');
assert.equal(selected.glibcVersion, '2.44-0');
assert.match(selected.archive, /^https:\/\/github\.com\/Asif2902\/MobileIDE\/releases\//);
assert.match(selected.sha256, /^[a-f0-9]{64}$/);
assert.match(selected.requiredLoaderSha256, /^[a-f0-9]{64}$/);
assert.ok(selected.bytes < 3 * 1024 * 1024, 'compressed runtime must stay below 3 MiB');
assert.ok(selected.installedBytes < 8 * 1024 * 1024, 'installed runtime must stay below 8 MiB');

const archivePath = path.join(
  root,
  'release/glibc',
  `adev-glibc-aarch64-v${selected.version}.tar.gz`,
);
const archiveBytes = fs.readFileSync(archivePath);
assert.equal(archiveBytes.length, selected.bytes);
assert.equal(hash(archiveBytes), selected.sha256);
assert.equal(
  fs.readFileSync(`${archivePath}.sha256`, 'utf8').trim(),
  `${selected.sha256}  ${path.basename(archivePath)}`,
);

const list = spawnSync('tar', ['-tzf', archivePath], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(list.status, 0, list.stderr);
const validateArchive = spawnSync(
  process.execPath,
  [
    '-e',
    `require(${JSON.stringify(cliPath)}).validateArchive(${JSON.stringify(archivePath)})`,
  ],
  {cwd: root, encoding: 'utf8'},
);
assert.equal(validateArchive.status, 0, validateArchive.stderr);
assert.match(list.stdout, /glibc\/lib\/libc\.so\.6/);
assert.match(list.stdout, /glibc\/lib\/libresolv\.so\.2/);
assert.match(list.stdout, /glibc\/bin\/getconf/);
assert.match(list.stdout, /glibc\/etc\/nsswitch\.conf/);
assert.match(list.stdout, /glibc\/etc\/hosts/);
assert.match(list.stdout, /glibc\/share\/licenses\/LGPL-3\.0\.txt/);
assert.doesNotMatch(list.stdout, /glibc\/include\//);
assert.doesNotMatch(list.stdout, /glibc\/lib\/.*\.a\r?$/m);
assert.doesNotMatch(list.stdout, /glibc\/lib\/gconv\//);

const loader = zlib.gunzipSync(fs.readFileSync(loaderArchivePath));
assert.equal(hash(loader), selected.requiredLoaderSha256);
assert.deepEqual([...loader.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
assert.equal(loader.readUInt16LE(18), 183, 'loader must be AArch64');
assert.equal(loader.readUInt16LE(54), 56, 'unexpected ELF64 program-header size');
const programHeaderOffset = Number(loader.readBigUInt64LE(32));
const programHeaderSize = loader.readUInt16LE(54);
const programHeaderCount = loader.readUInt16LE(56);
let executableLoad = false;
for (let index = 0; index < programHeaderCount; index += 1) {
  const offset = programHeaderOffset + index * programHeaderSize;
  if (loader.readUInt32LE(offset) !== 1) continue;
  const flags = loader.readUInt32LE(offset + 4);
  const alignment = Number(loader.readBigUInt64LE(offset + 48));
  assert.ok(alignment >= 0x4000, 'glibc loader has a PT_LOAD below 16 KiB alignment');
  if (flags & 1) executableLoad = true;
}
assert.equal(executableLoad, true);

for (const launcher of launcherPaths) {
  const bytes = fs.readFileSync(launcher.path);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
  assert.equal(bytes.readUInt16LE(18), launcher.machine, `${launcher.abi} launcher machine`);
  assert.ok(
    bytes.includes(Buffer.from('/system/bin/linker64\0')),
    `${launcher.abi} launcher must be Android/Bionic executable`,
  );
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-glibc-host-'));
try {
  const run = spawnSync(process.execPath, [cliPath, 'runtime', 'list', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: {...process.env, PREFIX: fixture, ADEV_RUNTIME: fixture},
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.runtimes.map(runtime => runtime.id), [
    'node',
    'python',
    'git',
    'glibc',
    'linux',
  ]);
  assert.equal(report.runtimes.find(runtime => runtime.id === 'glibc').installed, false);
  assert.equal(report.runtimes.find(runtime => runtime.id === 'linux').installed, false);
} finally {
  fs.rmSync(fixture, {recursive: true, force: true});
}

const cli = fs.readFileSync(cliPath, 'utf8');
const environment = fs.readFileSync(
  path.join(
    root,
    'android/app/src/main/java/com/mobileide/app/runtime/AdevEnvironment.kt',
  ),
  'utf8',
);
assert.match(cli, /glibc archive SHA-256 mismatch/);
assert.match(cli, /requiredLoaderSha256/);
assert.match(cli, /replaceSymlink\(loaderLink, launcher\)/);
assert.match(cli, /delete environment\.LD_PRELOAD/);
assert.match(cli, /environment\.ADEV_ENV_AUTOFILL = '0'/);
assert.match(cli, /if \(stagedInstalled && fs\.existsSync\(glibcRoot\)\) safeRemove\(glibcRoot\)/);
assert.match(cli, /refusing to remove path outside the glibc runtime/);
assert.doesNotMatch(cli, /\/system\/bin\/linker64/);
assert.match(environment, /MOBILEIDE_GLIBC_LOADER/);
assert.match(environment, /MOBILEIDE_GLIBC_LAUNCHER/);
assert.match(environment, /deliberately not added to PATH or/);

process.stdout.write(
  `ADEV glibc host checks passed: glibc ${selected.glibcVersion}, ` +
    `${selected.installedBytes} installed bytes, ${selected.bytes} compressed bytes.\n`,
);
