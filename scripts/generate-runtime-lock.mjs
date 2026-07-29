import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'android/app/src/main/assets/runtime');
const nativeMap = JSON.parse(
  fs.readFileSync(path.join(assets, 'native-map.json'), 'utf8'),
);
const packageManagers = JSON.parse(
  fs.readFileSync(path.join(assets, 'lib/adev-package-managers.json'), 'utf8'),
);
const toolPacks = JSON.parse(
  fs.readFileSync(path.join(assets, 'lib/adev-toolpacks.json'), 'utf8'),
);
const openCode = JSON.parse(
  fs.readFileSync(path.join(assets, 'lib/adev-opencode.json'), 'utf8'),
);
const releaseVersion = JSON.parse(
  fs.readFileSync(path.join(root, 'version.json'), 'utf8'),
);

const sha256 = file =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const owners = new Map();
for (const [runtimePath, packagedName] of Object.entries(nativeMap)) {
  const paths = owners.get(packagedName) ?? [];
  paths.push(runtimePath);
  owners.set(packagedName, paths);
}

const nativeFilesFor = (abi, runtimeOwners) => {
  const abiDir = path.join(root, 'android/app/src/main/jniLibs', abi);
  return fs
    .readdirSync(abiDir)
    .filter(packagedName => packagedName.endsWith('.so'))
    .sort()
    .map(packagedName => {
      const file = path.join(abiDir, packagedName);
      return {
        packagedName,
        sha256: sha256(file),
        bytes: fs.statSync(file).size,
        runtimePaths: (runtimeOwners.get(packagedName) ?? []).sort(),
        owner: runtimeOwners.has(packagedName)
          ? 'developer-runtime'
          : 'app-native',
      };
    });
};

const arm64Dir = path.join(root, 'android/app/src/main/jniLibs/arm64-v8a');
const arm64NativeFiles = nativeFilesFor('arm64-v8a', owners);
for (const packagedName of owners.keys()) {
  if (!fs.existsSync(path.join(arm64Dir, packagedName))) {
    throw new Error(`native-map entry has no ARM64 payload: ${packagedName}`);
  }
}
const x86NativeFiles = nativeFilesFor('x86_64', new Map());

const lock = {
  schemaVersion: 1,
  runtimeVersion: releaseVersion.runtimeVersion,
  platform: 'android-bionic',
  minApi: 29,
  compileApi: 36,
  targetApi: 36,
  pageAlignment: 16384,
  abis: {
    'arm64-v8a': {
      delivery: 'base-apk',
      developerRuntime: 'bundled',
      nativeFiles: arm64NativeFiles,
    },
    x86_64: {
      delivery: 'base-apk-plus-signed-runtime-feature-pack',
      developerRuntime: 'signed-android-feature-pack',
      capability:
        'IDE native helpers are packaged; the developer runtime requires the signed x86_64 runtime feature.',
      nativeFiles: x86NativeFiles,
    },
  },
  packageManagers: {
    sha256: sha256(path.join(assets, 'lib/adev-package-managers.json')),
    versions: {
      corepack: packageManagers.corepack.version,
      pnpm: packageManagers.managers.pnpm.version,
      yarn: packageManagers.managers.yarn.version,
    },
  },
  toolPacks: {
    sha256: sha256(path.join(assets, 'lib/adev-toolpacks.json')),
    ids: toolPacks.packs.map(pack => pack.id).sort(),
  },
  openCode: {
    sha256: sha256(path.join(assets, 'lib/adev-opencode.json')),
    version: openCode.version,
    platform: openCode.platform,
    supportedAbis: openCode.supportedAbis,
    source: openCode.source,
  },
};

const output = `${JSON.stringify(lock, null, 2)}\n`;
const lockPath = path.join(assets, 'runtime-lock.json');
const publicPath = path.join(assets, 'runtime-lock.pub.pem');
const signaturePath = path.join(assets, 'runtime-lock.sig');
fs.writeFileSync(lockPath, output);
const signingKeyPath = process.env.ADEV_RUNTIME_LOCK_PRIVATE_KEY;
if (signingKeyPath) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(signingKeyPath));
  const publicKey = crypto.createPublicKey(privateKey);
  fs.writeFileSync(publicPath, publicKey.export({type: 'spki', format: 'pem'}));
  fs.writeFileSync(
    signaturePath,
    crypto.sign(null, Buffer.from(output), privateKey),
  );
} else if (process.env.ADEV_RUNTIME_LOCK_BOOTSTRAP === '1') {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(publicPath, publicKey.export({type: 'spki', format: 'pem'}));
  fs.writeFileSync(
    signaturePath,
    crypto.sign(null, Buffer.from(output), privateKey),
  );
} else {
  if (!fs.existsSync(publicPath) || !fs.existsSync(signaturePath)) {
    throw new Error(
      'Signing material is absent; set ADEV_RUNTIME_LOCK_PRIVATE_KEY to an external Ed25519 PEM key.',
    );
  }
  const valid = crypto.verify(
    null,
    Buffer.from(output),
    fs.readFileSync(publicPath),
    fs.readFileSync(signaturePath),
  );
  if (!valid) {
    throw new Error(
      'Runtime lock changed; an external ADEV_RUNTIME_LOCK_PRIVATE_KEY is required to sign it.',
    );
  }
}
process.stdout.write(
  `signed runtime lock: ${arm64NativeFiles.length} ARM64 and ${
    x86NativeFiles.length
  } x86_64 payloads, ${Buffer.byteLength(output)} bytes\n`,
);
