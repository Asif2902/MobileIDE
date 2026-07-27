package com.mobileide.app.runtime

import android.content.Context
import android.content.res.AssetManager
import android.system.Os
import android.system.OsConstants
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * RuntimeManager handles extraction and management of the bundled developer runtime.
 * The runtime includes Node.js, Bash, Git, and core utilities for ARM64 Android.
 *
 * Execution model
 * ---------------
 * Android 10+ (this app targets SDK 34) forbids execve() of any file that lives
 * in the writable app data dir (filesDir/runtime/bin). The only app-owned,
 * exec-permitted location is nativeLibraryDir. The Gradle task
 * `prepareRuntimeNativeLibs` therefore relocates every ELF binary into
 * jniLibs/arm64-v8a/lib<mangled>.so and writes assets/runtime/native-map.json
 * (originalRelPath -> libName). At init we rebuild a *symlink farm* inside the
 * runtime tree: each original path (bin/node, bin/git, bin/git-core/...) becomes
 * a symlink to nativeLibraryDir/lib<mangled>.so. Non-ELF support files (JS,
 * shell scripts, config) are extracted normally.
 *
 * Runtime root structure:
 * {filesDir}/runtime/
 * ├── bin/          (symlinks into nativeLibraryDir + non-ELF helpers)
 * ├── lib/          (shared libraries / node_modules)
 * ├── home/         (user home directory, .npm-global, .local/bin)
 * ├── workspaces/   (all projects)
 * ├── tmp/          (temporary files)
 * ├── cache/        (npm cache, etc.)
 * └── etc/          (minimal config, ssl/certs, git-templates)
 */
class RuntimeManager(private val context: Context) {

    companion object {
        private const val TAG = "RuntimeManager"
        private const val RUNTIME_DIR = "runtime"
        private const val RUNTIME_VERSION_FILE = ".runtime_version"
        // Bump whenever bundled runtime assets change so devices re-extract.
        private const val CURRENT_RUNTIME_VERSION = "1.9.0"
        private const val NATIVE_MAP_FILE = "native-map.json"
        private const val RUNTIME_FINGERPRINT_FILE = ".runtime_fingerprint"

        // Virtual root paths (exposed to user)
        const val VIRTUAL_ROOT = "/root"
        const val VIRTUAL_BIN = "/root/bin"
        const val VIRTUAL_HOME = "/root/home"
        const val VIRTUAL_WORKSPACES = "/root/workspaces"
        const val VIRTUAL_TMP = "/root/tmp"
        const val VIRTUAL_CACHE = "/root/cache"
    }

    private val runtimeRoot: File by lazy { File(context.filesDir, RUNTIME_DIR) }
    private val binDir: File by lazy { File(runtimeRoot, "bin") }
    private val libDir: File by lazy { File(runtimeRoot, "lib") }
    private val homeDir: File by lazy { File(runtimeRoot, "home") }
    private val workspacesDir: File by lazy { File(runtimeRoot, "workspaces") }
    private val tmpDir: File by lazy { File(runtimeRoot, "tmp") }
    private val cacheDir: File by lazy { File(runtimeRoot, "cache") }
    private val etcDir: File by lazy { File(runtimeRoot, "etc") }

    // Global CLI install locations (npm -g, pip --user style, etc.)
    private val npmGlobalDir: File by lazy { File(homeDir, ".npm-global") }
    private val localBinDir: File by lazy { File(homeDir, ".local/bin") }
    private val caBundleFile: File by lazy { File(etcDir, "ssl/certs/ca-bundle.crt") }
    private val gitTemplateDir: File by lazy { File(etcDir, "git-templates") }

    /**
     * Check if runtime is already installed and up-to-date
     */
    fun isRuntimeReady(): Boolean {
        val versionFile = File(runtimeRoot, RUNTIME_VERSION_FILE)
        if (!versionFile.exists()) return false
        if (versionFile.readText().trim() != CURRENT_RUNTIME_VERSION) return false
        if (!binDir.exists() || !binDir.isDirectory) return false

        // Re-initialize whenever the bundled binary/library set changes, even if
        // the version string is unchanged. The fingerprint of native-map.json
        // (shipped in the APK) is compared against the fingerprint captured at the
        // last successful init; a mismatch means .so files were added/changed and
        // the symlink farm must be rebuilt. This self-heals the case where a newer
        // APK adds shared libraries but reuses the same runtime version.
        val stored = File(runtimeRoot, RUNTIME_FINGERPRINT_FILE)
        if (!stored.exists()) return false
        val current = assetNativeMapFingerprint() ?: return false
        if (stored.readText().trim() != current) return false

        // Guard against a partial/corrupted prior init: the node binary symlink
        // must resolve to a real file (File.exists() follows symlinks, so a
        // dangling link returns false and triggers a rebuild).
        if (!File(binDir, "node").exists()) return false

        return true
    }

    /**
     * SHA-256 of the native-map.json bundled in the APK assets. Detects when the
     * runtime binary/library set has changed between app upgrades so the symlink
     * farm is rebuilt even if CURRENT_RUNTIME_VERSION was not bumped.
     */
    private fun assetNativeMapFingerprint(): String? {
        return try {
            val bytes = context.assets.open("$RUNTIME_DIR/$NATIVE_MAP_FILE").use { it.readBytes() }
            java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
                .joinToString("") { "%02x".format(it) }
        } catch (e: Exception) {
            Log.w(TAG, "Could not fingerprint native-map.json: ${e.message}")
            null
        }
    }

    /**
     * Initialize the runtime by extracting binaries from APK assets.
     * This is called on first launch or when runtime version changes.
     */
    @Throws(IOException::class)
    fun initializeRuntime(onProgress: ((String, Float) -> Unit)? = null) {
        Log.i(TAG, "Initializing runtime v$CURRENT_RUNTIME_VERSION")

        onProgress?.invoke("Creating directories...", 0.05f)
        createDirectoryStructure()
        restoreBinWritability()

        onProgress?.invoke("Extracting runtime files...", 0.1f)
        extractRuntimeAssets(onProgress)

        onProgress?.invoke("Setting permissions...", 0.8f)
        setExecutablePermissions()

        onProgress?.invoke("Linking native binaries...", 0.85f)
        buildSymlinkFarm()
        createDropbearAliases()
        createGitRemoteAliases()
        createBusyboxAliases()
        createNpmShellAlias()

        onProgress?.invoke("Protecting runtime...", 0.9f)
        protectBinDirectory()

        onProgress?.invoke("Configuring environment...", 0.93f)
        setupEnvironment()
        setupPlatformSpoof()
        setupShellWrappers()
        setupNpmrc()

        onProgress?.invoke("Preparing certificates...", 0.95f)
        setupCaBundle()

        onProgress?.invoke("Creating workspace...", 0.97f)
        createGlobalDirs()
        createDefaultWorkspace()
        createDevProjectTemplates()

        // Mark runtime as installed. The fingerprint is written last so that an
        // interrupted init is not mistaken for a complete one on next launch.
        File(runtimeRoot, RUNTIME_VERSION_FILE).writeText(CURRENT_RUNTIME_VERSION)
        assetNativeMapFingerprint()?.let {
            File(runtimeRoot, RUNTIME_FINGERPRINT_FILE).writeText(it)
        }

        onProgress?.invoke("Runtime ready!", 1.0f)
        Log.i(TAG, "Runtime initialization complete")
    }

