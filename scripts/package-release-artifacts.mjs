import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(
  fs.readFileSync(path.join(root, 'version.json'), 'utf8'),
);
const policy = JSON.parse(
  fs.readFileSync(path.join(root, 'release/release-policy.json'), 'utf8'),
);
const sourceApk = path.join(
  root,
  'android/app/build/outputs/apk/release/app-release.apk',
);
const sourceAab = path.join(
  root,
  'android/app/build/outputs/bundle/release/app-release.aab',
);
for (const source of [sourceApk, sourceAab]) {
  if (!fs.existsSync(source)) throw new Error(`Release artifact not found: ${source}`);
}
const output = path.join(root, 'release', 'out');
fs.mkdirSync(output, {recursive: true});
const destination = kind =>
  path.join(
    output,
    policy.artifactNames[kind].replace('{versionName}', version.versionName),
  );
const apk = destination('apk');
const aab = destination('aab');
fs.copyFileSync(sourceApk, apk);
fs.copyFileSync(sourceAab, aab);
execFileSync(
  process.execPath,
  [
    path.join(root, 'scripts/verify-release-artifacts.mjs'),
    `--apk=${apk}`,
    `--aab=${aab}`,
  ],
  {cwd: root, stdio: 'inherit'},
);
process.stdout.write(`Verified release artifacts written under ${output}.\n`);
