import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const boundary = JSON.parse(
  fs.readFileSync(
    path.join(root, 'release/development-audit-boundary.json'),
    'utf8',
  ),
);
const policy = JSON.parse(
  fs.readFileSync(path.join(root, 'release/release-policy.json'), 'utf8'),
);
const allowed = new Set(boundary.productionException.advisories);

const verification = spawnSync(
  process.execPath,
  [path.join(root, 'scripts/verify-build-tool-security.mjs')],
  {cwd: root, encoding: 'utf8'},
);
if (verification.status !== 0) {
  process.stderr.write(verification.stderr || verification.stdout);
  process.exit(1);
}

const auditArgs = ['audit', '--omit=dev', '--json'];
const audit = process.env.npm_execpath
  ? spawnSync(process.execPath, [process.env.npm_execpath, ...auditArgs], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', auditArgs, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  process.stderr.write(audit.stderr || audit.stdout || 'npm audit produced no JSON.\n');
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};
for (const [severity, maximum] of Object.entries(
  policy.security.productionAuditMaximum,
)) {
  const observed = report.metadata?.vulnerabilities?.[severity] ?? 0;
  if (observed > maximum) {
    process.stderr.write(
      `Production audit ${severity} count ${observed} exceeds reviewed maximum ${maximum}.\n`,
    );
    process.exit(1);
  }
}
const advisoryUrls = new Set();
for (const vulnerability of Object.values(vulnerabilities)) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via !== 'string') {
      advisoryUrls.add(via.url);
    }
  }
}
const unexpected = [...advisoryUrls].filter(url => !allowed.has(url));
const missing = [...allowed].filter(url => !advisoryUrls.has(url));
if (unexpected.length > 0 || missing.length > 0) {
  process.stderr.write(
    `Production audit boundary mismatch. Unexpected: ${unexpected.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}.\n`,
  );
  process.exit(1);
}

const leafNames = new Set(
  Object.entries(vulnerabilities)
    .filter(([, vulnerability]) =>
      (vulnerability.via ?? []).some(via => typeof via !== 'string'),
    )
    .map(([name]) => name),
);
if (leafNames.size !== 1 || !leafNames.has('image-size')) {
  process.stderr.write(
    `Only the patched image-size advisory leaf is allowed; found ${[...leafNames].join(', ') || 'none'}.\n`,
  );
  process.exit(1);
}

if (new Date(boundary.productionException.expiresAt) < new Date()) {
  process.stderr.write('The production audit exception has expired.\n');
  process.exit(1);
}

process.stdout.write(verification.stdout);
process.stdout.write(
  `Production audit passed with ${report.metadata.vulnerabilities.total} transitive report nodes attributable only to two locally mitigated image-size advisories.\n`,
);
