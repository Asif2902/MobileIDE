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

// Package capability policy — reports Android/Bionic honestly, no platform spoof.
load('adev-runtime-policy.js');
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
