#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const valueAfter = flag => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

const packageName = valueAfter('--package') || process.env.npm_package_name || '<unknown>';
const packageVersion = valueAfter('--version') || process.env.npm_package_version || '*';
const arch = valueAfter('--arch') || process.arch;
const candidatesFile = valueAfter('--candidates');
const prefix = process.env.PREFIX || '';
const policyFile =
  process.env.ADEV_PACKAGE_POLICY_FILE ||
  path.join(prefix, 'lib', 'adev-runtime-policy.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

const policy = readJson(policyFile, {
  resolutionOrder: ['android-bionic', 'source-build', 'unsupported'],
  verifiedLinuxArtifacts: [],
  sourceBuild: { enabled: true, requires: ['python', 'make', 'clang', 'node-headers'] },
});
const candidates = candidatesFile ? readJson(candidatesFile, []) : [];
const verified = Array.isArray(policy.verifiedLinuxArtifacts)
  ? policy.verifiedLinuxArtifacts
  : [];

const tools = {
  python: Boolean(process.env.NODE_GYP_FORCE_PYTHON || process.env.PYTHON),
  make: Boolean(process.env.MAKE),
  clang: Boolean(process.env.CC && process.env.CXX),
  'node-headers': fs.existsSync(path.join(prefix, 'include', 'node', 'node.h')),
};
const missingBuildTools = Object.entries(tools)
  .filter(([, ready]) => !ready)
  .map(([name]) => name);

function samePackage(entry) {
  return entry.package === packageName &&
    (entry.version === packageVersion || entry.version === '*') &&
    entry.arch === arch;
}

const android = candidates.find(candidate =>
  candidate.platform === 'android' &&
  candidate.libc === 'bionic' &&
  candidate.arch === arch
);
const staticOrMusl = candidates.find(candidate =>
  ['static', 'musl'].includes(candidate.libc) &&
  candidate.arch === arch &&
  verified.some(entry =>
    samePackage(entry) &&
    entry.url === candidate.url &&
    entry.sha256 === candidate.sha256
  )
);

let result;
if (android) {
  result = {
    supported: true,
    decision: 'android-bionic',
    package: packageName,
    version: packageVersion,
    arch,
    artifact: android,
  };
} else if (staticOrMusl) {
  result = {
    supported: true,
    decision: 'verified-static-or-musl',
    package: packageName,
    version: packageVersion,
    arch,
    artifact: staticOrMusl,
  };
} else if (policy.sourceBuild && policy.sourceBuild.enabled && missingBuildTools.length === 0) {
  result = {
    supported: true,
    decision: 'source-build',
    package: packageName,
    version: packageVersion,
    arch,
    buildTools: tools,
  };
} else {
  result = {
    supported: false,
    decision: 'unsupported',
    package: packageName,
    version: packageVersion,
    arch,
    missingBuildTools,
    error: policy.unsupportedMessage ||
      'No compatible Android artifact or source-build path is available.',
  };
}

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`${packageName}@${packageVersion}: ${result.decision}\n`);
  if (!result.supported) process.stderr.write(`${result.error}\n`);
}
process.exitCode = result.supported ? 0 : 2;
