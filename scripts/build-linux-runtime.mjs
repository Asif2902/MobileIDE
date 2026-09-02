import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts', 'linux-runtime-sources.json'), 'utf8'),
);
const packVersion = '1.2.0';
const architecture = 'aarch64';
const releaseDir = path.join(root, 'release', 'linux');
const termuxPrefix = 'data/data/com.termux/files/usr';
const systemLibraries = new Set([
  'libandroid.so',
  'libc.so',
  'libdl.so',
  'liblog.so',
  'libm.so',
]);

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function download(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {'user-agent': 'ADEV-linux-runtime-builder/1'},
  });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function readCString(bytes, offset, limit) {
  if (offset < 0 || offset >= bytes.length || offset >= limit) return null;
  let end = offset;
  while (end < bytes.length && end < limit && bytes[end] !== 0) end += 1;
  if (end === limit || end === bytes.length) return null;
  return bytes.toString('utf8', offset, end);
}

function parseElf(bytes) {
  if (
    bytes.length < 64 ||
    bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46 ||
    bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 183
  ) return null;
  const type = bytes.readUInt16LE(16);
  const entry = bytes.readBigUInt64LE(24);
  const phoff = Number(bytes.readBigUInt64LE(32));
  const phentsize = bytes.readUInt16LE(54);
  const phnum = bytes.readUInt16LE(56);
  if (phentsize < 56 || phnum > 1024 || phoff + phentsize * phnum > bytes.length) return null;
  const loads = [];
  let dynamic = null;
  let interpreter = null;
  let executableLoad = false;
  for (let index = 0; index < phnum; index += 1) {
    const offset = phoff + index * phentsize;
    const kind = bytes.readUInt32LE(offset);
    const flags = bytes.readUInt32LE(offset + 4);
    const fileOffset = Number(bytes.readBigUInt64LE(offset + 8));
    const virtualAddress = bytes.readBigUInt64LE(offset + 16);
    const fileSize = Number(bytes.readBigUInt64LE(offset + 32));
    if (fileOffset + fileSize > bytes.length) return null;
    if (kind === 1) {
      loads.push({fileOffset, virtualAddress, fileSize});
      if ((flags & 1) !== 0) executableLoad = true;
    } else if (kind === 2) {
      dynamic = {fileOffset, fileSize};
    } else if (kind === 3) {
      interpreter = readCString(bytes, fileOffset, fileOffset + fileSize);
    }
  }
  const neededOffsets = [];
  let stringAddress = null;
  let stringSize = 0;
  let sonameOffset = null;
  if (dynamic) {
    for (let offset = dynamic.fileOffset; offset + 16 <= dynamic.fileOffset + dynamic.fileSize; offset += 16) {
      const tag = bytes.readBigInt64LE(offset);
      const value = bytes.readBigUInt64LE(offset + 8);
      if (tag === 0n) break;
      if (tag === 1n) neededOffsets.push(Number(value));
      else if (tag === 5n) stringAddress = value;
      else if (tag === 10n) stringSize = Number(value);
      else if (tag === 14n) sonameOffset = Number(value);
    }
  }
  let stringOffset = null;
  if (stringAddress !== null) {
    const load = loads.find(segment =>
      stringAddress >= segment.virtualAddress &&
      stringAddress < segment.virtualAddress + BigInt(segment.fileSize),
    );
    if (load) stringOffset = load.fileOffset + Number(stringAddress - load.virtualAddress);
  }
  const stringsEnd = stringOffset === null ? 0 : Math.min(bytes.length, stringOffset + stringSize);
  const needed = stringOffset === null
    ? []
    : neededOffsets.map(value => readCString(bytes, stringOffset + value, stringsEnd)).filter(Boolean);
  const soname = stringOffset === null || sonameOffset === null
    ? null
    : readCString(bytes, stringOffset + sonameOffset, stringsEnd);
  return {type, entry, interpreter, executableLoad, needed, soname};
}

