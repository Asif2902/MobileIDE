'use strict';

/*
 * Runtime capability preload.
 *
 * This intentionally does not modify process.platform, process.arch, or os.*.
 * Packages see the real Android/Bionic host. Linux artifacts are eligible only
 * when an entry with an exact package, version, architecture, URL and SHA-256
 * exists in adev-runtime-policy.json.
 */
(function loadAdevRuntimePolicy() {
  const fs = require('fs');
  const path = require('path');
  const policyFile =
    process.env.ADEV_PACKAGE_POLICY_FILE ||
    path.join(process.env.PREFIX || '', 'lib', 'adev-runtime-policy.json');

  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  } catch (error) {
    policy = {
      schemaVersion: 1,
      host: { platform: 'android', libc: 'bionic', architectures: [process.arch] },
      resolutionOrder: ['android-bionic', 'source-build', 'unsupported'],
      verifiedLinuxArtifacts: [],
      sourceBuild: { enabled: true, requires: ['python', 'make', 'clang', 'node-headers'] },
      policyError: String(error && error.message ? error.message : error),
    };
  }

  const capabilities = Object.freeze({
    policyFile,
    platform: process.platform,
    arch: process.arch,
    libc: 'bionic',
    resolutionOrder: Object.freeze([...(policy.resolutionOrder || [])]),
    verifiedLinuxArtifactCount: Array.isArray(policy.verifiedLinuxArtifacts)
      ? policy.verifiedLinuxArtifacts.length
      : 0,
    globalPlatformSpoof: false,
  });

  Object.defineProperty(process, 'adevRuntimeCapabilities', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: capabilities,
  });
  process.env.ADEV_PACKAGE_POLICY = capabilities.resolutionOrder.join(',');
  process.env.ADEV_PLATFORM_SPOOF = 'disabled';
})();
