'use strict';

/**
 * Android child-process compatibility for ordinary Node APIs.
 *
 * Android 10+ rejects direct exec of scripts and shims in writable app/shared
 * storage. ADEV's libc preload normally resolves their shebang before execve,
 * but a Node process created by Bun/OpenCode can receive the LD_PRELOAD string
 * after its dynamic linker already bound exec/posix_spawn. In that process the
 * environment looks correct while spawnSync still reaches Android as EACCES.
 *
 * Only commands that actually require Android translation are routed through
 * MOBILEIDE_ENV, a real APK-native executable which embeds ADEV's same bounded
 * recursive C resolver. Native /system and /data/app executables remain on
 * Node's unmodified fast path. This is command-class based, never package based.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const INSTALL_MARK = Symbol.for('adev.childProcessCompat.installed');
const SYSTEM_SHELL = '/system/bin/sh';
const VIRTUAL_EXECUTABLES = new Set([
  '/bin/sh',
  '/usr/bin/sh',
  '/bin/env',
  '/usr/bin/env',
  '/data/data/com.termux/files/usr/bin/sh',
  '/data/user/0/com.termux/files/usr/bin/sh',
]);
const WRITABLE_ANDROID_PREFIXES = [
  '/data/data/',
  '/data/user/',
  '/sdcard/',
  '/storage/emulated/',
  '/storage/self/primary/',
  '/mnt/runtime/',
  '/mnt/media_rw/',
];

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function nativeEnvLauncher(environment = process.env) {
  const configured = environment.MOBILEIDE_ENV || process.env.MOBILEIDE_ENV;
  if (configured && path.isAbsolute(configured) && isFile(configured)) return configured;
  const sibling = path.join(path.dirname(process.execPath), 'libbin_adev_env.so');
  return path.isAbsolute(sibling) && isFile(sibling) ? sibling : '';
}

function nativeCommandShell(environment = process.env) {
  for (const candidate of [
    environment.npm_config_script_shell,
    environment.NPM_CONFIG_SCRIPT_SHELL,
    process.env.npm_config_script_shell,
    process.env.NPM_CONFIG_SCRIPT_SHELL,
    path.join(path.dirname(process.execPath), 'libbin_adev_npm_shell.so'),
  ]) {
    if (candidate && path.isAbsolute(candidate) && isFile(candidate)) return candidate;
  }
  return SYSTEM_SHELL;
}

function pathEntries(environment) {
  const value = environment?.PATH || process.env.PATH || '';
  return value.split(path.delimiter).filter(Boolean);
}

function resolveCommand(command, environment, cwd) {
  if (typeof command !== 'string' || command.length === 0) return '';
  if (command.includes('/') || command.includes('\\')) {
    const candidate = path.isAbsolute(command)
      ? command
      : path.resolve(cwd || process.cwd(), command);
    return isFile(candidate) ? candidate : '';
  }
  for (const directory of pathEntries(environment)) {
    const candidate = path.join(directory, command);
    if (isFile(candidate)) return candidate;
  }
  return '';
}

function hasShebang(file) {
  if (!file) return false;
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const magic = Buffer.allocUnsafe(2);
    return fs.readSync(descriptor, magic, 0, 2, 0) === 2 && magic[0] === 0x23 && magic[1] === 0x21;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
  }
}

function nativeResolverLoaded() {
  try {
    return fs
      .readFileSync('/proc/self/maps', 'utf8')
      .includes('/liblib_adev_exec_compat.so');
  } catch {
    return false;
  }
}

function isWritableAndroidPath(file) {
  return WRITABLE_ANDROID_PREFIXES.some(prefix => file.startsWith(prefix));
}

function route(command, options = {}) {
  if (typeof command !== 'string' || command.length === 0) return null;
  const environment = options.env || process.env;
  const launcher = nativeEnvLauncher(environment);
  if (!launcher) return null;
  // adev_env already *is* the ADEV replacement for /usr/bin/env. Passing the
  // virtual path back to it would make it look for a file Android does not
  // have. Shell aliases, on the other hand, become Android's real system shell.
  if (command === '/bin/env' || command === '/usr/bin/env') {
    return {launcher, target: null};
  }
  if (VIRTUAL_EXECUTABLES.has(command)) {
    return {launcher, target: nativeCommandShell(environment)};
  }

  const resolved = resolveCommand(command, environment, options.cwd);
  if (!resolved) return null;
  if (!hasShebang(resolved) && !isWritableAndroidPath(resolved)) return null;

  // A writable symlink to an APK-native ELF is safe by its canonical target;
  // passing that target avoids asking Android to exec the noexec link itself.
  if (!hasShebang(resolved)) {
    try {
      const canonical = fs.realpathSync(resolved);
      if (canonical.startsWith('/data/app/') && isFile(canonical)) {
        // This is already an Android-executable APK ELF. Execute its canonical
        // target directly; wrapping env around env would make the randomized
        // install path (which contains '=') look like an env assignment.
        return {launcher: canonical, target: null};
      }
    } catch {}
  }
  return {launcher, target: resolved};
}

function normalizedShell(shell, environment) {
  if (shell === true || VIRTUAL_EXECUTABLES.has(shell)) {
    return nativeCommandShell(environment);
  }
  return shell;
}

function normalizedOptions(options) {
  if (!options || typeof options !== 'object') return options;
  const shell = normalizedShell(options.shell, options.env || process.env);
  return shell === options.shell ? options : {...options, shell};
}

function routedArgs(plan, argv) {
  return plan.target ? [plan.target, ...argv] : argv;
}

function install() {
  if (globalThis[INSTALL_MARK]) return false;
  // When the native resolver was loaded by the dynamic linker, it preserves
  // errno semantics (including ELOOP/ENOEXEC) better than any JS wrapper can.
  // The bridge exists only for the late-environment boundary where LD_PRELOAD
  // is present as text but this library is absent from the process mappings.
  if (nativeResolverLoaded()) return false;
  const launcher = nativeEnvLauncher(process.env);
  if (!launcher) return false;
  globalThis[INSTALL_MARK] = true;

  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  const originalExec = childProcess.exec;
  const originalExecSync = childProcess.execSync;

  childProcess.spawn = function adevSpawn(command, args, options) {
    const hasArgs = Array.isArray(args);
    const argv = hasArgs ? args : [];
    const opts = normalizedOptions((hasArgs ? options : args) || {});
    const plan = route(command, opts);
    return plan
      ? originalSpawn.call(this, plan.launcher, routedArgs(plan, argv), opts)
      : originalSpawn.call(this, command, ...(hasArgs ? [args, opts] : [opts]));
  };

  childProcess.spawnSync = function adevSpawnSync(command, args, options) {
    const hasArgs = Array.isArray(args);
    const argv = hasArgs ? args : [];
    const opts = normalizedOptions((hasArgs ? options : args) || {});
    const plan = route(command, opts);
    return plan
      ? originalSpawnSync.call(this, plan.launcher, routedArgs(plan, argv), opts)
      : originalSpawnSync.call(this, command, ...(hasArgs ? [args, opts] : [opts]));
  };

  childProcess.execFile = function adevExecFile(file, args, options, callback) {
    let argv = [];
    let opts = {};
    let done;
    if (Array.isArray(args)) {
      argv = args;
      if (typeof options === 'function') done = options;
      else {
        opts = options || {};
        done = callback;
      }
    } else if (typeof args === 'function') done = args;
    else {
      opts = args || {};
      done = options;
    }
    opts = normalizedOptions(opts);
    const plan = route(file, opts);
    return originalExecFile.call(
      this,
      plan ? plan.launcher : file,
      plan ? routedArgs(plan, argv) : argv,
      opts,
      done,
    );
  };

  childProcess.execFileSync = function adevExecFileSync(file, args, options) {
    const hasArgs = Array.isArray(args);
    const argv = hasArgs ? args : [];
    const opts = normalizedOptions((hasArgs ? options : args) || {});
    const plan = route(file, opts);
    return originalExecFileSync.call(
      this,
      plan ? plan.launcher : file,
      plan ? routedArgs(plan, argv) : argv,
      opts,
    );
  };

  childProcess.exec = function adevExec(command, options, callback) {
    let opts = options;
    let done = callback;
    if (typeof options === 'function') {
      opts = {};
      done = options;
    }
    const shell = normalizedShell(opts?.shell || true, opts?.env || process.env);
    return originalExec.call(this, command, {...(opts || {}), shell}, done);
  };

  childProcess.execSync = function adevExecSync(command, options) {
    const opts = options || {};
    const shell = normalizedShell(opts.shell || true, opts.env || process.env);
    return originalExecSync.call(this, command, {...opts, shell});
  };

  return true;
}

install();

module.exports = {
  install,
  nativeResolverLoaded,
  route,
  resolveCommand,
  nativeCommandShell,
  SYSTEM_SHELL,
};
