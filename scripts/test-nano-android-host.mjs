import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromRoot = relative => path.join(root, relative);
const read = relative => fs.readFileSync(fromRoot(relative));
const text = relative => read(relative).toString('utf8');
const json = relative => JSON.parse(text(relative));
const sha256 = value =>
  crypto.createHash('sha256').update(value).digest('hex');
const fileSha256 = relative => sha256(read(relative));

function treeDigest(relativeRoot) {
  const absoluteRoot = fromRoot(relativeRoot);
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const content = fs.readFileSync(absolute);
        files.push({
          relative: path.relative(absoluteRoot, absolute).split(path.sep).join('/'),
          bytes: content.length,
          sha256: sha256(content),
        });
      }
    }
  }
  walk(absoluteRoot);
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  const listing = files
    .map(file => `${file.relative}\t${file.bytes}\t${file.sha256}\n`)
    .join('');
  return {
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    treeSha256: sha256(Buffer.from(listing)),
  };
}

const manifestPath = 'android/app/src/main/assets/runtime/lib/adev-nano.json';
const nativePath =
  'android/app/src/main/jniLibs/arm64-v8a/libbin_nano.so';
const manifest = json(manifestPath);
const nativeMap = json('android/app/src/main/assets/runtime/native-map.json');
const lock = json('android/app/src/main/assets/runtime/runtime-lock.json');
const provenance = json('release/runtime-provenance.json');
const licenses = json('release/third-party-licenses.json');

assert.equal(manifest.package, 'nano');
assert.equal(manifest.version, '9.2');
assert.equal(manifest.platform, 'android-bionic');
assert.deepEqual(manifest.supportedAbis, ['arm64-v8a']);
assert.match(manifest.unsupportedAbis.x86_64, /No pinned and verified/);
assert.equal(manifest.source.signatureVerified, true);
assert.equal(
  manifest.source.signingKeyFingerprint,
  'CC72CF8BA7DBFA0182877D045A897D96E57CF20C',
);
assert.equal(
  manifest.source.nanoArchiveSha256,
  '59de33ebd2774625d8d8fd7855307a2d9e0bfdea45b9f5b1e95e78d8a5801fb4',
);
assert.equal(
  manifest.source.ncursesArchiveSha256,
  'f44bbfdc3d42ec0217bffa978309390e59cea5a48a9a83226d4a496c42ad0b99',
);
assert.equal(manifest.runtime.interpreter, '/system/bin/linker64');
assert.equal(manifest.runtime.minimumLoadAlignment, 16384);
assert.deepEqual(manifest.runtime.needed, [
  'libandroid-support.so',
  'libncursesw.so.6',
  'libc.so',
]);

const executable = manifest.components.find(
  component => component.packagedName === 'libbin_nano.so',
);
assert.ok(executable);
assert.equal(executable.sha256, fileSha256(nativePath));
assert.equal(executable.bytes, fs.statSync(fromRoot(nativePath)).size);
assert.equal(
  executable.sha256,
  'ee689aa27847d10a91a596e90590070c046b4f829f875a4e4ec71a25f8ad7682',
);
assert.equal(nativeMap['bin/nano'], 'libbin_nano.so');
assert.ok(
  !fs.existsSync(
    fromRoot('android/app/src/main/jniLibs/x86_64/libbin_nano.so'),
  ),
  'Nano must remain an explicit x86_64 capability boundary',
);

const arm64 = 'android/app/src/main/jniLibs/arm64-v8a';
assert.equal(
  fileSha256(`${arm64}/liblib_libandroid_support_so.so`),
  '739cf829511d71dafd6c67fdbb70f3f0c6048642ea2e1967790ee961fde14430',
);
assert.equal(
  fileSha256(`${arm64}/liblib_libncursesw_so_6.so`),
  '795f855f5a988d9e89116847b2c9aa03720cedbc02026259ca735be25398c4c5',
);
assert.equal(
  nativeMap['lib/libandroid-support.so'],
  'liblib_libandroid_support_so.so',
);
assert.equal(
  nativeMap['lib/libncursesw.so.6'],
  'liblib_libncursesw_so_6.so',
);

const syntax = treeDigest('android/app/src/main/assets/runtime/share/nano');
assert.deepEqual(syntax, {
  files: 44,
  bytes: 55036,
  treeSha256:
    '9ef9463f09be6a7868179f3f4f352374c51dcfa35ea7720f1d637afe65583370',
});
const terminfo = treeDigest(
  'android/app/src/main/assets/runtime/share/terminfo',
);
assert.deepEqual(terminfo, {
  files: 40,
  bytes: 105154,
  treeSha256:
    '2f91f3649f9d2a1bb73b32b976d256268b2c55eb085c49d39ffb6ec27a4c317f',
});
assert.equal(
  fileSha256(
    'android/app/src/main/assets/runtime/share/terminfo/x/xterm-256color',
  ),
  'd99d67da666c615e66948bf5998e2f0b90db569dc4a3fed13cabd7dfd5a91aa9',
);
assert.equal(
  fileSha256('android/app/src/main/assets/runtime/etc/nanorc.termux'),
  'bbdb6ef791eb8648576d48276b2e8862cdbf5534af6fb580a06d794a6d65bb9e',
);
assert.equal(
  fileSha256('android/app/src/main/assets/runtime/share/licenses/nano/COPYING'),
  'ab8264ecf333be0367fe48cbef3b3434122bc4622e7dbb98b308dd45125c56e8',
);
assert.equal(
  fileSha256(
    'android/app/src/main/assets/runtime/share/licenses/ncurses/COPYRIGHT',
  ),
  '708999f95527e1ffa670c6fce288c6c600cb477dd04afcc1171422b3dd4ee226',
);

