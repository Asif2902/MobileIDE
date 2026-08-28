import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetRoot = path.join(root, 'android/app/src/main/assets/runtime/lib');
const read = relative => fs.readFileSync(path.join(root, relative));
const json = relative => JSON.parse(read(relative).toString('utf8'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nativeMap = json('android/app/src/main/assets/runtime/native-map.json');

const catalog = json(
  'android/app/src/main/assets/runtime/lib/adev-cli-compat.json',
);
assert.equal(catalog.schemaVersion, 1);
assert.deepEqual(catalog.commands.dsh.nodeArgs, ['--expose-internals']);
assert.equal(catalog.commands.dsh.package, '@deepseek-ai/dsh');
assert.equal(
  catalog.wasmFallbacks[0].integrity,
  'sha512-zQnl4Kwp7Q6NHsENtU2T/00Zi+w3AQNwz3+UaTyVBy2FpXrzXzGjndpK61onhZjRtRpQXxCTeqw19bVyXOh7jA==',
);

for (const addon of catalog.nativeAddons) {
  const packagedName = nativeMap[`lib/${addon.source.replace(/^adev-native-addons\//, 'adev-native-addons/')}`] ?? nativeMap[path.posix.join('lib', addon.source)];
  assert.ok(packagedName, `${addon.package} native-map entry`);
  const bytes = fs.readFileSync(
    path.join(root, 'android/app/src/main/jniLibs/arm64-v8a', packagedName),
  );
  assert.equal(sha256(bytes), addon.sha256, `${addon.package} hash`);
  assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(bytes.readUInt16LE(18), 183, `${addon.package} must be AArch64`);
  assert.equal(addon.platform, 'android');
  assert.equal(addon.architecture, 'arm64');
  assert.ok(addon.target.endsWith('.node'));
  assert.ok(addon.lifecycleEvents.includes('install'));

  const archive = fs.readFileSync(
    path.join(root, 'android/app/src/main/prebuilt/arm64-v8a', `${packagedName}.gz`),
  );
  assert.deepEqual(zlib.gunzipSync(archive), bytes, `${addon.package} pinned archive`);
}

const sharp = json(
  'android/app/src/main/assets/runtime/lib/node_modules/@img/sharp-wasm32/package.json',
);
const emnapi = json(
  'android/app/src/main/assets/runtime/lib/node_modules/@emnapi/runtime/package.json',
);
const tslib = json(
  'android/app/src/main/assets/runtime/lib/node_modules/tslib/package.json',
);
assert.equal(sharp.version, '0.35.4');
assert.equal(sharp.dependencies['@emnapi/runtime'], '^1.11.3');
assert.equal(emnapi.version, '1.11.3');
assert.equal(tslib.version, '2.8.1');
assert.equal(sharp.license, 'Apache-2.0 AND LGPL-3.0-or-later AND MIT');
assert.equal(emnapi.license, 'MIT');
assert.equal(tslib.license, '0BSD');
assert.ok(
  fs.statSync(
    path.join(
      assetRoot,
      'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.4.node.wasm',
    ),
  ).size > 8_900_000,
);

const launcher = read(
  'android/app/src/main/assets/runtime/lib/adev-node-cli.js',
).toString('utf8');
assert.match(launcher, /refusing native-addon write outside the private ADEV runtime/);
assert.match(launcher, /fs\.renameSync\(temporary, target\)/);
assert.match(launcher, /sha256\(temporary\) !== addon\.sha256/);
assert.doesNotMatch(launcher, /NODE_OPTIONS\s*=/);

const lifecycle = read(
  'android/app/src/main/assets/runtime/lib/adev-native-addon-lifecycle.js',
).toString('utf8');
assert.match(lifecycle, /npm_lifecycle_event/);
assert.match(lifecycle, /installed verified/);
assert.match(lifecycle, /process\.exit\(0\)/);
assert.match(lifecycle, /refusing lifecycle addon write outside/);

const runtimeManager = read(
  'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
).toString('utf8');
assert.match(
  runtimeManager,
  /dsh\(\) \{ \\"\$node\\" --expose-internals/,
);
assert.match(runtimeManager, /"dsh",\s*"#!\/system\/bin\/sh/);

process.stdout.write(
  `Android CLI compatibility assets passed: ${catalog.nativeAddons.length} native addons, ` +
    'Sharp WASM 0.35.4, DSH Node startup flag preserved outside NODE_OPTIONS.\n',
);
