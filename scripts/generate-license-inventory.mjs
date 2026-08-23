import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relativePath =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const lock = JSON.parse(
  fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
);
const packageJson = readJson('package.json');
const runtimeLock = readJson(
  'android/app/src/main/assets/runtime/runtime-lock.json',
);
const runtimeProvenance = readJson('release/runtime-provenance.json');
const packageName = packagePath => {
  const marker = 'node_modules/';
  const offset = packagePath.lastIndexOf(marker);
  return offset === -1 ? packagePath : packagePath.slice(offset + marker.length);
};
const installedLicense = packagePath => {
  try {
    const installed = JSON.parse(
      fs.readFileSync(path.join(root, packagePath, 'package.json'), 'utf8'),
    );
    if (installed.license) return installed.license;
    if (Array.isArray(installed.licenses)) {
      return installed.licenses.map(entry => entry.type).filter(Boolean).join(' OR ');
    }
  } catch {}
  return 'UNKNOWN';
};
const packages = Object.entries(lock.packages)
  .filter(([packagePath]) => packagePath !== '')
  .map(([packagePath, metadata]) => ({
    name: metadata.name ?? packageName(packagePath),
    version: metadata.version ?? 'unknown',
    license: metadata.license ?? installedLicense(packagePath),
    developmentOnly: Boolean(metadata.dev),
    resolved: metadata.resolved ?? null,
    integrity: metadata.integrity ?? null,
  }))
  .sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version),
  );
const unknown = packages.filter(entry => entry.license === 'UNKNOWN');
if (unknown.length) {
  throw new Error(
    `npm license metadata is missing for ${unknown.length} packages: ` +
      unknown
        .slice(0, 10)
        .map(entry => `${entry.name}@${entry.version}`)
        .join(', '),
  );
}
const openCodeManifestPath = path.join(
  root,
  'android/app/src/main/assets/runtime/lib/adev-opencode.json',
);
const openCodeManifest = fs.existsSync(openCodeManifestPath)
  ? JSON.parse(fs.readFileSync(openCodeManifestPath, 'utf8'))
  : null;
const busyboxManifestPath = path.join(
  root,
  'android/app/src/main/assets/runtime/lib/adev-busybox.json',
);
const busyboxManifest = fs.existsSync(busyboxManifestPath)
  ? JSON.parse(fs.readFileSync(busyboxManifestPath, 'utf8'))
  : null;
const nanoManifestPath = path.join(
  root,
  'android/app/src/main/assets/runtime/lib/adev-nano.json',
);
const nanoManifest = fs.existsSync(nanoManifestPath)
  ? JSON.parse(fs.readFileSync(nanoManifestPath, 'utf8'))
  : null;
const ripgrepManifestPath = path.join(
  root,
  'android/app/src/main/assets/runtime/lib/adev-ripgrep.json',
);
const ripgrepManifest = fs.existsSync(ripgrepManifestPath)
  ? JSON.parse(fs.readFileSync(ripgrepManifestPath, 'utf8'))
  : null;
const appRepository =
  typeof packageJson.repository === 'string'
    ? packageJson.repository
    : packageJson.repository?.url ?? null;
const openCodeSource = openCodeManifest?.source?.androidPortRepository &&
  openCodeManifest?.source?.androidPortCommit
  ? `${openCodeManifest.source.androidPortRepository}/tree/${openCodeManifest.source.androidPortCommit}`
  : null;
const openCodeComponents = new Map(
  (openCodeManifest?.components ?? []).map(component => [
    component.packagedName,
    component,
  ]),
);
const busyboxComponents = new Map(
  (busyboxManifest?.components ?? []).map(component => [
    component.packagedName,
    component,
  ]),
);
const nanoComponents = new Map(
  (nanoManifest?.components ?? [])
    .filter(component => component.packagedName)
    .map(component => [component.packagedName, component]),
);
const ripgrepComponents = new Map(
  (ripgrepManifest?.components ?? [])
    .filter(component => component.packagedName)
    .map(component => [component.packagedName, component]),
);
const exactProvenance = new Map(
  (runtimeProvenance.artifacts ?? []).map(artifact => [
    `${artifact.abi}/${artifact.packagedName}`,
    artifact,
  ]),
);

