# SKILL.md — Operating guide for AI agents in A Dev Studio (Android runtime)

You are an AI agent running INSIDE the A Dev Studio Android app sandbox
(`com.mobileide.app.phonetest`) on a stock, non-rooted Android 10+ device.
Everything below is fact, verified on hardware. Trust it instead of
experimenting blindly: if something is listed as IMPOSSIBLE here, do not try
workarounds — choose the listed alternative.

## Where you are

- App-private root: `/data/data/com.mobileide.app.phonetest/files`
- Runtime prefix (`$PREFIX`): `<files>/runtime` — this is your `/usr` equivalent.
- Projects live in `$PREFIX/workspaces/<project>`.
- Home (`$HOME`) is `$PREFIX/home`; npm global prefix is `$PREFIX/home/.npm-global`.

Layout:

```
$PREFIX/bin/        node, npm, npx, python3, git, bash, busybox, rg, curl,
                    make, clang/lld wrappers, env shim, opencode launcher
$PREFIX/lib/        node_modules (incl. npm), preload JS, CA bundle,
                    adev-runtime-env-test.js, adev-doctor.js, package-managers/
$PREFIX/home/       XDG dirs, .npmrc, .npm-global, .gitconfig, .config
$PREFIX/workspaces/ user projects (agent picker starts here)
$PREFIX/cache/, $PREFIX/tmp/
```

## Hard platform truths (do NOT fight these)

1. **Executables exist only as packaged libraries.** Android forbids exec from
   app-writable storage. All ELFs ship inside the APK as `lib*.so` and are
   reached through `$PREFIX/bin` trampolines. Never try to chmod +x or execute
   anything under `$HOME`, workspaces, or cache — it cannot work.
   Scripts (`.sh`, `.py`, `.js` with shebangs) run fine anywhere.
2. **One environment contract, already applied.** PATH, HOME, PREFIX, TMPDIR,
   XDG_*, LD_LIBRARY_PATH, LD_PRELOAD, NODE_OPTIONS (exactly one `--require`),
   SSL_CERT_FILE, PYTHON*, npm_config_* are set correctly before any command
   runs. Never export these manually, never `env -i`, never reference Termux
   paths (`/data/data/com.termux`) — none exist and checks reject them.
3. **Spawn children through the provided shells/tools**, not `/system/bin/sh`
   directly. Toybox/system binaries bypass the runtime compatibility layer and
   lose the environment. `bash`, `node`, `python3` are always safe parents.
4. **Detached/background jobs**: use `busybox setsid sh -c 'exec mycommand'`.
   System `setsid` breaks script execution.
5. **Shebangs just work** (`#!/usr/bin/env node`, recursive scripts, npm
   lifecycle scripts) — handled by the exec-compat layer. No tricks needed.
6. **`/tmp` is remapped** to private temp automatically. Never mkdir /tmp.
7. **TLS**: real CA bundle installed (Python + Node verify certificates).
   Never disable verification.

## What works (verified on device)

- Node ~26, npm 11 (install/build/run/npx; spinner visible in terminals),
  corepack-style package managers under `$PREFIX/lib/package-managers/`
  (pnpm, yarn).
- Python 3 incl. subprocesses, pip against real TLS.
- git clone/push over HTTPS (bundled remote-https helper). Foreign CLIs that
  spawn git themselves (GitHub CLI, Go binaries) resolve an exec-safe launcher
  with the same workspace guard — `fork/exec … bin/git: permission denied`
  should not happen anymore; report it if it does.
- Opening http(s) links from any CLI: `adev-open-url https://…` (or
  `xdg-open`) launches the Android browser. `$BROWSER=adev-open-url` is
  exported, so GitHub CLI / Go programs discover it without configuration.
- Secure secret storage for any tool: `printf '%s' "$TOKEN" | adev-secret set
  gh/token`, then `adev-secret get gh/token`; also `adev-secret list` /
  `delete`. Values are AES/GCM-sealed under AndroidKeyStore inside the app and
  travel over stdin + loopback only — never argv, history, or dotfiles. Git's
  own credentials use the same Keystore-backed helper automatically.
- Native addon builds ON DEVICE: node-gyp + clang + make + sysroot
  (N-API C/C++ and V8 addons compile, link, load).
- Dev servers: Vite, Next 13/14/15 (`dev/build/start`), Express — concurrent,
  reachable in Chrome at `http://localhost:<port>` (dual-stack is handled;
  start servers with default/HOST=0.0.0.0, never hardcode 127.0.0.1 binds).
- Bundled OpenCode agent binary (`opencode` on PATH).

## What is IMPOSSIBLE (do not attempt)

- **Listing listening ports** via `netstat`/`ss`/`lsof`/`/proc/net/*`:
  blocked by Android SELinux for all apps on EVERY supported version
  (Android 10 and all newer releases — this never becomes available).
  You will get EACCES or empty output. Not fixable from userspace.
- **Seeing or killing other apps'/system processes**: different UID, hidden.
- `ping` and raw sockets (no raw ICMP for apps).
- Executing downloaded ELF binaries placed outside the APK library dir.

### Port workflow instead (this is the way — identical on all Android 10+ devices)

- `netstat`, `ss` and `lsof` on PATH are A Dev Studio shims: they list the
  app's own listening servers (from the verified task registry) and never
  throw EACCES. `lsof -i :PORT` filters; `-t` prints PIDs. Foreign apps'
  sockets are invisible by OS design — do not expect them.
- **Is a port free?** Try to bind it: `node -e "require('net').createServer().listen(PORT,'0.0.0.0').on('error',()=>{console.log('busy');process.exit(1)}).on('listening',function(){this.close();console.log('free')})"`.
- **What is on a port?** Probe it as a client: `curl -sS -m 2 http://localhost:PORT/`
  (or TCP connect). You learn liveness + identity from responses, not from
  process tables.
- **Which servers did WE start?** The app tracks every task it spawns
  (TaskRegistry): server URLs appear in task/terminal output (`Local: ...`),
  and those PIDs belong to us — `kill <pid>` works for anything started from
  this app's terminals/tasks (process-group kill is automatic on close).
- **Killing a port owner you did not start** is impossible by design; restart
  your own task on a different port instead.

## Self-check before claiming anything works

Run the built-in contract suite (22 offline checks, +1 network):

```
node "$PREFIX/lib/adev-runtime-env-test.js"            # expect: 22/22 passed
node "$PREFIX/lib/adev-runtime-env-test.js" --network  # expect: 23/23 passed
```

If checks fail, report honestly; do not paper over with exported env vars.

## Style rules

- Prefer `$PREFIX`-relative reasoning; never hardcode `/data/data/...` (the
  install ID can change) — use `$PREFIX`, `$HOME`, `$PWD`.
- Long-running servers belong in the app's terminal/tasks so the user sees
  them and can stop them; avoid orphaning background daemons.
- When something errors with EACCES/EPERM, re-read "Hard platform truths"
  above before retrying variants — retries of impossible things waste the
  user's time.
