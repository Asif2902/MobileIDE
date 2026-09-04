import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);

const root = path.resolve(import.meta.dirname, '..');
const indexPath = path.join(root, 'release', 'adev-linux-index.json');
const embeddedIndexPath = path.join(
  root,
  'android/app/src/main/assets/runtime/lib/adev-linux.json',
);
const cliPath = path.join(
  root,
  'android/app/src/main/assets/runtime/lib/adev-runtime-cli.js',
);
const execCompatPath = path.join(
  root,
  'android/app/src/main/cpp/adev_exec_compat.c',
);
const npmCompatPath = path.join(
  root,
  'android/app/src/main/assets/runtime/lib/adev-linux-npm.js',
);
const npmDispatcherPath = path.join(
  root,
  'android/app/src/main/assets/runtime/lib/adev-npm.js',
);
const envLauncherPath = path.join(root, 'android/app/src/main/cpp/adev_env.cpp');
const linuxCompatPath = path.join(
  root,
  'android/app/src/main/cpp/adev_linux_compat.c',
);
const guestCompatibilityPath = path.join(
  root,
  'android/app/src/main/java/com/mobileide/app/runtime/LinuxGuestCompatibility.kt',
);

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function inspectElf(bytes) {
  assert.deepEqual([...bytes.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
  assert.equal(bytes[4], 2, 'ELF must be 64-bit');
  assert.equal(bytes[5], 1, 'ELF must be little-endian');
  const type = bytes.readUInt16LE(16);
  const machine = bytes.readUInt16LE(18);
  const programOffset = Number(bytes.readBigUInt64LE(32));
  const programSize = bytes.readUInt16LE(54);
  const programCount = bytes.readUInt16LE(56);
  let interpreter = null;
  let executableLoad = false;
  for (let index = 0; index < programCount; index += 1) {
    const offset = programOffset + index * programSize;
    const kind = bytes.readUInt32LE(offset);
    const flags = bytes.readUInt32LE(offset + 4);
    if (kind === 1 && (flags & 1)) executableLoad = true;
    if (kind !== 3) continue;
    const fileOffset = Number(bytes.readBigUInt64LE(offset + 8));
    const fileSize = Number(bytes.readBigUInt64LE(offset + 32));
    interpreter = bytes.subarray(fileOffset, fileOffset + fileSize - 1).toString('utf8');
  }
  return {type, machine, interpreter, executableLoad};
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const embedded = JSON.parse(fs.readFileSync(embeddedIndexPath, 'utf8'));
assert.deepEqual(embedded, index);
assert.equal(index.schemaVersion, 1);
assert.equal(index.id, 'adev-linux');
assert.equal(index.channel, 'stable');
const selected = index.packages.aarch64;
assert.equal(selected.version, '1.2.0');
assert.equal(selected.backend, 'qemu-aarch64');
assert.equal(selected.backendVersion, '11.0.3');
assert.match(selected.archive, /^https:\/\/github\.com\/Asif2902\/MobileIDE\/releases\//);
assert.ok(selected.bytes < 12 * 1024 * 1024, 'compressed runtime must stay below 12 MiB');
assert.ok(selected.installedBytes < 25 * 1024 * 1024, 'installed runtime must stay below 25 MiB');

const archivePath = path.join(
  root,
  'release/linux',
  `adev-linux-aarch64-v${selected.version}.tar.gz`,
);
const archiveBytes = fs.readFileSync(archivePath);
assert.equal(archiveBytes.length, selected.bytes);
assert.equal(sha256(archiveBytes), selected.sha256);
assert.equal(
  fs.readFileSync(`${archivePath}.sha256`, 'utf8').trim(),
  `${selected.sha256}  ${path.basename(archivePath)}`,
);

const list = spawnSync('tar', ['-tzf', archivePath], {cwd: root, encoding: 'utf8'});
assert.equal(list.status, 0, list.stderr);
for (const required of [
  'linux/manifest.json',
  'linux/bin/qemu-aarch64',
  'linux/probes/static-aarch64',
  'linux/probes/busybox-static',
  'linux/probes/openssl',
  'linux/rootfs/lib/ld-musl-aarch64.so.1',
  'linux/rootfs/usr/lib/libssl.so.3',
  'linux/rootfs/usr/lib/libcrypto.so.3',
  'linux/rootfs/etc/ssl/openssl.cnf',
]) assert.match(list.stdout, new RegExp(required.replaceAll('.', '\\.')));
assert.doesNotMatch(list.stdout, /^linux\/usr\//m);

const validateArchive = spawnSync(
  process.execPath,
  ['-e', `require(${JSON.stringify(cliPath)}).validateLinuxArchive(${JSON.stringify(archivePath)})`],
  {cwd: root, encoding: 'utf8'},
);
assert.equal(validateArchive.status, 0, validateArchive.stderr);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-linux-host-'));
try {
  const extract = spawnSync('tar', ['-xzf', archivePath, '-C', stage], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(extract.status, 0, extract.stderr);
  const linuxRoot = path.join(stage, 'linux');
  const qemu = inspectElf(fs.readFileSync(path.join(linuxRoot, 'bin/qemu-aarch64')));
  assert.deepEqual(qemu, {
    type: 3,
    machine: 183,
    interpreter: '/system/bin/linker64',
    executableLoad: true,
  });
  const probe = inspectElf(fs.readFileSync(path.join(linuxRoot, 'probes/static-aarch64')));
  assert.deepEqual(probe, {
    type: 2,
    machine: 183,
    interpreter: null,
    executableLoad: true,
  });
  const busybox = inspectElf(fs.readFileSync(path.join(linuxRoot, 'probes/busybox-static')));
  assert.equal(busybox.machine, 183);
  assert.equal(busybox.interpreter, null);
  const openssl = inspectElf(fs.readFileSync(path.join(linuxRoot, 'probes/openssl')));
  assert.equal(openssl.machine, 183);
  assert.equal(openssl.interpreter, '/lib/ld-musl-aarch64.so.1');
  const npmCompat = require(npmCompatPath);
  assert.deepEqual(npmCompat.targetFromAlias('npm:@scope/tool@1.2.3-linux-arm64'), {
    name: '@scope/tool',
    version: '1.2.3-linux-arm64',
  });
  assert.equal(npmCompat.targetFromAlias('latest'), null);
  assert.equal(
    npmCompat.inspectElf(path.join(linuxRoot, 'probes/static-aarch64')).kind,
    'static',
  );
  assert.equal(npmCompat.inspectElf(path.join(linuxRoot, 'bin/qemu-aarch64')).kind, 'android');
  assert.equal(
    npmCompat.validPlatformPackage({os: ['linux'], cpu: ['arm64']}),
    true,
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(linuxRoot, 'manifest.json'), 'utf8'));
  require(cliPath).verifyLinuxPayload(linuxRoot, selected, 'aarch64');
  assert.equal(manifest.architecture, 'aarch64');
  assert.equal(manifest.backend.name, selected.backend);
  assert.equal(manifest.backend.version, selected.backendVersion);
  for (const entry of manifest.files) {
    const file = path.join(linuxRoot, ...entry.path.split('/'));
    assert.equal(sha256(fs.readFileSync(file)), entry.sha256, entry.path);
  }
} finally {
  fs.rmSync(stage, {recursive: true, force: true});
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-linux-list-'));
try {
  const listRuntime = spawnSync(process.execPath, [cliPath, 'runtime', 'list', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: {...process.env, PREFIX: fixture, ADEV_RUNTIME: fixture},
  });
  assert.equal(listRuntime.status, 0, listRuntime.stderr);
  const report = JSON.parse(listRuntime.stdout);
  assert.deepEqual(report.runtimes.map(runtime => runtime.id), [
    'node', 'python', 'git', 'glibc', 'linux',
  ]);
  assert.equal(report.runtimes.at(-1).installed, false);
} finally {
  fs.rmSync(fixture, {recursive: true, force: true});
}

const source = fs.readFileSync(execCompatPath, 'utf8');
const npmCompatSource = fs.readFileSync(npmCompatPath, 'utf8');
const npmDispatcherSource = fs.readFileSync(npmDispatcherPath, 'utf8');
const envLauncherSource = fs.readFileSync(envLauncherPath, 'utf8');
const linuxCompatSource = fs.readFileSync(linuxCompatPath, 'utf8');
const guestCompatibilitySource = fs.readFileSync(guestCompatibilityPath, 'utf8');
assert.match(source, /adev_inspect_elf/);
assert.match(source, /ADEV_ELF_LINUX_STATIC/);
assert.match(source, /adev runtime install linux/);
assert.match(source, /adev runtime install glibc/);
assert.match(source, /-U/);
assert.match(source, /LD_PRELOAD/);
assert.match(source, /liblib_adev_linux_compat\.so/);
assert.match(source, /ADEV_LINUX_TRACE/);
assert.match(source, /emulator_argv\[output\+\+\] = "-L"/);
assert.match(source, /TERMUX_EXEC__PROC_SELF_EXE/);
assert.match(source, /TERMUX_EXEC__PROC_SELF_INTERPRETER/);
assert.match(source, /\/system\/bin\/linker64/);
assert.doesNotMatch(source, /muse|@openai\/codex|codex-linux-arm64/i);
assert.match(npmCompatSource, /parent\.optionalDependencies/);
assert.match(npmCompatSource, /linux-\(\?:arm64\|aarch64\)/);
assert.match(npmCompatSource, /payload\.nativeAddon/);
assert.match(npmCompatSource, /--ignore-scripts/);
assert.doesNotMatch(npmCompatSource, /muse|@openai\/codex|codex-linux-arm64/i);
assert.match(npmDispatcherSource, /require\(linuxCompat\)/);
assert.match(npmDispatcherSource, /stdio: 'inherit'/);
assert.match(envLauncherSource, /runtime_file\("lib\/adev-npm\.js"\)/);
assert.match(envLauncherSource, /SYS_readlinkat/);
assert.match(envLauncherSource, /actual_self_executable/);
assert.doesNotMatch(npmDispatcherSource, /muse|@openai\/codex|codex-linux-arm64/i);
assert.match(fs.readFileSync(cliPath, 'utf8'), /runtimeDoctor/);
assert.match(fs.readFileSync(cliPath, 'utf8'), /dnsSource/);
assert.match(fs.readFileSync(cliPath, 'utf8'), /-verify_hostname/);
assert.match(fs.readFileSync(cliPath, 'utf8'), /hostSeccompSyscalls/);
assert.deepEqual(
  require(cliPath).processResult({
    status: 0,
    stderr: 'ADEV linux: Android seccomp blocked host syscall 293; returned ENOSYS\n',
    stdout: '',
  }, Date.now()).hostSeccompSyscalls,
  [293],
);
assert.match(linuxCompatSource, /__NR_setgid/);
assert.match(linuxCompatSource, /__NR_setuid/);
assert.match(linuxCompatSource, /permission_denied/);
assert.match(linuxCompatSource, /SYS_SECCOMP/);
assert.match(linuxCompatSource, /returned ENOSYS/);
assert.match(linuxCompatSource, /info->si_syscall/);
assert.doesNotMatch(linuxCompatSource, /muse|codex|grok/i);
assert.match(guestCompatibilitySource, /activeDnsServers/);
assert.match(guestCompatibilitySource, /dnsResponseIsSafe/);
assert.match(guestCompatibilitySource, /verified-fallback/);
assert.match(guestCompatibilitySource, /network\?\.bindSocket\(socket\)/);
assert.doesNotMatch(guestCompatibilitySource, /auth\.openai|auth\.x\.ai|muse/i);

process.stdout.write(
  `ADEV linux runtime checks passed: ${selected.backend} ${selected.backendVersion}, ` +
    `${selected.installedBytes} installed bytes, ${selected.bytes} compressed bytes.\n`,
);