const nativeRuntimeArtifacts = Object.entries(runtimeLock.abis)
  .flatMap(([abi, policy]) =>
    policy.nativeFiles.map(entry => {
      const exact = exactProvenance.get(`${abi}/${entry.packagedName}`);
      const openCode = openCodeComponents.get(entry.packagedName);
      const busybox = busyboxComponents.get(entry.packagedName);
      const nano = nanoComponents.get(entry.packagedName);
      const ripgrep = ripgrepComponents.get(entry.packagedName);
      const appOwned =
        entry.packagedName.startsWith('libbin_adev_') ||
        entry.packagedName.startsWith('liblib_adev_') ||
        entry.packagedName === 'libbin_opencode.so';

      if (exact?.sha256 && exact.sha256 !== entry.sha256) {
        throw new Error(
          `Runtime provenance hash mismatch for ${abi}/${entry.packagedName}: ` +
            `${exact.sha256} != ${entry.sha256}`,
        );
      }
      if (busybox?.sha256 && busybox.sha256 !== entry.sha256) {
        throw new Error(
          `BusyBox manifest hash mismatch for ${abi}/${entry.packagedName}: ` +
            `${busybox.sha256} != ${entry.sha256}`,
        );
      }
      if (nano?.sha256 && nano.sha256 !== entry.sha256) {
        throw new Error(
          `Nano manifest hash mismatch for ${abi}/${entry.packagedName}: ` +
            `${nano.sha256} != ${entry.sha256}`,
        );
      }
      if (ripgrep?.sha256 && ripgrep.sha256 !== entry.sha256) {
        throw new Error(
          `ripgrep manifest hash mismatch for ${abi}/${entry.packagedName}: ` +
            `${ripgrep.sha256} != ${entry.sha256}`,
        );
      }

      let metadata;
      if (exact) {
        metadata = {
          package: exact.package ?? null,
          version: exact.version,
          license: exact.license,
          source: exact.source,
          metadataStatus: exact.metadataStatus ?? 'exact',
          architecture: exact.architecture ?? null,
          platform: exact.platform ?? runtimeLock.platform,
          archiveSha256: exact.archiveSha256 ?? null,
          interpreter: exact.interpreter ?? null,
          soname: exact.soname ?? null,
          needed: exact.needed ?? null,
          minimumLoadAlignment: exact.minimumLoadAlignment ?? null,
        };
      } else if (busybox) {
        metadata = {
          package: busyboxManifest.package,
          version: busyboxManifest.version,
          license: busyboxManifest.license,
          source: busyboxManifest.source.archiveUrl,
          metadataStatus: 'exact',
          architecture: abi,
          platform: busyboxManifest.platform,
          archiveSha256: busyboxManifest.source.archiveSha256,
          interpreter:
            busybox.role.includes('executable')
              ? busyboxManifest.runtime.interpreter
              : null,
          soname:
            busybox.role.includes('shared library')
              ? busyboxManifest.runtime.librarySoname
              : null,
          needed:
            busybox.role.includes('executable')
              ? busyboxManifest.runtime.executableNeeded
              : busyboxManifest.runtime.libraryNeeded,
          minimumLoadAlignment:
            busyboxManifest.runtime.minimumLoadAlignment,
        };
      } else if (nano) {
        metadata = {
          package: nanoManifest.package,
          version: nanoManifest.version,
          license: nano.license ?? nanoManifest.license,
          source: nanoManifest.source.nanoArchiveUrl,
          metadataStatus: 'exact',
          architecture: abi,
          platform: nanoManifest.platform,
          archiveSha256: nanoManifest.source.nanoArchiveSha256,
          interpreter: nanoManifest.runtime.interpreter,
          soname: null,
          needed: nanoManifest.runtime.needed,
          minimumLoadAlignment: nanoManifest.runtime.minimumLoadAlignment,
        };
      } else if (ripgrep) {
        metadata = {
          package: ripgrepManifest.package,
          version: ripgrepManifest.version,
          license: ripgrepManifest.license,
          source: ripgrepManifest.source.archiveUrl,
          metadataStatus: 'exact',
          architecture: abi,
          platform: ripgrepManifest.platform,
          archiveSha256: ripgrepManifest.source.archiveSha256,
          interpreter: ripgrepManifest.runtime.interpreter,
          soname: null,
          needed: ripgrepManifest.runtime.needed,
          minimumLoadAlignment:
            ripgrepManifest.runtime.minimumLoadAlignment,
        };
      } else if (openCode) {
        metadata = {
          package: null,
          version: openCodeManifest.version,
          license: openCode.license,
          source: openCodeSource,
          metadataStatus: openCodeSource ? 'exact' : 'incomplete',
          architecture: abi,
          platform: openCodeManifest.platform,
          archiveSha256:
            openCodeManifest.source?.archiveSha256 ?? null,
          interpreter: null,
          soname: null,
          needed: null,
          minimumLoadAlignment: null,
        };
      } else if (appOwned) {
        metadata = {
          package: null,
          version: packageJson.version,
          license: packageJson.license,
          source: appRepository,
          metadataStatus: appRepository ? 'application-source' : 'incomplete',
          architecture: abi,
          platform: runtimeLock.platform,
          archiveSha256: null,
          interpreter: null,
          soname: null,
          needed: null,
          minimumLoadAlignment: null,
        };
      } else {
        metadata = {
          package: null,
          version: null,
          license: null,
          source: null,
          metadataStatus: 'hash-only',
          architecture: abi,
          platform: runtimeLock.platform,
          archiveSha256: null,
          interpreter: null,
          soname: null,
          needed: null,
          minimumLoadAlignment: null,
        };
      }

      return {
        name: entry.packagedName,
        abi,
        owner: entry.owner,
        runtimePaths: entry.runtimePaths,
        bytes: entry.bytes,
        sha256: entry.sha256,
        ...metadata,
      };
    }),
  )
  .sort((left, right) =>
    left.abi.localeCompare(right.abi) || left.name.localeCompare(right.name),
  );

