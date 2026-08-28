import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release', 'glibc');
const prebuiltDir = path.join(
  root,
  'android',
  'app',
  'src',
  'main',
  'prebuilt',
  'arm64-v8a',
);

const packVersion = '1.0.1';
const glibcVersion = '2.44-0';
const architecture = 'aarch64';
const upstreamArchiveName = `glibc-${glibcVersion}-${architecture}.pkg.tar.xz`;
const upstreamArchiveUrl =
  `https://service.termux-pacman.dev/gpkg/${architecture}/${upstreamArchiveName}`;
const upstreamArchiveSha256 =
  '8725a20d85fa35a094cf092286295668fd5292247128c4bb8101585ba063799c';
const upstreamRoot = 'data/data/com.termux/files/usr/glibc';
const loaderRelativePath = 'lib/ld-linux-aarch64.so.1';
const upstreamLoaderSha256 =
  'ca4af7c4022222bb405b0b601d818506ea608a2242f3cce43bd0b56b71f94530';
const compiledPrefix = '/data/data/com.termux/files/usr/glibc';
const fdPrefixBase = '/proc/self/fd/255';
const fdPrefix = fdPrefixBase + '/'.repeat(compiledPrefix.length - fdPrefixBase.length);

const runtimeFiles = [
  'bin/getconf',
  'lib/libc.so.6',
  'lib/libm.so.6',
  'lib/libmvec.so.1',
  'lib/libresolv.so.2',
  'lib/libpthread.so.0',
  'lib/libdl.so.2',
  'lib/librt.so.1',
  'lib/libnss_dns.so.2',
  'lib/libnss_files.so.2',
  'lib/libutil.so.1',
  'lib/libanl.so.1',
  'lib/libBrokenLocale.so.1',
];

const generatedRuntimeFiles = {
  'etc/nsswitch.conf': 'hosts: files dns\nnetworks: files dns\n',
  'etc/hosts': '127.0.0.1 localhost\n::1 ip6-localhost ip6-loopback\n',
  'etc/host.conf': 'multi on\n',
  'etc/resolv.conf': 'nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:2 attempts:2\n',
};