function staticProbe() {
  const message = Buffer.from('adev-linux-static-ok\n');
  const codeWords = [
    0xd2800020, // mov x0, #1 (stdout)
    0xd2802481, // mov x1, #0x124
    0xf2a00801, // movk x1, #0x40, lsl #16 -> 0x400124
    0xd28002a2, // mov x2, #21
    0xd2800808, // mov x8, #64 (write)
    0xd4000001, // svc #0
    0xd2800000, // mov x0, #0
    0xd2800ba8, // mov x8, #93 (exit)
    0xd4000001, // svc #0
  ];
  const bytes = Buffer.alloc(0x100 + codeWords.length * 4 + message.length);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(bytes, 0);
  bytes.writeUInt16LE(2, 16); // ET_EXEC
  bytes.writeUInt16LE(183, 18); // EM_AARCH64
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(0x400100n, 24);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt32LE(1, 64); // PT_LOAD
  bytes.writeUInt32LE(5, 68); // PF_R | PF_X
  bytes.writeBigUInt64LE(0n, 72);
  bytes.writeBigUInt64LE(0x400000n, 80);
  bytes.writeBigUInt64LE(0x400000n, 88);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 96);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 104);
  bytes.writeBigUInt64LE(0x10000n, 112);
  codeWords.forEach((word, index) => bytes.writeUInt32LE(word, 0x100 + index * 4));
  message.copy(bytes, 0x100 + codeWords.length * 4);
  return bytes;
}

function extractDeb(deb, destination) {
  const arRoot = path.join(destination, 'ar');
  fs.mkdirSync(arRoot, {recursive: true});
  run('tar', ['-xf', deb, '-C', arRoot]);
  const data = fs.readdirSync(arRoot).find(name => /^data\.tar\./.test(name));
  if (!data) throw new Error(`Debian package has no data archive: ${deb}`);
  return path.join(arRoot, data);
}

