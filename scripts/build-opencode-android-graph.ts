#!/usr/bin/env bun
/**
 * Build OpenCode for Android (aarch64)
 *
 * This script:
 * 1. Generates the models-snapshot.js
 * 2. Loads migrations
 * 3. Bundles OpenCode using Bun.build() with compile targeting Linux ARM64
 * 4. Extracts the module graph from the compiled binary
 * 5. Appends it to our Android bun binary to create the final standalone
 */

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"

// These are set by the build-opencode.sh wrapper script
const OPENCODE_DIR = process.env.OPENCODE_DIR || (() => { throw new Error("OPENCODE_DIR env var not set") })()
const ANDROID_BUN = process.env.ANDROID_BUN || (() => { throw new Error("ANDROID_BUN env var not set") })()
const OUTPUT_DIR = process.env.OUTPUT_DIR || (() => { throw new Error("OUTPUT_DIR env var not set") })()

// Validate Android bun exists
if (!fs.existsSync(ANDROID_BUN)) {
  console.error("Android bun binary not found at:", ANDROID_BUN)
  process.exit(1)
}

process.chdir(OPENCODE_DIR)

// OpenTUI's Solid reconciler currently treats every unregistered intrinsic as
// fatal. That made a tree-shaken optional registration (`spinner`) crash the
// whole Android TUI. Keep the explicit spinner registration in the pinned
// source patch, and also make the compiled renderer degrade unknown,
// non-critical intrinsics to a text/span container. Children and ordinary text
// remain visible while the missing component is reported on stderr.
const solidRendererPath = Bun.resolveSync("@opentui/solid", OPENCODE_DIR)
const solidRendererSource = fs.readFileSync(solidRendererPath, "utf8")
const unknownComponentThrow = `    if (!elements[tagName]) {
      throw new Error(\`[Reconciler] Unknown component type: \${tagName}\`);
    }
    const element = new elements[tagName](solidRenderer, { id });`
const unknownComponentFallback = `    let component = elements[tagName];
    if (!component) {
      component = elements.span ?? elements.text;
      if (!component) {
        throw new Error(\`[Reconciler] Unknown component type: \${tagName}; no text fallback is registered\`);
      }
      console.warn(\`[Reconciler] Unknown component type: \${tagName}; using text fallback\`);
    }
    const element = new component(solidRenderer, { id });`
if (solidRendererSource.includes(unknownComponentThrow)) {
  fs.writeFileSync(
    solidRendererPath,
    solidRendererSource.replace(unknownComponentThrow, unknownComponentFallback),
  )
  console.log(`Patched OpenTUI unknown-component fallback: ${solidRendererPath}`)
} else if (solidRendererSource.includes("using text fallback")) {
  console.log(`OpenTUI unknown-component fallback already patched: ${solidRendererPath}`)
} else {
  throw new Error(
    `OpenTUI reconciler shape changed; refusing to build without the unknown-component fallback: ${solidRendererPath}`,
  )
}

// OpenTUI 0.4+ statically imports both Linux ARM64 renderer packages when the
// standalone graph is cross-compiled. Those packages contain glibc/musl .so
// files that cannot run on Android and add tens of megabytes of dead payload.
// The Android source patch calls setRenderLibPath() with ADEV's matching
// Bionic library before renderer resolution, so keep the package entries as
// lightweight fallbacks to that verified external path.
for (const packageName of [
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
]) {
  try {
    const entry = Bun.resolveSync(packageName, OPENCODE_DIR)
    fs.writeFileSync(
      entry,
      `const renderPath = process.env.OPENTUI_LIB_PATH
if (!renderPath) throw new Error("ADEV Android requires OPENTUI_LIB_PATH")
export default renderPath
`,
    )
    console.log(`Redirected ${packageName} to OPENTUI_LIB_PATH`)
  } catch (error) {
    throw new Error(`Required ARM64 OpenTUI package is missing: ${packageName}`, { cause: error })
  }
}

// This builder lives in ADEV rather than the upstream checkout. Resolve the
// pinned plugin from the supplied OpenCode tree after changing into it.
const { createSolidTransformPlugin } = await import(
  pathToFileURL(Bun.resolveSync("@opentui/solid/bun-plugin", OPENCODE_DIR)).href,
)

