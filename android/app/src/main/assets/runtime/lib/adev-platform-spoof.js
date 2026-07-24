/**
 * A Dev Studio — report linux/arm64 instead of android to package managers.
 *
 * Many CLIs (opencode, codex, esbuild, swc, …) ship prebuilt binaries as
 * optionalDependencies keyed by npm's idea of process.platform / process.arch.
 * On Android, Node often reports platform "android", so npm looks for
 * "*-android-arm64" packages that do not exist and the install fails.
 *
 * Loaded via NODE_OPTIONS=--require so every node/npm process inherits it.
 *
 * NOTE: This only fixes *selection* of packages. A glibc-linked linux binary
 * may still fail to execute on Android (bionic). Prefer musl/static builds or
 * Android-specific artifacts when available.
 */
(function () {
  'use strict';
  try {
    var os = require('os');

    try {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        enumerable: true,
        get: function () { return 'linux'; }
      });
    } catch (e) {
      try { process.platform = 'linux'; } catch (e2) {}
    }

    try {
      Object.defineProperty(process, 'arch', {
        configurable: true,
        enumerable: true,
        get: function () { return 'arm64'; }
      });
    } catch (e) {
      try { process.arch = 'arm64'; } catch (e2) {}
    }

    // os.* is what many installers check (not only process.*)
    os.platform = function () { return 'linux'; };
    os.type = function () { return 'Linux'; };
    os.arch = function () { return 'arm64'; };
    os.endianness = os.endianness || function () { return 'LE'; };
    // Keep real hostname/homedir — only lie about OS identity.
    var realRelease = os.release;
    os.release = function () {
      try { return realRelease.call(os); } catch (e) { return '5.15.0'; }
    };

    // Marker for debugging: node -e "console.log(process.platform, process.adevPlatformSpoof)"
    process.adevPlatformSpoof = 'linux-arm64';
  } catch (err) {
    // Never crash the process if spoofing fails.
  }
})();