function archiveEntry(archive, entry) {
  const result = spawnSync('tar', ['-xOf', archive, entry], {
    cwd: root,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function walk(rootDirectory) {
  const result = [];
  if (!fs.existsSync(rootDirectory)) return result;
  for (const entry of fs.readdirSync(rootDirectory, {withFileTypes: true})) {
    const file = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) result.push(...walk(file));
    else result.push(file);
  }
  return result;
}

async function main() {
  if (sources.architecture !== architecture) throw new Error('linux source architecture mismatch');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-linux-pack-'));
  try {
    const candidates = new Map();
    let qemuBytes = null;
    for (const [name, version, filename, expectedHash, expectedBytes] of sources.packages) {
      const packageRoot = path.join(work, 'packages', name.replace(/[^a-z0-9_.+-]/gi, '_'));
      fs.mkdirSync(packageRoot, {recursive: true});
      const deb = path.join(packageRoot, 'package.deb');
      const url = new URL(filename.replace(/:/g, '%3A'), sources.repository).href;
      const bytes = await download(url);
      if (bytes.length !== expectedBytes || sha256(bytes) !== expectedHash) {
        throw new Error(`upstream package verification failed: ${name}@${version}`);
      }
      fs.writeFileSync(deb, bytes);
      const dataArchive = extractDeb(deb, packageRoot);
      const entries = String(run('tar', ['-tf', dataArchive])).split(/\r?\n/).filter(Boolean);
      const qemuEntry = entries.find(entry =>
        entry.replace(/^\.\//, '') === `${termuxPrefix}/bin/qemu-aarch64`,
      );
      if (name === 'qemu-user-aarch64') {
        qemuBytes = qemuEntry ? archiveEntry(dataArchive, qemuEntry) : null;
        if (!qemuBytes?.length) throw new Error('qemu-aarch64 payload is missing');
      }
      for (const candidate of entries) {
        const normalized = candidate.replace(/^\.\//, '');
        if (!normalized.startsWith(`${termuxPrefix}/lib/`) || !path.basename(normalized).includes('.so')) {
          continue;
        }
        const payload = archiveEntry(dataArchive, candidate);
        if (!payload?.length) continue; // symlink; the real file supplies DT_SONAME.
        const elf = parseElf(payload);
        if (!elf) continue;
        const record = {path: normalized, payload, elf, package: {name, version, filename, sha256: expectedHash}};
        candidates.set(path.basename(normalized), record);
        if (elf.soname) candidates.set(elf.soname, record);
      }
    }
    if (!qemuBytes) throw new Error('qemu-aarch64 payload was not selected');
    const qemuElf = parseElf(qemuBytes);
    if (!qemuElf || qemuElf.type !== 3 || qemuElf.interpreter !== '/system/bin/linker64') {
      throw new Error('qemu-aarch64 is not an Android/Bionic PIE executable');
    }

    const stageRoot = path.join(work, 'stage');
    const linuxRoot = path.join(stageRoot, 'linux');
    const bin = path.join(linuxRoot, 'bin');
    const lib = path.join(linuxRoot, 'lib');
    fs.mkdirSync(bin, {recursive: true});
    fs.mkdirSync(lib, {recursive: true});
    fs.writeFileSync(path.join(bin, 'qemu-aarch64'), qemuBytes);
    fs.chmodSync(path.join(bin, 'qemu-aarch64'), 0o755);

    const queue = [...qemuElf.needed];
    const installed = new Set();
    const selectedPackages = new Map();
    selectedPackages.set('qemu-user-aarch64', sources.packages.find(entry => entry[0] === 'qemu-user-aarch64'));
    while (queue.length) {
      const needed = queue.shift();
      if (installed.has(needed) || systemLibraries.has(needed)) continue;
      const source = candidates.get(needed);
      if (!source) throw new Error(`unresolved qemu library dependency: ${needed}`);
      fs.writeFileSync(path.join(lib, needed), source.payload, {mode: 0o644});
      installed.add(needed);
      selectedPackages.set(source.package.name, sources.packages.find(entry => entry[0] === source.package.name));
      queue.push(...source.elf.needed);
    }

    const muslBytes = await download(sources.musl.url);
    if (muslBytes.length !== sources.musl.bytes || sha256(muslBytes) !== sources.musl.sha256) {
      throw new Error('Alpine musl package verification failed');
    }
    const muslArchive = path.join(work, 'musl.apk');
    fs.writeFileSync(muslArchive, muslBytes);
    const muslLoader = spawnSync('tar', ['-xOzf', muslArchive, 'lib/ld-musl-aarch64.so.1'], {
      cwd: root,
      encoding: null,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (muslLoader.status !== 0 || !parseElf(muslLoader.stdout)) {
      throw new Error(`could not extract verified musl loader: ${String(muslLoader.stderr).trim()}`);
    }
    const guestLib = path.join(linuxRoot, 'rootfs', 'lib');
    fs.mkdirSync(guestLib, {recursive: true});
    for (const name of ['ld-musl-aarch64.so.1', 'libc.musl-aarch64.so.1']) {
      fs.writeFileSync(path.join(guestLib, name), muslLoader.stdout, {mode: 0o755});
    }

    const probeDir = path.join(linuxRoot, 'probes');
    fs.mkdirSync(probeDir, {recursive: true});
    fs.writeFileSync(path.join(probeDir, 'static-aarch64'), staticProbe(), {mode: 0o755});

    // A small, statically linked guest utility provides real DNS, TCP and TLS
    // probes for `adev runtime doctor` without adding a Linux distribution to
    // the APK. It remains part of the independently downloadable runtime pack.
    const busyboxBytes = await download(sources.busyboxStatic.url);
    if (busyboxBytes.length !== sources.busyboxStatic.bytes ||
        sha256(busyboxBytes) !== sources.busyboxStatic.sha256) {
      throw new Error('Alpine busybox-static package verification failed');
    }
    const busyboxArchive = path.join(work, 'busybox-static.apk');
    fs.writeFileSync(busyboxArchive, busyboxBytes);
    const busybox = spawnSync(
      'tar',
      ['-xOzf', busyboxArchive, sources.busyboxStatic.entry],
      {cwd: root, encoding: null, maxBuffer: 4 * 1024 * 1024},
    );
    const busyboxElf = busybox.status === 0 ? parseElf(busybox.stdout) : null;
    if (!busyboxElf || busyboxElf.interpreter !== null) {
      throw new Error(`could not extract verified static BusyBox: ${String(busybox.stderr).trim()}`);
    }
    fs.writeFileSync(path.join(probeDir, 'busybox-static'), busybox.stdout, {mode: 0o755});

    // BusyBox can exercise DNS and TCP but its Alpine static build explicitly
    // does not validate TLS certificates. Keep a small, verified musl OpenSSL
    // client in the optional pack so doctor tests the same CA contract real
    // Linux CLIs depend on instead of reporting a false-positive HTTPS pass.
    for (const packageSpec of sources.opensslProbe.packages) {
      const packageBytes = await download(packageSpec.url);
      if (packageBytes.length !== packageSpec.bytes || sha256(packageBytes) !== packageSpec.sha256) {
        throw new Error(`Alpine OpenSSL probe package verification failed: ${packageSpec.name}`);
      }
      const packageArchive = path.join(work, `${packageSpec.name}.apk`);
      fs.writeFileSync(packageArchive, packageBytes);
      for (const [entry, destination, modeText] of packageSpec.files) {
        const extracted = spawnSync('tar', ['-xOzf', packageArchive, entry], {
          cwd: root,
          encoding: null,
          maxBuffer: 8 * 1024 * 1024,
        });
        if (extracted.status !== 0 || !extracted.stdout?.length) {
          throw new Error(
            `could not extract verified OpenSSL probe file ${entry}: ${String(extracted.stderr).trim()}`,
          );
        }
        const output = path.join(linuxRoot, ...destination.split('/'));
        fs.mkdirSync(path.dirname(output), {recursive: true});
        fs.writeFileSync(output, extracted.stdout, {mode: Number.parseInt(modeText, 8)});
      }
    }
    const opensslElf = parseElf(fs.readFileSync(path.join(probeDir, 'openssl')));
    if (
      !opensslElf || opensslElf.interpreter !== '/lib/ld-musl-aarch64.so.1' ||
      !opensslElf.needed.includes('libssl.so.3') || !opensslElf.needed.includes('libcrypto.so.3')
    ) {
      throw new Error('verified OpenSSL probe has an unexpected ELF contract');
    }

    const inventory = walk(linuxRoot)
      .filter(file => fs.statSync(file).isFile())
      .map(file => ({
        path: path.relative(linuxRoot, file).split(path.sep).join('/'),
        sha256: sha256(fs.readFileSync(file)),
        bytes: fs.statSync(file).size,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const installedBytes = inventory.reduce((sum, file) => sum + file.bytes, 0);
    const manifest = {
      schemaVersion: 1,
      id: 'adev-linux',
      version: packVersion,
      architecture,
      platform: 'linux-user-on-android',
      delivery: 'optional-runtime-pack',
      defaultRuntime: false,
      backend: {name: 'qemu-aarch64', version: '11.0.3', mode: 'linux-user'},
      guestLibraries: {musl: sources.musl.version},
      diagnostics: {
        busyboxStatic: sources.busyboxStatic.version,
        openssl: sources.opensslProbe.version,
      },
      files: inventory,
      upstream: {
        termuxRepository: sources.repository,
        packages: [...selectedPackages.values()].map(([name, version, filename, hash, bytes]) => ({
          name, version, filename, sha256: hash, bytes,
        })),
        musl: sources.musl,
        busyboxStatic: sources.busyboxStatic,
        opensslProbe: sources.opensslProbe,
      },
      installedBytes,
    };
    fs.writeFileSync(path.join(linuxRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    fs.mkdirSync(releaseDir, {recursive: true});
    const archiveName = `adev-linux-${architecture}-v${packVersion}.tar.gz`;
    const archivePath = path.join(releaseDir, archiveName);
    const tarPath = path.join(work, 'adev-linux-runtime.tar');
    run('tar', [
      '-cf', tarPath,
      '--format', 'ustar',
      '--mtime', '2026-09-01 00:00:00',
      '-C', stageRoot,
      'linux',
    ]);
    fs.writeFileSync(archivePath, zlib.gzipSync(fs.readFileSync(tarPath), {level: 9, mtime: 0}));
    const archiveBytes = fs.readFileSync(archivePath);
    const archiveHash = sha256(archiveBytes);
    fs.writeFileSync(`${archivePath}.sha256`, `${archiveHash}  ${archiveName}\n`);
    const index = {
      schemaVersion: 1,
      id: 'adev-linux',
      channel: 'stable',
      packages: {
        aarch64: {
          version: packVersion,
          backend: 'qemu-aarch64',
          backendVersion: '11.0.3',
          archive: `https://github.com/Asif2902/MobileIDE/releases/download/adev-linux-v${packVersion}/${archiveName}`,
          sha256: archiveHash,
          bytes: archiveBytes.length,
          installedBytes,
          minAndroidApi: 29,
        },
      },
    };
    const indexBytes = `${JSON.stringify(index, null, 2)}\n`;
    fs.writeFileSync(path.join(root, 'release', 'adev-linux-index.json'), indexBytes);
    fs.writeFileSync(
      path.join(root, 'android/app/src/main/assets/runtime/lib/adev-linux.json'),
      indexBytes,
    );
    process.stdout.write(
      `${archivePath}\nqemu=11.0.3 libraries=${installed.size} ` +
      `installed=${installedBytes} compressed=${archiveBytes.length} sha256=${archiveHash}\n`,
    );
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
}

main().catch(error => {
  process.stderr.write(`ADEV linux pack build failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
