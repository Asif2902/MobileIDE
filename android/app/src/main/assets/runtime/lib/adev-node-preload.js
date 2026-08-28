'use strict';

/**
 * The one and only module A Dev Studio puts on NODE_OPTIONS.
 *
 * NODE_OPTIONS must carry exactly one `--require`. Next.js reads NODE_OPTIONS,
 * parses it with `parseArgs`, joins repeated values for the same option with a
 * space and re-serialises the result before spawning its dev and build workers.
 * Two `--require` flags therefore arrive in the worker as a single option whose
 * value is `"/path/a.js /path/b.js"` — one unresolvable module path — and every
 * worker dies with MODULE_NOT_FOUND before it does any work. Vite, Jest and
 * anything else that round-trips NODE_OPTIONS has the same shape of problem.
 *
 * So the runtime preloads this file, and this file loads everything else.
 * Nothing here may throw: a preload failure takes down an otherwise healthy
 * process before user code runs.
 */

const path = require('node:path');
const dns = require('node:dns');

// Node 17+ may prefer IPv6 for "localhost". Android Chrome does too.
// Keep Node's own loopback fetches on IPv4 first so they match 127.0.0.1.
if (typeof dns.setDefaultResultOrder === 'function') {
  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    // Older Node builds reject an unknown order; leave the default.
  }
}

function load(name) {
  try {
    require(path.join(__dirname, name));
    return true;
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return false;
    process.stderr.write(`adev: preload ${name} failed: ${error.message}\n`);
    return false;
  }
}

// Exact Android native prebuilds are installed before upstream lifecycle
// scripts fall back to irrelevant Linux/CMake paths. This may intentionally
// finish the matching lifecycle process, so it must run before other hooks.
load('adev-native-addon-lifecycle.js');

// Package capability policy — reports Android/Bionic honestly, no platform spoof.
load('adev-runtime-policy.js');
// Route only Android-noexec scripts/runtime shims through the APK-native env
// executable. The launcher embeds the same recursive C resolver as LD_PRELOAD,
// so this also covers a Node child that received the preload text too late for
// the dynamic linker to interpose its already-bound child_process symbols.
load('adev-child-process-compat.js');
// Structured listen/exit events for the app's Output panel and port routing.
load('adev-server-events.js');

// Next.js SWC bridge. The loader hook is installed in every process (CLI,
// next-server, webpack workers). Mapping preparation only runs for the CLI.
try {
  const swc = require(path.join(__dirname, 'adev-next-swc.js'));
  swc.installNextSwcHooks();
  swc.bootstrap();
} catch (error) {
  if (!error || error.code !== 'MODULE_NOT_FOUND') {
    process.stderr.write(`adev: Next.js SWC bridge failed: ${error.message}\n`);
  }
}