const VERSION = process.env.OPENCODE_VERSION || "1.3.13"
const CHANNEL = process.env.OPENCODE_CHANNEL || "latest"

console.log(`Building OpenCode v${VERSION} (channel: ${CHANNEL}) for Android aarch64`)

// Step 1: Generate models-snapshot.js
console.log("\n=== Step 1: Generating models-snapshot.js ===")
const preservedModels = path.join(OPENCODE_DIR, "src/provider/models-snapshot.js")
if (process.env.MODELS_SNAPSHOT_PRESERVE === "1" && fs.existsSync(preservedModels)) {
  console.log("Preserving the pinned models-snapshot.js")
} else {
const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"
let modelsData: string = ""
if (process.env.MODELS_DEV_API_JSON) {
  modelsData = await Bun.file(process.env.MODELS_DEV_API_JSON).text()
} else {
  console.log(`Fetching from ${modelsUrl}/api.json ...`)
  let fetchErr: Error | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`${modelsUrl}/api.json`, { signal: AbortSignal.timeout(15000) })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      modelsData = await resp.text()
      fetchErr = null
      break
    } catch (err: any) {
      fetchErr = err
      console.error(`  Attempt ${attempt}/3 failed: ${err.message}`)
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }
  if (fetchErr) {
    console.error(`ERROR: Failed to fetch models after 3 attempts: ${fetchErr.message}`)
    process.exit(1)
  }
}
await Bun.write(
  path.join(OPENCODE_DIR, "src/provider/models-snapshot.js"),
  `// @ts-nocheck\n// Auto-generated by build.ts - do not edit\nexport const snapshot = ${modelsData}\n`,
)
await Bun.write(
  path.join(OPENCODE_DIR, "src/provider/models-snapshot.d.ts"),
  `// Auto-generated by build.ts - do not edit\nexport declare const snapshot: Record<string, unknown>\n`,
)
console.log("Generated models-snapshot.js")
}