    /**
     * A prior init marks bin/ (and its files) read-only via protectBinDirectory().
     * Before re-extracting assets on an upgrade we must restore write access
     * across the bin tree, otherwise overwriting a protected helper script throws
     * and aborts the rebuild. Cheap because bin/ holds only a handful of files.
     */
    private fun restoreBinWritability() {
        if (!binDir.exists()) return
        fun walk(f: File) {
            try { f.setWritable(true, false) } catch (_: Exception) { }
            if (f.isDirectory) f.listFiles()?.forEach { walk(it) }
        }
        walk(binDir)
    }

    /**
     * Create the runtime directory structure
     */
    private fun createDirectoryStructure() {
        listOf(runtimeRoot, binDir, libDir, homeDir, workspacesDir, tmpDir, cacheDir, etcDir).forEach { dir ->
            if (!dir.exists()) {
                dir.mkdirs()
                Log.d(TAG, "Created directory: ${dir.absolutePath}")
            } else {
                // Ensure a previously read-only bin dir can be refreshed.
                dir.setWritable(true, false)
            }
        }
    }

    /**
     * Extract runtime support files from APK assets to the runtime directory.
     * ELF binaries no longer live in assets (they were relocated to jniLibs by
     * the Gradle task); only JS, shell scripts, config and native-map.json are
     * extracted here.
     */
    private fun extractRuntimeAssets(onProgress: ((String, Float) -> Unit)? = null) {
        val assetManager = context.assets
        val runtimeAssetPath = "runtime"

        try {
            val assets = assetManager.list(runtimeAssetPath) ?: emptyArray()
            if (assets.isEmpty()) {
                Log.e(TAG, "No runtime assets found - runtime binaries are missing")
                return
            }

            val totalAssets = assets.size.toFloat()
            assets.forEachIndexed { index, assetName ->
                val progress = 0.1f + (0.65f * (index / totalAssets))
                onProgress?.invoke("Extracting $assetName...", progress)
                extractAssetRecursive(assetManager, "$runtimeAssetPath/$assetName", runtimeRoot)
            }
        } catch (e: IOException) {
            Log.e(TAG, "Error extracting runtime assets", e)
        }
    }

    /**
     * Recursively extract assets from APK
     */
    private fun extractAssetRecursive(assetManager: AssetManager, assetPath: String, destDir: File) {
        val assets = assetManager.list(assetPath)

        if (assets.isNullOrEmpty()) {
            // It's a file, extract it
            val fileName = assetPath.substringAfterLast('/')
            val destFile = File(destDir, fileName)

            assetManager.open(assetPath).use { input ->
                FileOutputStream(destFile).use { output ->
                    input.copyTo(output)
                }
            }
        } else {
            // It's a directory
            val dirName = assetPath.substringAfterLast('/')
            val subDir = File(destDir, dirName)
            if (!subDir.exists()) subDir.mkdirs()

            assets.forEach { asset ->
                extractAssetRecursive(assetManager, "$assetPath/$asset", subDir)
            }
        }
    }

    /**
     * Build the symlink farm: for every entry in native-map.json, create a
     * symlink inside the runtime tree pointing at the real ELF that now lives in
     * nativeLibraryDir (the only exec-permitted location on Android 10+).
     */
    private fun buildSymlinkFarm() {
        val mapFile = File(runtimeRoot, NATIVE_MAP_FILE)
        if (!mapFile.exists()) {
            Log.w(TAG, "native-map.json not found - runtime binaries unavailable")
            return
        }
        val nativeLibDir = context.applicationInfo.nativeLibraryDir
        val entries = try {
            parseNativeMap(mapFile.readText())
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse native-map.json", e)
            return
        }

        var created = 0
        for ((relPath, libName) in entries) {
            val target = File(nativeLibDir, libName)
            val link = File(runtimeRoot, relPath)
            try {
                link.parentFile?.let {
                    it.mkdirs()
                    it.setWritable(true, false)
                }
                if (link.exists() || isSymlink(link)) link.delete()
                if (!target.exists()) {
                    Log.w(TAG, "Native lib missing for $relPath: ${target.absolutePath}")
                    continue
                }
                Os.symlink(target.absolutePath, link.absolutePath)
                created++
            } catch (e: Exception) {
                Log.e(TAG, "Symlink failed for $relPath", e)
            }
        }
        Log.i(TAG, "Symlink farm ready: $created binaries linked to $nativeLibDir")
    }

    private fun isSymlink(file: File): Boolean = try {
        OsConstants.S_ISLNK(Os.lstat(file.absolutePath).st_mode)
    } catch (e: Exception) {
        false
    }

    /**
     * Dropbear ships as a single multi-call binary (dropbearmulti) that
     * dispatches on argv[0]. If it was embedded (relocated to
     * libbin_dropbearmulti.so), create symlinks for each applet so `dbclient`,
     * `scp`, `dropbearkey`, `dropbearconvert` resolve on PATH. The `ssh` name is
     * provided as a shell shim (rc files) since it is not a native applet name.
     */
    private fun createDropbearAliases() {
        val nativeLibDir = context.applicationInfo.nativeLibraryDir
        val dropbearLib = File(nativeLibDir, "libbin_dropbearmulti.so")
        if (!dropbearLib.exists()) {
            Log.d(TAG, "dropbear not embedded; skipping ssh aliases")
            return
        }
        binDir.setWritable(true, false)
        listOf("dbclient", "scp", "dropbearkey", "dropbearconvert").forEach { name ->
            val link = File(binDir, name)
            try {
                if (link.exists() || isSymlink(link)) link.delete()
                Os.symlink(dropbearLib.absolutePath, link.absolutePath)
            } catch (e: Exception) {
                Log.e(TAG, "dropbear alias $name failed", e)
            }
        }
        Log.i(TAG, "Dropbear ssh applets linked (dbclient, scp, dropbearkey, dropbearconvert)")
    }

    /**
     * Git looks up protocol helpers as `git-remote-<scheme>` under GIT_EXEC_PATH.
     * We ship a single ELF (`git-remote-http`) that handles both http and https
     * (same as upstream git, where git-remote-https is a hardlink/symlink to it).
     * Without the https name, `git clone https://...` fails with:
     *   git: 'remote-https' is not a git command
     */
    private fun createGitRemoteAliases() {
        val nativeLibDir = context.applicationInfo.nativeLibraryDir
        val httpLib = File(nativeLibDir, "libbin_git_core_git_remote_http.so")
        val httpLink = File(binDir, "git-core/git-remote-http")
        val target: String = when {
            httpLib.exists() -> httpLib.absolutePath
            httpLink.exists() -> try {
                httpLink.canonicalPath
            } catch (_: Exception) {
                httpLink.absolutePath
            }
            else -> {
                Log.w(TAG, "git-remote-http missing; HTTPS clone will fail")
                return
            }
        }

        val gitCore = File(binDir, "git-core")
        gitCore.mkdirs()
        gitCore.setWritable(true, false)

        // Upstream names that resolve to the same remote-http helper binary.
        listOf("git-remote-https", "git-remote-ftp", "git-remote-ftps").forEach { name ->
            val link = File(gitCore, name)
            try {
                if (link.exists() || isSymlink(link)) link.delete()
                Os.symlink(target, link.absolutePath)
            } catch (e: Exception) {
                Log.e(TAG, "git remote alias $name failed", e)
            }
        }
        Log.i(TAG, "git remote helpers linked (https/ftp/ftps -> remote-http)")
    }

