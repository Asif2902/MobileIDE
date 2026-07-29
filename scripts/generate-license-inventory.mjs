import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(
  fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
);
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
const inventory = {
  schemaVersion: 1,
  generatedFrom: 'package-lock.json',
  applicationLicense: lock.packages[''].license,
  packageCount: packages.length,
  packages,
};
const destination = path.join(root, 'release', 'third-party-licenses.json');
fs.writeFileSync(destination, `${JSON.stringify(inventory, null, 2)}\n`);
process.stdout.write(
  `License inventory generated: ${packages.length} npm packages -> ${destination}\n`,
);
