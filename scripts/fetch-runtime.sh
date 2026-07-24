#!/usr/bin/env bash
# =============================================================================
# ADEV / MobileIDE - Runtime asset fetcher (run on a DESKTOP, not the phone)
# =============================================================================
# Populates android/app/src/main/assets/runtime/ with the support files that
# are too large or license-encumbered to commit to the repo:
#
#   * npm / npx / corepack  (JS + the node_modules/npm tree) from the official
#     Node ARM64 (aarch64) Linux distribution that MATCHES the bundled node.
#   * SSH client tools       (Dropbear multi-call binary, or OpenSSH static).
#   * Python (optional)      a static aarch64 build.
#
# It also pre-strips the large ELF binaries (node, git) with llvm-strip to
# shrink the APK. The Gradle task `prepareRuntimeNativeLibs` later relocates
# every ELF found here into jniLibs/arm64-v8a/lib*.so at build time.
#
# NOTE: The Node .js tooling (npm-cli.js etc.) is architecture-independent, so
# we can extract it on any desktop. Only the ELF binaries must be aarch64.
#
# Usage:
#   NODE_VERSION=v20.11.1 ./scripts/fetch-runtime.sh            # npm + ssh
#   WITH_PYTHON=1 ./scripts/fetch-runtime.sh                    # + python
#   SSH_IMPL=openssh ./scripts/fetch-runtime.sh                 # openssh not dropbear
#
# Requires: bash, curl, tar, xz (for .tar.xz), and optionally llvm-strip.
# =============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# Paths & configuration
# ----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$PROJECT_ROOT/android/app/src/main/assets/runtime"
BIN_DIR="$RUNTIME_DIR/bin"
LIB_DIR="$RUNTIME_DIR/lib"
WORK_DIR="$(mktemp -d)"

# Node version: must match the bundled node ELF. If you don't know it, run
# `strings android/app/src/main/assets/runtime/bin/node | grep -m1 'node v'`
# on the (already relocated) binary, or check libbin_node.so in jniLibs.
NODE_VERSION="${NODE_VERSION:-v20.11.1}"
NODE_ARCH="${NODE_ARCH:-linux-arm64}"
NODE_TARBALL="node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"

# SSH implementation: dropbear (default, tiny) or openssh.
SSH_IMPL="${SSH_IMPL:-dropbear}"
DROPBEAR_URL="${DROPBEAR_URL:-}"      # optional prebuilt aarch64 dropbearmulti URL
OPENSSH_URL="${OPENSSH_URL:-}"        # optional prebuilt aarch64 openssh tarball URL

WITH_PYTHON="${WITH_PYTHON:-0}"
PYTHON_URL="${PYTHON_URL:-}"          # aarch64 static python tarball URL

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}==>${NC} $*"; }
ok()   { echo -e "${GREEN}  ok:${NC} $*"; }
warn() { echo -e "${YELLOW}  warn:${NC} $*"; }
err()  { echo -e "${RED}  err:${NC} $*" >&2; }

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

need() { command -v "$1" >/dev/null 2>&1 || { err "missing required tool: $1"; exit 1; }; }
need curl
need tar

mkdir -p "$BIN_DIR" "$LIB_DIR"

# Locate an llvm-strip / strip for pre-stripping ELF (optional).
STRIP_BIN=""
for cand in llvm-strip llvm-strip-17 llvm-strip-16 aarch64-linux-android-strip strip; do
  if command -v "$cand" >/dev/null 2>&1; then STRIP_BIN="$cand"; break; fi
done
[ -n "$STRIP_BIN" ] && ok "using strip: $STRIP_BIN" || warn "no llvm-strip found; skipping pre-strip"