    /**
     * Busybox multi-call: only link the `busybox` entry itself into bin/.
     * Per-applet symlinks under filesDir are dangerous on Android 10+ noexec
     * (they shadow working /system/bin/toybox tools when the symlink exec fails).
     * Applets are provided as shell functions in setupShellWrappers() that invoke
     * the ELF in nativeLibraryDir with the applet name as argv0/arg.
     */
    private fun createBusyboxAliases() {
        val nativeLibDir = context.applicationInfo.nativeLibraryDir
        val busyboxLib = File(nativeLibDir, "libbin_busybox.so")
        if (!busyboxLib.exists()) {
            Log.d(TAG, "busybox not embedded; relying on /system/bin toybox + shell wrappers")
            return
        }
        binDir.setWritable(true, false)
        // Remove any previous broken applet symlinks that shadowed toybox.
        listOf(
            "ls", "cat", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown",
            "touch", "find", "grep", "sed", "awk", "head", "tail", "wc", "sort", "uniq",
            "tr", "cut", "xargs", "tee", "diff", "which", "whoami", "id",
            "clear", "sleep", "date", "base64", "md5sum", "sha256sum",
            "tar", "gzip", "gunzip", "bzip2", "xz", "wget", "vi", "less", "more",
            "ps", "kill", "killall", "pgrep", "pkill", "du", "df", "realpath",
            "dirname", "basename", "env", "printenv", "seq", "yes", "true", "false",
            "test", "echo", "printf"
        ).forEach { name ->
            val link = File(binDir, name)
            try {
                if (link.exists() || isSymlink(link)) link.delete()
            } catch (_: Exception) { }
        }
        try {
            val link = File(binDir, "busybox")
            if (link.exists() || isSymlink(link)) link.delete()
            Os.symlink(busyboxLib.absolutePath, link.absolutePath)
            Log.i(TAG, "busybox binary linked (applets via shell wrappers)")
        } catch (e: Exception) {
            Log.e(TAG, "busybox self-link failed", e)
        }
    }

