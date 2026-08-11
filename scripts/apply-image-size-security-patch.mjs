import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packagePath = require.resolve('image-size/package.json', {paths: [root]});
const packageRoot = path.dirname(packagePath);
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

if (packageJson.version !== '1.2.1') {
  throw new Error(
    `Refusing to patch unreviewed image-size ${packageJson.version}; review the new upstream source first.`,
  );
}

function replaceExactly(file, candidates, replacement, marker) {
  const filePath = path.join(packageRoot, 'dist', 'types', file);
  let source = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  if (source.includes(marker)) {
    return false;
  }

  const candidate = candidates.find(value => source.includes(value));
  if (!candidate) {
    throw new Error(
      `Refusing to patch unexpected image-size source in ${filePath}.`,
    );
  }
  source = source.replace(candidate, replacement);
  fs.writeFileSync(filePath, source, 'utf8');
  return true;
}

const boxMarker = 'ADEV-SECURITY: reject non-advancing ISO media boxes';
const boxPatched = replaceExactly(
  'utils.js',
  [
    '        offset += box.size;\n',
    '        // Fix the infinite loop by ensuring offset always increases\n        // If box.size is 0, advance by at least 8 bytes (the size of the box header)\n        offset += box.size > 0 ? box.size : 8;\n',
  ],
  `        // ${boxMarker} (GHSA-5p2g-fcmc-qvqq).\n        if (box.size < 8)\n            throw new TypeError('Invalid image box length');\n        offset += box.size;\n`,
  boxMarker,
);

const icnsMarker = 'ADEV-SECURITY: reject non-advancing ICNS entries';
const icnsPatched = replaceExactly(
  'icns.js',
  [
    '            imageOffset += imageHeader[1];\n            result.images.push(imageSize);\n',
  ],
  `            // ${icnsMarker} (GHSA-w3rx-r6r6-pgpr).\n            const imageLength = imageHeader[1];\n            if (imageLength < SIZE_HEADER || imageOffset + imageLength > inputLength)\n                throw new TypeError('Invalid ICNS entry length');\n            imageOffset += imageLength;\n            result.images.push(imageSize);\n`,
  icnsMarker,
);

// The first entry is evaluated before the loop and must be guarded separately.
const icnsPath = path.join(packageRoot, 'dist', 'types', 'icns.js');
let icnsSource = fs.readFileSync(icnsPath, 'utf8').replace(/\r\n/g, '\n');
const firstMarker = 'ADEV-SECURITY: validate the first ICNS entry';
if (!icnsSource.includes(firstMarker)) {
  const original = '        imageOffset += imageHeader[1];\n        if (imageOffset === fileLength)\n';
  if (!icnsSource.includes(original)) {
    throw new Error(`Refusing to patch unexpected image-size source in ${icnsPath}.`);
  }
  icnsSource = icnsSource.replace(
    original,
    `        // ${firstMarker} (GHSA-w3rx-r6r6-pgpr).\n        const firstImageLength = imageHeader[1];\n        if (firstImageLength < SIZE_HEADER || imageOffset + firstImageLength > inputLength)\n            throw new TypeError('Invalid ICNS entry length');\n        imageOffset += firstImageLength;\n        if (imageOffset === fileLength)\n`,
  );
  fs.writeFileSync(icnsPath, icnsSource, 'utf8');
}

process.stdout.write(
  `image-size ${packageJson.version} security patch ${boxPatched || icnsPatched ? 'applied' : 'already present'}.\n`,
);
