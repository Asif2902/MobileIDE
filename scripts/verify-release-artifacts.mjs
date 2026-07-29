import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(
  fs.readFileSync(path.join(root, 'release/release-policy.json'), 'utf8'),
);
const version = JSON.parse(
  fs.readFileSync(path.join(root, 'version.json'), 'utf8'),
);
const output = path.join(root, 'release', 'out');
const expectedName = kind =>
  policy.artifactNames[kind].replace('{versionName}', version.versionName);
const findArgument = name => {
  const prefix = `--${name}=`;
  const value = process.argv.find(argument => argument.startsWith(prefix));
  return value?.slice(prefix.length);
};
const apk = path.resolve(
  findArgument('apk') ?? path.join(output, expectedName('apk')),
);
const aab = path.resolve(
  findArgument('aab') ?? path.join(output, expectedName('aab')),
);
assert.ok(fs.existsSync(apk) && fs.statSync(apk).isFile(), `APK not found: ${apk}`);
assert.ok(fs.existsSync(aab) && fs.statSync(aab).isFile(), `AAB not found: ${aab}`);
assert.equal(path.basename(apk), expectedName('apk'));
assert.equal(path.basename(aab), expectedName('aab'));

const sdk =
  process.env.ANDROID_SDK_ROOT ??
  process.env.ANDROID_HOME ??
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? '', 'Android/Sdk')
    : path.join(os.homedir(), 'Android/Sdk'));
const suffix = process.platform === 'win32' ? '.exe' : '';
const apksigner = path.join(
  sdk,
  'build-tools',
  policy.buildToolsVersion,
  `apksigner${suffix}`,
);
assert.ok(fs.existsSync(apksigner), `apksigner not found: ${apksigner}`);
const javaHome = process.env.JAVA_HOME;
assert.ok(javaHome, 'JAVA_HOME must point to JDK 17.');
const jarsigner = path.join(javaHome, 'bin', `jarsigner${suffix}`);
assert.ok(fs.existsSync(jarsigner), `jarsigner not found: ${jarsigner}`);
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });

run(process.execPath, ['scripts/verify-phase4-apk.mjs', apk]);
const signer = run(apksigner, ['verify', '--verbose', '--print-certs', apk]);
assert.doesNotMatch(
  signer,
  /CN=Android Debug|Android Debug,O=Android/i,
  'Release APK is signed with an Android debug certificate.',
);
const fingerprint =
  signer.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]+)/i)?.[1] ??
  signer.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f]+)/i)?.[1];
assert.ok(fingerprint, 'apksigner did not report a signer SHA-256 digest.');
const normalizedFingerprint = fingerprint.replaceAll(':', '').toUpperCase();
const expectedFingerprint = process.env.ADEV_RELEASE_CERT_SHA256;
assert.ok(
  expectedFingerprint,
  'ADEV_RELEASE_CERT_SHA256 is required to bind artifacts to the approved release key.',
);
assert.equal(
  normalizedFingerprint,
  expectedFingerprint.replaceAll(':', '').toUpperCase(),
  'Release certificate digest does not match ADEV_RELEASE_CERT_SHA256.',
);

run(jarsigner, ['-verify', '-strict', '-certs', aab]);
const bundletool = process.env.BUNDLETOOL_JAR;
assert.ok(bundletool && fs.existsSync(bundletool), 'BUNDLETOOL_JAR is required.');
run(
  path.join(javaHome, 'bin', `java${suffix}`),
  ['-jar', bundletool, 'validate', `--bundle=${aab}`],
);

for (const [kind, artifact] of [
  ['apk', apk],
  ['aab', aab],
]) {
  const bytes = fs.statSync(artifact).size;
  assert.ok(
    bytes <= policy.sizeBudgetsBytes[kind],
    `${kind.toUpperCase()} is ${bytes} bytes; budget is ${policy.sizeBudgetsBytes[kind]}.`,
  );
  const digest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(artifact))
    .digest('hex')
    .toUpperCase();
  process.stdout.write(
    `${kind.toUpperCase()} release gate passed: ${bytes} bytes, SHA-256 ${digest}.\n`,
  );
}
