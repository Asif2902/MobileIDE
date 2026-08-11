import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packagePath = require.resolve('image-size/package.json', {paths: [root]});
const packageRoot = path.dirname(packagePath);
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const packageLock = JSON.parse(
  fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
);

assert.equal(packageJson.version, '1.2.1');
assert.equal(packageLock.packages['node_modules/nanoid'].version, '3.3.18');
assert.equal(
  packageLock.packages['node_modules/fast-xml-parser'].version,
  '5.10.1',
);
const lockedVersions = name =>
  Object.entries(packageLock.packages)
    .filter(([entry]) => entry.endsWith(`/node_modules/${name}`) || entry === `node_modules/${name}`)
    .map(([, value]) => value.version);
assert.ok(lockedVersions('brace-expansion').includes('1.1.18'));
assert.ok(lockedVersions('brace-expansion').includes('5.0.9'));
assert.ok(lockedVersions('js-yaml').includes('3.15.1'));
assert.ok(lockedVersions('js-yaml').includes('4.3.1'));

const utils = fs.readFileSync(
  path.join(packageRoot, 'dist/types/utils.js'),
  'utf8',
);
const icns = fs.readFileSync(
  path.join(packageRoot, 'dist/types/icns.js'),
  'utf8',
);
assert.match(utils, /ADEV-SECURITY: reject non-advancing ISO media boxes/);
assert.match(utils, /if \(box\.size < 8\)/);
assert.match(icns, /ADEV-SECURITY: validate the first ICNS entry/);
assert.match(icns, /ADEV-SECURITY: reject non-advancing ICNS entries/);

const probe = String.raw`
const path = require('node:path');
const root = process.argv[1];
const types = path.join(root, 'node_modules/image-size/dist/types');
const {findBox} = require(path.join(types, 'utils.js'));
const {ICNS} = require(path.join(types, 'icns.js'));
const invalidBox = Buffer.alloc(8);
invalidBox.write('free', 4, 'ascii');
assertRejects(() => findBox(invalidBox, 'jxlc', 0));
const invalidIcns = Buffer.alloc(16);
invalidIcns.write('icns', 0, 'ascii');
invalidIcns.writeUInt32BE(16, 4);
invalidIcns.write('ic07', 8, 'ascii');
assertRejects(() => ICNS.calculate(invalidIcns));
function assertRejects(fn) {
  let rejected = false;
  try { fn(); } catch { rejected = true; }
  if (!rejected) process.exit(2);
}
`;
const result = spawnSync(process.execPath, ['-e', probe, root], {
  encoding: 'utf8',
  timeout: 2000,
});
assert.notEqual(result.error?.code, 'ETIMEDOUT', 'malformed image probe hung');
assert.equal(result.status, 0, result.stderr || result.stdout);

process.stdout.write(
  'Build-tool security checks passed: fixed nanoid and bounded image-size ICNS/JXL/HEIF parsing.\n',
);