const licenseSources = [
  {
    name: 'GPL-3.0.txt',
    url: 'https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-3.0-only.txt',
    sha256: 'fb981668c18a279e285fc4d83fba1e836cc84dd4daa73c9697d3cfd2d8aca6e0',
  },
  {
    name: 'LGPL-3.0.txt',
    url: 'https://raw.githubusercontent.com/spdx/license-list-data/main/text/LGPL-3.0-only.txt',
    sha256: '996af0513df21f7496288951c41428a03c174e9e4a9d63665c57d670f845ccb1',
  },
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function retargetCompiledPrefix(bytes) {
  const output = Buffer.from(bytes);
  const source = Buffer.from(compiledPrefix);
  const replacement = Buffer.from(fdPrefix);
  if (source.length !== replacement.length) {
    throw new Error('glibc prefix replacement must preserve ELF string-table offsets');
  }
  let offset = 0;
  let replacements = 0;
  while ((offset = output.indexOf(source, offset)) >= 0) {
    replacement.copy(output, offset);
    offset += replacement.length;
    replacements += 1;
  }
  return {bytes: output, replacements};
}

async function download(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {'user-agent': 'ADEV-glibc-runtime-builder/1'},
  });
  if (!response.ok) {
    throw new Error(`download failed (${response.status}): ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function runTar(args, options = {}) {
  const result = spawnSync('tar', args, {
    cwd: root,
    encoding: options.encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `tar ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function extractEntry(archive, entry) {
  const result = spawnSync('tar', ['-xOf', archive, entry], {
    cwd: root,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`missing upstream entry ${entry}: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function parseArgs() {
  const packageFlag = process.argv.indexOf('--package');
  return {
    packagePath:
      packageFlag >= 0 && process.argv[packageFlag + 1]
        ? path.resolve(process.argv[packageFlag + 1])
        : null,
  };
}

async function main() {
  const {packagePath} = parseArgs();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-glibc-pack-'));
  try {
    const upstreamArchive = path.join(work, upstreamArchiveName);
    const upstreamBytes = packagePath
      ? fs.readFileSync(packagePath)
      : await download(upstreamArchiveUrl);
    const actualUpstreamHash = sha256(upstreamBytes);
    if (actualUpstreamHash !== upstreamArchiveSha256) {
      throw new Error(
        `upstream glibc SHA-256 mismatch: expected ${upstreamArchiveSha256}, ` +
          `got ${actualUpstreamHash}`,
      );
    }
    fs.writeFileSync(upstreamArchive, upstreamBytes);

    const upstreamLoader = extractEntry(
      upstreamArchive,
      `${upstreamRoot}/${loaderRelativePath}`,
    );
    const actualUpstreamLoaderHash = sha256(upstreamLoader);
    if (actualUpstreamLoaderHash !== upstreamLoaderSha256) {
      throw new Error(
        `glibc loader SHA-256 mismatch: expected ${upstreamLoaderSha256}, ` +
          `got ${actualUpstreamLoaderHash}`,
      );
    }
    const patchedLoader = retargetCompiledPrefix(upstreamLoader);
    if (patchedLoader.replacements === 0) {
      throw new Error('glibc loader did not contain its expected compiled Termux prefix');
    }
    const loader = patchedLoader.bytes;
    const loaderSha256 = sha256(loader);

    fs.mkdirSync(prebuiltDir, {recursive: true});
    const loaderArchive = path.join(
      prebuiltDir,
      'libbin_adev_glibc_ld.so.gz',
    );
    fs.writeFileSync(loaderArchive, zlib.gzipSync(loader, {level: 9, mtime: 0}));

    const stageRoot = path.join(work, 'stage');
    const glibcRoot = path.join(stageRoot, 'glibc');
    for (const relative of runtimeFiles) {
      const extracted = extractEntry(upstreamArchive, `${upstreamRoot}/${relative}`);
      const {bytes} = retargetCompiledPrefix(extracted);
      const destination = path.join(glibcRoot, ...relative.split('/'));
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.writeFileSync(destination, bytes);
      fs.chmodSync(destination, relative.startsWith('bin/') ? 0o755 : 0o644);
    }
    for (const [relative, contents] of Object.entries(generatedRuntimeFiles)) {
      const destination = path.join(glibcRoot, ...relative.split('/'));
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.writeFileSync(destination, contents, {mode: 0o644});
    }

    const licenseDir = path.join(glibcRoot, 'share', 'licenses');
    fs.mkdirSync(licenseDir, {recursive: true});
    for (const license of licenseSources) {
      const bytes = await download(license.url);
      const actual = sha256(bytes);
      if (actual !== license.sha256) {
        throw new Error(
          `${license.name} SHA-256 mismatch: expected ${license.sha256}, got ${actual}`,
        );
      }
      fs.writeFileSync(path.join(licenseDir, license.name), bytes);
    }

    const files = [...runtimeFiles, ...Object.keys(generatedRuntimeFiles)].map(relative => {
      const file = path.join(glibcRoot, ...relative.split('/'));
      return {
        path: relative,
        sha256: sha256(fs.readFileSync(file)),
        bytes: fs.statSync(file).size,
      };
    });
    const installedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const manifest = {
      schemaVersion: 1,
      id: 'adev-glibc',
      version: packVersion,
      glibcVersion,
      architecture,
      platform: 'linux-glibc-on-android',
      delivery: 'optional-runtime-pack',
      defaultRuntime: false,
      loader: {
        runtimePath: loaderRelativePath,
        delivery: 'apk-native-exec-anchor',
        sha256: loaderSha256,
        note:
          'The installer replaces this public path with ADEV\'s APK-native Bionic launcher, which opens the pack root on inherited fd 255 and enters this genuine glibc loader from nativeLibraryDir.',
      },
      prefixBinding: {
        strategy: 'inherited-directory-fd',
        fd: 255,
        compiledPath: fdPrefix,
        replacesUpstreamPath: compiledPrefix,
      },
      files,
      upstream: {
        repository: 'https://github.com/termux-pacman/glibc-packages',
        packageUrl: upstreamArchiveUrl,
        packageSha256: upstreamArchiveSha256,
        packageVersion: glibcVersion,
        licenses: ['GPL-3.0-only', 'LGPL-3.0-only'],
      },
      installedBytes,
    };
    fs.writeFileSync(
      path.join(glibcRoot, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    fs.mkdirSync(releaseDir, {recursive: true});
    const archiveName = `adev-glibc-${architecture}-v${packVersion}.tar.gz`;
    const archivePath = path.join(releaseDir, archiveName);
    const tarPath = path.join(work, 'adev-glibc-runtime.tar');
    runTar([
      '-cf',
      tarPath,
      '--format',
      'ustar',
      '--mtime',
      '2026-08-27 00:00:00',
      '-C',
      stageRoot,
      'glibc',
    ]);
    fs.writeFileSync(
      archivePath,
      zlib.gzipSync(fs.readFileSync(tarPath), {level: 9, mtime: 0}),
    );
    const archiveBytes = fs.readFileSync(archivePath);
    const archiveHash = sha256(archiveBytes);
    fs.writeFileSync(
      `${archivePath}.sha256`,
      `${archiveHash}  ${archiveName}\n`,
    );

    const index = {
      schemaVersion: 1,
      id: 'adev-glibc',
      channel: 'stable',
      packages: {
        aarch64: {
          version: packVersion,
          glibcVersion,
          archive:
            `https://github.com/Asif2902/MobileIDE/releases/download/` +
            `adev-glibc-v${packVersion}/${archiveName}`,
          sha256: archiveHash,
          bytes: archiveBytes.length,
          installedBytes,
          minAndroidApi: 29,
          requiredLoaderSha256: loaderSha256,
          source: {
            repository: 'https://github.com/termux-pacman/glibc-packages',
            archive: upstreamArchiveUrl,
            archiveSha256: upstreamArchiveSha256,
            licenses: ['GPL-3.0-only', 'LGPL-3.0-only'],
          },
        },
      },
    };
    const indexBytes = `${JSON.stringify(index, null, 2)}\n`;
    fs.writeFileSync(path.join(root, 'release', 'adev-glibc-index.json'), indexBytes);
    fs.writeFileSync(
      path.join(
        root,
        'android',
        'app',
        'src',
        'main',
        'assets',
        'runtime',
        'lib',
        'adev-glibc.json',
      ),
      indexBytes,
    );

    const listed = String(runTar(['-tzf', archivePath], {encoding: 'utf8'}));
    if (!listed.includes('glibc/lib/libc.so.6') || listed.includes('glibc/include/')) {
      throw new Error('generated archive does not match the minimal runtime policy');
    }

    process.stdout.write(
      `${archivePath}\n` +
        `glibc=${glibcVersion} installed=${installedBytes} compressed=${archiveBytes.length} ` +
        `sha256=${archiveHash}\n` +
        `loader-gzip=${loaderArchive}\n`,
    );
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
}

main().catch(error => {
  process.stderr.write(`ADEV glibc pack build failed: ${error.message}\n`);
  process.exitCode = 1;
});