# ----------------------------------------------------------------------------
# 1. npm / npx / corepack  (from the official Node dist)
# ----------------------------------------------------------------------------
fetch_npm() {
  log "Fetching npm/npx/corepack from Node ${NODE_VERSION} (${NODE_ARCH})"
  local out="$WORK_DIR/$NODE_TARBALL"
  if ! curl -fL --retry 3 -o "$out" "$NODE_URL"; then
    err "download failed: $NODE_URL"
    warn "set NODE_VERSION to match your bundled node and retry"
    return 1
  fi
  need tar
  tar -xf "$out" -C "$WORK_DIR"
  local extracted="$WORK_DIR/node-${NODE_VERSION}-${NODE_ARCH}"

  # The npm/npx/corepack CLIs are plain JS launched through node; copy the
  # whole node_modules trees + the bin launcher scripts.
  mkdir -p "$LIB_DIR/node_modules"
  for pkg in npm corepack; do
    if [ -d "$extracted/lib/node_modules/$pkg" ]; then
      rm -rf "$LIB_DIR/node_modules/$pkg"
      cp -a "$extracted/lib/node_modules/$pkg" "$LIB_DIR/node_modules/$pkg"
      ok "copied lib/node_modules/$pkg"
    else
      warn "not found in dist: lib/node_modules/$pkg"
    fi
  done

  # The bin/ launcher symlinks point at ../lib/node_modules/npm/bin/*.js. We
  # ship the .js entrypoints; the shell shims in .bashrc call node on them.
  # Copy the resolved JS entrypoints to bin/ for discoverability.
  for f in npm-cli.js npx-cli.js; do
    if [ -f "$extracted/lib/node_modules/npm/bin/$f" ]; then
      cp -a "$extracted/lib/node_modules/npm/bin/$f" "$BIN_DIR/$f"
      ok "copied bin/$f"
    fi
  done

  # corepack shim entrypoint
  if [ -f "$extracted/lib/node_modules/corepack/dist/corepack.js" ]; then
    cp -a "$extracted/lib/node_modules/corepack/dist/corepack.js" "$BIN_DIR/corepack.js"
    ok "copied bin/corepack.js"
  fi

  # Android aapt/asset packaging silently drops directories whose names start with
  # '_' (e.g. @sigstore/protobuf-specs dist/__generated__). Rename them and
  # rewrite require() paths so npm can load on-device.
  sanitize_npm_android_assets
}

# Rename underscore-prefixed dirs under the bundled npm tree and patch JS requires.
# Without this, `npm` fails at startup with MODULE_NOT_FOUND for './generated/envelope'.
sanitize_npm_android_assets() {
  local nm="$LIB_DIR/node_modules"
  [ -d "$nm" ] || return 0
  log "Sanitizing npm assets for Android packaging (underscore dirs)"
  # Process deepest dirs first so nested renames are stable.
  while IFS= read -r -d '' d; do
    local parent base new
    parent="$(dirname "$d")"
    base="$(basename "$d")"
    # Strip leading underscores: __generated__ -> generated, _foo -> foo
    new="$(echo "$base" | sed 's/^__*//')"
    [ -n "$new" ] && [ "$new" != "$base" ] || continue
    if [ -e "$parent/$new" ]; then
      warn "skip rename $d (target exists: $parent/$new)"
      continue
    fi
    mv "$d" "$parent/$new"
    ok "renamed $base -> $new"
  done < <(find "$nm" -type d -name '_*' -print0 | sort -z -r)

  # Rewrite require/import paths that still point at the old names.
  if command -v grep >/dev/null 2>&1; then
    while IFS= read -r -d '' f; do
      if grep -q '__generated__' "$f" 2>/dev/null; then
        if command -v sed >/dev/null 2>&1; then
          sed -i.bak 's|__generated__|generated|g' "$f" && rm -f "${f}.bak"
          ok "patched requires in $(basename "$(dirname "$f")")/$(basename "$f")"
        fi
      fi
    done < <(find "$nm" -type f -name '*.js' -print0)
  fi
}

# ----------------------------------------------------------------------------
# 2. SSH (dropbear multi-call binary, or OpenSSH)
#
# dropbearmulti is a single ELF that dispatches on argv[0]. We embed ONLY that
# binary; the app (RuntimeManager.createDropbearAliases) creates the applet
# symlinks (dbclient/scp/dropbearkey/dropbearconvert) on-device, and an `ssh`
# shell shim maps to dbclient. No symlinks are created here (keeps it Windows-
# and traversal-safe for the Gradle relocation step).
# ----------------------------------------------------------------------------
TERMUX_BASE="${TERMUX_BASE:-https://packages.termux.dev/apt/termux-main}"