    /**
     * Write shell functions that exec real ELFs under nativeLibraryDir.
     * Android 10+ noexec blocks execve of paths under filesDir (even symlinks),
     * so `node`/`ls` must not rely on $PREFIX/bin/node alone — call the .so path.
     */
    private fun setupShellWrappers() {
        try {
            val nativeLibDir = context.applicationInfo.nativeLibraryDir
            val node = File(nativeLibDir, "libbin_node.so").absolutePath
            val git = File(nativeLibDir, "libbin_git.so").absolutePath
            val bash = File(nativeLibDir, "libbin_bash.so").absolutePath
            val busybox = File(nativeLibDir, "libbin_busybox.so").absolutePath
            val npmShell = File(nativeLibDir, "libbin_adev_npm_shell.so").absolutePath
            val hasBusybox = File(nativeLibDir, "libbin_busybox.so").exists()
            val hasNode = File(nativeLibDir, "libbin_node.so").exists()
            val hasGit = File(nativeLibDir, "libbin_git.so").exists()

            // Full useful set for agents (OpenCode) + daily terminal work.
            val applets = listOf(
                // file ops
                "ls", "cat", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown", "chgrp",
                "touch", "find", "install", "sync", "truncate", "dd", "readlink", "stat",
                "mktemp", "mkfifo", "realpath", "dirname", "basename",
                // text
                "grep", "egrep", "fgrep", "sed", "awk", "head", "tail", "wc", "sort", "uniq",
                "tr", "cut", "xargs", "tee", "diff", "patch", "cmp", "comm", "paste", "fold",
                "expand", "unexpand", "nl", "rev", "split", "od", "hexdump", "strings",
                "printf", "echo", "yes", "seq", "fmt", "pr", "tac", "shuf", "column",
                // checksums / encode
                "md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum", "base64", "base32",
                // archive
                "tar", "gzip", "gunzip", "bzip2", "bzcat", "xz", "zcat", "lzma", "unlzma",
                // process / system
                "ps", "kill", "killall", "pgrep", "pkill", "top", "free", "uptime", "nproc",
                "du", "df", "mount", "umount", "sysctl", "dmesg", "uname", "id", "whoami",
                "groups", "logname", "tty", "stty", "env", "printenv", "expr", "test",
                "true", "false", "clear", "reset", "sleep", "date", "hwclock", "time", "timeout",
                "nice", "nohup", "watch", "which", "whereis", "type",
                // network (when applet present)
                "wget", "nc", "netstat", "ifconfig", "ip", "ping", "route", "hostname",
                // editors / pagers
                "vi", "less", "more", "ed",
                // shell
                "sh", "ash"
            )

            val sb = StringBuilder()
            sb.appendLine("# Generated by RuntimeManager — do not edit by hand")
            sb.appendLine("# Exec ELFs from nativeLibraryDir (exec-safe). filesDir is noexec.")
            sb.appendLine("export MOBILEIDE_NATIVE_LIB=\"$nativeLibDir\"")
            sb.appendLine("# Agent-friendly: always source this file in non-interactive shells")
            sb.appendLine("export ADEV_WRAPPERS=\"\$HOME/.adev-wrappers\"")
            sb.appendLine()

            if (hasNode) {
                sb.appendLine("node() { \"$node\" \"\$@\"; }")
                sb.appendLine("npm() { \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npm-cli.js\" \"\$@\"; }")
                sb.appendLine("npx() { \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npx-cli.js\" \"\$@\"; }")
                sb.appendLine("if [ -f \"\$PREFIX/lib/node_modules/corepack/dist/corepack.js\" ]; then")
                sb.appendLine("  corepack() { \"$node\" \"\$PREFIX/lib/node_modules/corepack/dist/corepack.js\" \"\$@\"; }")
                sb.appendLine("  yarn() { \"$node\" \"\$PREFIX/lib/node_modules/corepack/dist/corepack.js\" yarn \"\$@\"; }")
                sb.appendLine("  pnpm() { \"$node\" \"\$PREFIX/lib/node_modules/corepack/dist/corepack.js\" pnpm \"\$@\"; }")
                sb.appendLine("fi")
                // Common build/typecheck tools via npx (works for agents + humans)
                sb.appendLine("tsc() { npx --no-install tsc \"\$@\" 2>/dev/null || npx tsc \"\$@\"; }")
                sb.appendLine("eslint() { npx --no-install eslint \"\$@\" 2>/dev/null || npx eslint \"\$@\"; }")
                sb.appendLine("prettier() { npx --no-install prettier \"\$@\" 2>/dev/null || npx prettier \"\$@\"; }")
                sb.appendLine("vite() { npx --no-install vite \"\$@\" 2>/dev/null || npx vite \"\$@\"; }")
                sb.appendLine("esbuild() { npx --no-install esbuild \"\$@\" 2>/dev/null || npx esbuild \"\$@\"; }")
                sb.appendLine()
            }
            if (hasGit) {
                sb.appendLine("git() { \"$git\" \"\$@\"; }")
                sb.appendLine()
            }
            if (File(nativeLibDir, "libbin_bash.so").exists()) {
                sb.appendLine("bash() { \"$bash\" \"\$@\"; }")
                sb.appendLine()
            }
            if (File(nativeLibDir, "libbin_adev_npm_shell.so").exists()) {
                sb.appendLine("adev-npm-shell() { \"$npmShell\" \"\$@\"; }")
                sb.appendLine()
            }

            if (hasBusybox) {
                sb.appendLine("busybox() { \"$busybox\" \"\$@\"; }")
                // Multi-call: busybox <applet> args — works even when argv0 tricks fail.
                applets.forEach { ap ->
                    if (ap == "sh" || ap == "ash") {
                        // Don't override interactive shell entry for mksh/bash; provide ash helper only.
                        if (ap == "ash") {
                            sb.appendLine("ash() { \"$busybox\" ash \"\$@\"; }")
                        }
                        return@forEach
                    }
                    sb.appendLine(
                        "$ap() { \"$busybox\" $ap \"\$@\" 2>/dev/null || /system/bin/$ap \"\$@\" 2>/dev/null || /system/xbin/$ap \"\$@\"; }"
                    )
                }
                sb.appendLine()
            } else {
                applets.forEach { ap ->
                    if (ap == "sh" || ap == "ash") return@forEach
                    sb.appendLine(
                        "$ap() { /system/bin/$ap \"\$@\" 2>/dev/null || /system/xbin/$ap \"\$@\" || command $ap \"\$@\"; }"
                    )
                }
                sb.appendLine()
            }

            // Build / typecheck shortcuts for agents & humans
            sb.appendLine("adev-typecheck() { npm run typecheck 2>/dev/null || npx tsc --noEmit \"\$@\"; }")
            sb.appendLine("adev-build() { npm run build \"\$@\"; }")
            sb.appendLine("adev-test() { npm test \"\$@\"; }")
            sb.appendLine("adev-dev() { npm run dev \"\$@\" 2>/dev/null || npm start \"\$@\"; }")
            sb.appendLine()

            sb.appendLine("adev-doctor() {")
            sb.appendLine("  echo \"=== ADEV doctor ===\"")
            sb.appendLine("  echo \"NATIVE=\$MOBILEIDE_NATIVE_LIB\"")
            sb.appendLine("  echo \"PREFIX=\$PREFIX\"")
            sb.appendLine("  echo -n \"node: \"; node -v 2>&1")
            sb.appendLine("  echo -n \"platform: \"; node -p \"process.platform+' '+process.arch\" 2>&1")
            sb.appendLine("  echo -n \"npm: \"; npm -v 2>&1")
            sb.appendLine("  echo -n \"git: \"; git --version 2>&1")
            sb.appendLine("  echo -n \"ls: \"; ls -la /system/bin 2>&1 | head -n 2")
            sb.appendLine("  echo -n \"grep: \"; echo hello | grep hello 2>&1")
            sb.appendLine("  echo -n \"busybox: \"; busybox echo ok 2>&1 || echo missing")
            sb.appendLine("  echo -n \"tar: \"; tar --help 2>&1 | head -n 1")
            sb.appendLine("  echo \"PATH=\$PATH\"")
            sb.appendLine("  echo \"For agents: source \$HOME/.adev-wrappers before commands\"")
            sb.appendLine("}")

            val out = File(homeDir, ".adev-wrappers")
            out.writeText(sb.toString())

            // Non-interactive agent bootstrap (OpenCode / background tools).
            val agentEnv = StringBuilder()
            agentEnv.appendLine("# Source in agent shells:  . \"\$HOME/.adev-agent-env\"")
            agentEnv.appendLine("export PREFIX=\"${runtimeRoot.absolutePath}\"")
            agentEnv.appendLine("export HOME=\"${homeDir.absolutePath}\"")
            agentEnv.appendLine("export MOBILEIDE_NATIVE_LIB=\"$nativeLibDir\"")
            agentEnv.appendLine("export HOST=0.0.0.0")
            agentEnv.appendLine("export BROWSER=none")
            agentEnv.appendLine("export CHOKIDAR_USEPOLLING=true")
            agentEnv.appendLine("export WATCHPACK_POLLING=true")
            agentEnv.appendLine("export npm_config_platform=linux")
            agentEnv.appendLine("export npm_config_arch=arm64")
            agentEnv.appendLine("[ -f \"\$HOME/.adev-wrappers\" ] && . \"\$HOME/.adev-wrappers\"")
            agentEnv.appendLine(
                "[ -f \"\$PREFIX/lib/adev-platform-spoof.js\" ] && " +
                    "export NODE_OPTIONS=\"--require \$PREFIX/lib/adev-platform-spoof.js \${'$'}{NODE_OPTIONS:-}\""
            )
            File(homeDir, ".adev-agent-env").writeText(agentEnv.toString())

            Log.i(TAG, "Wrote shell wrappers + agent env: ${out.absolutePath}")
        } catch (e: Exception) {
            Log.w(TAG, "setupShellWrappers failed: ${e.message}")
        }
    }

    /**
     * Link bin/adev-npm-shell to the native trampoline that runs npm lifecycle
     * scripts via node when filesDir is noexec (fixes Permission denied on
     * node_modules/.bin shims and postinstall .mjs files).
     */
    private fun createNpmShellAlias() {
        val nativeLibDir = context.applicationInfo.nativeLibraryDir
        // CMake names it libbin_adev_npm_shell.so (see cpp/CMakeLists.txt).
        val candidates = listOf(
            File(nativeLibDir, "libbin_adev_npm_shell.so"),
            File(nativeLibDir, "libadev_npm_shell.so")
        )
        val target = candidates.firstOrNull { it.exists() }
        if (target == null) {
            Log.w(TAG, "adev-npm-shell ELF missing in $nativeLibDir — npm scripts may hit noexec")
            return
        }
        binDir.setWritable(true, false)
        listOf("adev-npm-shell", "npm-shell").forEach { name ->
            val link = File(binDir, name)
            try {
                if (link.exists() || isSymlink(link)) link.delete()
                Os.symlink(target.absolutePath, link.absolutePath)
            } catch (e: Exception) {
                Log.e(TAG, "npm-shell alias $name failed", e)
            }
        }
        Log.i(TAG, "adev-npm-shell linked -> ${target.absolutePath}")
    }

