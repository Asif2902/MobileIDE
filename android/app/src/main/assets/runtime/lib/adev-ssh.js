#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { brokerRequest } = require('./adev-broker-client.js');

function hostFromArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (['-p', '-l', '-i', '-o', '-F', '-J', '-W'].includes(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith('-')) return value.includes('@') ? value.split('@').pop() : value;
  }
  return '';
}

async function main() {
  const args = process.argv.slice(2);
  const host = hostFromArgs(args);
  const prepared = await brokerRequest({ action: 'prepare-ssh', input: { host } });
  if (!prepared.ok) {
    process.stderr.write(`ADEV SSH policy blocked ${host || 'the connection'}: ${prepared.error}\n`);
    return 1;
  }
  const nativeDir = process.env.MOBILEIDE_NATIVE_LIB || '';
  const prefix = process.env.PREFIX || path.resolve(__dirname, '..');
  const dbclient =
    process.env.ADEV_DBCLIENT || path.join(prefix, 'bin', 'dbclient');
  if (!fs.existsSync(dbclient)) {
    process.stderr.write('ADEV SSH client is missing from the runtime.\n');
    return 127;
  }
  const launchArgs = [
    '-o',
    'StrictHostKeyChecking=yes',
    ...(prepared.identityPath ? ['-i', prepared.identityPath] : []),
    ...args,
  ];
  const env = { ...process.env, HOME: prepared.sshHome || process.env.HOME };
  if (prepared.passphrase) env.DROPBEAR_PASSWORD = prepared.passphrase;
  const result = childProcess.spawnSync(dbclient, launchArgs, {
    stdio: 'inherit',
    env,
  });
  await brokerRequest({
    action: 'cleanup-ssh',
    input: { lease: prepared.lease || '' },
  }).catch(() => {});
  if (result.error) {
    process.stderr.write(`ADEV SSH launch failed: ${result.error.message}\n`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

main().then(
  code => {
    process.exitCode = code;
  },
  error => {
    process.stderr.write(`ADEV SSH helper failed: ${error.message}\n`);
    process.exitCode = 1;
  }
);

module.exports = { hostFromArgs };
