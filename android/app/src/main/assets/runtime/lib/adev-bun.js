#!/usr/bin/env node
'use strict';

const report = {
  schemaVersion: 1,
  command: 'bun',
  supported: false,
  platform: 'android',
  libc: 'bionic',
  reason:
    'Bun does not publish or support an Android/Bionic runtime. Linux glibc and musl builds are not Android artifacts.',
  safeAlternative: 'Use the bundled Node.js with npm, npx, pnpm, or Yarn.',
  upstream: 'https://bun.sh/docs/installation',
};

if (process.argv.includes('--json') || process.argv.includes('--adev-capability')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stderr.write(
    `bun is unavailable on Android/Bionic.\n${report.reason}\n${report.safeAlternative}\n` +
      `Upstream platforms: ${report.upstream}\n`
  );
}
process.exitCode = 126;
