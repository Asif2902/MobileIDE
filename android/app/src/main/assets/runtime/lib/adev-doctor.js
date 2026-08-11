#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');
const verbose = args.has('--verbose');
const selfTest = args.has('--self-test');
const prefix = process.env.PREFIX || '';
const nativeDir = process.env.MOBILEIDE_NATIVE_LIB || '';

function firstExisting(...values) {
  return values.find(value => value && fs.existsSync(value)) || null;
}

function probe(name, executable, probeArgs, options = {}) {
  if (!executable || (!path.isAbsolute(executable) && !options.allowPath)) {
    return { name, ready: false, error: 'not bundled' };
  }
  if (path.isAbsolute(executable) && !fs.existsSync(executable)) {
    return { name, ready: false, path: executable, error: 'missing' };
  }
  try {
    const result = childProcess.spawnSync(executable, probeArgs, {
      encoding: 'utf8',
      timeout: options.timeout || 15000,
      env: process.env,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    return {
      name,
      ready: result.status === 0,
      path: executable,
      exitCode: result.status,
      version: output.split(/\r?\n/)[0] || null,
      error: result.error ? result.error.message : null,
    };
  } catch (error) {
    return { name, ready: false, path: executable, error: error.message };
  }
}

function native(name) {
  return firstExisting(
    process.env[`MOBILEIDE_${name.toUpperCase().replace(/-/g, '_')}`],
    nativeDir && path.join(nativeDir, `libbin_${name.replace(/-/g, '_')}.so`)
  );
}

function countFiles(directory) {
  if (!directory || !fs.existsSync(directory)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (entry.isDirectory()) count += countFiles(path.join(directory, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

const npmCli = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const nodeGyp = path.join(
  prefix,
  'lib',
  'node_modules',
  'npm',
  'node_modules',
  'node-gyp',
  'bin',
  'node-gyp.js'
);
const probes = {
  node: probe('node', process.execPath, ['--version']),
  npm: probe('npm', process.execPath, [npmCli, '--version']),
  nodeGyp: probe('node-gyp', process.execPath, [nodeGyp, '--version']),
  python: probe('python', process.env.NODE_GYP_FORCE_PYTHON || process.env.PYTHON, ['--version']),
  make: probe('make', process.env.MAKE, ['--version']),
  clang: probe('clang', (process.env.CC || '').split(' ')[0], ['--version']),
  git: probe('git', process.env.MOBILEIDE_GIT || native('git'), ['--version']),
  curl: probe('curl', process.env.MOBILEIDE_CURL || native('curl'), ['--version']),
  bash: probe('bash', process.env.MOBILEIDE_BASH || native('bash'), ['--version']),
  nano: probe('nano', process.env.MOBILEIDE_NANO || native('nano'), ['--version']),
  busybox: probe('busybox', process.env.MOBILEIDE_BUSYBOX || native('busybox'), ['--help']),
  opencode: probe(
    'opencode',
    process.env.MOBILEIDE_OPENCODE || native('opencode'),
    ['--version'],
    {timeout: 30000}
  ),
};

const packageManagerLauncher = path.join(prefix, 'lib', 'adev-package-manager.js');
const packageManagerLock = path.join(prefix, 'lib', 'adev-package-managers.json');
const packageManagerStatusProbe = fs.existsSync(packageManagerLauncher)
  ? childProcess.spawnSync(process.execPath, [packageManagerLauncher, '--status'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15000,
      env: process.env,
    })
  : null;
let packageManagers = {error: 'package-manager launcher missing'};
try {
  packageManagers = JSON.parse(packageManagerStatusProbe && packageManagerStatusProbe.stdout);
} catch (error) {
  packageManagers = {error: error.message};
}
packageManagers.lockPath = packageManagerLock;
packageManagers.lockReady = fs.existsSync(packageManagerLock);
packageManagers.pnpmProbe = fs.existsSync(packageManagerLauncher)
  ? probe('pnpm', process.execPath, [packageManagerLauncher, 'pnpm', '--version'])
  : {name: 'pnpm', ready: false, error: 'launcher missing'};
packageManagers.yarnProbe = fs.existsSync(packageManagerLauncher)
  ? probe('yarn', process.execPath, [packageManagerLauncher, 'yarn', '--version'])
  : {name: 'yarn', ready: false, error: 'launcher missing'};

const toolPackLauncher = path.join(prefix, 'lib', 'adev-toolpack.js');
const toolPackProbe = fs.existsSync(toolPackLauncher)
  ? childProcess.spawnSync(process.execPath, [toolPackLauncher, 'status', '--json'], {
      encoding: 'utf8',
      timeout: 15000,
      env: process.env,
    })
  : null;
let toolPacks = {catalogVerified: false, error: 'tool-pack launcher missing'};
try {
  toolPacks = JSON.parse(toolPackProbe && toolPackProbe.stdout);
} catch (error) {
  toolPacks = {
    catalogVerified: false,
    error: (toolPackProbe && toolPackProbe.stderr.trim()) || error.message,
  };
}

const nativeGitCredentialHelper =
  nativeDir && path.join(nativeDir, 'libbin_adev_git_credential.so');
const sshLauncher = path.join(prefix, 'lib', 'adev-ssh.js');
const bunBoundary = path.join(prefix, 'lib', 'adev-bun.js');
const gitIntegration = {
  nativeCliReady: probes.git.ready,
  credentialStore: 'Android Keystore AES-GCM',
  credentialBrokerReady: Boolean(
    nativeGitCredentialHelper &&
      fs.existsSync(nativeGitCredentialHelper) &&
      process.env.ADEV_GIT_CREDENTIAL_PORT &&
      process.env.ADEV_GIT_CREDENTIAL_SESSION
  ),
  secretsInCommandLine: false,
  ssh: {
    launcherReady: fs.existsSync(sshLauncher),
    clientReady: Boolean(nativeDir && fs.existsSync(path.join(nativeDir, 'libbin_dropbearmulti.so'))),
    strictHostKeyChecking: true,
    knownHostsManaged: true,
    keyMaterialization: 'ephemeral app-private lease',
  },
  https: {
    ca: process.env.GIT_SSL_CAINFO || process.env.GIT_SSL_CAPATH || null,
    proxyConfigured: Boolean(
      process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        process.env.https_proxy ||
        process.env.http_proxy
    ),
    redirects: 'initial',
  },
  lfs: {
    ready: Boolean(nativeDir && fs.existsSync(path.join(nativeDir, 'libbin_git_lfs.so'))),
    boundary: 'signed Android feature pack required when false',
  },
  submodules: true,
};

const requiredLinuxCommands = [
  'sh', 'env', 'ls', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'ln', 'chmod', 'touch',
  'find', 'grep', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'uniq', 'xargs',
  'tee', 'diff', 'patch', 'tar', 'gzip', 'gunzip', 'xz', 'base64', 'sha256sum',
  'ps', 'kill', 'pgrep', 'pkill', 'du', 'df', 'id', 'whoami', 'date', 'sleep',
  'timeout', 'mktemp', 'realpath', 'readlink',
];
let busyboxApplets = [];
if (probes.busybox.path) {
  const list = childProcess.spawnSync(probes.busybox.path, ['--list'], {
    encoding: 'utf8',
    timeout: 15000,
    env: process.env,
  });
  if (list.status === 0) busyboxApplets = list.stdout.trim().split(/\r?\n/);
}
const systemCommands = new Set(['sh']);
const missingLinuxCommands = requiredLinuxCommands.filter(
  command => !busyboxApplets.includes(command) && !systemCommands.has(command)
);

const policyFile =
  process.env.ADEV_PACKAGE_POLICY_FILE ||
  path.join(prefix, 'lib', 'adev-runtime-policy.json');
let packagePolicy = null;
try {
  packagePolicy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
} catch (error) {
  packagePolicy = { error: error.message };
}

const nextLauncher =
  process.env.ADEV_NEXT_LAUNCHER || path.join(prefix, 'lib', 'adev-next.js');
const serverEvents = path.join(prefix, 'lib', 'adev-server-events.js');
let nextProject = null;
try {
  const nextManifest = require.resolve('next/package.json', { paths: [process.cwd()] });
  const nextVersion = JSON.parse(fs.readFileSync(nextManifest, 'utf8')).version;
  const nextCache = path.join(
    process.env.ADEV_NEXT_CACHE || path.join(prefix, 'cache', 'next-swc'),
    nextVersion
  );
  const wasmManifest = path.join(
    nextCache,
    'node_modules',
    '@next',
    'swc-wasm-nodejs',
    'package.json'
  );
  nextProject = {
    installed: true,
    version: nextVersion,
    launcherReady: fs.existsSync(nextLauncher),
    wasmCached: fs.existsSync(wasmManifest),
    wasmManifest,
    bundler: 'webpack',
    projectModifiedByLauncher: false,
  };
} catch {
  nextProject = {
    installed: false,
    launcherReady: fs.existsSync(nextLauncher),
    wasmCached: false,
    bundler: 'webpack',
  };
}

const executionTests = {};
if (selfTest || verbose) {
  const testDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'adev-doctor-'));
  const childFile = path.join(testDir, 'fork-child.js');
  fs.writeFileSync(childFile, 'if (process.send) process.send({ok:true}); process.exit(0);');
  executionTests.spawn = probe('spawn', process.execPath, ['-e', 'process.stdout.write("ok")']);
  executionTests.execFile = probe(
    'execFile',
    process.execPath,
    ['-e', 'require("child_process").execFile(process.execPath,["-e","process.exit(0)"],e=>process.exit(e?1:0))']
  );
  executionTests.exec = probe(
    'exec',
    process.execPath,
    ['-e', 'require("child_process").exec("node --version",e=>process.exit(e?1:0))']
  );
  executionTests.fork = probe(
    'fork',
    process.execPath,
    ['-e', `require("child_process").fork(${JSON.stringify(childFile)}).on("exit",c=>process.exit(c||0))`]
  );
  const shell = process.env.MOBILEIDE_BASH || '/system/bin/sh';
  executionTests.nestedShell = probe('nested-shell', shell, ['-c', 'node -e "process.exit(0)"']);
  if (selfTest) {
    executionTests.curlHttps = probe(
      'curl-https',
      process.env.MOBILEIDE_CURL || native('curl'),
      ['--fail', '--silent', '--show-error', '--head', '--max-time', '20', 'https://registry.npmjs.org/'],
      {timeout: 30000}
    );
    executionTests.gitHttps = probe(
      'git-https',
      process.env.MOBILEIDE_GIT || native('git'),
      ['ls-remote', '--heads', 'https://github.com/git/git.git', 'master'],
      {timeout: 30000}
    );
  }
  fs.rmSync(testDir, { recursive: true, force: true });
}

const reportedAbi = process.env.ADEV_ABI || process.arch;
const nanoSupported = ['arm64-v8a', 'arm64', 'aarch64'].includes(reportedAbi);
const nanoTerminfo = path.join(prefix, 'share', 'terminfo');
const nanoSyntax = path.join(prefix, 'share', 'nano');
const nanoUserConfig = path.join(process.env.HOME || '', '.nanorc');
const nanoDataReady =
  fs.existsSync(path.join(nanoTerminfo, 'x', 'xterm-256color')) &&
  countFiles(nanoTerminfo) === 40 &&
  countFiles(nanoSyntax) === 44 &&
  fs.existsSync(nanoUserConfig);
const nanoReady = nanoSupported && probes.nano.ready && nanoDataReady;

const requiredReady = [
  probes.node,
  probes.npm,
  probes.nodeGyp,
  probes.python,
  probes.make,
  probes.clang,
  probes.git,
  probes.curl,
  probes.busybox,
].every(item => item.ready) && (!nanoSupported || nanoReady);
const executionReady = Object.values(executionTests).every(item => item.ready);

const runtimeLockPath = path.join(prefix, 'runtime-lock.json');
const runtimeLockPublicKey = path.join(prefix, 'runtime-lock.pub.pem');
const runtimeLockSignature = path.join(prefix, 'runtime-lock.sig');
let runtimeDistribution = {
  lockReady: false,
  signatureVerified: false,
  error: 'runtime lock missing',
};
try {
  const lockBytes = fs.readFileSync(runtimeLockPath);
  const lock = JSON.parse(lockBytes);
  runtimeDistribution = {
    lockReady: true,
    signatureVerified: crypto.verify(
      null,
      lockBytes,
      fs.readFileSync(runtimeLockPublicKey),
      fs.readFileSync(runtimeLockSignature)
    ),
    runtimeVersion: lock.runtimeVersion,
    minApi: lock.minApi,
    targetApi: lock.targetApi,
    pageAlignment: lock.pageAlignment,
    abis: lock.abis,
  };
} catch (error) {
  runtimeDistribution = {
    lockReady: fs.existsSync(runtimeLockPath),
    signatureVerified: false,
    error: error.message,
  };
}

const report = {
  schemaVersion: 4,
  healthy:
    requiredReady &&
    executionReady &&
    missingLinuxCommands.length === 0 &&
    runtimeDistribution.signatureVerified,
  app: {
    version: process.env.ADEV_APP_VERSION || null,
    runtimeVersion: process.env.ADEV_RUNTIME_VERSION || null,
  },
  device: {
    platform: process.platform,
    arch: process.arch,
    abi: process.env.ADEV_ABI || process.arch,
    androidApi: process.env.ANDROID__BUILD_VERSION_SDK || null,
    libc: 'bionic',
    selinuxContext: process.env.TERMUX__SE_PROCESS_CONTEXT || null,
  },
  paths: {
    prefix,
    home: process.env.HOME || null,
    tmp: process.env.TMPDIR || null,
    nativeLibraryDir: nativeDir,
    nodeHeaders: path.join(prefix, 'include', 'node'),
    caBundle: process.env.SSL_CERT_FILE || process.env.SSL_CERT_DIR || null,
  },
  environment: {
    path: process.env.PATH || null,
    shell: process.env.SHELL || null,
    npmScriptShell:
      process.env.npm_config_script_shell || process.env.NPM_CONFIG_SCRIPT_SHELL || null,
    termuxRootfs: process.env.TERMUX__ROOTFS || null,
    termuxPackage: process.env.TERMUX_APP__PACKAGE_NAME || null,
    termuxExecPreload: Boolean(process.env.LD_PRELOAD),
    globalPlatformSpoof: false,
    npmPlatform: process.env.npm_config_platform || process.env.NPM_CONFIG_PLATFORM || null,
    buildFromSource:
      process.env.npm_config_build_from_source ||
      process.env.NPM_CONFIG_BUILD_FROM_SOURCE ||
      null,
    watchMode: process.env.ADEV_WATCH_MODE || null,
    chokidarPolling: process.env.CHOKIDAR_USEPOLLING || null,
    watchpackPolling: process.env.WATCHPACK_POLLING || null,
    structuredServerEvents:
      fs.existsSync(serverEvents) && (process.env.NODE_OPTIONS || '').includes(serverEvents),
  },
  compiler: {
    api: process.env.ADEV_NATIVE_BUILD_API || null,
    cc: process.env.CC || null,
    cxx: process.env.CXX || null,
    ar: process.env.AR || null,
    ld: process.env.LD || null,
    ldflags: process.env.LDFLAGS || null,
    nodeHeadersReady: fs.existsSync(path.join(prefix, 'include', 'node', 'node.h')),
  },
  packageResolution: packagePolicy,
  packageManagers,
  runtimeDistribution,
  git: gitIntegration,
  toolPacks,
  bun: {
    supported: false,
    capabilityGateReady: fs.existsSync(bunBoundary),
    platform: 'android',
    libc: 'bionic',
    alternative: 'node/npm/npx/pnpm/yarn',
    upstream: 'https://bun.sh/docs/installation',
  },
  opencode: {
    ready: false,
    diagnosticsReady: probes.opencode.ready,
    version: probes.opencode.version,
    platform: 'android-bionic',
    abi: process.env.ADEV_ABI || process.arch,
    supportedAbis: ['arm64-v8a'],
    delivery: 'APK native library',
    globalLinuxSpoof: false,
    capabilities: {
      version: probes.opencode.ready,
      help: true,
      debugPaths: probes.opencode.ready,
      interactiveTui: false,
      agentRun: false,
      serve: false,
      web: false,
    },
    boundary: probes.opencode.ready
      ? 'The installed ARM64 payload is diagnostic-only: available upstream Android Bun/OpenTUI builds abort in native Bionic code for TUI, run, serve, and web modes.'
      : 'No verified Android/Bionic OpenCode diagnostic payload is available for this ABI.',
  },
  nano: {
    ready: nanoReady,
    executableReady: probes.nano.ready,
    version: probes.nano.version,
    platform: 'android-bionic',
    abi: reportedAbi,
    supportedAbis: ['arm64-v8a'],
    terminfo: process.env.TERMINFO || null,
    terminfoEntries: countFiles(nanoTerminfo),
    syntaxDefinitions: countFiles(nanoSyntax),
    userConfigReady: fs.existsSync(nanoUserConfig),
    boundary: nanoSupported
      ? (nanoReady ? null : 'Nano is incomplete: check the native payload, TERMINFO, syntax data, and generated user config.')
      : 'Nano is not bundled for x86_64; use vi until a pinned Android/Bionic x86_64 payload is verified.',
  },
  frameworks: {
    next: nextProject,
    serverEvents: {
      ready: fs.existsSync(serverEvents),
      path: serverEvents,
      requiresVerifiedLoopbackProbe: true,
    },
  },
  linuxCommandSuite: {
    required: requiredLinuxCommands,
    provider: 'busybox with /system/bin fallback',
    missing: missingLinuxCommands,
    ready: missingLinuxCommands.length === 0,
  },
  commands: probes,
  executableTests: executionTests,
};

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`A Dev Studio ${report.app.version || '?'} / runtime ${report.app.runtimeVersion || '?'}\n`);
  process.stdout.write(
    `Android API ${report.device.androidApi || '?'} ${report.device.abi} (${report.device.libc})\n`
  );
  for (const item of Object.values(probes)) {
    process.stdout.write(
      `${item.ready ? 'OK' : 'FAIL'}  ${item.name}: ${item.version || item.error || 'unknown'}\n`
    );
  }
  process.stdout.write(
    `Package policy: ${(packagePolicy.resolutionOrder || []).join(' -> ') || 'unavailable'}\n`
  );
  process.stdout.write(`Platform spoof: disabled\n`);
  process.stdout.write(
    `Watch mode: ${report.environment.watchMode || 'unknown'} (polling only on shared/FUSE storage)\n`
  );
  process.stdout.write(
    `Server events: ${report.frameworks.serverEvents.ready ? 'ready' : 'missing'}; preview ports require loopback verification\n`
  );
  process.stdout.write(
    `Git credentials: ${gitIntegration.credentialBrokerReady ? 'Keystore broker ready' : 'broker missing'}; ` +
      `SSH host checks ${gitIntegration.ssh.strictHostKeyChecking ? 'strict' : 'unsafe'}; ` +
      `LFS ${gitIntegration.lfs.ready ? 'ready' : 'feature-gated'}\n`
  );
  process.stdout.write(
    `Package managers: Corepack ${packageManagers.corepack?.version || '?'}; ` +
      `pnpm ${packageManagers.pnpm?.bundledVersion || '?'} ` +
      `${packageManagers.pnpm?.offlineReady ? 'offline-ready' : 'network/cache'}; ` +
      `Yarn ${packageManagers.yarn?.bundledVersion || '?'} ` +
      `${packageManagers.yarn?.offlineReady ? 'offline-ready' : 'network/cache'}\n`
  );
  process.stdout.write(
    `Tool-pack catalog: ${toolPacks.catalogVerified ? 'signature verified' : 'invalid'}; ` +
      `Bun: unsupported Android/Bionic boundary\n`
  );
  process.stdout.write(
    `OpenCode: ${report.opencode.diagnosticsReady ? 'version/help diagnostics ready' : 'diagnostics unavailable'}; ` +
      `TUI/run/server unsupported by the verified Android payload\n`
  );
  process.stdout.write(
    `Nano: ${report.nano.ready ? 'ready' : report.nano.boundary}; ` +
      `${report.nano.terminfoEntries} terminfo entries, ${report.nano.syntaxDefinitions} syntax files\n`
  );
  if (nextProject.installed) {
    process.stdout.write(
      `Next.js: ${nextProject.version}; webpack launcher ${nextProject.launcherReady ? 'ready' : 'missing'}; WASM ${nextProject.wasmCached ? 'cached' : 'will be cached on first run'}\n`
    );
  }
  process.stdout.write(
    `Linux command suite: ${missingLinuxCommands.length === 0 ? 'ready' : `missing ${missingLinuxCommands.join(', ')}`}\n`
  );
  if (verbose) {
    process.stdout.write(`PATH=${report.environment.path}\n`);
    process.stdout.write(`SELinux=${report.device.selinuxContext || 'unavailable'}\n`);
    for (const item of Object.values(executionTests)) {
      process.stdout.write(`${item.ready ? 'OK' : 'FAIL'}  ${item.name}\n`);
    }
  }
}
process.exitCode = report.healthy ? 0 : 1;
