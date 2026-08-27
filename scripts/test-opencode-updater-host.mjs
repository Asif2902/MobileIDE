import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const updater = path.join(
  root,
  'android/app/src/main/assets/runtime/lib/adev-opencode-update.js',
);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-update-test-'));

try {
  const apiFile = path.join(fixture, 'latest.json');
  fs.writeFileSync(apiFile, JSON.stringify({
    tag_name: 'v1.3.31',
    assets: [{
      name: 'app-phoneTest.apk',
      browser_download_url:
        'https://github.com/Asif2902/MobileIDE/releases/download/v1.3.31/app-phoneTest.apk',
    }],
  }));

  const run = currentApp => spawnSync(
    process.execPath,
    [updater, '--check', '--json', '--target', '1.18.23'],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADEV_APP_VERSION: currentApp,
        ADEV_OPENCODE_VERSION: '1.17.9',
        ADEV_UPDATE_API_FILE: apiFile,
      },
    },
  );

  const available = run('1.3.30-phone-test');
  assert.equal(available.status, 0, available.stderr);
  const availableResult = JSON.parse(available.stdout);
  assert.equal(availableResult.managedBy, 'adev-apk');
  assert.equal(availableResult.updateAvailable, true);
  assert.equal(availableResult.requestedOpenCode, '1.18.23');
  assert.match(availableResult.downloadUrl, /^https:\/\/github\.com\//);

  const current = run('1.3.31-phone-test');
  assert.equal(current.status, 0, current.stderr);
  assert.equal(JSON.parse(current.stdout).updateAvailable, false);

  process.stdout.write('ADEV-managed OpenCode updater host checks passed.\n');
} finally {
  fs.rmSync(fixture, {recursive: true, force: true});
}
