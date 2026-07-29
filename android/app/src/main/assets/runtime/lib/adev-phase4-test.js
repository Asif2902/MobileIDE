#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const prefix = process.env.PREFIX || path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(prefix, name));
const result = {
  api: Number(process.env.ANDROID__BUILD_VERSION_SDK || 0) || null,
  abi: process.env.ADEV_ABI || process.arch,
  privateWorkspace: process.cwd().startsWith(
    path.join(prefix, 'workspaces') + path.sep
  ),
  runtimeLock: false,
  targetApi: null,
  pageAlignment: null,
};

try {
  const lockBytes = read('runtime-lock.json');
  const lock = JSON.parse(lockBytes);
  result.runtimeLock = crypto.verify(
    null,
    lockBytes,
    read('runtime-lock.pub.pem'),
    read('runtime-lock.sig')
  );
  result.targetApi = lock.targetApi;
  result.pageAlignment = lock.pageAlignment;
  result.abiDelivery = lock.abis[result.abi] || null;
} catch (error) {
  result.error = error.message;
}

result.ready =
  result.runtimeLock &&
  result.targetApi === 36 &&
  result.pageAlignment === 16384 &&
  Boolean(result.abiDelivery);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ready ? 0 : 1;
