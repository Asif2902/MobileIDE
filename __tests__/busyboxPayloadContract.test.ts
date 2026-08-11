import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const projectPath = (...segments: string[]) =>
  path.join(__dirname, '..', ...segments);
const readJson = (...segments: string[]) =>
  JSON.parse(fs.readFileSync(projectPath(...segments), 'utf8'));
const sha256 = (file: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const EXPECTED_EXECUTABLE_SHA256 =
  'db7f2a847ab051086c71d1c8c367e71adf59a3c39c8323ff801126ff11c84058';
const EXPECTED_LIBRARY_SHA256 =
  'b8153ac191754afcd6dd1896f961c7ecf3965cafd727a2690f648fdd9ba57cc1';

const inspectElf64Aarch64 = (file: string) => {
  const bytes = fs.readFileSync(file);
  expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  expect(bytes[4]).toBe(2);
  expect(bytes[5]).toBe(1);
  expect(bytes.readUInt16LE(18)).toBe(183);

  const programHeaderOffset = Number(bytes.readBigUInt64LE(0x20));
  const programHeaderSize = bytes.readUInt16LE(0x36);
  const programHeaderCount = bytes.readUInt16LE(0x38);
  const loadAlignments: number[] = [];
  for (let index = 0; index < programHeaderCount; index += 1) {
    const header = programHeaderOffset + index * programHeaderSize;
    expect(header + 56).toBeLessThanOrEqual(bytes.length);
    if (bytes.readUInt32LE(header) === 1) {
      loadAlignments.push(Number(bytes.readBigUInt64LE(header + 48)));
    }
  }
  expect(loadAlignments.length).toBeGreaterThan(0);
  loadAlignments.forEach(alignment => expect(alignment).toBeGreaterThanOrEqual(0x4000));
  return bytes;
};

describe('verified Android BusyBox payload', () => {
  const executable = projectPath(
    'android/app/src/main/jniLibs/arm64-v8a/libbin_busybox.so',
  );
  const library = projectPath(
    'android/app/src/main/jniLibs/arm64-v8a/liblib_libbusybox_so_1_38_0.so',
  );
  const nativeMap = readJson(
    'android',
    'app',
    'src',
    'main',
    'assets',
    'runtime',
    'native-map.json',
  );
  const manifest = readJson(
    'android',
    'app',
    'src',
    'main',
    'assets',
    'runtime',
    'lib',
    'adev-busybox.json',
  );

  it('stages the pinned ELF64 AArch64 executable and matching shared library', () => {
    expect(fs.statSync(executable).size).toBe(4320);
    expect(fs.statSync(library).size).toBe(876576);
    expect(sha256(executable)).toBe(EXPECTED_EXECUTABLE_SHA256);
    expect(sha256(library)).toBe(EXPECTED_LIBRARY_SHA256);

    const executableBytes = inspectElf64Aarch64(executable);
    expect(executableBytes.includes(Buffer.from('/system/bin/linker64\0'))).toBe(true);
    expect(executableBytes.includes(Buffer.from('libbusybox.so.1.38.0\0'))).toBe(true);
    expect(executableBytes.includes(Buffer.from('libc.so\0'))).toBe(true);

    const libraryBytes = inspectElf64Aarch64(library);
    expect(libraryBytes.includes(Buffer.from('libbusybox.so.1.38.0\0'))).toBe(true);
    expect(libraryBytes.includes(Buffer.from('libandroid-selinux.so\0'))).toBe(true);
    expect(libraryBytes.includes(Buffer.from('libm.so\0'))).toBe(true);
    expect(libraryBytes.includes(Buffer.from('libc.so\0'))).toBe(true);
  });

  it('maps every non-system SONAME in the BusyBox dynamic closure', () => {
    expect(nativeMap['bin/busybox']).toBe('libbin_busybox.so');
    expect(nativeMap['lib/libbusybox.so.1.38.0']).toBe(
      'liblib_libbusybox_so_1_38_0.so',
    );
    expect(nativeMap['lib/libandroid-selinux.so']).toBe(
      'liblib_libandroid_selinux_so.so',
    );
    expect(
      fs.existsSync(
        projectPath(
          'android/app/src/main/jniLibs/arm64-v8a/liblib_libandroid_selinux_so.so',
        ),
      ),
    ).toBe(true);
  });

  it('binds source, archive, components, and Android runtime requirements', () => {
    expect(manifest).toMatchObject({
      package: 'busybox',
      version: '1.38.0-1',
      platform: 'android-bionic',
      license: 'GPL-2.0-only',
      supportedAbis: ['arm64-v8a'],
      source: {
        archiveSha256:
          '1bb7f1d4c00cadd0e1117b6dd7110311b8bf749ef00b486e96cfdc11c98f8fd9',
      },
      runtime: {
        interpreter: '/system/bin/linker64',
        minimumLoadAlignment: 16384,
        executableNeeded: ['libbusybox.so.1.38.0', 'libc.so'],
        librarySoname: 'libbusybox.so.1.38.0',
        libraryNeeded: ['libandroid-selinux.so', 'libm.so', 'libc.so'],
      },
    });
    expect(manifest.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packagedName: 'libbin_busybox.so',
          sha256: EXPECTED_EXECUTABLE_SHA256,
          bytes: 4320,
        }),
        expect.objectContaining({
          packagedName: 'liblib_libbusybox_so_1_38_0.so',
          sha256: EXPECTED_LIBRARY_SHA256,
          bytes: 876576,
        }),
      ]),
    );
  });

  it('keeps the signed runtime lock synchronized with the staged payload', () => {
    const runtimeLock = readJson(
      'android',
      'app',
      'src',
      'main',
      'assets',
      'runtime',
      'runtime-lock.json',
    );
    const locked = runtimeLock.abis['arm64-v8a'].nativeFiles.find(
      (entry: any) => entry.packagedName === 'libbin_busybox.so',
    );
    expect(locked).toMatchObject({
      sha256: EXPECTED_EXECUTABLE_SHA256,
      bytes: 4320,
      runtimePaths: ['bin/busybox'],
      owner: 'developer-runtime',
    });
    expect(runtimeLock.busybox).toMatchObject({
      version: '1.38.0-1',
      platform: 'android-bionic',
      supportedAbis: ['arm64-v8a'],
    });
  });

  it('pins the archive and both extracted hashes in the staging script', () => {
    const script = fs.readFileSync(
      projectPath('scripts', 'fetch-busybox-android.ps1'),
      'utf8',
    );
    expect(script).toContain(
      'busybox_1.38.0-1_aarch64.deb',
    );
    expect(script).toContain(EXPECTED_EXECUTABLE_SHA256);
    expect(script).toContain(EXPECTED_LIBRARY_SHA256);
    expect(script).toContain('Assert-AndroidElf64Aarch64');
  });
});