    private fun parseNativeMap(json: String): Map<String, String> {
        val obj = JSONObject(json)
        val result = LinkedHashMap<String, String>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            result[k] = obj.getString(k)
        }
        return result
    }

    /**
     * Set executable permissions on non-symlink files in bin/ and subdirectories.
     * Symlinks resolve to nativeLibraryDir, which is already exec-permitted.
     */
    private fun setExecutablePermissions() {
        setPermissionsRecursive(binDir)

        // Also set permissions on lib directory
        libDir.listFiles()?.forEach { file ->
            if (file.isFile) {
                file.setReadable(true, false)
            }
        }
    }

    private fun setPermissionsRecursive(dir: File) {
        dir.listFiles()?.forEach { file ->
            if (file.isDirectory) {
                setPermissionsRecursive(file)
            } else if (file.isFile) {
                try {
                    Os.chmod(file.absolutePath, 0b111101101) // 755
                } catch (e: Exception) {
                    file.setExecutable(true, false)
                    file.setReadable(true, false)
                }
            }
        }
    }

    /**
     * Make bin directory read-only to protect runtime binaries
     */
    private fun protectBinDirectory() {
        binDir.setWritable(false, false)
        binDir.listFiles()?.forEach { file ->
            file.setWritable(false, false)
        }
        Log.i(TAG, "Runtime bin directory protected (read-only)")
    }

    /**
     * Setup environment configuration files
     */
    private fun setupEnvironment() {
        gitTemplateDir.mkdirs()

        // Create .profile (sourced by mksh on Android)
        val profile = File(homeDir, ".profile")
        profile.writeText(getProfileContent())

        // Also create .bashrc in case bash is used later
        val bashrc = File(homeDir, ".bashrc")
        bashrc.writeText(getBashrcContent())

        // Create .mkshrc for Android's default shell
        val mkshrc = File(homeDir, ".mkshrc")
        mkshrc.writeText(getMkshrcContent())

        // Create minimal /etc files for git
        val passwd = File(etcDir, "passwd")
        passwd.writeText("root:x:0:0:root:${homeDir.absolutePath}:/bin/sh\n")

        val group = File(etcDir, "group")
        group.writeText("root:x:0:\n")

        // Create git config
        val gitconfig = File(homeDir, ".gitconfig")
        if (!gitconfig.exists()) {
            gitconfig.writeText("""
                [user]
                    name = A Dev Studio User
                    email = user@adevstudio.local
                [core]
                    editor = vi
                [init]
                    defaultBranch = main
            """.trimIndent())
        }
    }

    /**
     * Create global CLI install locations so `npm install -g` works and the
     * installed bins are discoverable via shell shims / termux-exec.
     */
    private fun createGlobalDirs() {
        listOf(
            npmGlobalDir,
            File(npmGlobalDir, "bin"),
            File(npmGlobalDir, "lib/node_modules"),
            localBinDir
        ).forEach { if (!it.exists()) it.mkdirs() }
    }

    /**
     * Ensure the platform-spoof preload script is present under the runtime
     * tree (copied from assets, or written if missing). Used via NODE_OPTIONS.
     */
    private fun setupPlatformSpoof() {
        try {
            val dest = File(libDir, "adev-platform-spoof.js")
            dest.parentFile?.mkdirs()
            // Prefer the asset shipped in the APK (updated on each runtime extract).
            val assetPath = "runtime/lib/adev-platform-spoof.js"
            try {
                context.assets.open(assetPath).use { input ->
                    FileOutputStream(dest).use { output -> input.copyTo(output) }
                }
            } catch (_: Exception) {
                if (!dest.exists()) {
                    dest.writeText(
                        """
                        try{
                          Object.defineProperty(process,'platform',{get:function(){return 'linux'}});
                          Object.defineProperty(process,'arch',{get:function(){return 'arm64'}});
                          var os=require('os');
                          os.platform=function(){return 'linux'};
                          os.arch=function(){return 'arm64'};
                          os.type=function(){return 'Linux'};
                          process.adevPlatformSpoof='linux-arm64';
                        }catch(e){}
                        """.trimIndent()
                    )
                }
            }
            Log.i(TAG, "Platform spoof ready: ${dest.absolutePath}")
        } catch (e: Exception) {
            Log.w(TAG, "setupPlatformSpoof failed: ${e.message}")
        }
    }

    /**
     * Write a user .npmrc tuned for Android (prefix, cache, quieter installs).
     * Always overwrite so upgrades pick up new defaults.
     */
    private fun setupNpmrc() {
        try {
            val npmrc = File(homeDir, ".npmrc")
            val scriptShell = File(binDir, "adev-npm-shell").absolutePath
            npmrc.writeText(
                """
                prefix=${npmGlobalDir.absolutePath}
                cache=${cacheDir.absolutePath}
                fund=false
                audit=false
                update-notifier=false
                # Run lifecycle scripts through our noexec-safe trampoline.
                script-shell=${scriptShell}
                # Pretend we are linux/arm64 so optional platform packages resolve
                # (opencode, codex, esbuild, …) instead of missing *-android-arm64.
                platform=linux
                arch=arm64
                # Allow optionalDependencies (needed for platform binary packages).
                # Pure-JS fallbacks still apply when a native optional fails.
                optional=true
                fetch-retries=3
                fetch-retry-mintimeout=20000
                fetch-retry-maxtimeout=120000
                """.trimIndent() + "\n"
            )
            // npm lifecycle hook: rehash global CLI shims after any install.
            val hooksDir = File(homeDir, ".npm-global/etc")
            hooksDir.mkdirs()
            // Document limits for the user (opened from Files if needed).
            File(homeDir, "ADEV-RUNTIME.md").writeText(
                """
                # A Dev Studio runtime notes

                ## Platform identity (linux arm64 spoof)
                Node and npm report **linux / arm64** (not android) so CLI tools
                install the same optional packages as Linux aarch64:

                    node -p "process.platform + ' ' + process.arch"
                    # => linux arm64

                This is intentional. Check: `node -p "process.adevPlatformSpoof"`

                ## Frontend / backend (essentials)
                Env is set for device servers:
                  HOST=0.0.0.0  CHOKIDAR_USEPOLLING=true  BROWSER=none

                Seed projects (created once under workspaces/):
                  demo-web   Vite frontend   → npm install && npm run dev  (port 5173)
                  demo-api   Express API     → npm install && npm start    (port 3000)

                Preview: Output panel → Ports → Open (opens http://127.0.0.1:PORT)

                Shell helpers: adev-help | adev-vite | adev-next | projects

                ## What works
                - node, npm, npx, corepack (yarn/pnpm via corepack)
                - git (HTTPS), busybox applets, pure JS packages
                - Many prebuilt **linux-arm64** optional deps (esbuild via Vite, etc.)
                - Lifecycle scripts via adev-npm-shell (noexec-safe)

                ## Global CLIs
                - After `npm i -g …`: `adev-rehash` (mksh) or new terminal
                - Platform spoof: node reports linux/arm64 for package selection

                ## CLI agents (OpenCode, Codex, …) — later / optional
                - Prefer linux-arm64 optional packages; binary may still need musl/static
                - Downloadable tool installs come later (keeps APK small)

                ## What still fails
                - Packages that must **compile** native code (node-gyp / python / gcc)
                - glibc-only linux binaries that cannot load on Android bionic
                """.trimIndent() + "\n"
            )
        } catch (e: Exception) {
            Log.w(TAG, "setupNpmrc failed: ${e.message}")
        }
    }

    /**
     * Assemble a CA bundle so git https + npm registry TLS work. Prefer a
     * bundled bundle; otherwise concatenate the Android system trust store into
     * a single PEM file.
     */
    private fun setupCaBundle() {
        try {
            if (caBundleFile.exists() && caBundleFile.length() > 0) return
            caBundleFile.parentFile?.mkdirs()
            val sysCerts = File("/system/etc/security/cacerts")
            if (sysCerts.isDirectory) {
                caBundleFile.bufferedWriter().use { w ->
                    sysCerts.listFiles()?.forEach { c ->
                        if (c.isFile) {
                            try {
                                w.write(c.readText())
                                w.write("\n")
                            } catch (_: Exception) { }
                        }
                    }
                }
                Log.i(TAG, "Assembled CA bundle (${caBundleFile.length()} bytes)")
            }
        } catch (e: Exception) {
            Log.w(TAG, "CA bundle assembly failed: ${e.message}")
        }
    }

    /**
     * Create a default workspace with a welcome file so the file explorer isn't empty
     */
    private fun createDefaultWorkspace() {
        val defaultProject = File(workspacesDir, "my-project")
        if (!defaultProject.exists()) {
            defaultProject.mkdirs()

            // Create a welcome file
            File(defaultProject, "index.js").writeText("""
                // Welcome to A Dev Studio!
                // This is your first project.
                
                function greet(name) {
                  console.log(`Hello, ${'$'}{name}! Welcome to A Dev Studio.`);
                }
                
                greet('World');
                
                // Try running: node index.js
            """.trimIndent())

            // Create package.json
            File(defaultProject, "package.json").writeText("""
                {
                  "name": "my-project",
                  "version": "1.0.0",
                  "main": "index.js",
                  "scripts": {
                    "start": "node index.js"
                  }
                }
            """.trimIndent())

            // Create a README
            File(defaultProject, "README.md").writeText("""
                # My Project
                
                Created with A Dev Studio.
                
                ## Getting Started
                
                ```bash
                node index.js
                ```
            """.trimIndent())

            Log.i(TAG, "Created default workspace: ${defaultProject.absolutePath}")
        }
    }

    /**
     * Seed demo-web (Vite) and demo-api (Express) so FE/BE can be run with
     * two standard commands after npm install. Only created if missing.
     */
    private fun createDevProjectTemplates() {
        try {
            createDemoWebProject()
            createDemoApiProject()
        } catch (e: Exception) {
            Log.w(TAG, "createDevProjectTemplates failed: ${e.message}")
        }
    }

    private fun createDemoWebProject() {
        val dir = File(workspacesDir, "demo-web")
        if (dir.exists()) return
        dir.mkdirs()
        File(dir, "package.json").writeText(
            """
            {
              "name": "demo-web",
              "private": true,
              "version": "1.0.0",
              "type": "module",
              "scripts": {
                "dev": "vite --host 0.0.0.0 --port 5173",
                "build": "vite build",
                "preview": "vite preview --host 0.0.0.0 --port 4173"
              },
              "devDependencies": {
                "vite": "^5.4.0"
              }
            }
            """.trimIndent() + "\n"
        )
        File(dir, "index.html").writeText(
            """
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1.0" />
              <title>ADEV demo-web</title>
            </head>
            <body>
              <div id="app"></div>
              <script type="module" src="/main.js"></script>
            </body>
            </html>
            """.trimIndent() + "\n"
        )
        File(dir, "main.js").writeText(
            """
            const app = document.querySelector('#app');
            app.innerHTML = `
              <h1>A Dev Studio — demo-web</h1>
              <p>Vite is running on this device.</p>
              <p>Open the URL shown in the terminal (port 5173) from Output → Open.</p>
            `;
            console.log('demo-web ready');
            """.trimIndent() + "\n"
        )
        File(dir, "vite.config.js").writeText(
            """
            import { defineConfig } from 'vite';
            export default defineConfig({
              server: {
                host: '0.0.0.0',
                port: 5173,
                strictPort: false,
                watch: { usePolling: true, interval: 1000 }
              },
              preview: { host: '0.0.0.0', port: 4173 }
            });
            """.trimIndent() + "\n"
        )
        File(dir, "README.md").writeText(
            """
            # demo-web (Vite)

            ```bash
            cd ~/workspaces/demo-web   # or: projects && cd demo-web
            npm install
            npm run dev
            ```

            Then open `http://127.0.0.1:5173` from the Output panel (Open) or Chrome on the phone.
            """.trimIndent() + "\n"
        )
        Log.i(TAG, "Created demo-web template")
    }

    private fun createDemoApiProject() {
        val dir = File(workspacesDir, "demo-api")
        if (dir.exists()) return
        dir.mkdirs()
        File(dir, "package.json").writeText(
            """
            {
              "name": "demo-api",
              "private": true,
              "version": "1.0.0",
              "type": "module",
              "scripts": {
                "start": "node server.js",
                "dev": "node --watch server.js"
              },
              "dependencies": {
                "express": "^4.21.0"
              }
            }
            """.trimIndent() + "\n"
        )
        File(dir, "server.js").writeText(
            """
            import express from 'express';

            const app = express();
            const PORT = Number(process.env.PORT) || 3000;
            const HOST = process.env.HOST || '0.0.0.0';

            app.use(express.json());

            app.get('/', (_req, res) => {
              res.type('html').send(`<!doctype html>
            <html><body style="font-family:sans-serif;padding:24px">
            <h1>A Dev Studio — demo-api</h1>
            <p>Express is running on this device.</p>
            <p><a href="/api/health">/api/health</a></p>
            </body></html>`);
            });

            app.get('/api/health', (_req, res) => {
              res.json({ ok: true, platform: process.platform, arch: process.arch, time: Date.now() });
            });

            app.listen(PORT, HOST, () => {
              console.log(`demo-api listening on http://${HOST}:${PORT}`);
              console.log(`Try: http://127.0.0.1:${PORT}/api/health`);
            });
            """.trimIndent() + "\n"
        )
        File(dir, "README.md").writeText(
            """
            # demo-api (Express)

            ```bash
            cd ~/workspaces/demo-api
            npm install
            npm start
            ```

            Then open `http://127.0.0.1:3000` from Output → Open.
            """.trimIndent() + "\n"
        )
        Log.i(TAG, "Created demo-api template")
    }

    private fun getMkshrcContent(): String = """
        # A Dev Studio - mksh configuration
        export PS1='adev:${'$'}PWD ${'$'} '
        export EDITOR=vi

        # Core tools: exec nativeLibraryDir ELFs (filesDir is noexec on Android 10+).
        [ -f "${'$'}HOME/.adev-wrappers" ] && . "${'$'}HOME/.adev-wrappers"

        # Report Linux/arm64 to shell tools that call uname (install scripts).
        uname() {
          case "${'$'}1" in
            -m|-p|-i) echo aarch64 ;;
            -s) echo Linux ;;
            -o) echo GNU/Linux ;;
            -a) echo "Linux adev 5.15.0 aarch64 GNU/Linux" ;;
            -r) command uname -r 2>/dev/null || echo 5.15.0 ;;
            "") echo Linux ;;
            *) command uname "${'$'}@" 2>/dev/null || echo Linux ;;
          esac
        }

        command -v dbclient >/dev/null 2>&1 && ssh() { dbclient "${'$'}@"; }

        adev-rehash() {
            shimf="${'$'}HOME/.adev-shims"
            : > "${'$'}shimf"
            for f in "${'$'}HOME/.npm-global/bin"/* "${'$'}HOME/.local/bin"/*; do
                [ -f "${'$'}f" ] || continue
                n=${'$'}{f##*/}
                case "${'$'}n" in npm|npx|node|corepack|git|ls|cat) continue ;; esac
                printf '%s() { node "%s" "${'$'}@"; }\n' "${'$'}n" "${'$'}f" >> "${'$'}shimf"
            done
            . "${'$'}shimf" 2>/dev/null
            echo "adev: rehashed global CLI shims"
        }
        adev-rehash 2>/dev/null

        adev-help() {
          echo "A Dev Studio — essential commands"
          echo "  adev-doctor       check node/npm/git/ls"
          echo "  projects          cd workspaces"
          echo "  cd demo-web && npm install && npm run dev"
          echo "  cd demo-api && npm install && npm start"
          echo "  adev-vite / adev-next"
          echo "See ~/ADEV-RUNTIME.md"
        }
        adev-vite() { npx vite --host 0.0.0.0 --port 5173 "${'$'}@"; }
        adev-next() { npx next dev -H 0.0.0.0 -p 3000 "${'$'}@"; }

        alias ll='ls -la'
        alias la='ls -a'
        alias ..='cd ..'
        alias cls='clear'
        alias projects='cd ${workspacesDir.absolutePath}'

        echo "Welcome to A Dev Studio — type adev-help or adev-doctor"
    """.trimIndent()

    private fun getBashrcContent(): String = """
        # A Dev Studio - bash configuration
        export PS1='\[\033[01;32m\]adev\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]${'$'} '
        export EDITOR=vi
        export LANG=en_US.UTF-8

        # Core tools: exec nativeLibraryDir ELFs (filesDir is noexec on Android 10+).
        [ -f "${'$'}HOME/.adev-wrappers" ] && . "${'$'}HOME/.adev-wrappers"

        # Report Linux/arm64 to shell tools that call uname (install scripts).
        uname() {
          case "${'$'}1" in
            -m|-p|-i) echo aarch64 ;;
            -s) echo Linux ;;
            -o) echo GNU/Linux ;;
            -a) echo "Linux adev 5.15.0 aarch64 GNU/Linux" ;;
            -r) command uname -r 2>/dev/null || echo 5.15.0 ;;
            "") echo Linux ;;
            *) command uname "${'$'}@" 2>/dev/null || echo Linux ;;
          esac
        }

        command -v dbclient >/dev/null 2>&1 && ssh() { dbclient "${'$'}@"; }

        command_not_found_handle() {
            local cmd="${'$'}1"; shift
            local base f
            for base in "${'$'}HOME/.npm-global/bin" "${'$'}HOME/.local/bin"; do
                f="${'$'}base/${'$'}cmd"
                if [ -f "${'$'}f" ]; then
                    node "${'$'}f" "${'$'}@"
                    return ${'$'}?
                fi
            done
            if [ -f "./node_modules/.bin/${'$'}cmd" ]; then
                node "./node_modules/.bin/${'$'}cmd" "${'$'}@"
                return ${'$'}?
            fi
            echo "adev: ${'$'}cmd: command not found" >&2
            return 127
        }

        adev-rehash() {
            hash -r 2>/dev/null
            echo "adev: bash hash cleared"
        }

        adev-help() {
          echo "A Dev Studio — essential commands"
          echo "  adev-doctor       check node/npm/git/ls"
          echo "  projects          cd workspaces"
          echo "  cd demo-web && npm install && npm run dev"
          echo "  cd demo-api && npm install && npm start"
          echo "  adev-vite [port] / adev-next [port]"
          echo "See ~/ADEV-RUNTIME.md"
        }
        adev-vite() {
          local p=5173
          case "${'$'}1" in
            [0-9]*) p="${'$'}1"; shift ;;
          esac
          npx vite --host 0.0.0.0 --port "${'$'}p" "${'$'}@"
        }
        adev-next() {
          local p=3000
          case "${'$'}1" in
            [0-9]*) p="${'$'}1"; shift ;;
          esac
          npx next dev -H 0.0.0.0 -p "${'$'}p" "${'$'}@"
        }

        alias ll='ls -la'
        alias la='ls -a'
        alias ..='cd ..'
        alias cls='clear'
        alias projects='cd ${workspacesDir.absolutePath}'

        export HISTSIZE=2000
        export HISTFILE=${homeDir.absolutePath}/.bash_history

        echo "Welcome to A Dev Studio — type adev-help or adev-doctor"
    """.trimIndent()

    private fun getProfileContent(): String = """
        # A Dev Studio Profile
        if [ -f ${homeDir.absolutePath}/.bashrc ]; then
            . ${homeDir.absolutePath}/.bashrc
        fi
    """.trimIndent()

    // Public getters for paths
    fun getRuntimeRoot(): String = runtimeRoot.absolutePath
    fun getBinDir(): String = binDir.absolutePath
    fun getLibDir(): String = libDir.absolutePath
    fun getHomeDir(): String = homeDir.absolutePath
    fun getWorkspacesDir(): String = workspacesDir.absolutePath
    fun getTmpDir(): String = tmpDir.absolutePath
    fun getCacheDir(): String = cacheDir.absolutePath
    fun getEtcDir(): String = etcDir.absolutePath
    fun getNativeLibDir(): String = context.applicationInfo.nativeLibraryDir

    /**
     * Get the environment map for process execution
     */
    fun getEnvironment(): Map<String, String> {
        val nativeLibDir = context.applicationInfo.nativeLibraryDir
        val globalBin = File(npmGlobalDir, "bin").absolutePath
        val localBin = localBinDir.absolutePath
        // Prefer absolute path to bash ELF in nativeLibraryDir (exec-safe).
        val bashNative = File(nativeLibDir, "libbin_bash.so")
        val shell = when {
            bashNative.exists() -> bashNative.absolutePath
            File(binDir, "bash").exists() -> File(binDir, "bash").absolutePath
            else -> "/system/bin/sh"
        }

        // PATH order (Android 10+ noexec on filesDir):
        // 1) /system/bin first — working toybox ls/cat/… (do NOT shadow with broken
        //    filesDir busybox symlinks)
        // 2) nativeLibraryDir — real ELFs (libbin_node.so etc.); shell wrappers
        //    call these by absolute path anyway
        // 3) bin/ — remaining symlinks (git-core helpers, dropbear) + termux-exec
        // 4) npm global bins last
        val env = mutableMapOf(
            "PATH" to listOf(
                "/system/bin",
                "/system/xbin",
                nativeLibDir,
                binDir.absolutePath,
                "${binDir.absolutePath}/git-core",
                globalBin,
                localBin
            ).joinToString(":"),
            "HOME" to homeDir.absolutePath,
            "TMPDIR" to tmpDir.absolutePath,
            "TEMP" to tmpDir.absolutePath,
            "TMP" to tmpDir.absolutePath,
            "PREFIX" to runtimeRoot.absolutePath,
            "LD_LIBRARY_PATH" to "${libDir.absolutePath}:$nativeLibDir",
            // Prefer the bundled npm tree for requires; global modules second.
            "NODE_PATH" to listOf(
                "${libDir.absolutePath}/node_modules",
                "${npmGlobalDir.absolutePath}/lib/node_modules"
            ).joinToString(":"),
            "NPM_CONFIG_PREFIX" to npmGlobalDir.absolutePath,
            "NPM_CONFIG_CACHE" to cacheDir.absolutePath,
            "NPM_CONFIG_USERCONFIG" to File(homeDir, ".npmrc").absolutePath,
            // Avoid interactive update noise and optional fund prompts on mobile.
            "NPM_CONFIG_UPDATE_NOTIFIER" to "false",
            "NPM_CONFIG_FUND" to "false",
            "NPM_CONFIG_AUDIT" to "false",
            // Allow optionalDependencies (platform binary packages for CLIs).
            "NPM_CONFIG_OPTIONAL" to "true",
            // Force npm's package resolution to linux/arm64 (not android).
            "npm_config_platform" to "linux",
            "npm_config_arch" to "arm64",
            "npm_config_target_platform" to "linux",
            "npm_config_target_arch" to "arm64",
            "NPM_CONFIG_PLATFORM" to "linux",
            "NPM_CONFIG_ARCH" to "arm64",
            "USER" to "root",
            "LOGNAME" to "root",
            "SHELL" to shell,
            "ENV" to "${homeDir.absolutePath}/.mkshrc",
            "TERM" to "xterm-256color",
            "COLORTERM" to "truecolor",
            "LANG" to "en_US.UTF-8",
            "LC_ALL" to "en_US.UTF-8",
            "GIT_EXEC_PATH" to "${binDir.absolutePath}/git-core",
            "GIT_TEMPLATE_DIR" to gitTemplateDir.absolutePath,
            // Prefer HTTP/1.1 for flaky mobile TLS stacks with libcurl.
            "GIT_HTTP_LOW_SPEED_LIMIT" to "1000",
            "GIT_HTTP_LOW_SPEED_TIME" to "30",
            // Do NOT set HOSTNAME=adev — Next/Vite/http servers read HOSTNAME for bind/display.
            "MOBILEIDE_HOST_LABEL" to "adev",
            "MOBILEIDE_ROOT" to runtimeRoot.absolutePath,
            "MOBILEIDE_WORKSPACES" to workspacesDir.absolutePath,
            // Used by adev-npm-shell to locate libbin_node.so if PATH node is missing.
            "MOBILEIDE_NATIVE_LIB" to nativeLibDir,
            // ---- Dev-server essentials (frontend + backend on device) ----
            // Bind all interfaces so the in-app browser / phone can hit the server.
            "HOST" to "0.0.0.0",
            // Next.js / many CLIs honor this for listen address.
            "HOSTNAME" to "0.0.0.0",
            // Don't try to open a desktop browser from the CLI.
            "BROWSER" to "none",
            // File watchers on Android/FAT/emulated storage are unreliable; polling is required for HMR.
            "CHOKIDAR_USEPOLLING" to "true",
            "CHOKIDAR_INTERVAL" to "1000",
            "WATCHPACK_POLLING" to "true",
            "FORCE_COLOR" to "1",
            // Vite / webpack friendliness
            "VITE_CJS_IGNORE_WARNING" to "true"
        )

        // Every node process (npm, npx, CLIs) loads the platform spoof first.
        val spoof = File(libDir, "adev-platform-spoof.js")
        if (spoof.exists()) {
            val requireFlag = "--require ${spoof.absolutePath}"
            val existing = env["NODE_OPTIONS"]?.trim().orEmpty()
            env["NODE_OPTIONS"] = if (existing.isEmpty()) {
                requireFlag
            } else if (existing.contains("adev-platform-spoof")) {
                existing
            } else {
                "$requireFlag $existing"
            }
        }

        // npm lifecycle: always use the nativeLibraryDir ELF (not filesDir symlink).
        val npmShellNative = File(nativeLibDir, "libbin_adev_npm_shell.so")
        if (npmShellNative.exists()) {
            env["NPM_CONFIG_SCRIPT_SHELL"] = npmShellNative.absolutePath
            env["npm_config_script_shell"] = npmShellNative.absolutePath
        }

        // termux-exec: LD_PRELOAD hooks execve so shebang scripts under the
        // writable app data dir can run (Android 10+ noexec). Prefer the
        // linker variant used on modern Termux / targetSdk 34.
        val preloadCandidates = listOf(
            File(nativeLibDir, "liblib_libtermux_exec_linker_ld_preload_so.so"),
            File(nativeLibDir, "liblib_libtermux_exec_direct_ld_preload_so.so"),
            File(libDir, "libtermux-exec-linker-ld-preload.so"),
            File(libDir, "libtermux-exec-direct-ld-preload.so")
        )
        val preload = preloadCandidates.firstOrNull { it.exists() }
        if (preload != null) {
            env["LD_PRELOAD"] = preload.absolutePath
            // Hint for termux-exec system_linker_exec path on newer Android.
            env["TERMUX_EXEC__EXECVE_CALL__INTERCEPT"] = "enable"
        }

        // TLS: prefer a bundled/assembled CA bundle; else use the system store.
        if (caBundleFile.exists() && caBundleFile.length() > 0) {
            env["SSL_CERT_FILE"] = caBundleFile.absolutePath
            env["GIT_SSL_CAINFO"] = caBundleFile.absolutePath
            env["NODE_EXTRA_CA_CERTS"] = caBundleFile.absolutePath
        } else {
            env["SSL_CERT_DIR"] = "/system/etc/security/cacerts"
            env["GIT_SSL_CAPATH"] = "/system/etc/security/cacerts"
        }
        return env
    }

    /**
     * Convert virtual path to real path
     */
    fun resolveVirtualPath(virtualPath: String): String {
        return when {
            virtualPath == VIRTUAL_ROOT -> runtimeRoot.absolutePath
            virtualPath.startsWith(VIRTUAL_BIN) -> virtualPath.replace(VIRTUAL_BIN, binDir.absolutePath)
            virtualPath.startsWith(VIRTUAL_HOME) -> virtualPath.replace(VIRTUAL_HOME, homeDir.absolutePath)
            virtualPath.startsWith(VIRTUAL_WORKSPACES) -> virtualPath.replace(VIRTUAL_WORKSPACES, workspacesDir.absolutePath)
            virtualPath.startsWith(VIRTUAL_TMP) -> virtualPath.replace(VIRTUAL_TMP, tmpDir.absolutePath)
            virtualPath.startsWith(VIRTUAL_CACHE) -> virtualPath.replace(VIRTUAL_CACHE, cacheDir.absolutePath)
            virtualPath.startsWith(VIRTUAL_ROOT) -> virtualPath.replace(VIRTUAL_ROOT, runtimeRoot.absolutePath)
            else -> virtualPath
        }
    }

    /**
     * Convert real path to virtual path
     */
    fun toVirtualPath(realPath: String): String {
        return when {
            realPath == runtimeRoot.absolutePath -> VIRTUAL_ROOT
            realPath.startsWith(binDir.absolutePath) -> realPath.replace(binDir.absolutePath, VIRTUAL_BIN)
            realPath.startsWith(homeDir.absolutePath) -> realPath.replace(homeDir.absolutePath, VIRTUAL_HOME)
            realPath.startsWith(workspacesDir.absolutePath) -> realPath.replace(workspacesDir.absolutePath, VIRTUAL_WORKSPACES)
            realPath.startsWith(tmpDir.absolutePath) -> realPath.replace(tmpDir.absolutePath, VIRTUAL_TMP)
            realPath.startsWith(cacheDir.absolutePath) -> realPath.replace(cacheDir.absolutePath, VIRTUAL_CACHE)
            realPath.startsWith(runtimeRoot.absolutePath) -> realPath.replace(runtimeRoot.absolutePath, VIRTUAL_ROOT)
            else -> realPath
        }
    }
}
