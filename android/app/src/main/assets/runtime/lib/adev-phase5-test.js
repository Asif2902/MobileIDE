'use strict';

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const runtimeLib = __dirname;
const network = process.argv.includes('--network');
const expected = process.env.ADEV_RUNTIME_VERSION;
if (!expected) {
  throw new Error('ADEV_RUNTIME_VERSION is missing from the Android environment.');
}
const installed = fs
  .readFileSync(path.join(runtimeLib, '..', '.runtime_version'), 'utf8')
  .trim();
if (installed !== expected) {
  throw new Error(`Runtime version mismatch: environment=${expected}, installed=${installed}`);
}
for (const phase of [1, 2, 3, 4]) {
  const args = [path.join(runtimeLib, `adev-phase${phase}-test.js`)];
  if (network && phase <= 3) args.push('--network');
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Phase ${phase} device harness failed with status ${result.status}.`);
  }
}
const environmentSuite = spawnSync(
  process.execPath,
  [path.join(runtimeLib, 'adev-runtime-env-test.js'), ...(network ? ['--network'] : [])],
  {cwd: process.cwd(), env: process.env, stdio: 'inherit'},
);
if (environmentSuite.error) throw environmentSuite.error;
if (environmentSuite.status !== 0) {
  throw new Error(
    `Runtime environment contract suite failed with status ${environmentSuite.status}.`,
  );
}
process.stdout.write(
  `Phase 5 Android device gate passed: runtime ${installed}, API ${process.env.ADEV_ANDROID_API}, ABI ${process.arch}.\n`,
);
