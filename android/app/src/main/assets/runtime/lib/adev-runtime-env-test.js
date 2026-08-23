'use strict';

/**
 * On-device regression suite for the A Dev Studio runtime environment contract.
 *
 * Everything here is a property that broke in practice: a tool that saw a
 * different HOME from its parent, an XDG directory nothing had created, a TLS
 * trust store only some processes knew about, a Termux path compiled into a
 * bundled artifact, a NODE_OPTIONS value Next.js could not round-trip, or a
 * WebAssembly compiler the build workers could not resolve.
 *
 * Run with `--network` to include verified-HTTPS checks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const network = process.argv.includes('--network');
const failures = [];
let checks = 0;

function check(name, run) {
  checks++;
  try {
    const detail = run();
    process.stdout.write(`  ok   ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    process.stdout.write(`  FAIL ${name} — ${error.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
    timeout: options.timeoutMs || 120000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

const runtimeRoot = process.env.ADEV_RUNTIME || process.env.PREFIX;
const shellContract = path.join(runtimeRoot || '', 'etc', 'adev-env.sh');
const confContract = path.join(runtimeRoot || '', 'etc', 'adev-env.conf');

// ---------------------------------------------------------------------------
// The contract exists, is complete, and every value is usable.
// ---------------------------------------------------------------------------

const CONTRACT = [
  'ADEV_RUNTIME',
  'PREFIX',
  'HOME',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'LD_LIBRARY_PATH',
  'NODE_PATH',
  'SSL_CERT_FILE',
];

process.stdout.write('A Dev Studio runtime environment contract\n');

check('runtime root is known', () => {
  assert(runtimeRoot, 'neither ADEV_RUNTIME nor PREFIX is set');
  assert(fs.existsSync(runtimeRoot), `${runtimeRoot} does not exist`);
  return runtimeRoot;
});

check('contract is published for shells and native tools', () => {
  assert(fs.existsSync(shellContract), `${shellContract} is missing`);
  assert(fs.existsSync(confContract), `${confContract} is missing`);
  const conf = fs.readFileSync(confContract, 'utf8');
  for (const name of CONTRACT) {
    assert(new RegExp(`^${name}=`, 'm').test(conf), `${name} is not published`);
  }
  return `${conf.trim().split('\n').length} lines`;
});

check('every contract variable is set in this process', () => {
  const missing = CONTRACT.filter(name => !process.env[name]);
  assert(missing.length === 0, `unset: ${missing.join(', ')}`);
});

check('no contract value points at a Termux installation', () => {
  const stale = Object.entries(process.env)
    .filter(([, value]) => typeof value === 'string' && value.includes('/com.termux/'))
    .map(([name]) => name);
  assert(stale.length === 0, `stale Termux paths in: ${stale.join(', ')}`);
});

check('directories the contract promises exist and are writable', () => {
  const directories = [
    process.env.HOME,
    path.join(process.env.HOME || '', '.cache'),
    process.env.TMPDIR,
    process.env.XDG_CACHE_HOME,
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_DATA_HOME,
    process.env.XDG_STATE_HOME,
    process.env.XDG_RUNTIME_DIR,
  ];
  for (const directory of directories) {
    assert(directory, 'a required directory variable is empty');
    assert(fs.statSync(directory).isDirectory(), `${directory} is not a directory`);
    const probe = path.join(directory, `.adev-env-probe-${process.pid}`);
    fs.writeFileSync(probe, 'probe');
    fs.unlinkSync(probe);
  }
  return `${directories.length} directories`;
});

// ---------------------------------------------------------------------------
// Every runtime agrees with every other one.
// ---------------------------------------------------------------------------

check('Node, Python and the shell agree on the contract', () => {
  const shellValues = run(process.env.SHELL || '/system/bin/sh', [
    '-c',
    CONTRACT.map(name => `printf '%s\\n' "$${name}"`).join('; '),
  ]);
  assert(shellValues.status === 0, `shell probe exited ${shellValues.status}`);
  const fromShell = shellValues.stdout.split('\n');

  const nodeValues = run(process.execPath, [
    '-e',
    `process.stdout.write(${JSON.stringify(CONTRACT)}.map(n => process.env[n] || '').join('\\n'))`,
  ]);
  assert(nodeValues.status === 0, `node probe exited ${nodeValues.status}`);
  const fromNode = nodeValues.stdout.split('\n');

  const python = process.env.PYTHON || 'python';
  const pythonValues = run(python, [
    '-c',
    `import os;print('\\n'.join(os.environ.get(n,'') for n in ${JSON.stringify(CONTRACT)}))`,
  ]);
  assert(pythonValues.status === 0, `python probe exited ${pythonValues.status}`);
  const fromPython = pythonValues.stdout.split('\n');

  CONTRACT.forEach((name, index) => {
    // PATH may legitimately gain entries; every other value must be identical.
    if (name === 'PATH') return;
    assert(
      fromShell[index] === fromNode[index] && fromNode[index] === fromPython[index],
      `${name} differs: shell=${fromShell[index]} node=${fromNode[index]} python=${fromPython[index]}`,
    );
  });
});

check('HOME resolves the same way in every runtime', () => {
  const home = process.env.HOME;
  assert(os.homedir() === home, `Node os.homedir()=${os.homedir()}`);
  const python = process.env.PYTHON || 'python';
  const expanded = run(python, ['-c', 'import os;print(os.path.expanduser("~"))']);
  assert(expanded.stdout === home, `Python expanduser=${expanded.stdout}`);
  return home;
});

check('a grandchild process still has the contract', () => {
  const inner = run(process.execPath, [
    '-e',
    "const {spawnSync}=require('child_process');" +
      "const r=spawnSync(process.env.SHELL||'/system/bin/sh',['-c','printf %s \"$XDG_CACHE_HOME|$HOME|$SSL_CERT_FILE\"'],{encoding:'utf8'});" +
      'process.stdout.write(r.stdout||"")',
  ]);
  const [cache, home, certificates] = inner.stdout.split('|');
  assert(cache === process.env.XDG_CACHE_HOME, `XDG_CACHE_HOME=${cache}`);
  assert(home === process.env.HOME, `HOME=${home}`);
  assert(certificates === process.env.SSL_CERT_FILE, `SSL_CERT_FILE=${certificates}`);
});

// ---------------------------------------------------------------------------
// Execution: shebangs, interpreters and the `env` bridge.
// ---------------------------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR, 'adev-env-suite-'));
try {
  check('standard shebangs run', () => {
    const cases = [
      ['env-node.js', '#!/usr/bin/env node\nconsole.log("ok")\n'],
      ['env-python.py', '#!/usr/bin/env python\nprint("ok")\n'],
      ['env-python3.py', '#!/usr/bin/env python3\nprint("ok")\n'],
      ['system-sh.sh', '#!/system/bin/sh\necho ok\n'],
      ['bin-sh.sh', '#!/bin/sh\necho ok\n'],
      ['env-bash.sh', '#!/usr/bin/env bash\necho ok\n'],
    ];
    for (const [name, body] of cases) {
      const file = path.join(scratch, name);
      fs.writeFileSync(file, body, {mode: 0o755});
      const result = run(file, []);
      assert(result.status === 0, `${name} exited ${result.status}: ${result.stderr}`);
      assert(result.stdout === 'ok', `${name} printed ${JSON.stringify(result.stdout)}`);
    }
    return `${cases.length} interpreters`;
  });

  check('an interpreter that is itself a script still resolves', () => {
    const interpreter = path.join(scratch, 'interpreter.js');
    fs.writeFileSync(
      interpreter,
      '#!/usr/bin/env node\nconsole.log("chained")\n',
      {mode: 0o755},
    );
    const script = path.join(scratch, 'chained.txt');
    fs.writeFileSync(script, `#!${interpreter}\npayload\n`, {mode: 0o755});
    const result = run(script, []);
    assert(result.status === 0, `exited ${result.status}: ${result.stderr}`);
    assert(result.stdout === 'chained', result.stdout);
  });

  check('`env` runs the runtime interpreters, not Toybox behaviour', () => {
    for (const [command, args, expected] of [
      ['node', ['-e', 'console.log("node")'], 'node'],
      ['python', ['-c', 'print("python")'], 'python'],
    ]) {
      const result = run('env', [command, ...args]);
      assert(
        result.status === 0 && result.stdout === expected,
        `env ${command} exited ${result.status}: ${result.stderr || result.stdout}`,
      );
    }
  });

  check('`env` is a real executable ahead of the system one', () => {
    const first = (process.env.PATH || '').split(':')[0];
    const shim = path.join(first, 'env');
    assert(fs.existsSync(shim), `${shim} is missing from the front of PATH`);
    const header = fs.openSync(shim, 'r');
    try {
      const magic = Buffer.alloc(4);
      fs.readSync(header, magic, 0, 4, 0);
      assert(
        magic.toString('binary') === '\x7fELF',
        `PATH's first env is not an ELF executable (magic ${magic.toString('hex')})`,
      );
    } finally {
      fs.closeSync(header);
    }
    return shim;
  });

  // ---------------------------------------------------------------------------
  // Python: no Termux shell, real TLS trust.
  // ---------------------------------------------------------------------------

  check('Python subprocesses use an ADEV shell', () => {
    const python = process.env.PYTHON || 'python';
    const popen = run(python, ['-c', 'import os;print(os.popen("echo hello").read().strip())']);
    assert(popen.status === 0 && popen.stdout === 'hello', popen.stderr || popen.stdout);
    const shell = run(python, [
      '-c',
      'import subprocess;print(subprocess.run("echo hello", shell=True, capture_output=True, text=True).stdout.strip())',
    ]);
    assert(shell.status === 0 && shell.stdout === 'hello', shell.stderr || shell.stdout);
  });

  check('Python trusts the runtime CA bundle', () => {
    const python = process.env.PYTHON || 'python';
    const paths = run(python, [
      '-c',
      'import ssl;p=ssl.get_default_verify_paths();print(p.cafile or "")',
    ]);
    assert(
      paths.stdout === process.env.SSL_CERT_FILE,
      `OpenSSL cafile=${paths.stdout} but SSL_CERT_FILE=${process.env.SSL_CERT_FILE}`,
    );
    const bundle = fs.readFileSync(process.env.SSL_CERT_FILE, 'utf8');
    const count = (bundle.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    assert(count > 20, `CA bundle holds only ${count} certificates`);
    assert(
      !/Certificate:\s*\n\s*Data:/.test(bundle),
      'CA bundle contains OpenSSL text dumps rather than certificate blocks only',
    );
    return `${count} trust anchors`;
  });

  if (network) {
    check('Python HTTPS verifies certificates', () => {
      const python = process.env.PYTHON || 'python';
      const result = run(python, [
        '-c',
        'import urllib.request;print(urllib.request.urlopen("https://github.com", timeout=30).status)',
      ], {timeoutMs: 90000});
      assert(result.status === 0, result.stderr);
      assert(result.stdout === '200', result.stdout);
    });

    check('Node HTTPS verifies certificates', () => {
      const result = run(process.execPath, [
        '-e',
        "require('https').get('https://registry.npmjs.org/-/ping',r=>{console.log(r.statusCode);r.resume()}).on('error',e=>{console.error(e.message);process.exit(1)})",
      ], {timeoutMs: 90000});
      assert(result.status === 0, result.stderr);
      assert(result.stdout === '200', result.stdout);
    });
  }

  // ---------------------------------------------------------------------------
  // npm discovery without any manual PREFIX.
  // ---------------------------------------------------------------------------

  check('npm resolves its prefix and global root by itself', () => {
    const clean = {...process.env};
    delete clean.PREFIX;
    delete clean.ADEV_RUNTIME;
    const root = run('npm', ['root', '-g'], {env: clean});
    assert(root.status === 0, root.stderr);
    assert(root.stdout.startsWith('/'), root.stdout);
    const prefix = run('npm', ['prefix', '-g'], {env: clean});
    assert(prefix.status === 0, prefix.stderr);
    return `${prefix.stdout}`;
  });

  check('the Next launcher finds npm without PREFIX', () => {
    const clean = {...process.env};
    delete clean.PREFIX;
    delete clean.ADEV_NPM_CLI;
    delete clean.ADEV_RUNTIME;
    const result = run(process.execPath, [
      '-e',
      `process.chdir(${JSON.stringify(scratch)});` +
        `const swc=require(${JSON.stringify(path.join(__dirname, 'adev-next-swc.js'))});` +
        'const cli=swc.npmCli();' +
        "process.stdout.write(cli || 'none')",
    ], {env: clean});
    assert(result.stdout !== 'none', 'the bundled npm CLI was not found');
    assert(fs.existsSync(result.stdout), `${result.stdout} does not exist`);
    return result.stdout;
  });

  // ---------------------------------------------------------------------------
  // NODE_OPTIONS must survive Next.js's parse/serialise round trip.
  // ---------------------------------------------------------------------------

  check('NODE_OPTIONS carries exactly one --require', () => {
    const options = process.env.NODE_OPTIONS || '';
    const count = (options.match(/--require/g) || []).length;
    assert(count === 1, `${count} --require flags in NODE_OPTIONS: ${options}`);
  });

  check('NODE_OPTIONS survives the Next.js worker round trip', () => {
    // Next parses NODE_OPTIONS, joins repeated values for one option with a
    // space and re-serialises before spawning dev/build workers. Reproduce that
    // exactly and confirm the result still starts a Node process.
    const {parseArgs} = require('node:util');
    const args = (process.env.NODE_OPTIONS || '').split(' ').filter(Boolean);
    const {tokens} = parseArgs({args, strict: false, tokens: true});
    const values = {};
    for (const token of tokens) {
      if (token.kind !== 'option' || token.value === undefined) continue;
      const name = token.name;
      values[name] =
        name in values && typeof values[name] === 'string'
          ? `${values[name]} ${token.value}`
          : token.value;
    }
    const reserialised = Object.entries(values)
      .map(([key, value]) =>
        value === true
          ? `--${key}`
          : `--${key}=${String(value).includes(' ') ? JSON.stringify(value) : value}`,
      )
      .join(' ');
    const result = run(process.execPath, ['-e', 'process.stdout.write("worker-ok")'], {
      env: {...process.env, NODE_OPTIONS: reserialised},
    });
    assert(
      result.status === 0 && result.stdout === 'worker-ok',
      `a Next-style worker could not start with NODE_OPTIONS=${reserialised}: ${result.stderr}`,
    );
    return reserialised;
  });

  // ---------------------------------------------------------------------------
  // Next.js SWC layout.
  // ---------------------------------------------------------------------------

  check('the SWC cache keeps the scoped package layout', () => {
    const swc = require(path.join(__dirname, 'adev-next-swc.js'));
    assert(swc.SPECIFIER === '@next/swc-wasm-nodejs', swc.SPECIFIER);
    const relative = path
      .relative(swc.cacheRoot('0.0.0'), swc.cachedPackageDir('0.0.0'))
      .split(path.sep)
      .join('/');
    assert(
      relative === 'node_modules/@next/swc-wasm-nodejs',
      `scoped layout is wrong: ${relative}`,
    );
    const project = path.join(scratch, 'next-project');
    fs.mkdirSync(path.join(project, 'node_modules', 'next'), {recursive: true});
    fs.writeFileSync(path.join(project, 'package.json'), '{"private":true}\n');
    fs.writeFileSync(
      path.join(project, 'node_modules', 'next', 'package.json'),
      JSON.stringify({name: 'next', version: '0.0.0'}),
    );
    // Both mappings must keep the scoped `@next/` directory level; a flat
    // `swc-wasm-nodejs` directory does not resolve for either of Next's two
    // load paths. Compare by suffix: Android exposes the app data directory as
    // both /data/user/0/<package> and /data/data/<package>, and Node's resolver
    // reports the canonical one, so the prefixes legitimately differ.
    const targets = swc
      .projectTargets(project, swc.resolveNext(project))
      .map(target => target.split(path.sep).join('/'));
    assert(
      targets[0].endsWith('/node_modules/@next/swc-wasm-nodejs'),
      `bare-specifier mapping is wrong: ${targets[0]}`,
    );
    assert(
      targets[1].endsWith('/node_modules/next/wasm/@next/swc-wasm-nodejs'),
      `exact-path mapping is wrong: ${targets[1]}`,
    );
    return `${targets.length} scoped mappings`;
  });

  check('HTTP servers bind dual-stack so localhost and 127.0.0.1 both work', () => {
    const listen = require(path.join(__dirname, 'adev-listen-compat.js'));
    const rewritten = listen.normalizeListenArgs([3000, process.env.HOST || '0.0.0.0']);
    assert(rewritten.options.host === '::', JSON.stringify(rewritten.options));
    assert(rewritten.options.ipv6Only === false, 'IPv4-mapped loopback needs ipv6Only false');
    return `${process.env.HOST || '0.0.0.0'} → ${rewritten.options.host} ipv6Only=${rewritten.options.ipv6Only}`;
  });

  check('Next 14 SWC loader is rewritten to load WASM first on Android', () => {
    const swc = require(path.join(__dirname, 'adev-next-swc.js'));
    const next14 =
      'const knownDefaultWasmFallbackTriples = ["aarch64-linux-android"];\n' +
      'const shouldLoadWasmFallbackFirst = !disableWasmFallback && unsupportedPlatform && useWasmBinary || isWebContainer;';
    const next15 =
      'const knownDefaultWasmFallbackTriples = ["aarch64-linux-android"];\n' +
      'const shouldLoadWasmFallbackFirst = !disableWasmFallback && useWasmBinary || unsupportedPlatform || isWebContainer;';
    const rewritten = swc.preferAndroidWasmLoader(next14);
    assert(
      /\|\|\s*unsupportedPlatform/.test(rewritten),
      `Next 14 loader was not rewritten for WASM-first: ${rewritten}`,
    );
    assert(
      !/unsupportedPlatform\s*&&\s*useWasmBinary/.test(rewritten),
      'rewritten Next 14 loader still requires useWasmBinary on Android',
    );
    assert(
      swc.preferAndroidWasmLoader(next15) === next15,
      'Next 15 loader must be left alone',
    );
    return 'Next 14 → WASM-first; Next 15 unchanged';
  });

  // ---------------------------------------------------------------------------
  // The packaged sysroot points at this installation.
  // ---------------------------------------------------------------------------

  check('packaged sysroot files were retargeted away from Termux', () => {
    const index = path.join(runtimeRoot, 'prefix-retarget.json');
    assert(fs.existsSync(index), 'prefix-retarget.json is missing');
    const manifest = JSON.parse(fs.readFileSync(index, 'utf8'));
    let inspected = 0;
    for (const relative of manifest.files) {
      const file = path.join(runtimeRoot, relative);
      if (!fs.existsSync(file)) continue;
      const contents = fs.readFileSync(file, 'utf8');
      assert(
        !contents.includes(manifest.packagedPrefix),
        `${relative} still names ${manifest.packagedPrefix}`,
      );
      inspected++;
    }
    assert(inspected > 0, 'no packaged sysroot files were found to verify');
    return `${inspected} files`;
  });
} finally {
  fs.rmSync(scratch, {recursive: true, force: true});
}

process.stdout.write(
  `\n${checks - failures.length}/${checks} runtime environment checks passed` +
    `${network ? ' (with network)' : ''}.\n`,
);
if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} failure(s):\n`);
  failures.forEach(failure => process.stdout.write(`  - ${failure}\n`));
  process.exitCode = 1;
}