# Resolve the newest dropbear .deb Filename from the Termux aarch64 index.
resolve_dropbear_deb() {
  local pkgindex
  pkgindex="$(curl -fsSL "$TERMUX_BASE/dists/stable/main/binary-aarch64/Packages" 2>/dev/null)" || return 1
  echo "$pkgindex" | awk '/^Package: dropbear$/{f=1} f&&/^Filename:/{print $2; exit}'
}

# Extract usr/bin/dropbearmulti out of a Termux .deb (ar -> data.tar.{xz,gz,zst}).
extract_dropbear_deb() {
  local deb="$1" ; local outdir="$WORK_DIR/deb" ; mkdir -p "$outdir"
  if command -v ar >/dev/null 2>&1; then
    ( cd "$outdir" && ar x "$deb" )
  elif command -v bsdtar >/dev/null 2>&1; then
    ( cd "$outdir" && bsdtar -xf "$deb" )
  else
    err "need 'ar' (binutils) or bsdtar to extract .deb"; return 1
  fi
  local data
  data="$(find "$outdir" -maxdepth 1 -name 'data.tar*' | head -n1)"
  [ -n "$data" ] || { err "no data.tar in .deb"; return 1; }
  case "$data" in
    *.zst) command -v zstd >/dev/null 2>&1 || { err "need zstd for data.tar.zst"; return 1; }
           zstd -d -c "$data" | tar -x -C "$outdir" ;;
    *)     tar -xf "$data" -C "$outdir" ;;
  esac
  local bin
  bin="$(find "$outdir" -type f -name dropbearmulti | head -n1)"
  [ -n "$bin" ] || { err "dropbearmulti not found in package"; return 1; }
  cp -a "$bin" "$BIN_DIR/dropbearmulti"
  chmod +x "$BIN_DIR/dropbearmulti"
}

fetch_ssh() {
  if [ "$SSH_IMPL" = "dropbear" ]; then
    # Direct binary override wins if provided.
    if [ -n "$DROPBEAR_URL" ]; then
      log "Fetching dropbearmulti (aarch64) from DROPBEAR_URL"
      curl -fL --retry 3 -o "$BIN_DIR/dropbearmulti" "$DROPBEAR_URL"
      chmod +x "$BIN_DIR/dropbearmulti"
      ok "dropbearmulti embedded (applets are wired on-device)"
      return 0
    fi
    # Otherwise resolve+download the .deb from the Termux repo automatically.
    log "Resolving dropbear from Termux repo ($TERMUX_BASE)"
    local rel ; rel="$(resolve_dropbear_deb)" || true
    if [ -z "$rel" ]; then
      warn "could not resolve dropbear from Termux; set DROPBEAR_URL to a direct"
      warn "aarch64 'dropbearmulti' binary and re-run. Skipping ssh."
      return 0
    fi
    local deb="$WORK_DIR/dropbear.deb"
    log "Downloading $rel"
    if ! curl -fL --retry 3 -o "$deb" "$TERMUX_BASE/$rel"; then
      warn "dropbear .deb download failed; skipping ssh"; return 0
    fi
    if extract_dropbear_deb "$deb"; then
      ok "dropbearmulti embedded (applets are wired on-device)"
    else
      warn "dropbear extraction failed; skipping ssh"
    fi
  else
    if [ -z "$OPENSSH_URL" ]; then
      warn "SSH: set OPENSSH_URL to an aarch64 OpenSSH tarball to enable ssh. Skipping."
      return 0
    fi
    log "Fetching OpenSSH (aarch64)"
    local out="$WORK_DIR/openssh.tar.gz"
    curl -fL --retry 3 -o "$out" "$OPENSSH_URL"
    tar -xf "$out" -C "$WORK_DIR/"
    for tool in ssh ssh-keygen scp sftp; do
      f="$(find "$WORK_DIR" -type f -name "$tool" | head -n1 || true)"
      if [ -n "$f" ]; then cp -a "$f" "$BIN_DIR/$tool"; chmod +x "$BIN_DIR/$tool"; ok "copied $tool"; fi
    done
  fi
}

