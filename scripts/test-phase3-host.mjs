import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'runtime');
const runtimeLib = path.join(runtime, 'lib');
const nativeDir = path.join(root, 'android', 'app', 'src', 'main', 'jniLibs', 'arm64-v8a');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-phase3-host-'));
const baseEnv = {
  ...process.env,
  PREFIX: runtime,
  MOBILEIDE_NATIVE_LIB: nativeDir,
  HOME: path.join(temp, 'home'),
  COREPACK_HOME: path.join(temp, 'corepack'),
  ADEV_OFFLINE: '1',
  COREPACK_ENABLE_NETWORK: '0',
};

function run(script, args = [], options = {}) {
  return spawnSync(process.execPath, [path.join(runtimeLib, script), ...args], {
    cwd: options.cwd || root,
    env: {...baseEnv, ...(options.env || {})},
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    input: options.input,
  });
}

function assertSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

try {
  const lock = JSON.parse(
    fs.readFileSync(path.join(runtimeLib, 'adev-package-managers.json'), 'utf8'),
  );
  assert.equal(lock.corepack.version, '0.35.0');
  assert.equal(lock.managers.pnpm.version, '11.18.0');
  assert.equal(lock.managers.yarn.version, '4.18.0');
  assert.match(lock.corepack.registryIntegrity, /^sha512-/);
  assert.match(lock.managers.pnpm.registryIntegrity, /^sha512-/);
  assert.match(lock.managers.yarn.registryIntegrity, /^sha512-/);

  const corepackManifest = JSON.parse(
    fs.readFileSync(path.join(runtimeLib, 'node_modules', 'corepack', 'package.json'), 'utf8'),
  );
  const pnpmManifest = JSON.parse(
    fs.readFileSync(
      path.join(runtimeLib, 'package-managers', 'pnpm-11.18.0', 'package.json'),
      'utf8',
    ),
  );
  const yarnManifest = JSON.parse(
    fs.readFileSync(
      path.join(runtimeLib, 'package-managers', 'yarn-4.18.0', 'package.json'),
      'utf8',
    ),
  );
  assert.equal(corepackManifest.version, lock.corepack.version);
  assert.equal(pnpmManifest.version, lock.managers.pnpm.version);
  assert.equal(yarnManifest.version, lock.managers.yarn.version);

  const corepackVersion = run('adev-package-manager.js', ['corepack', '--version']);
  assertSuccess(corepackVersion, 'Corepack');
  assert.equal(corepackVersion.stdout.trim(), lock.corepack.version);
  const pnpmVersion = run('adev-package-manager.js', ['pnpm', '--version']);
  assertSuccess(pnpmVersion, 'offline pnpm');
  assert.equal(pnpmVersion.stdout.trim(), lock.managers.pnpm.version);
  const yarnVersion = run('adev-package-manager.js', ['yarn', '--version']);
  assertSuccess(yarnVersion, 'offline Yarn');
  assert.equal(yarnVersion.stdout.trim(), lock.managers.yarn.version);

  const declaredProject = path.join(temp, 'declared-project');
  fs.mkdirSync(declaredProject, {recursive: true});
  const declaredManifest = `${JSON.stringify(
    {private: true, packageManager: `pnpm@${lock.managers.pnpm.version}`},
    null,
    2,
  )}\n`;
  fs.writeFileSync(path.join(declaredProject, 'package.json'), declaredManifest);
  const declaredStatus = run('adev-package-manager.js', ['--status'], {cwd: declaredProject});
  assertSuccess(declaredStatus, 'declared package-manager status');
  const declaredReport = JSON.parse(declaredStatus.stdout);
  assert.equal(declaredReport.pnpm.offlineReady, true);
  assert.equal(declaredReport.pnpm.source, 'project-packageManager+bundled-offline');
  assert.equal(
    fs.readFileSync(path.join(declaredProject, 'package.json'), 'utf8'),
    declaredManifest,
    'launcher must not modify the project manifest',
  );

  const lifecycleScript =
    "require('fs').appendFileSync('lifecycle.log', process.argv[1] + String.fromCharCode(10))";
  const pnpmFixture = path.join(temp, 'pnpm-fixture');
  fs.mkdirSync(pnpmFixture);
  fs.writeFileSync(
    path.join(pnpmFixture, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        packageManager: `pnpm@${lock.managers.pnpm.version}`,
        scripts: {
          preinstall: `node -e ${JSON.stringify(lifecycleScript)} preinstall`,
          postinstall: `node -e ${JSON.stringify(lifecycleScript)} postinstall`,
          build: `node -e ${JSON.stringify(lifecycleScript)} build`,
          test: `node -e ${JSON.stringify(lifecycleScript)} test`,
        },
      },
      null,
      2,
    )}\n`,
  );
  assertSuccess(
    run('adev-package-manager.js', ['pnpm', 'install', '--offline'], {cwd: pnpmFixture}),
    'pnpm offline install/lifecycle',
  );
  assertSuccess(
    run('adev-package-manager.js', ['pnpm', 'run', 'build'], {cwd: pnpmFixture}),
    'pnpm build',
  );
  assertSuccess(
    run('adev-package-manager.js', ['pnpm', 'test'], {cwd: pnpmFixture}),
    'pnpm test',
  );
  const pnpmLifecycle = fs.readFileSync(path.join(pnpmFixture, 'lifecycle.log'), 'utf8');
  for (const marker of ['preinstall', 'postinstall', 'build', 'test']) {
    assert.match(pnpmLifecycle, new RegExp(`^${marker}$`, 'm'));
  }

  const yarnFixture = path.join(temp, 'yarn-fixture');
  fs.mkdirSync(yarnFixture);
  fs.writeFileSync(
    path.join(yarnFixture, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        packageManager: `yarn@${lock.managers.yarn.version}`,
        scripts: {
          postinstall: `node -e ${JSON.stringify(lifecycleScript)} postinstall`,
          build: `node -e ${JSON.stringify(lifecycleScript)} build`,
          test: `node -e ${JSON.stringify(lifecycleScript)} test`,
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(yarnFixture, 'yarn.lock'), '');
  assertSuccess(
    run('adev-package-manager.js', ['yarn', 'install'], {
      cwd: yarnFixture,
      env: {YARN_ENABLE_NETWORK: '0'},
    }),
    'Yarn offline install/lifecycle',
  );
  assertSuccess(
    run('adev-package-manager.js', ['yarn', 'run', 'build'], {cwd: yarnFixture}),
    'Yarn build',
  );
  assertSuccess(
    run('adev-package-manager.js', ['yarn', 'test'], {cwd: yarnFixture}),
    'Yarn test',
  );
  const yarnLifecycle = fs.readFileSync(path.join(yarnFixture, 'lifecycle.log'), 'utf8');
  for (const marker of ['postinstall', 'build', 'test']) {
    assert.match(yarnLifecycle, new RegExp(`^${marker}$`, 'm'));
  }

  fs.writeFileSync(
    path.join(declaredProject, 'package.json'),
    `${JSON.stringify({private: true, packageManager: 'pnpm@9.0.0'}, null, 2)}\n`,
  );
  const unavailableOffline = run('adev-package-manager.js', ['pnpm', '--version'], {
    cwd: declaredProject,
  });
  assert.equal(unavailableOffline.status, 69);
  assert.match(unavailableOffline.stderr, /offline cache contains pnpm@11\.18\.0/);

  const bun = run('adev-bun.js', ['--json']);
  assert.equal(bun.status, 126);
  const bunReport = JSON.parse(bun.stdout);
  assert.equal(bunReport.supported, false);
  assert.equal(bunReport.platform, 'android');
  assert.equal(bunReport.libc, 'bionic');
  assert.match(bunReport.safeAlternative, /Node\.js/);

  const toolPackStatus = run('adev-toolpack.js', ['status', '--json']);
  assertSuccess(toolPackStatus, 'signed tool-pack status');
  const toolPackReport = JSON.parse(toolPackStatus.stdout);
  assert.equal(toolPackReport.catalogVerified, true);
  for (const id of [
    'cmake-ninja',
    'rust-cargo',
    'nasm',
    'autotools-libtool',
    'java',
    'development-libraries',
    'git-lfs',
  ]) {
    assert.ok(toolPackReport.packs.some(pack => pack.id === id), `missing pack ${id}`);
  }

  const fakeNative = path.join(temp, 'fake-native');
  const toolState = path.join(temp, 'tool-state');
  fs.mkdirSync(fakeNative, {recursive: true});
  fs.writeFileSync(path.join(fakeNative, 'libbin_nasm.so'), 'host-fixture');
  const installed = run('adev-toolpack.js', ['install', 'nasm'], {
    env: {MOBILEIDE_NATIVE_LIB: fakeNative, ADEV_TOOLPACK_STATE: toolState},
  });
  assertSuccess(installed, 'tool-pack install fixture');
  assert.equal(JSON.parse(installed.stdout).installed, true);
  const uninstalled = run('adev-toolpack.js', ['uninstall', 'nasm'], {
    env: {MOBILEIDE_NATIVE_LIB: fakeNative, ADEV_TOOLPACK_STATE: toolState},
  });
  assertSuccess(uninstalled, 'tool-pack uninstall fixture');
  assert.equal(JSON.parse(uninstalled.stdout).installed, null);

  const tamperedCatalog = path.join(temp, 'tampered-toolpacks.json');
  fs.writeFileSync(
    tamperedCatalog,
    fs.readFileSync(path.join(runtimeLib, 'adev-toolpacks.json'), 'utf8') + ' ',
  );
  const tampered = run('adev-toolpack.js', ['status', '--json'], {
    env: {ADEV_TOOLPACK_CATALOG: tamperedCatalog},
  });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /signature verification failed/);

  const nativeCredentialHelper = fs.readFileSync(
    path.join(root, 'android', 'app', 'src', 'main', 'cpp', 'adev_git_credential.cpp'),
    'utf8',
  );
  assert.match(nativeCredentialHelper, /ADEV_GIT_CREDENTIAL_SESSION/);
  assert.match(nativeCredentialHelper, /127\.0\.0\.1/);
  assert.match(nativeCredentialHelper, /password=%s/);
  assert.doesNotMatch(nativeCredentialHelper, /libbin_node|exec[vlp]*\([^)]*node/i);

  const gitPolicy = fs.readFileSync(
    path.join(
      root,
      'android',
      'app',
      'src',
      'main',
      'java',
      'com',
      'mobileide',
      'app',
      'git',
      'GitCredentialStore.kt',
    ),
    'utf8',
  );
  assert.match(gitPolicy, /AndroidKeyStore/);
  assert.match(gitPolicy, /AES\/GCM\/NoPadding/);
  assert.match(gitPolicy, /Unknown SSH host/);
  assert.match(gitPolicy, /git-ssh-leases/);

  const runtimeManager = fs.readFileSync(
    path.join(
      root,
      'android',
      'app',
      'src',
      'main',
      'java',
      'com',
      'mobileide',
      'app',
      'runtime',
      'RuntimeManager.kt',
    ),
    'utf8',
  );
  assert.match(runtimeManager, /GIT_CONFIG_COUNT/);
  assert.match(runtimeManager, /GitCredentialBroker\.get\(context\)\.environment/);
  assert.match(runtimeManager, /libbin_adev_git_credential\.so/);
  assert.match(runtimeManager, /adev-package-manager\.js/);
  assert.match(runtimeManager, /adev-bun\.js/);
  assert.match(
    runtimeManager,
    /CURRENT_RUNTIME_VERSION = BuildConfig\.ADEV_RUNTIME_VERSION/,
  );
  const credentialBrokerSource = fs.readFileSync(
    path.join(
      root,
      'android',
      'app',
      'src',
      'main',
      'java',
      'com',
      'mobileide',
      'app',
      'git',
      'GitCredentialBroker.kt',
    ),
    'utf8',
  );
  assert.match(credentialBrokerSource, /ADEV_GIT_CREDENTIAL_SESSION/);
  assert.match(credentialBrokerSource, /InetAddress\.getByName\("127\.0\.0\.1"\)/);

  process.stdout.write(
    'Phase 3 host checks passed: protected Git bridge, strict SSH policy, ' +
      'offline Corepack/pnpm/Yarn payloads, signed tool-pack lifecycle, and Bun gate.\n',
  );
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