// Step 2: Load migrations
console.log("\n=== Step 2: Loading migrations ===")
const migrationDirs = (
  await fs.promises.readdir(path.join(OPENCODE_DIR, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(OPENCODE_DIR, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

// Step 3: Build with Bun.build() --compile for Linux ARM64. The appended module
// graph retains compile-time platform/architecture branches, so building it as
// x64 makes OpenTUI select @opentui/core-linux-x64 even after the graph is
// attached to Android Bun. Cross-target ARM64 is required here.
console.log("\n=== Step 3: Bundling OpenCode ===")

const plugin = createSolidTransformPlugin()

// Find parser.worker.js
const localPath = path.resolve(OPENCODE_DIR, "node_modules/@opentui/core/parser.worker.js")
const rootPath = path.resolve(OPENCODE_DIR, "../../node_modules/@opentui/core/parser.worker.js")
let parserWorkerResolved: string
try {
  parserWorkerResolved = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
} catch {
  // Try bun's module resolution
  parserWorkerResolved = require.resolve("@opentui/core/parser.worker.js")
}
console.log(`Parser worker: ${parserWorkerResolved}`)

const workerPath = "./src/cli/tui/worker.ts"

const bunfsRoot = "/$bunfs/root/"
const workerRelativePath = path.relative(OPENCODE_DIR, parserWorkerResolved).replaceAll("\\", "/")

// OpenTUI 0.4.5 resolves parser.worker through a top-level type=file dynamic
// import. Bun's standalone compiler creates the worker entry correctly, but
// after the module graph is grafted onto the Android/Bionic Bun prefix the
// imported module's default path is undefined. Pin the loader to the same
// explicit bunfs entrypoint that is already supplied to Bun.build below.
const openTuiCoreDirectory = path.dirname(Bun.resolveSync("@opentui/core", OPENCODE_DIR))
const parserWorkerLoaderPrefix =
  "var bundledTreeSitterWorkerPath = await resolveBundledFilePath(PARSER_WORKER_ASSET_KEY,"
let parserWorkerLoaderPatched = false
for (const file of fs.readdirSync(openTuiCoreDirectory)) {
  if (!/^chunk-bun-.+\.js$/.test(file)) continue
  const chunkPath = path.join(openTuiCoreDirectory, file)
  const chunkSource = fs.readFileSync(chunkPath, "utf8")
  const line = chunkSource
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(parserWorkerLoaderPrefix))
  if (!line) continue
  fs.writeFileSync(
    chunkPath,
    chunkSource.replace(
      line,
      `var bundledTreeSitterWorkerPath = ${JSON.stringify(bunfsRoot + workerRelativePath)};`,
    ),
  )
  parserWorkerLoaderPatched = true
  console.log(`Pinned OpenTUI parser worker bunfs path in ${file}`)
}
if (!parserWorkerLoaderPatched) {
  throw new Error("OpenTUI parser worker loader signature was not found")
}

await $`rm -rf ${OUTPUT_DIR}`
await $`mkdir -p ${OUTPUT_DIR}`

// Build with --compile for Linux ARM64 to get the correctly specialized graph.
// We'll extract the module graph from it
const hostBinaryPath = path.join(OUTPUT_DIR, "opencode-host")

console.log("Building standalone binary for host platform...")
const result = await Bun.build({
  conditions: ["browser"],
  tsconfig: "./tsconfig.json",
  plugins: [plugin],
  compile: {
    target: "bun-linux-arm64",
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    outfile: hostBinaryPath,
    execArgv: [`--user-agent=opencode/${VERSION}`, "--use-system-ca", "--"],
  },
  entrypoints: ["./src/index.ts", parserWorkerResolved, workerPath],
  define: {
    OPENCODE_VERSION: `'${VERSION}'`,
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    OPENCODE_WORKER_PATH: workerPath,
    OPENCODE_CHANNEL: `'${CHANNEL}'`,
    OPENCODE_LIBC: "",
  },
})

if (!result.success) {
  console.error("Build failed:")
  for (const msg of result.logs) {
    console.error(msg)
  }
  process.exit(1)
}

console.log(`Host standalone binary: ${hostBinaryPath}`)

// Step 4: Extract module graph from host binary
console.log("\n=== Step 4: Extracting module graph ===")

const hostBinary = await Bun.file(hostBinaryPath).arrayBuffer()
const hostBytes = new Uint8Array(hostBinary)

// Standalone binary format (ELF):
//   [bun binary (seek_pos bytes)]
//   [module_graph bytes]
//   [total_byte_count as u64 LE (8 bytes)]
//
// Module graph internal layout:
//   [string data] [module list] [offsets (32 bytes)] [trailer "\n---- Bun! ----\n" (16 bytes)]
//
// offsets.byte_count = len(string_data) + len(module_list)
// total_byte_count = seek_pos + len(module_graph) + 8 = file_size
//
// We derive the module graph size from the trailer and offsets struct,
// WITHOUT relying on process.execPath (which may differ from the bun
// binary that was embedded during --compile).

const TRAILER_STR = "\n---- Bun! ----\n"
const TRAILER_LEN = TRAILER_STR.length  // 16
const OFFSETS_SIZE_CONST = 32

// Find trailer: it's near the end of the file, just before the final 8-byte u64.
// Search backwards from (end - 8) for the trailer sentinel.
const trailerBuf = Buffer.from(TRAILER_STR)
const searchBuf = Buffer.from(hostBytes.buffer, hostBytes.byteOffset, hostBytes.length)
const trailerEnd = hostBytes.length - 8  // trailer must end here
const expectedTrailerStart = trailerEnd - TRAILER_LEN

// Verify trailer at expected position
const foundTrailer = searchBuf.compare(
  trailerBuf, 0, TRAILER_LEN,
  expectedTrailerStart, trailerEnd
) === 0

if (!foundTrailer) {
  console.error("ERROR: Bun standalone trailer not found at expected position")
  console.error("       The standalone binary format may have changed.")
  process.exit(1)
}

// Read offsets struct (32 bytes) just before the trailer
const offsetsStart = expectedTrailerStart - OFFSETS_SIZE_CONST
const offsetsByteCount = Number(searchBuf.readBigUInt64LE(offsetsStart))

// Module graph total size = byte_count (string data + module list) + offsets(32) + trailer(16)
const moduleGraphSize = offsetsByteCount + OFFSETS_SIZE_CONST + TRAILER_LEN
const hostBunSize = hostBytes.length - 8 - moduleGraphSize

console.log(`Host standalone size: ${hostBytes.length}`)
console.log(`Derived host bun size: ${hostBunSize}`)
console.log(`Module graph size: ${moduleGraphSize}`)

if (hostBunSize <= 0) {
  console.error(`ERROR: Derived host bun size is ${hostBunSize} — something is wrong`)
  process.exit(1)
}

const moduleGraphBytes = hostBytes.slice(hostBunSize, hostBytes.length - 8)
console.log(`Module graph extracted: ${moduleGraphBytes.length} bytes`)
console.log(`Trailer verified: OK`)

// Step 5: Patch the module graph for Android
console.log("\n=== Step 5: Patching module graph for Android ===")

// The module graph format (from StandaloneModuleGraph.zig):
//   [string data: all file names, contents, sourcemaps, bytecodes concatenated]
//   [CompiledModuleGraphFile array]
//   [Offsets struct: 32 bytes]
//   [trailer: "\n---- Bun! ----\n"]
//
// Offsets struct layout (32 bytes, little-endian, unchanged across Bun versions):
//   byte_count:              u64  (8 bytes) - size of everything before the Offsets struct
//   modules_ptr.offset:      u32  (4 bytes)
//   modules_ptr.length:      u32  (4 bytes)
//   entry_point_id:          u32  (4 bytes)
//   compile_exec_argv.offset:u32  (4 bytes)
//   compile_exec_argv.length:u32  (4 bytes)
//   flags:                   u32  (4 bytes)
//
// NOTE: CompiledModuleGraphFile layout varies between Bun versions:
//   - Bun 1.2.x: 36 bytes (4 StringPointers + 3 u8 + 1 padding)
//   - Bun 1.3.x: 52 bytes (6 StringPointers + 4 u8)
// We avoid parsing individual modules. The undici patch is a same-size
// in-place byte replacement in the raw string data, so we don't need to
// know the module struct layout at all. The module list and offsets are
// passed through unchanged.

const mgTrailer = "\n---- Bun! ----\n"
const mgTrailerBuf = Buffer.from(mgTrailer)
const OFFSETS_SIZE = 32

// Parse the module graph — only the Offsets struct (version-independent)
const mgBuf = Buffer.from(moduleGraphBytes)
const trailerPosInMg = mgBuf.lastIndexOf(mgTrailerBuf)
if (trailerPosInMg < 0) throw new Error("Trailer not found in module graph!")

// Offsets struct is just before the trailer
const mgOffsetsStart = trailerPosInMg - OFFSETS_SIZE
const byteCount = Number(mgBuf.readBigUInt64LE(mgOffsetsStart))
const modOff = mgBuf.readUInt32LE(mgOffsetsStart + 8)
const modLen = mgBuf.readUInt32LE(mgOffsetsStart + 12)
const entryId = mgBuf.readUInt32LE(mgOffsetsStart + 16)
const argvOff = mgBuf.readUInt32LE(mgOffsetsStart + 20)
const argvLen = mgBuf.readUInt32LE(mgOffsetsStart + 24)
const flags = mgBuf.readUInt32LE(mgOffsetsStart + 28)

console.log(`Module graph: trailer at ${trailerPosInMg}, offsets at ${mgOffsetsStart}`)
console.log(`byte_count=${byteCount}, modules_ptr=(${modOff},${modLen}), entry_id=${entryId}`)
console.log(`String data region: [0, ${modOff}), Module list: [${modOff}, ${modOff + modLen})`)

// ---- Patch 1: Fix undici reference ----
// The host bun bundler compiles `import "undici"` as a bare global reference `undici`.
// Android bun v1.2.13 doesn't expose globalThis.undici, but it does expose `Undici`
// (capital U, the moduleExports object). `__reExport` skips the "default" key anyway,
// so the result is identical.
//
// This is a same-byte-count replacement: we search the entire string data region
// for the pattern and replace in-place. No module struct parsing required.
const UNDICI_SEARCH  = Buffer.from('__reExport(exports_Undici, undici)')
const UNDICI_REPLACE = Buffer.from('__reExport(exports_Undici, Undici)')
console.log(`\nPatch 1: Replacing undici->Undici in string data (same size, no offset changes)`)

let undiciPatchCount = 0
let searchPos = 0
// Search only within the string data region [0, modOff)
const strDataRegion = mgBuf.slice(0, modOff)
while (true) {
  const pos = strDataRegion.indexOf(UNDICI_SEARCH, searchPos)
  if (pos < 0) break
  console.log(`  Found at string data offset ${pos}, replacing...`)
  UNDICI_REPLACE.copy(mgBuf, pos)
  undiciPatchCount++
  searchPos = pos + UNDICI_SEARCH.length
}
if (undiciPatchCount === 0) {
  console.error("WARNING: __reExport(exports_Undici, undici) not found — skipping Patch 1")
} else {
  console.log(`  Patched ${undiciPatchCount} occurrence(s)`)
}

// ---- Patch 2: Neutralize @ff-labs/fff-bun getCurrentDir ----
// In Bun 1.3.2 standalone graphs, modules reachable only through the extra
// TUI worker entrypoint evaluate with an undefined `import.meta.url`, and
// fff-bun's top-level native-binding resolution calls
// `import.meta.url.includes("$bunfs")` — crashing every TUI boot with
// "path101.includes is not a function". The resolved directory is only used
// to locate a glibc/musl binding ADEV never loads (native rendering goes
// through OPENTUI_LIB_PATH), so replacing the function body with
// `return <dirname>(process.execPath)` is behavior-neutral here and keeps
// the byte count identical (padded with trailing spaces).
const FFF_MARKER = Buffer.from('includes("$bunfs")')
const FFF_FUNC = 'function getCurrentDir()'
let fffPatchCount = 0
{
  // Decode once and match whole functions: bundled sources keep upstream
  // pretty-printing, so each function ends at the first UNINDENTED newline-brace.
  const haystack = mgBuf.slice(0, modOff).toString("latin1")
  const re = /function getCurrentDir\(\)\s*\{[\s\S]*?\n\}/g
  let m
  while ((m = re.exec(haystack)) !== null) {
    const start = m.index, text = m[0]
    const dirnameAlias = text.match(/dirname\d+/)?.[0]
    const base = `${FFF_FUNC}{return ${dirnameAlias ?? "dirname"}(process.execPath)}`
    if (base.length > text.length) {
      throw new Error(`fff-bun patch: replacement exceeds original span (${base.length} > ${text.length})`)
    }
    const replacement = Buffer.from(base + " ".repeat(text.length - base.length))
    replacement.copy(mgBuf, start)
    fffPatchCount++
    console.log(`  fff-bun getCurrentDir at graph offset ${start}: neutered (${text.length} bytes, dirname=${dirnameAlias})`)
    re.lastIndex = start + text.length
  }
}
if (fffPatchCount === 0) {
  console.error("WARNING: fff-bun getCurrentDir not found - skipping Patch 2")
} else {
  console.log(`  Patched ${fffPatchCount} fff-bun occurrence(s)`)
  const residue = (() => {
    let pos = 0
    for (;;) {
      const at = mgBuf.indexOf(FFF_MARKER, pos)
      if (at < 0) return -1
      // Optional chaining (`?.includes`) tolerates undefined meta — skip it.
      let back = at - 1
      while (back >= 0 && (mgBuf[back] === 0x20 || mgBuf[back] === 0x09)) back--
      const guarded = back >= 0 && mgBuf[back] === 0x3f // '?'
      if (!guarded) return at
      pos = at + FFF_MARKER.length
    }
  })()
  if (residue >= 0) {
    console.log(
      "  RESIDUE CONTEXT: " +
        mgBuf
          .slice(Math.max(0, residue - 260), residue + 260)
          .toString("latin1")
          .replace(/[^\x20-\x7e]/g, "."),
    )
  }
}
// Since all patches are same-size in-place edits, the module graph is unchanged
// in structure. We just pass through the entire mgBuf (with our in-place edits)
// as the final module graph.
var finalModuleGraph = mgBuf.slice(0, trailerPosInMg + mgTrailerBuf.length)
console.log(`Module graph size: ${finalModuleGraph.length} bytes (unchanged)`)

// Step 6: Create Android standalone binary
console.log("\n=== Step 6: Creating Android standalone binary ===")

const androidBunBytes = new Uint8Array(await Bun.file(ANDROID_BUN).arrayBuffer())
const androidBunSize = androidBunBytes.length
console.log(`Android bun size: ${androidBunSize}`)

// New total_byte_count = android_bun_size + module_graph.length + 8
const newTotalByteCount = androidBunSize + finalModuleGraph.length + 8

// Create the output buffer
const outputSize = androidBunSize + finalModuleGraph.length + 8
const output = new Uint8Array(outputSize)

// Copy Android bun binary
output.set(androidBunBytes, 0)

// Copy patched module graph
output.set(new Uint8Array(finalModuleGraph.buffer, finalModuleGraph.byteOffset, finalModuleGraph.length), androidBunSize)

// Write new total_byte_count as u64 LE
const totalView = new DataView(output.buffer, outputSize - 8, 8)
totalView.setUint32(0, newTotalByteCount & 0xFFFFFFFF, true)
totalView.setUint32(4, Math.floor(newTotalByteCount / 0x100000000), true)

const androidOutputPath = path.join(OUTPUT_DIR, "opencode")
await Bun.write(androidOutputPath, output)
fs.chmodSync(androidOutputPath, 0o755)

console.log(`\nAndroid standalone binary: ${androidOutputPath}`)
console.log(`Size: ${(outputSize / 1024 / 1024).toFixed(1)} MB`)

// Verify
const verifyBytes = new Uint8Array(await Bun.file(androidOutputPath).arrayBuffer())
const verifyView = new DataView(verifyBytes.buffer, verifyBytes.length - 8, 8)
const verifyTotal = verifyView.getUint32(0, true) + verifyView.getUint32(4, true) * 0x100000000
console.log(`Verification: total_byte_count=${verifyTotal}, file_size=${verifyBytes.length}, match=${verifyTotal === verifyBytes.length}`)

// Check ELF header
const elfMagic = String.fromCharCode(verifyBytes[0], verifyBytes[1], verifyBytes[2], verifyBytes[3])
console.log(`ELF magic: ${elfMagic === "\x7fELF" ? "OK" : "INVALID"}`)

// Step 7: Verify no x86_64 ELF files were embedded in the final binary.
// On Android, embedded x86_64 .so files (e.g. from bun-pty on a host build)
// will fail to dlopen at runtime.
console.log("\n=== Step 7: Verifying embedded ELF architectures ===")
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] // "\x7fELF"
const EM_AARCH64 = 0xb7
const EM_X86_64 = 0x3e
const EM_X86 = 0x03

let foundElfCount = 0
let foundX64 = false
let foundX86 = false

for (let i = 0; i < verifyBytes.length - 20; i++) {
  if (
    verifyBytes[i] === ELF_MAGIC[0] &&
    verifyBytes[i + 1] === ELF_MAGIC[1] &&
    verifyBytes[i + 2] === ELF_MAGIC[2] &&
    verifyBytes[i + 3] === ELF_MAGIC[3]
  ) {
    foundElfCount++
    const ei_class = verifyBytes[i + 4]
    const e_machine_lo = verifyBytes[i + 18]
    const e_machine_hi = verifyBytes[i + 19]
    const machine = e_machine_lo | (e_machine_hi << 8)
    const archName =
      machine === EM_AARCH64
        ? "aarch64"
        : machine === EM_X86_64
        ? "x86_64"
        : machine === EM_X86
        ? "x86"
        : `machine=0x${machine.toString(16)}`
    console.log(`  ELF at offset ${i}: ${archName} (${ei_class === 1 ? "32" : "64"}-bit)`)
    if (machine === EM_X86_64) foundX64 = true
    if (machine === EM_X86) foundX86 = true
  }
}

console.log(`  Found ${foundElfCount} embedded ELF image(s)`)

if (foundX64 || foundX86) {
  // bun-pty embeds x86_64 rust_pty .so files because Bun's static analyzer
  // resolves its require() against the host platform (linux/x64). On Android
  // PTY support needs a separate Android/Bionic ARM64 library. Host embedded
  // rust_pty files are dead weight for normal TUI startup; libopentui.so is
  // shipped separately as an ARM64 file loaded via OPENTUI_LIB_PATH.
  console.warn("WARNING: Embedded x86/x86_64 ELF files detected in the Android binary.")
  console.warn("         This is usually rust_pty from the host build and is ignored")
  console.warn("         unless an Android/Bionic PTY library is shipped via BUN_PTY_LIB.")
} else {
  console.log("  No x86/x86_64 embedded ELF files detected: OK")
}

console.log("\n=== Build complete! ===")
console.log(`Output: ${androidOutputPath}`)