# ----------------------------------------------------------------------------
# 3. Python (optional, static aarch64)
# ----------------------------------------------------------------------------
fetch_python() {
  [ "$WITH_PYTHON" = "1" ] || return 0
  if [ -z "$PYTHON_URL" ]; then
    warn "WITH_PYTHON=1 but PYTHON_URL not set; skipping python"
    return 0
  fi
  log "Fetching Python (aarch64)"
  local out="$WORK_DIR/python.tar.gz"
  curl -fL --retry 3 -o "$out" "$PYTHON_URL"
  tar -xf "$out" -C "$RUNTIME_DIR/"
  ok "python extracted into runtime"
}

# ----------------------------------------------------------------------------
# 4. Pre-strip the large ELF binaries to shrink the APK
# ----------------------------------------------------------------------------
strip_elf() {
  [ -n "$STRIP_BIN" ] || return 0
  log "Pre-stripping ELF binaries"
  # Only strip real ELF files (skip shell-script git-core helpers).
  while IFS= read -r -d '' f; do
    # ELF magic: 0x7F 45 4C 46
    if head -c4 "$f" | od -An -tx1 2>/dev/null | grep -qi '7f 45 4c 46'; then
      before=$(wc -c < "$f")
      "$STRIP_BIN" --strip-unneeded "$f" 2>/dev/null || "$STRIP_BIN" "$f" 2>/dev/null || true
      after=$(wc -c < "$f")
      ok "stripped $(basename "$f"): ${before} -> ${after} bytes"
    fi
  done < <(find "$BIN_DIR" -type f -print0)
}

# ----------------------------------------------------------------------------
# 5. git-core dedup: replace true-builtin ELF duplicates with symlinks to git
# ----------------------------------------------------------------------------
dedup_gitcore() {
  local core="$BIN_DIR/git-core"
  [ -d "$core" ] || return 0
  [ -f "$BIN_DIR/git" ] || return 0
  log "De-duplicating git-core builtins against bin/git"
  local gitsum core_sum
  gitsum="$( (sha256sum "$BIN_DIR/git" 2>/dev/null || shasum -a256 "$BIN_DIR/git") | awk '{print $1}')"
  while IFS= read -r -d '' f; do
    # skip if it is already a symlink or a shell script
    [ -L "$f" ] && continue
    head -c4 "$f" | od -An -tx1 2>/dev/null | grep -qi '7f 45 4c 46' || continue
    core_sum="$( (sha256sum "$f" 2>/dev/null || shasum -a256 "$f") | awk '{print $1}')"
    if [ "$core_sum" = "$gitsum" ]; then
      rm -f "$f"
      ln -s ../git "$f"
      ok "symlinked $(basename "$f") -> git"
    fi
  done < <(find "$core" -type f -print0)
}

# ----------------------------------------------------------------------------
main() {
  echo -e "${GREEN}ADEV runtime asset fetcher${NC}"
  echo "Runtime dir: $RUNTIME_DIR"
  echo "Node:        $NODE_VERSION ($NODE_ARCH)"
  echo "SSH impl:    $SSH_IMPL"
  echo "Python:      $([ "$WITH_PYTHON" = 1 ] && echo yes || echo no)"
  echo "----------------------------------------"

  fetch_npm  || warn "npm fetch skipped/failed"
  fetch_ssh  || warn "ssh fetch skipped/failed"
  fetch_python || warn "python fetch skipped/failed"
  dedup_gitcore || true
  strip_elf || true

  echo "----------------------------------------"
  echo -e "${GREEN}Done.${NC} Assets are in: $RUNTIME_DIR"
  echo "Next: build the app. The Gradle task 'prepareRuntimeNativeLibs' will"
  echo "relocate every ELF into jniLibs/arm64-v8a/lib*.so automatically."
}

main "$@"
