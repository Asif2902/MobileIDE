#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const prefix = process.env.PREFIX;
const nativeDir = process.env.MOBILEIDE_NATIVE_LIB;
const network = process.argv.includes('--network');
const keep = process.argv.includes('--keep');
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'adev-phase3-device-'));
const results = [];

function record(name, ready, detail = null) {
  results.push({name, ready, detail});
}

function run(name, executable, args, options = {}) {
  const result = childProcess.spawnSync(executable, args, {
    cwd: options.cwd || root,
    env: {...process.env, ...(options.env || {})},
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    input: options.input,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  record(name, result.status === (options.expectedStatus ?? 0), {
    status: result.status,
    output: output.slice(0, 2000),
  });
  return result;
}

try {
  const node = process.execPath;
  const git = process.env.MOBILEIDE_GIT || path.join(nativeDir, 'libbin_git.so');
  const packageManager = path.join(prefix, 'lib', 'adev-package-manager.js');
  const toolPack = path.join(prefix, 'lib', 'adev-toolpack.js');
  const bun = path.join(prefix, 'lib', 'adev-bun.js');

  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  run('git-init', git, ['init', '-b', 'main'], {cwd: repo});
  fs.writeFileSync(path.join(repo, 'README.md'), '# phase 3\n');
  run('git-add', git, ['add', 'README.md'], {cwd: repo});
  run(
    'git-commit',
    git,
    [
      '-c',
      'user.name=A Dev Studio Test',
      '-c',
      'user.email=phase3@local',
      'commit',
      '-m',
      'phase 3 fixture',
    ],
    {cwd: repo},
  );
  run('git-status', git, ['status', '--porcelain=v1'], {cwd: repo});

  run('pnpm-offline', node, [packageManager, 'pnpm', '--version'], {
    env: {ADEV_OFFLINE: '1', COREPACK_ENABLE_NETWORK: '0'},
  });
  run('yarn-offline', node, [packageManager, 'yarn', '--version'], {
    env: {ADEV_OFFLINE: '1', COREPACK_ENABLE_NETWORK: '0'},
  });
  run('toolpack-signature', node, [toolPack, 'status', '--json']);
  run('bun-capability-boundary', node, [bun, '--json'], {expectedStatus: 126});

  record(
    'credential-broker-environment',
    Boolean(
      process.env.ADEV_GIT_CREDENTIAL_PORT &&
        process.env.ADEV_GIT_CREDENTIAL_SESSION &&
        fs.existsSync(path.join(nativeDir, 'libbin_adev_git_credential.so')),
    ),
    'Secrets must not appear in this report.',
  );
  record(
    'ssh-strict-launcher',
    fs.existsSync(path.join(prefix, 'lib', 'adev-ssh.js')) &&
      fs.existsSync(path.join(nativeDir, 'libbin_dropbearmulti.so')),
    'Unknown hosts require native fingerprint confirmation.',
  );
  record(
    'git-lfs-capability',
    true,
    fs.existsSync(path.join(nativeDir, 'libbin_git_lfs.so'))
      ? 'bundled'
      : 'explicit signed Android feature-pack boundary',
  );

  if (network) {
    run(
      'git-https',
      git,
      ['ls-remote', '--heads', 'https://github.com/git/git.git', 'master'],
      {timeout: 180_000},
    );
    const npmCli = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    run('npm-registry', node, [npmCli, 'view', 'is-number@7.0.0', 'version'], {
      timeout: 180_000,
    });
    const publicClone = path.join(root, 'github-public-clone');
    run(
      'git-https-clone',
      git,
      [
        'clone',
        '--depth',
        '1',
        '--',
        'https://github.com/octocat/Hello-World.git',
        publicClone,
      ],
      {timeout: 180_000},
    );
    run('git-https-fetch', git, ['fetch', '--prune', '--', 'origin'], {
      cwd: publicClone,
      timeout: 180_000,
    });
  }
} catch (error) {
  record('harness', false, error.stack || error.message);
} finally {
  if (!keep) fs.rmSync(root, {recursive: true, force: true});
}

const failed = results.filter(result => !result.ready);
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      phase: 3,
      network,
      root: keep ? root : null,
      healthy: failed.length === 0,
      results,
    },
    null,
    2,
  )}\n`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