const sdk =
  process.env.ANDROID_SDK_ROOT ??
  process.env.ANDROID_HOME ??
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? '', 'Android/Sdk')
    : path.join(os.homedir(), 'Android/Sdk'));
const binaryName = process.platform === 'win32' ? 'llvm-readelf.exe' : 'llvm-readelf';
const prebuiltRoot = path.join(
  sdk,
  'ndk',
  '29.0.14206865',
  'toolchains',
  'llvm',
  'prebuilt',
);
const prebuilt = fs.readdirSync(prebuiltRoot, {withFileTypes: true}).find(entry =>
  fs.existsSync(path.join(prebuiltRoot, entry.name, 'bin', binaryName)),
);
assert.ok(prebuilt, `NDK r29 llvm-readelf missing under ${prebuiltRoot}`);
const readelf = path.join(prebuiltRoot, prebuilt.name, 'bin', binaryName);
const elf = execFileSync(readelf, ['-hlWd', fromRoot(nativePath)], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
assert.match(elf, /Type:\s+DYN\b/);
assert.match(elf, /Requesting program interpreter: \/system\/bin\/linker64/);
assert.doesNotMatch(elf, /ld-linux|GLIBC_/);
const needed = [...elf.matchAll(/Shared library: \[([^\]]+)\]/g)].map(
  match => match[1],
);
assert.deepEqual(needed, manifest.runtime.needed);
const alignments = elf
  .split(/\r?\n/)
  .filter(line => /^\s*LOAD/.test(line))
  .map(line => Number.parseInt(line.trim().split(/\s+/).at(-1), 16));
assert.ok(alignments.length > 0);
assert.ok(Math.min(...alignments) >= 0x4000);

assert.equal(lock.nano.sha256, fileSha256(manifestPath));
assert.equal(lock.nano.version, '9.2');
assert.ok(
  lock.abis['arm64-v8a'].nativeFiles.some(
    file => file.packagedName === 'libbin_nano.so' && file.sha256 === executable.sha256,
  ),
);
assert.ok(
  !lock.abis.x86_64.nativeFiles.some(file => file.packagedName === 'libbin_nano.so'),
);
assert.equal(
  crypto.verify(
    null,
    read('android/app/src/main/assets/runtime/runtime-lock.json'),
    read('android/app/src/main/assets/runtime/runtime-lock.pub.pem'),
    read('android/app/src/main/assets/runtime/runtime-lock.sig'),
  ),
  true,
);

const runtime = text(
  'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
);
assert.match(runtime, /setupNanoConfiguration\(\)/);
assert.match(runtime, /if \(!userNanorc\.exists\(\)\)/);
assert.match(runtime, /"TERMINFO" to File\(runtimeRoot, "share\/terminfo"\)/);
assert.match(runtime, /nano\(\) \{ \\"\$\{nano\.absolutePath\}\\"/);
assert.match(runtime, /writeScript\("nano"/);
assert.match(runtime, /MOBILEIDE_NANO/);
const processManager = text(
  'android/app/src/main/java/com/mobileide/app/process/ProcessManager.kt',
);
assert.match(processManager, /"nano" to "libbin_nano\.so"/);
const doctor = text('android/app/src/main/assets/runtime/lib/adev-doctor.js');
assert.match(doctor, /MOBILEIDE_NANO/);
assert.match(doctor, /terminfoEntries/);
assert.match(doctor, /Nano is not bundled for x86_64/);

const artifact = provenance.artifacts.find(
  candidate => candidate.packagedName === 'libbin_nano.so',
);
assert.deepEqual(artifact.needed, manifest.runtime.needed);
assert.equal(artifact.sha256, executable.sha256);
assert.equal(artifact.metadataStatus, 'exact');
const licensedArtifact = licenses.runtimeArtifacts.find(
  candidate =>
    candidate.abi === 'arm64-v8a' && candidate.name === 'libbin_nano.so',
);
assert.equal(licensedArtifact.package, 'nano');
assert.equal(licensedArtifact.version, '9.2');
assert.equal(licensedArtifact.license, 'GPL-3.0-only');
assert.equal(licensedArtifact.metadataStatus, 'exact');
for (const runtimePath of [
  'etc/nanorc.termux',
  'share/nano',
  'share/terminfo',
  'share/licenses/nano/COPYING',
  'share/licenses/ncurses/COPYRIGHT',
]) {
  assert.ok(
    licenses.bundledRuntimeData.some(record => record.name === runtimePath),
    `${runtimePath} is absent from the license/provenance inventory`,
  );
}

const fetchScript = text('scripts/fetch-nano-android.ps1');
assert.match(fetchScript, /gpgv/);
assert.match(fetchScript, /CC72CF8BA7DBFA0182877D045A897D96E57CF20C/);
assert.match(fetchScript, /59de33ebd2774625d8d8fd7855307a2d9e0bfdea45b9f5b1e95e78d8a5801fb4/);
assert.match(fetchScript, /f44bbfdc3d42ec0217bffa978309390e59cea5a48a9a83226d4a496c42ad0b99/);

process.stdout.write(
  'Nano Android host checks passed: signed Termux provenance, exact ARM64/Bionic ELF closure, 16 KiB alignment, runtime data/config, ABI boundary, and signed lock.\n',
);
