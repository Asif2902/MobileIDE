import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);
const forbiddenNames = /\.(?:jks|p12|pfx|keystore)$/i;
const forbiddenContent = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[opusr]_[A-Za-z0-9_]{30,}\b/,
  /\bADEV_RELEASE_(?:STORE_PASSWORD|KEY_PASSWORD)\s*=\s*[^\s$<{][^\r\n]*/i,
];
const vendoredBinaryPrefixes = [
  'android/app/src/main/assets/runtime/',
  'android/app/src/main/jniLibs/',
];
const failures = [];
for (const relative of tracked) {
  if (
    forbiddenNames.test(relative) &&
    relative.replaceAll('\\', '/') !== 'android/app/debug.keystore'
  ) {
    failures.push(`${relative}: forbidden signing-key file`);
    continue;
  }
  const normalized = relative.replaceAll('\\', '/');
  if (vendoredBinaryPrefixes.some(prefix => normalized.startsWith(prefix))) {
    continue;
  }
  const file = path.join(root, relative);
  const stats = fs.statSync(file);
  if (!stats.isFile() || stats.size > 5 * 1024 * 1024) continue;
  const content = fs.readFileSync(file, 'utf8');
  for (const pattern of forbiddenContent) {
    if (pattern.test(content)) {
      failures.push(`${relative}: matches secret pattern ${pattern}`);
    }
  }
}
if (failures.length) {
  throw new Error(`Tracked-secret gate failed:\n${failures.join('\n')}`);
}
process.stdout.write(`Tracked-secret gate passed: ${tracked.length} files scanned.\n`);
