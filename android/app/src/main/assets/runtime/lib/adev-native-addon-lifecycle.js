'use strict';

/**
 * Install-time Android native-addon resolver.
 *
 * npm starts lifecycle scripts with ADEV's single NODE_OPTIONS preload.  When
 * an exact package/version has a verified Android prebuilt in the capability
 * catalog, materialize that real addon before upstream falls back to a host
 * build tool that is irrelevant (or unavailable) on the device.  Only the
 * lifecycle events explicitly listed in the signed catalog are completed
 * early; every other package and script keeps normal npm behavior.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function installVerifiedLifecycleAddon() {
  if (process.platform !== 'android' || process.arch !== 'arm64') return false;
  const event = process.env.npm_lifecycle_event || '';
  if (!event) return false;

  const packageRoot = fs.realpathSync(process.cwd());
  const manifestPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const catalog = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'adev-cli-compat.json'), 'utf8'),
  );
  const addon = catalog.nativeAddons.find(
    candidate =>
      candidate.package === manifest.name &&
      candidate.version === manifest.version &&
      Array.isArray(candidate.lifecycleEvents) &&
      candidate.lifecycleEvents.includes(event),
  );
  if (!addon) return false;

  const configuredPrefix = path.resolve(process.env.PREFIX || path.join(__dirname, '..'));
  const prefix = fs.realpathSync(configuredPrefix);
  const source = path.resolve(__dirname, addon.source);
  const target = path.resolve(packageRoot, addon.target);
  if (!isWithin(prefix, packageRoot) || !isWithin(packageRoot, target)) {
    throw new Error(`refusing lifecycle addon write outside the private ADEV runtime: ${target}`);
  }
  if (!fs.existsSync(source) || sha256(source) !== addon.sha256) {
    throw new Error(`verified ${addon.package} Android addon is missing or corrupt`);
  }

  fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
  const temporary = `${target}.adev-${process.pid}`;
  try {
    fs.copyFileSync(source, temporary);
    fs.chmodSync(temporary, 0o755);
    if (sha256(temporary) !== addon.sha256) throw new Error('copy verification failed');
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or never created */ }
  }
  process.stdout.write(
    `adev: installed verified ${addon.package}@${addon.version} Android ARM64 addon\n`,
  );
  return true;
}

try {
  if (installVerifiedLifecycleAddon()) process.exit(0);
} catch (error) {
  process.stderr.write(`adev: native-addon lifecycle resolver failed: ${error.message}\n`);
  process.exit(1);
}
