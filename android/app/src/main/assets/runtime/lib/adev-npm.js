#!/usr/bin/env node
'use strict';

/*
 * Authoritative npm entrypoint for ADEV. Interactive shells, ProcessManager,
 * agents and direct $PREFIX/bin/npm aliases all enter here, so npm lifecycle
 * behavior and optional Linux CLI payload resolution cannot drift apart.
 */
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');

const prefix = path.resolve(process.env.PREFIX || path.join(__dirname, '..'));
const node = process.env.MOBILEIDE_NODE || process.execPath;
const npmCli = path.join(prefix, 'lib/node_modules/npm/bin/npm-cli.js');
const linuxCompat = path.join(prefix, 'lib/adev-linux-npm.js');
const linuxManifest = path.join(prefix, 'linux/manifest.json');
const npmArgs = process.argv.slice(2);

if (!fs.existsSync(npmCli)) {
  process.stderr.write(`ADEV npm entrypoint is missing: ${npmCli}\n`);
  process.exit(127);
}

const child = spawn(node, [npmCli, ...npmArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    try { child.kill(signal); } catch {}
  });
}

child.on('error', error => {
  process.stderr.write(`ADEV could not start npm: ${error.message}\n`);
  process.exit(127);
});

child.on('exit', (status, signal) => {
  if (signal) {
    // Android/Node does not expose a portable shell-style status mapping for
    // every signal. Preserve failure and the signal name in diagnostics.
    process.stderr.write(`npm terminated by ${signal}\n`);
    process.exit(1);
  }
  const exitStatus = Number.isInteger(status) ? status : 1;
  if (exitStatus === 0 && process.env.ADEV_LINUX_NPM_REENTRY !== '1' &&
      fs.existsSync(linuxManifest) && fs.existsSync(linuxCompat)) {
    try {
      // adev-linux-npm reads the same argv and performs only a conservative,
      // validated post-install repair. Its failure never changes npm's own
      // successful exit status; it emits an actionable compatibility message.
      require(linuxCompat);
    } catch (error) {
      process.stderr.write(`ADEV linux npm compatibility check failed: ${error.message}\n`);
    }
  }
  process.exit(exitStatus);
});
