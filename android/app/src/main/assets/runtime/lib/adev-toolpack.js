#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const prefix = process.env.PREFIX || path.resolve(__dirname, '..');
const nativeDir = process.env.MOBILEIDE_NATIVE_LIB || '';
const catalogPath =
  process.env.ADEV_TOOLPACK_CATALOG || path.join(prefix, 'lib', 'adev-toolpacks.json');
const signaturePath =
  process.env.ADEV_TOOLPACK_SIGNATURE || path.join(prefix, 'lib', 'adev-toolpacks.sig');
const publicKeyPath =
  process.env.ADEV_TOOLPACK_PUBLIC_KEY || path.join(prefix, 'lib', 'adev-toolpacks.pub.pem');
const stateRoot =
  process.env.ADEV_TOOLPACK_STATE || path.join(process.env.HOME || prefix, '.adev', 'toolpacks');

function readAndVerifyCatalog() {
  const bytes = fs.readFileSync(catalogPath);
  const signature = Buffer.from(fs.readFileSync(signaturePath, 'utf8').trim(), 'base64');
  const publicKey = fs.readFileSync(publicKeyPath);
  if (!crypto.verify(null, bytes, publicKey, signature)) {
    throw new Error('tool-pack catalog signature verification failed');
  }
  const catalog = JSON.parse(bytes.toString('utf8'));
  if (
    catalog.schemaVersion !== 1 ||
    catalog.platform !== 'android-bionic' ||
    catalog.signatureAlgorithm !== 'Ed25519'
  ) {
    throw new Error('unsupported tool-pack catalog policy');
  }
  return catalog;
}

function markerPath(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid tool-pack id: ${id}`);
  return path.join(stateRoot, `${id}.json`);
}

function packAvailability(pack) {
  const missingNativeLibraries = (pack.requiredNativeLibraries || []).filter(
    name => !nativeDir || !fs.existsSync(path.join(nativeDir, name))
  );
  const missingAssetMarker =
    pack.requiredAssetMarker && !fs.existsSync(path.join(prefix, pack.requiredAssetMarker))
      ? pack.requiredAssetMarker
      : null;
  return {
    delivered: missingNativeLibraries.length === 0 && !missingAssetMarker,
    missingNativeLibraries,
    missingAssetMarker,
  };
}

function packStatus(pack) {
  const availability = packAvailability(pack);
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(markerPath(pack.id), 'utf8'));
  } catch {}
  return {
    id: pack.id,
    version: pack.version,
    capabilities: pack.capabilities,
    dependencies: pack.dependencies,
    license: pack.license,
    delivery: pack.delivery,
    delivered: availability.delivered,
    installed:
      availability.delivered &&
      state &&
      state.id === pack.id &&
      state.version === pack.version,
    missingNativeLibraries: availability.missingNativeLibraries,
    missingAssetMarker: availability.missingAssetMarker,
    boundary: availability.delivered ? null : pack.phase4Boundary,
  };
}

function requirePack(catalog, id) {
  const pack = catalog.packs.find(candidate => candidate.id === id);
  if (!pack) throw new Error(`unknown tool pack: ${id}`);
  return pack;
}

function installPack(catalog, id, visiting = new Set()) {
  if (visiting.has(id)) throw new Error(`tool-pack dependency cycle at ${id}`);
  visiting.add(id);
  const pack = requirePack(catalog, id);
  for (const dependency of pack.dependencies || []) {
    if (dependency === 'native-c-cpp') continue;
    installPack(catalog, dependency, visiting);
  }
  visiting.delete(id);
  const status = packStatus(pack);
  if (!status.delivered) {
    const missing = [
      ...status.missingNativeLibraries,
      ...(status.missingAssetMarker ? [status.missingAssetMarker] : []),
    ];
    throw new Error(
      `${id}@${pack.version} is verified but not delivered in this APK ` +
        `(missing: ${missing.join(', ') || 'feature payload'}). ${status.boundary}`
    );
  }
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    markerPath(id),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id,
        version: pack.version,
        installedAt: new Date().toISOString(),
        catalogSignatureVerified: true,
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return packStatus(pack);
}

function uninstallPack(catalog, id) {
  const pack = requirePack(catalog, id);
  fs.rmSync(markerPath(id), { force: true });
  return packStatus(pack);
}

function main() {
  const catalog = readAndVerifyCatalog();
  const command = process.argv[2] || 'list';
  const id = process.argv[3];
  if (command === 'list' || command === 'status') {
    const statuses = catalog.packs.map(packStatus);
    if (process.argv.includes('--json')) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            catalogVerified: true,
            platform: catalog.platform,
            abi: catalog.abi,
            packs: statuses,
          },
          null,
          2
        )}\n`
      );
    } else {
      for (const status of statuses) {
        process.stdout.write(
          `${status.installed ? 'INSTALLED' : status.delivered ? 'AVAILABLE' : 'FEATURE-GATE'} ` +
            `${status.id}@${status.version}\n`
        );
      }
    }
    return 0;
  }
  if (!id) throw new Error(`adev-toolpack ${command} requires a pack id`);
  const status =
    command === 'install'
      ? installPack(catalog, id)
      : command === 'uninstall'
        ? uninstallPack(catalog, id)
        : (() => {
            throw new Error(`unknown tool-pack command: ${command}`);
          })();
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`ADEV tool pack: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  readAndVerifyCatalog,
  packAvailability,
  packStatus,
  installPack,
  uninstallPack,
};
