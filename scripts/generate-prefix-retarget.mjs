import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Index the packaged sysroot files that still carry the Termux build prefix.
 *
 * A Dev Studio bundles headers, pkg-config files and build metadata produced by
 * the Termux toolchain, and those artifacts have `/data/data/com.termux/files/usr`
 * compiled into them. ADEV is not Termux and that directory never exists here,
 * so a native addon build reads include and library paths that cannot resolve.
 *
 * Scanning 8,500 header files on the device at every install would be slow, so
 * the small set that actually needs rewriting is indexed here at build time and
 * RuntimeManager retargets exactly those files during extraction.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'android/app/src/main/assets/runtime');
const PREFIX = '/data/data/com.termux/files/usr';
// etc/ is excluded on purpose: the packaged nanorc is kept verbatim as build
// evidence and RuntimeManager generates a prefix-correct copy beside it.
const SCAN_ROOTS = ['include', 'lib/pkgconfig', 'share/pkgconfig'];
const MAX_BYTES = 2 * 1024 * 1024;

const matches = [];

function scan(absolute, relative) {
  let entries;
  try {
    entries = fs.readdirSync(absolute, {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(absolute, entry.name);
    const childRelative = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      scan(child, childRelative);
      continue;
    }
    if (!entry.isFile()) continue;
    let stats;
    try {
      stats = fs.statSync(child);
    } catch {
      continue;
    }
    if (stats.size === 0 || stats.size > MAX_BYTES) continue;
    const buffer = fs.readFileSync(child);
    // Skip binaries: a NUL byte means this is not a text artifact to rewrite.
    if (buffer.includes(0)) continue;
    if (buffer.toString('utf8').includes(PREFIX)) matches.push(childRelative);
  }
}

for (const scanRoot of SCAN_ROOTS) {
  scan(path.join(assets, scanRoot), scanRoot);
}
matches.sort();

const output = path.join(assets, 'prefix-retarget.json');
const contents = `${JSON.stringify({packagedPrefix: PREFIX, files: matches}, null, 2)}\n`;

// --check keeps the committed index honest without rewriting it, so a suite can
// fail when new packaged artifacts arrive still carrying the Termux prefix.
if (process.argv.includes('--check')) {
  const current = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
  if (current !== contents) {
    process.stderr.write(
      'prefix-retarget.json is stale; run: node scripts/generate-prefix-retarget.mjs\n',
    );
    process.exit(1);
  }
  process.stdout.write(`Prefix retarget index is current (${matches.length} files).\n`);
} else {
  fs.writeFileSync(output, contents);
  process.stdout.write(
    `Indexed ${matches.length} packaged files that need prefix retargeting.\n`,
  );
}
