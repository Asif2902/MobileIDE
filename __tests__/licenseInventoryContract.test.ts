import fs from 'fs';
import path from 'path';

const readJson = (relativePath: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'));

describe('native runtime license and provenance inventory', () => {
  const runtimeLock = readJson(
    'android/app/src/main/assets/runtime/runtime-lock.json',
  );
  const inventory = readJson('release/third-party-licenses.json');
  const provenance = readJson('release/runtime-provenance.json');
  const openCode = readJson(
    'android/app/src/main/assets/runtime/lib/adev-opencode.json',
  );

  it('inventories every native artifact in the signed runtime lock', () => {
    const expected = Object.values(runtimeLock.abis).reduce(
      (count: number, policy: any) => count + policy.nativeFiles.length,
      0,
    );
    expect(inventory.runtimeArtifactCount).toBe(expected);
    expect(inventory.runtimeArtifacts).toHaveLength(expected);

    for (const [abi, policy] of Object.entries(runtimeLock.abis) as any) {
      for (const entry of policy.nativeFiles) {
        expect(
          inventory.runtimeArtifacts.find(
            (artifact: any) =>
              artifact.abi === abi &&
              artifact.name === entry.packagedName &&
              artifact.sha256 === entry.sha256,
          ),
        ).toBeDefined();
      }
    }
  });

  it('derives OpenCode source metadata from its selected payload manifest', () => {
    const expectedSource =
      `${openCode.source.androidPortRepository}/tree/${openCode.source.androidPortCommit}`;
    for (const component of openCode.components) {
      const artifact = inventory.runtimeArtifacts.find(
        (candidate: any) => candidate.name === component.packagedName,
      );
      expect(artifact?.source).toBe(expectedSource);
      expect(artifact?.version).toBe(openCode.version);
      expect(artifact?.license).toBe(component.license);
    }
  });

  it('records the paired Termux AArch64 BusyBox executable and library', () => {
    const command = provenance.artifacts.find(
      (artifact: any) => artifact.packagedName === 'libbin_busybox.so',
    );
    const library = provenance.artifacts.find(
      (artifact: any) =>
        artifact.packagedName === 'liblib_libbusybox_so_1_38_0.so',
    );

    expect(command).toMatchObject({
      package: 'busybox',
      version: '1.38.0-1',
      architecture: 'ELF64 AArch64',
      platform: 'android-bionic (Termux prefix)',
      interpreter: '/system/bin/linker64',
      needed: ['libbusybox.so.1.38.0', 'libc.so'],
      minimumLoadAlignment: 16384,
      sha256: 'db7f2a847ab051086c71d1c8c367e71adf59a3c39c8323ff801126ff11c84058',
    });
    expect(library).toMatchObject({
      package: 'busybox',
      version: '1.38.0-1',
      architecture: 'ELF64 AArch64',
      platform: 'android-bionic (Termux prefix)',
      soname: 'libbusybox.so.1.38.0',
      needed: ['libandroid-selinux.so', 'libm.so', 'libc.so'],
      minimumLoadAlignment: 16384,
      sha256: 'b8153ac191754afcd6dd1896f961c7ecf3965cafd727a2690f648fdd9ba57cc1',
    });

    const licensedCommand = inventory.runtimeArtifacts.find(
      (artifact: any) =>
        artifact.abi === 'arm64-v8a' &&
        artifact.name === 'libbin_busybox.so',
    );
    const licensedLibrary = inventory.runtimeArtifacts.find(
      (artifact: any) =>
        artifact.abi === 'arm64-v8a' &&
        artifact.name === 'liblib_libbusybox_so_1_38_0.so',
    );
    expect(licensedCommand).toMatchObject({
      package: 'busybox',
      version: '1.38.0-1',
      license: 'GPL-2.0-only',
      metadataStatus: 'exact',
      sha256: command.sha256,
      needed: ['libbusybox.so.1.38.0', 'libc.so'],
    });
    expect(licensedLibrary).toMatchObject({
      package: 'busybox',
      version: '1.38.0-1',
      license: 'GPL-2.0-only',
      metadataStatus: 'exact',
      sha256: library.sha256,
      soname: 'libbusybox.so.1.38.0',
      needed: ['libandroid-selinux.so', 'libm.so', 'libc.so'],
    });
  });

  it('records Nano and its non-native terminal data with exact provenance', () => {
    const nano = provenance.artifacts.find(
      (artifact: any) => artifact.packagedName === 'libbin_nano.so',
    );
    expect(nano).toMatchObject({
      package: 'nano',
      version: '9.2',
      license: 'GPL-3.0-only',
      interpreter: '/system/bin/linker64',
      needed: ['libandroid-support.so', 'libncursesw.so.6', 'libc.so'],
      minimumLoadAlignment: 16384,
      sha256: 'ee689aa27847d10a91a596e90590070c046b4f829f875a4e4ec71a25f8ad7682',
    });
    expect(
      inventory.runtimeArtifacts.find(
        (artifact: any) =>
          artifact.abi === 'arm64-v8a' &&
          artifact.name === 'libbin_nano.so',
      ),
    ).toMatchObject({
      package: 'nano',
      version: '9.2',
      license: 'GPL-3.0-only',
      metadataStatus: 'exact',
    });
    for (const name of ['share/nano', 'share/terminfo']) {
      expect(
        inventory.bundledRuntimeData.find((entry: any) => entry.name === name),
      ).toMatchObject({metadataStatus: 'exact'});
    }
  });

  it('reports missing package/license mappings instead of inventing them', () => {
    expect(inventory.runtimeMetadataCoverage['hash-only']).toBeGreaterThan(0);
    expect(inventory.runtimeMetadataCoverage.complete).toBe(false);
    expect(inventory.releaseBlockers.join('\n')).toMatch(
      /no persisted package\/version\/license mapping/,
    );
  });
});
