#!/usr/bin/env node
'use strict';

/**
 * Android cannot exec a freshly downloaded OpenCode binary from writable app
 * storage. ADEV therefore upgrades OpenCode through a compatible ADEV APK,
 * whose native libraries are installed by Android into an executable location.
 *
 * This broker discovers the newest ADEV release dynamically. It never replaces
 * the current payload, never downloads a desktop/glibc artifact, and never
 * requires the bundled OpenCode version to be hard-coded here.
 */

const fs = require('node:fs');
const {spawnSync} = require('node:child_process');

const repository = process.env.ADEV_UPDATE_REPOSITORY || 'Asif2902/MobileIDE';
const releasesUrl = `https://api.github.com/repos/${repository}/releases/latest`;
const releasesPage = `https://github.com/${repository}/releases/latest`;

function parseArgs(argv) {
  const result = {check: false, json: false, target: ''};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') result.check = true;
    else if (argument === '--json') result.json = true;
    else if (argument === '--target' && argv[index + 1]) result.target = argv[++index];
    else if (argument === '--method') index += 1;
    else if (!argument.startsWith('-') && !result.target) result.target = argument;
  }
  result.target = result.target.replace(/^v/, '');
  return result;
}

function numericVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function isNewer(candidate, current) {
  const left = numericVersion(candidate);
  const right = numericVersion(current);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

async function latestRelease() {
  if (process.env.ADEV_UPDATE_API_FILE) {
    return JSON.parse(fs.readFileSync(process.env.ADEV_UPDATE_API_FILE, 'utf8'));
  }
  const response = await fetch(releasesUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `ADEV-Studio/${process.env.ADEV_APP_VERSION || 'unknown'}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub release check returned HTTP ${response.status}`);
  return response.json();
}

function safeApkAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.find(asset => {
    if (!asset || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') {
      return false;
    }
    if (!asset.name.toLowerCase().endsWith('.apk')) return false;
    try {
      const url = new URL(asset.browser_download_url);
      return url.protocol === 'https:' && url.hostname === 'github.com';
    } catch {
      return false;
    }
  });
}

function openAndroidDownload(url) {
  const opener = process.env.ADEV_OPENCODE_XDG_OPEN || 'adev-open-url';
  const launched = spawnSync(opener, [url], {env: process.env, stdio: 'inherit'});
  if (launched.error) throw launched.error;
  if (launched.status !== 0) throw new Error(`Android URL broker exited ${launched.status}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const currentApp = process.env.ADEV_APP_VERSION || '0.0.0';
  const currentOpenCode = process.env.ADEV_OPENCODE_VERSION || 'unknown';
  const release = await latestRelease();
  const latestApp = String(release.tag_name || '').replace(/^v/, '');
  const apk = safeApkAsset(release);
  const updateAvailable = Boolean(apk && isNewer(latestApp, currentApp));
  const result = {
    managedBy: 'adev-apk',
    currentApp,
    latestApp,
    currentOpenCode,
    requestedOpenCode: args.target || null,
    updateAvailable,
    downloadUrl: updateAvailable ? apk.browser_download_url : null,
    releasesPage,
    reason: updateAvailable
      ? 'compatible-adev-update-available'
      : 'awaiting-compatible-adev-build',
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (updateAvailable) {
    process.stdout.write(
      `ADEV ${latestApp} contains the newest Android-compatible OpenCode runtime.\n` +
      `${args.check ? 'Download' : 'Opening Android download'}: ${apk.browser_download_url}\n`,
    );
  } else {
    process.stdout.write(
      `OpenCode ${currentOpenCode} is managed by ADEV on Android.\n` +
      (args.target ? `Upstream ${args.target} cannot be installed as a desktop Linux binary.\n` : '') +
      `No newer compatible ADEV build is published yet. Check ${releasesPage}\n`,
    );
  }

  if (updateAvailable && !args.check) openAndroidDownload(apk.browser_download_url);
}

main().catch(error => {
  process.stderr.write(
    `ADEV OpenCode update check failed: ${error?.message || String(error)}\n` +
    `Open the compatible Android releases page: ${releasesPage}\n`,
  );
  process.exitCode = 1;
});
