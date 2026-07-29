import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'android/app/src/main/assets/runtime');
const lockPath = path.join(runtime, 'runtime-lock.json');
const lockBytes = fs.readFileSync(lockPath);
const publicKey = crypto.createPublicKey(
  fs.readFileSync(path.join(runtime, 'runtime-lock.pub.pem')),
);
assert.equal(
  crypto.verify(
    null,
    lockBytes,
    publicKey,
    fs.readFileSync(path.join(runtime, 'runtime-lock.sig')),
  ),
  true,
  'Refusing to prune from an invalid runtime lock signature.',
);
const lock = JSON.parse(lockBytes);
const apply = process.argv.includes('--apply');
const stale = [];
for (const [abi, policy] of Object.entries(lock.abis)) {
  const directory = path.join(root, 'android/app/src/main/jniLibs', abi);
  if (!fs.existsSync(directory)) continue;
  const owned = new Set(policy.nativeFiles.map(entry => entry.packagedName));
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (
      entry.isFile() &&
      /^lib(?:bin|lib)_.+\.so$/.test(entry.name) &&
      !owned.has(entry.name)
    ) {
      const file = path.join(directory, entry.name);
      stale.push(path.relative(root, file).replaceAll('\\', '/'));
      if (apply) fs.rmSync(file);
    }
  }
}

const nativeMapPath = path.join(runtime, 'native-map.json');
const nativeMap = JSON.parse(fs.readFileSync(nativeMapPath, 'utf8'));
const arm64Owned = new Set(
  lock.abis['arm64-v8a'].nativeFiles.map(entry => entry.packagedName),
);
let mapChanged = false;
for (const [runtimePath, packagedName] of Object.entries(nativeMap)) {
  if (!arm64Owned.has(packagedName)) {
    stale.push(`native-map.json:${runtimePath}->${packagedName}`);
    if (apply) {
      delete nativeMap[runtimePath];
      mapChanged = true;
    }
  }
}
if (apply && mapChanged) {
  fs.writeFileSync(nativeMapPath, `${JSON.stringify(nativeMap, null, 2)}\n`);
}
if (stale.length && !apply) {
  throw new Error(
    `Stale manifest-owned runtime outputs found:\n${stale.join('\n')}\n` +
      'Run this script with --apply only after approving the signed runtime lock.',
  );
}
process.stdout.write(
  `${apply ? 'Pruned' : 'Checked'} signed-manifest runtime outputs: ${stale.length} stale entries.\n`,
);