const metadataCounts = nativeRuntimeArtifacts.reduce(
  (counts, artifact) => {
    counts[artifact.metadataStatus] =
      (counts[artifact.metadataStatus] ?? 0) + 1;
    return counts;
  },
  {},
);
const hashOnlyCount = metadataCounts['hash-only'] ?? 0;

const packageManagerManifest = readJson(
  'android/app/src/main/assets/runtime/lib/adev-package-managers.json',
);
const bundledPackageDefinitions = [
  {
    name: 'corepack',
    descriptor: packageManagerManifest.corepack,
    packageJson:
      'android/app/src/main/assets/runtime/lib/node_modules/corepack/package.json',
  },
  {
    name: 'pnpm',
    descriptor: packageManagerManifest.managers.pnpm,
    packageJson: `android/app/src/main/assets/runtime/lib/package-managers/pnpm-${packageManagerManifest.managers.pnpm.version}/package.json`,
  },
  {
    name: '@yarnpkg/cli-dist',
    descriptor: packageManagerManifest.managers.yarn,
    packageJson: `android/app/src/main/assets/runtime/lib/package-managers/yarn-${packageManagerManifest.managers.yarn.version}/package.json`,
  },
  {
    name: 'npm',
    descriptor: {
      version: readJson(
        'android/app/src/main/assets/runtime/lib/node_modules/npm/package.json',
      ).version,
      source: null,
    },
    packageJson:
      'android/app/src/main/assets/runtime/lib/node_modules/npm/package.json',
  },
];
const bundledRuntimePackages = bundledPackageDefinitions.map(definition => {
  const metadata = readJson(definition.packageJson);
  const source = definition.descriptor.source ??
    (definition.name === 'npm'
      ? `https://registry.npmjs.org/npm/-/npm-${metadata.version}.tgz`
      : null);
  return {
    name: definition.name,
    version: definition.descriptor.version,
    license: metadata.license ?? null,
    source,
    registryIntegrity: definition.descriptor.registryIntegrity ?? null,
    entrypoint: definition.descriptor.entrypoint ?? null,
  };
});
const bundledRuntimeData = (nanoManifest?.components ?? [])
  .filter(component => component.runtimePath && !component.packagedName)
  .map(component => ({
    name: component.runtimePath,
    package:
      component.package ??
      (component.runtimePath.includes('terminfo') ||
      component.runtimePath.includes('licenses/ncurses')
        ? 'ncurses'
        : nanoManifest.package),
    version:
      component.version ??
      (component.runtimePath.includes('terminfo') ||
      component.runtimePath.includes('licenses/ncurses')
        ? nanoManifest.dependencies.find(item => item.package === 'ncurses')
            ?.version
        : nanoManifest.version),
    license: component.license ?? nanoManifest.license,
    source:
      component.runtimePath.includes('terminfo') ||
      component.runtimePath.includes('licenses/ncurses')
        ? nanoManifest.source.ncursesArchiveUrl
        : nanoManifest.source.nanoArchiveUrl,
    archiveSha256:
      component.runtimePath.includes('terminfo') ||
      component.runtimePath.includes('licenses/ncurses')
        ? nanoManifest.source.ncursesArchiveSha256
        : nanoManifest.source.nanoArchiveSha256,
    bytes: component.bytes ?? null,
    files: component.files ?? null,
    sha256: component.sha256 ?? null,
    treeSha256: component.treeSha256 ?? null,
    metadataStatus: 'exact',
  }));
const inventory = {
  schemaVersion: 2,
  generatedFrom: 'package-lock.json',
  applicationLicense: lock.packages[''].license,
  packageCount: packages.length,
  packages,
  bundledRuntimePackages,
  bundledRuntimeData,
  runtimeArtifactCount: nativeRuntimeArtifacts.length,
  runtimeMetadataCoverage: {
    total: nativeRuntimeArtifacts.length,
    ...metadataCounts,
    complete: hashOnlyCount === 0,
  },
  runtimeArtifacts: nativeRuntimeArtifacts,
  releaseBlockers:
    hashOnlyCount > 0
      ? [
          `${hashOnlyCount} signed native runtime artifacts retain exact hashes and runtime paths but no persisted package/version/license mapping. Regenerate the Termux runtime with a retained provenance manifest before claiming complete production license coverage.`,
        ]
      : [],
};
const destination = path.join(root, 'release', 'third-party-licenses.json');
fs.writeFileSync(destination, `${JSON.stringify(inventory, null, 2)}\n`);
process.stdout.write(
  `License inventory generated: ${packages.length} npm packages, ` +
    `${bundledRuntimePackages.length} bundled package managers, and ` +
    `${nativeRuntimeArtifacts.length} signed native artifacts ` +
    `(${hashOnlyCount} hash-only provenance records) -> ${destination}\n`,
);
