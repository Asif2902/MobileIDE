package com.mobileide.app.runtime

import android.content.Context
import android.content.res.AssetManager
import android.os.Build
import android.system.Os
import android.system.OsConstants
import android.util.Log
import com.mobileide.app.BuildConfig
import com.mobileide.app.git.GitCredentialBroker
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/**
 * RuntimeManager handles extraction and management of the bundled developer runtime.
 * The runtime includes Node.js, Bash, Git, curl, and native build utilities for
 * Android. The base developer runtime is ARM64; x86_64 uses the signed runtime
 * feature capability recorded in runtime-lock.json.
 *
 * Execution model
 * ---------------
 * Android 10+ (this app targets SDK 34) forbids execve() of any file that lives
 * in the writable app data dir (filesDir/runtime/bin). The only app-owned,
 * exec-permitted location is nativeLibraryDir. The Gradle task
 * `prepareRuntimeNativeLibs` therefore relocates every ELF binary into
 * the ABI-specific jniLibs directory and writes assets/runtime/native-map.json
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
        private val CURRENT_RUNTIME_VERSION = BuildConfig.ADEV_RUNTIME_VERSION
        private const val NATIVE_MAP_FILE = "native-map.json"
        private const val RUNTIME_FINGERPRINT_FILE = ".runtime_fingerprint"
        // Keep addons compatible with the app's minimum supported Android.
        private const val NATIVE_BUILD_API = 29
        private const val NATIVE_BUILD_TRIPLE = "aarch64-linux-android"
        private const val NATIVE_LINK_FLAGS =
            "-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"

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
    private val customCaDir: File by lazy { File(etcDir, "ssl/custom-ca") }
    private val gitTemplateDir: File by lazy { File(etcDir, "git-templates") }
    private val nativeLibDir: File by lazy { File(context.applicationInfo.nativeLibraryDir) }
    private val selinuxProcessContext: String? by lazy {
        try {
            // Some Android 11 kernels expose a NUL-terminated security context
            // followed by non-text bytes. File.readText() preserved those bytes
            // as replacement characters; ProcessBuilder then rejected the whole
            // environment and the terminal silently fell back from Bash to sh.
            val raw = File("/proc/self/attr/current").readBytes()
            val end = raw.indexOf(0).let { if (it >= 0) it else raw.size }
            String(raw, 0, end, StandardCharsets.US_ASCII)
                .trim()
                .takeIf { value ->
                    value.isNotEmpty() && value.all { ch ->
                        ch.isLetterOrDigit() || ch in "_:,.-"
                    }
                }
        } catch (_: Exception) {
            null
        }
    }

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
        // Replace key bin/* symlinks with shebang trampolines so OpenCode / agents
        // can exec node|npm|git via PATH (termux-exec runs scripts on noexec).
        createPathTrampolines()

        onProgress?.invoke("Protecting runtime...", 0.9f)
        protectBinDirectory()

        onProgress?.invoke("Configuring environment...", 0.93f)
        setupEnvironment()
        setupNanoConfiguration()
        setupRuntimePolicy()
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
        // Remove only pure applet *symlinks* that would shadow toybox with a
        // noexec path. createPathTrampolines() may re-add a few as shell scripts
        // for applets agents need when toybox is incomplete.
        listOf(
            "ls", "cat", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown",
            "touch", "find", "grep", "sed", "awk", "head", "tail", "wc", "sort", "uniq",
            "tr", "cut", "xargs", "tee", "diff", "which", "whoami", "id",
            "clear", "sleep", "date", "base64", "md5sum", "sha256sum",
            "tar", "gzip", "gunzip", "bzip2", "xz", "wget", "vi", "less", "more",
            "ps", "kill", "killall", "pgrep", "pkill", "du", "df", "realpath",
            "dirname", "basename", "env", "printenv", "seq", "yes", "true", "false",
            "test", "echo", "printf", "patch"
        ).forEach { name ->
            val link = File(binDir, name)
            try {
                if (link.exists() || isSymlink(link)) link.delete()
            } catch (_: Exception) { }
        }
        val busyboxDispatcher = File(nativeLibDir, "libbin_adev_busybox.so")
        try {
            val link = File(binDir, "busybox")
            if (link.exists() || isSymlink(link)) link.delete()
            if (busyboxDispatcher.isFile) {
                Os.symlink(busyboxDispatcher.absolutePath, link.absolutePath)
                Log.i(TAG, "busybox argv0 dispatcher linked")
            } else {
                Log.w(TAG, "busybox dispatcher missing; applets remain unavailable")
            }
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
            val node = File(nativeLibDir, "libbin_node.so").absolutePath
            val git = File(nativeLibDir, "libbin_git.so").absolutePath
            val bash = File(nativeLibDir, "libbin_bash.so").absolutePath
            val busyboxDispatcher =
                File(nativeLibDir, "libbin_adev_busybox.so").absolutePath
            val npmShell = File(nativeLibDir, "libbin_adev_npm_shell.so").absolutePath
            val python = findNativeTool("libbin_python", ".so")
            val make = findMakeCommand()
            val clang = findNativeTool("libbin_clang_", ".so")
            val llvmAr = findNativeTool("libbin_llvm_ar", ".so")
            val lld = findNativeTool("libbin_lld", ".so")
            val pkgConfig = findNativeTool("libbin_pkg_config", ".so")
            val curl = File(nativeLibDir, "libbin_curl.so")
            val nano = File(nativeLibDir, "libbin_nano.so")
            val openCode = File(nativeLibDir, "libbin_opencode.so")
            val clangResourceDir = findClangResourceDir()
            val nodeGyp = File(libDir, "node_modules/npm/node_modules/node-gyp/bin/node-gyp.js")
            val doctor = File(libDir, "adev-doctor.js")
            val packageResolver = File(libDir, "adev-package-resolver.js")
            val phase1Test = File(libDir, "adev-phase1-test.js")
            val nextLauncher = File(libDir, "adev-next.js")
            val phase2Test = File(libDir, "adev-phase2-test.js")
            val packageManagerLauncher = File(libDir, "adev-package-manager.js")
            val bunBoundary = File(libDir, "adev-bun.js")
            val sshLauncher = File(libDir, "adev-ssh.js")
            val toolPackLauncher = File(libDir, "adev-toolpack.js")
            val phase3Test = File(libDir, "adev-phase3-test.js")
            val hasBusybox =
                File(nativeLibDir, "libbin_busybox.so").exists() &&
                    File(nativeLibDir, "libbin_adev_busybox.so").exists()
            val hasNode = File(nativeLibDir, "libbin_node.so").exists()
            val hasGit = File(nativeLibDir, "libbin_git.so").exists()

            // Lean applet list. Never define bash reserved words as functions
            // (time, type, …) — that yields: syntax error near unexpected token )
            // Prefer /system/bin toybox for common cmds; wrap only useful extras.
            val bashReserved = setOf(
                "time", "type", "!", "[[", "]]", "{", "}", "case", "do", "done",
                "elif", "else", "esac", "fi", "for", "function", "if", "in",
                "select", "then", "until", "while", "coproc"
            )
            // Skip builtins/keywords that break or just noise when redefined.
            val skipAsFunction = bashReserved + setOf(
                "sh", "ash", "test", "true", "false", "echo", "printf", "which",
                "command", "exec", "eval", "source", "return", "exit", "break",
                "continue", "shift", "export", "readonly", "local", "declare",
                "typeset", "unset", "alias", "unalias", "bg", "fg", "jobs",
                "wait", "trap", "ulimit", "umask", "read", "cd", "pwd", "login",
                "logout", "hash", "help", "history", "fc", "let", "mapfile",
                "readarray", "caller", "bind", "builtin", "compgen", "complete",
                "compopt", "dirs", "disown", "enable", "getopts", "kill", "popd",
                "pushd", "set", "shopt", "suspend"
            )
            val applets = listOf(
                // file
                "ls", "cat", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown",
                "touch", "find", "realpath", "dirname", "basename", "readlink", "stat", "mktemp",
                // text
                "grep", "sed", "awk", "head", "tail", "wc", "sort", "uniq", "tr", "cut",
                "xargs", "tee", "diff", "patch",
                // checksums / archive
                "md5sum", "sha256sum", "base64", "tar", "gzip", "gunzip", "xz", "zcat",
                // process / system (no time/type — reserved)
                "ps", "killall", "pgrep", "pkill", "du", "df", "id", "whoami", "w",
                "env", "printenv", "clear", "sleep", "date", "timeout", "nohup",
                // network / editors
                "wget", "nc", "ping", "vi", "less", "more"
            ).filter { it !in skipAsFunction }

            val sb = StringBuilder()
            sb.appendLine("# Generated by RuntimeManager — do not edit by hand")
            sb.appendLine("# Exec ELFs from nativeLibraryDir (exec-safe). filesDir is noexec.")
            sb.appendLine("export MOBILEIDE_NATIVE_LIB=\"$nativeLibDir\"")
            sb.appendLine("export ADEV_WRAPPERS=\"\$HOME/.adev-wrappers\"")
            sb.appendLine()

            if (hasNode) {
                sb.appendLine("node() { \"$node\" \"\$@\"; }")
                sb.appendLine("npm() { \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npm-cli.js\" \"\$@\"; }")
                sb.appendLine("npx() { \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npx-cli.js\" \"\$@\"; }")
                if (nodeGyp.exists()) {
                    sb.appendLine("node-gyp() { \"$node\" \"${nodeGyp.absolutePath}\" \"\$@\"; }")
                }
                sb.appendLine("if [ -f \"${packageManagerLauncher.absolutePath}\" ]; then")
                sb.appendLine("  corepack() { \"$node\" \"${packageManagerLauncher.absolutePath}\" corepack \"\$@\"; }")
                sb.appendLine("  yarn() { \"$node\" \"${packageManagerLauncher.absolutePath}\" yarn \"\$@\"; }")
                sb.appendLine("  pnpm() { \"$node\" \"${packageManagerLauncher.absolutePath}\" pnpm \"\$@\"; }")
                sb.appendLine("fi")
                if (bunBoundary.exists()) {
                    sb.appendLine("bun() { \"$node\" \"${bunBoundary.absolutePath}\" \"\$@\"; }")
                }
                if (sshLauncher.exists()) {
                    sb.appendLine("ssh() { \"$node\" \"${sshLauncher.absolutePath}\" \"\$@\"; }")
                }
                sb.appendLine("tsc() { npx --no-install tsc \"\$@\" 2>/dev/null || npx --yes tsc \"\$@\"; }")
                sb.appendLine("eslint() { npx --no-install eslint \"\$@\" 2>/dev/null || npx --yes eslint \"\$@\"; }")
                sb.appendLine("vite() { npx --no-install vite \"\$@\" 2>/dev/null || npx --yes vite \"\$@\"; }")
                if (nextLauncher.exists()) {
                    sb.appendLine("next() { \"$node\" \"${nextLauncher.absolutePath}\" \"\$@\"; }")
                }
                sb.appendLine()
            }
            python?.let {
                sb.appendLine("python() { \"${it.absolutePath}\" \"\$@\"; }")
                sb.appendLine("python3() { \"${it.absolutePath}\" \"\$@\"; }")
            }
            make?.let { sb.appendLine("make() { \"${it.absolutePath}\" \"\$@\"; }") }
            clang?.let {
                val common = clangDriverFlags(clangResourceDir)
                sb.appendLine("clang() { \"${it.absolutePath}\" $common \"\$@\"; }")
                sb.appendLine("cc() { \"${it.absolutePath}\" $common \"\$@\"; }")
                sb.appendLine("clang++() { \"${it.absolutePath}\" --driver-mode=g++ $common \"\$@\"; }")
                sb.appendLine("c++() { \"${it.absolutePath}\" --driver-mode=g++ $common \"\$@\"; }")
                sb.appendLine("gcc() { clang \"\$@\"; }")
                sb.appendLine("g++() { clang++ \"\$@\"; }")
            }
            llvmAr?.let {
                sb.appendLine("ar() { \"${it.absolutePath}\" \"\$@\"; }")
                sb.appendLine("ranlib() { \"${it.absolutePath}\" s \"\$@\"; }")
            }
            lld?.let { sb.appendLine("ld.lld() { \"${it.absolutePath}\" \"\$@\"; }") }
            pkgConfig?.let { sb.appendLine("pkg-config() { \"${it.absolutePath}\" \"\$@\"; }") }
            if (curl.exists()) {
                sb.appendLine("curl() { \"${curl.absolutePath}\" \"\$@\"; }")
            }
            if (nano.exists()) {
                sb.appendLine("nano() { \"${nano.absolutePath}\" \"\$@\"; }")
            }
            if (openCode.exists()) {
                sb.appendLine("opencode() { \"${openCode.absolutePath}\" \"\$@\"; }")
            }
            if (python != null || make != null || clang != null) sb.appendLine()
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
                sb.appendLine("busybox() { \"$busyboxDispatcher\" \"\$@\"; }")
                applets.forEach { ap ->
                    sb.appendLine(
                        "$ap() { \"$busyboxDispatcher\" $ap \"\$@\" 2>/dev/null || /system/bin/$ap \"\$@\" 2>/dev/null || /system/xbin/$ap \"\$@\"; }"
                    )
                }
                sb.appendLine()
            }

            // Dev server helpers (bind 0.0.0.0 so phone browser / Output → Open works)
            sb.appendLine("adev-typecheck() { npm run typecheck 2>/dev/null || npm run check 2>/dev/null || npx --yes tsc --noEmit \"\$@\"; }")
            sb.appendLine("adev-build() { npm run build \"\$@\"; }")
            sb.appendLine("adev-test() { npm test \"\$@\"; }")
            sb.appendLine("adev-lint() { npm run lint 2>/dev/null || npx --yes eslint . \"\$@\"; }")
            sb.appendLine("adev-dev() { npm run dev -- --host 0.0.0.0 \"\$@\" 2>/dev/null || npm start \"\$@\"; }")
            sb.appendLine("adev-run-web() {")
            sb.appendLine("  cd \"\$PREFIX/workspaces/demo-web\" || return 1")
            sb.appendLine("  [ -d node_modules ] || npm install")
            sb.appendLine("  npm run dev")
            sb.appendLine("}")
            sb.appendLine("adev-run-api() {")
            sb.appendLine("  cd \"\$PREFIX/workspaces/demo-api\" || return 1")
            sb.appendLine("  [ -d node_modules ] || npm install")
            sb.appendLine("  npm start")
            sb.appendLine("}")
            sb.appendLine()

            // Private ext4/f2fs workspaces use native watchers. Android shared
            // and FUSE paths opt into polling only when the current directory
            // actually requires it. Interactive shells refresh this after cd.
            sb.appendLine("adev-update-watch-mode() {")
            sb.appendLine("  case \"\$PWD/\" in")
            sb.appendLine("    /storage/*|/sdcard/*|/mnt/media_rw/*)")
            sb.appendLine("      export ADEV_WATCH_MODE=polling CHOKIDAR_USEPOLLING=true CHOKIDAR_INTERVAL=1000 WATCHPACK_POLLING=true ;;")
            sb.appendLine("    *)")
            sb.appendLine("      export ADEV_WATCH_MODE=native")
            sb.appendLine("      unset CHOKIDAR_USEPOLLING CHOKIDAR_INTERVAL WATCHPACK_POLLING ;;")
            sb.appendLine("  esac")
            sb.appendLine("}")
            sb.appendLine("adev-update-watch-mode")
            sb.appendLine("cd() { command cd \"\$@\" && adev-update-watch-mode; }")
            sb.appendLine()

            if (hasNode && doctor.exists()) {
                sb.appendLine("adev-doctor() { \"$node\" \"${doctor.absolutePath}\" \"\$@\"; }")
            }
            if (hasNode && packageResolver.exists()) {
                sb.appendLine(
                    "adev-resolve-package() { \"$node\" \"${packageResolver.absolutePath}\" \"\$@\"; }"
                )
            }
            if (hasNode && phase1Test.exists()) {
                sb.appendLine("adev-phase1-test() { \"$node\" \"${phase1Test.absolutePath}\" \"\$@\"; }")
            }
            if (hasNode && phase2Test.exists()) {
                sb.appendLine("adev-phase2-test() { \"$node\" \"${phase2Test.absolutePath}\" \"\$@\"; }")
            }
            if (hasNode && toolPackLauncher.exists()) {
                sb.appendLine("adev-toolpack() { \"$node\" \"${toolPackLauncher.absolutePath}\" \"\$@\"; }")
            }
            if (hasNode && phase3Test.exists()) {
                sb.appendLine("adev-phase3-test() { \"$node\" \"${phase3Test.absolutePath}\" \"\$@\"; }")
            }

            val out = File(homeDir, ".adev-wrappers")
            out.writeText(sb.toString())

            // Non-interactive agent bootstrap (OpenCode / background tools).
            // Also used as BASH_ENV so `bash -c '…'` loads tools without -i/-l.
            val agentEnv = StringBuilder()
            agentEnv.appendLine("# ADEV agent bootstrap — source: . \"\$HOME/.adev-agent-env\"")
            agentEnv.appendLine("# Auto-loaded for non-interactive bash via BASH_ENV")
            agentEnv.appendLine("export PREFIX=\"${runtimeRoot.absolutePath}\"")
            agentEnv.appendLine("export HOME=\"${homeDir.absolutePath}\"")
            agentEnv.appendLine("export MOBILEIDE_NATIVE_LIB=\"$nativeLibDir\"")
            if (hasNode) {
                agentEnv.appendLine("export MOBILEIDE_NODE=\"$node\"")
            }
            if (hasGit) {
                agentEnv.appendLine("export MOBILEIDE_GIT=\"$git\"")
            }
            if (File(nativeLibDir, "libbin_bash.so").exists()) {
                agentEnv.appendLine("export MOBILEIDE_BASH=\"$bash\"")
            }
            if (hasBusybox) {
                agentEnv.appendLine("export MOBILEIDE_BUSYBOX=\"$busyboxDispatcher\"")
            }
            if (curl.exists()) {
                agentEnv.appendLine("export MOBILEIDE_CURL=\"${curl.absolutePath}\"")
            }
            if (nano.exists()) {
                agentEnv.appendLine("export MOBILEIDE_NANO=\"${nano.absolutePath}\"")
            }
            agentEnv.appendLine("export TERMINFO=\"${File(runtimeRoot, "share/terminfo").absolutePath}\"")
            agentEnv.appendLine("export TERMINFO_DIRS=\"${File(runtimeRoot, "share/terminfo").absolutePath}\"")
            agentEnv.appendLine("export HOST=0.0.0.0")
            agentEnv.appendLine("export HOSTNAME=0.0.0.0")
            agentEnv.appendLine("export BROWSER=none")
            agentEnv.appendLine("export ADEV_PACKAGE_POLICY_FILE=\"${File(libDir, "adev-runtime-policy.json").absolutePath}\"")
            agentEnv.appendLine("export ADEV_PACKAGE_MANAGER_LOCK=\"${File(libDir, "adev-package-managers.json").absolutePath}\"")
            agentEnv.appendLine("export COREPACK_HOME=\"${File(cacheDir, "corepack").absolutePath}\"")
            agentEnv.appendLine("export ADEV_PLATFORM_SPOOF=disabled")
            appendToolchainEnvironment(agentEnv, exportPrefix = "export ")
            agentEnv.appendLine("export ADEV_WRAPPERS=\"\$HOME/.adev-wrappers\"")
            agentEnv.appendLine("[ -f \"\$HOME/.adev-wrappers\" ] && . \"\$HOME/.adev-wrappers\"")
            agentEnv.appendLine("export ADEV_NEXT_LAUNCHER=\"${nextLauncher.absolutePath}\"")
            agentEnv.appendLine("export ADEV_NEXT_CACHE=\"${File(cacheDir, "next-swc").absolutePath}\"")
            agentEnv.appendLine("export ADEV_NPM_CLI=\"${File(libDir, "node_modules/npm/bin/npm-cli.js").absolutePath}\"")
            // Escape Kotlin's '$' once so the generated POSIX shell retains
            // the parameter expansion. Using ${'$'} here would write that
            // Kotlin escape expression literally and Android sh rejects it.
            agentEnv.appendLine("adev_node_options=\"\${NODE_OPTIONS:-}\"")
            agentEnv.appendLine("case \"\$adev_node_options\" in *adev-server-events.js*) ;; *) [ -f \"\$PREFIX/lib/adev-server-events.js\" ] && adev_node_options=\"--require \$PREFIX/lib/adev-server-events.js \$adev_node_options\" ;; esac")
            agentEnv.appendLine("case \"\$adev_node_options\" in *adev-runtime-policy.js*) ;; *) [ -f \"\$PREFIX/lib/adev-runtime-policy.js\" ] && adev_node_options=\"--require \$PREFIX/lib/adev-runtime-policy.js \$adev_node_options\" ;; esac")
            agentEnv.appendLine("export NODE_OPTIONS=\"\$adev_node_options\"")
            agentEnv.appendLine("unset adev_node_options")
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

    /**
     * Write shebang trampolines in bin/ for tools agents (OpenCode) exec by PATH.
     * Symlinks to nativeLibraryDir often hit EACCES on Android 10+ noexec when the
     * *path* is under filesDir. A small `#!/system/bin/sh` script that `exec`s the
     * absolute ELF works when LD_PRELOAD=termux-exec is set (our getEnvironment).
     * Interactive shells still use function wrappers from .adev-wrappers.
     */
    private fun createPathTrampolines() {
        try {
            val node = File(nativeLibDir, "libbin_node.so")
            val git = File(nativeLibDir, "libbin_git.so")
            val bash = File(nativeLibDir, "libbin_bash.so")
            val busyboxRuntime = File(nativeLibDir, "libbin_busybox.so")
            val busyboxDispatcher = File(nativeLibDir, "libbin_adev_busybox.so")
            val python = findNativeTool("libbin_python", ".so")
            val make = findMakeCommand()
            val clang = findNativeTool("libbin_clang_", ".so")
            val llvmAr = findNativeTool("libbin_llvm_ar", ".so")
            val lld = findNativeTool("libbin_lld", ".so")
            val pkgConfig = findNativeTool("libbin_pkg_config", ".so")
            val curl = File(nativeLibDir, "libbin_curl.so")
            val nano = File(nativeLibDir, "libbin_nano.so")
            val openCode = File(nativeLibDir, "libbin_opencode.so")
            val clangResourceDir = findClangResourceDir()
            val npmCli = File(libDir, "node_modules/npm/bin/npm-cli.js")
            val npxCli = File(libDir, "node_modules/npm/bin/npx-cli.js")
            val corepackJs = File(libDir, "node_modules/corepack/dist/corepack.js")
            val nodeGyp = File(libDir, "node_modules/npm/node_modules/node-gyp/bin/node-gyp.js")
            val doctor = File(libDir, "adev-doctor.js")
            val packageResolver = File(libDir, "adev-package-resolver.js")
            val phase1Test = File(libDir, "adev-phase1-test.js")
            val nextLauncher = File(libDir, "adev-next.js")
            val phase2Test = File(libDir, "adev-phase2-test.js")
            val packageManagerLauncher = File(libDir, "adev-package-manager.js")
            val bunBoundary = File(libDir, "adev-bun.js")
            val sshLauncher = File(libDir, "adev-ssh.js")
            val toolPackLauncher = File(libDir, "adev-toolpack.js")
            val phase3Test = File(libDir, "adev-phase3-test.js")

            binDir.setWritable(true, false)

            fun writeScript(name: String, body: String) {
                val f = File(binDir, name)
                try {
                    if (f.exists() || isSymlink(f)) f.delete()
                    f.writeText(body)
                    try {
                        Os.chmod(f.absolutePath, 0b111101101) // 0755
                    } catch (_: Exception) {
                        f.setExecutable(true, false)
                        f.setReadable(true, false)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "trampoline $name failed: ${e.message}")
                }
            }

            if (node.exists()) {
                val n = node.absolutePath
                writeScript("node", "#!/system/bin/sh\nexec \"$n\" \"\$@\"\n")
                if (npmCli.exists()) {
                    writeScript(
                        "npm",
                        "#!/system/bin/sh\nexec \"$n\" \"${npmCli.absolutePath}\" \"\$@\"\n"
                    )
                }
                if (npxCli.exists()) {
                    writeScript(
                        "npx",
                        "#!/system/bin/sh\nexec \"$n\" \"${npxCli.absolutePath}\" \"\$@\"\n"
                    )
                }
                if (nodeGyp.exists()) {
                    writeScript(
                        "node-gyp",
                        "#!/system/bin/sh\nexec \"$n\" \"${nodeGyp.absolutePath}\" \"\$@\"\n"
                    )
                }
                if (corepackJs.exists() && packageManagerLauncher.exists()) {
                    val launcher = packageManagerLauncher.absolutePath
                    writeScript("corepack", "#!/system/bin/sh\nexec \"$n\" \"$launcher\" corepack \"\$@\"\n")
                    writeScript("yarn", "#!/system/bin/sh\nexec \"$n\" \"$launcher\" yarn \"\$@\"\n")
                    writeScript("yarnpkg", "#!/system/bin/sh\nexec \"$n\" \"$launcher\" yarn \"\$@\"\n")
                    writeScript("pnpm", "#!/system/bin/sh\nexec \"$n\" \"$launcher\" pnpm \"\$@\"\n")
                    writeScript("pnpx", "#!/system/bin/sh\nexec \"$n\" \"$launcher\" pnpm dlx \"\$@\"\n")
                }
                if (bunBoundary.exists()) {
                    writeScript(
                        "bun",
                        "#!/system/bin/sh\nexec \"$n\" \"${bunBoundary.absolutePath}\" \"\$@\"\n"
                    )
                }
                if (sshLauncher.exists()) {
                    writeScript(
                        "ssh",
                        "#!/system/bin/sh\nexec \"$n\" \"${sshLauncher.absolutePath}\" \"\$@\"\n"
                    )
                }
                if (doctor.exists()) {
                    writeScript(
                        "adev-doctor",
                        "#!/system/bin/sh\nexec \"$n\" \"${doctor.absolutePath}\" \"\$@\"\n"
                    )
                }
                if (packageResolver.exists()) {
                    writeScript(
                        "adev-resolve-package",
                        "#!/system/bin/sh\nexec \"$n\" \"${packageResolver.absolutePath}\" \"\$@\"\n"
                    )
                }
                if (phase1Test.exists()) {
                    writeScript(
                        "adev-phase1-test",
                        "#!/system/bin/sh\nexec \"$n\" \"${phase1Test.absolutePath}\" \"\$@\"\n"
                    )
                }
                if (nextLauncher.exists()) {
                    writeScript(
                        "next",
                        "#!/system/bin/sh\nexec \"$n\" \"${nextLauncher.absolutePath}\" \"\$@\"\n"
                    )
                    writeScript(
                        "adev-next",
                        "#!/system/bin/sh\nexec \"$n\" \"${nextLauncher.absolutePath}\" \"\$@\"\n"
                    )
                }
                if (phase2Test.exists()) {
                    writeScript(
                        "adev-phase2-test",
                        "#!/system/bin/sh\nexec \"$n\" \"${phase2Test.absolutePath}\" \"\$@\"\n"
                    )
                }
                if (toolPackLauncher.exists()) {
                    writeScript(
                        "adev-toolpack",
                        "#!/system/bin/sh\nexec \"$n\" \"${toolPackLauncher.absolutePath}\" \"\$@\"\n"
                    )
                }
                if (phase3Test.exists()) {
                    writeScript(
                        "adev-phase3-test",
                        "#!/system/bin/sh\nexec \"$n\" \"${phase3Test.absolutePath}\" \"\$@\"\n"
                    )
                }
            }
            if (git.exists()) {
                writeScript("git", "#!/system/bin/sh\nexec \"${git.absolutePath}\" \"\$@\"\n")
            }
            if (bash.exists()) {
                writeScript("bash", "#!/system/bin/sh\nexec \"${bash.absolutePath}\" \"\$@\"\n")
            }
            // termux-exec translates #!/bin/sh to $PREFIX/bin/sh. Keep this
            // explicit bridge even though /system/bin is earlier on normal PATH.
            writeScript("sh", "#!/system/bin/sh\nexec /system/bin/sh \"\$@\"\n")
            if (busyboxRuntime.exists() && busyboxDispatcher.exists()) {
                val bb = busyboxDispatcher.absolutePath
                writeScript("busybox", "#!/system/bin/sh\nexec \"$bb\" \"\$@\"\n")
                // termux-exec rewrites #!/usr/bin/env to $PREFIX/bin/env. The
                // npm/node ecosystem overwhelmingly uses that shebang, so this
                // entry is required for generic child_process script launches.
                writeScript("env", "#!/system/bin/sh\nexec \"$bb\" env \"\$@\"\n")
                // High-value applets agents call by name (prefer busybox when present)
                listOf(
                    "tar", "gzip", "gunzip", "xz", "zcat", "wget", "nc", "ping",
                    "find", "xargs", "sed", "awk", "grep", "head", "tail", "wc",
                    "sort", "uniq", "tr", "cut", "tee", "diff", "patch", "md5sum",
                    "sha256sum", "base64", "mktemp", "realpath", "dirname", "basename",
                    "readlink", "stat", "timeout", "nohup", "killall", "pgrep", "pkill",
                    "du", "df", "w", "vi", "less", "more"
                ).forEach { ap ->
                    writeScript(ap, "#!/system/bin/sh\nexec \"$bb\" $ap \"\$@\"\n")
                }
            }
            python?.let {
                val p = it.absolutePath
                writeScript("python", "#!/system/bin/sh\nexec \"$p\" \"\$@\"\n")
                writeScript("python3", "#!/system/bin/sh\nexec \"$p\" \"\$@\"\n")
            }
            make?.let {
                writeScript("make", "#!/system/bin/sh\nexec \"${it.absolutePath}\" \"\$@\"\n")
            }
            clang?.let {
                val common = clangDriverFlags(clangResourceDir)
                val c = it.absolutePath
                writeScript("clang", "#!/system/bin/sh\nexec \"$c\" $common \"\$@\"\n")
                writeScript("cc", "#!/system/bin/sh\nexec \"$c\" $common \"\$@\"\n")
                writeScript("gcc", "#!/system/bin/sh\nexec \"$c\" $common \"\$@\"\n")
                writeScript("clang++", "#!/system/bin/sh\nexec \"$c\" --driver-mode=g++ $common \"\$@\"\n")
                writeScript("c++", "#!/system/bin/sh\nexec \"$c\" --driver-mode=g++ $common \"\$@\"\n")
                writeScript("g++", "#!/system/bin/sh\nexec \"$c\" --driver-mode=g++ $common \"\$@\"\n")
            }
            llvmAr?.let {
                writeScript("ar", "#!/system/bin/sh\nexec \"${it.absolutePath}\" \"\$@\"\n")
            }
            lld?.let {
                writeScript("ld.lld", "#!/system/bin/sh\nexec \"${it.absolutePath}\" \"\$@\"\n")
            }
            pkgConfig?.let {
                writeScript("pkg-config", "#!/system/bin/sh\nexec \"${it.absolutePath}\" \"\$@\"\n")
            }
            if (curl.exists()) {
                writeScript("curl", "#!/system/bin/sh\nexec \"${curl.absolutePath}\" \"\$@\"\n")
            }
            if (nano.exists()) {
                writeScript("nano", "#!/system/bin/sh\nexec \"${nano.absolutePath}\" \"\$@\"\n")
            }
            if (openCode.exists()) {
                // OpenCode must be discoverable through PATH by non-interactive
                // shells and child processes, not only as an interactive shell
                // function from ~/.adev-wrappers.
                writeScript(
                    "opencode",
                    "#!/system/bin/sh\nexec \"${openCode.absolutePath}\" \"\$@\"\n"
                )
            }

            Log.i(TAG, "PATH trampolines written under ${binDir.absolutePath}")
        } catch (e: Exception) {
            Log.w(TAG, "createPathTrampolines failed: ${e.message}")
        }
    }

    /**
     * Locate a relocated tool in nativeLibraryDir without pinning its versioned
     * source name (python3.14, clang-21, ...). Gradle's mangleLibName() produces
     * stable libbin_<name>.so entries from runtime/bin assets.
     */
    private fun findNativeTool(prefix: String, suffix: String): File? =
        nativeLibDir.listFiles()
            ?.filter { it.isFile && it.name.startsWith(prefix) && it.name.endsWith(suffix) }
            ?.sortedBy { it.name }
            ?.firstOrNull()

    /**
     * Prefer the APK-native bridge that replaces GNU Make's compiled Termux
     * shell path. The raw Make ELF remains the fallback for capability reports
     * from older/partial packages.
     */
    private fun findMakeCommand(): File? {
        val launcher = File(nativeLibDir, "libbin_adev_make.so")
        return launcher.takeIf { it.isFile } ?: findNativeTool("libbin_make", ".so")
    }

    private fun findClangResourceDir(): File? =
        File(libDir, "clang").listFiles()
            ?.filter { it.isDirectory }
            ?.sortedByDescending { it.name }
            ?.firstOrNull()

    private fun findPythonLibDir(): File? =
        libDir.listFiles()
            ?.filter { it.isDirectory && it.name.matches(Regex("""python\d+\.\d+""")) }
            ?.sortedByDescending { it.name }
            ?.firstOrNull()

    private fun nativeSysrootIncludeDirs(): List<File> {
        val includeRoot = File(runtimeRoot, "include")
        // Android's generated UAPI headers intentionally use includes such as
        // <asm/types.h>. Those architecture headers live below the target
        // triple, not directly below include/, so that directory must precede
        // the generic Bionic headers for every compiler entry point.
        return listOf(File(includeRoot, NATIVE_BUILD_TRIPLE), includeRoot)
    }

    private fun nativeSysrootHeadersReady(): Boolean = listOf(
        File(runtimeRoot, "include/linux/types.h"),
        File(runtimeRoot, "include/$NATIVE_BUILD_TRIPLE/asm/types.h"),
        File(runtimeRoot, "include/asm-generic/types.h")
    ).all(File::isFile)

    private fun nativeSysrootIncludePath(): String =
        nativeSysrootIncludeDirs().joinToString(":") { it.absolutePath }

    private fun clangDriverFlags(resourceDir: File? = findClangResourceDir()): String {
        val prefix = runtimeRoot.absolutePath
        val systemIncludes = nativeSysrootIncludeDirs()
            .joinToString(" ") { "-isystem ${it.absolutePath}" }
        val resource = resourceDir?.absolutePath?.let { " -resource-dir $it" }.orEmpty()
        val linker = findNativeTool("libbin_lld", ".so")
            ?.absolutePath
            ?.let { " --ld-path=$it" }
            .orEmpty()
        return "--target=$NATIVE_BUILD_TRIPLE$NATIVE_BUILD_API " +
            "--sysroot=$prefix $systemIncludes -L$prefix/lib -B$prefix/lib" +
            "$resource$linker"
    }

    /**
     * Add relocatable node-gyp toolchain settings. Values are absolute paths to
     * APK-installed ELFs, so Python/Clang/Make never execute through filesDir.
     */
    private fun appendToolchainEnvironment(out: StringBuilder, exportPrefix: String) {
        val python = findNativeTool("libbin_python", ".so")
        val make = findMakeCommand()
        val clang = findNativeTool("libbin_clang_", ".so")
        val llvmAr = findNativeTool("libbin_llvm_ar", ".so")
        val lld = findNativeTool("libbin_lld", ".so")
        val clangFlags = clangDriverFlags()
        python?.let {
            out.appendLine("${exportPrefix}PYTHON=\"${it.absolutePath}\"")
            out.appendLine("${exportPrefix}NODE_GYP_FORCE_PYTHON=\"${it.absolutePath}\"")
            out.appendLine("${exportPrefix}npm_package_config_node_gyp_python=\"${it.absolutePath}\"")
            out.appendLine("${exportPrefix}PYTHONHOME=\"${runtimeRoot.absolutePath}\"")
            findPythonLibDir()?.let { py ->
                out.appendLine("${exportPrefix}PYTHONPATH=\"${py.absolutePath}\"")
            }
        }
        make?.let { out.appendLine("${exportPrefix}MAKE=\"${it.absolutePath}\"") }
        clang?.let {
            out.appendLine("${exportPrefix}CC=\"${it.absolutePath} $clangFlags\"")
            out.appendLine("${exportPrefix}CXX=\"${it.absolutePath} --driver-mode=g++ $clangFlags\"")
            // CPATH also covers packages that invoke clang directly instead
            // of respecting node-gyp's CC/CXX command strings.
            out.appendLine("${exportPrefix}CPATH=\"${nativeSysrootIncludePath()}\"")
        }
        llvmAr?.let { out.appendLine("${exportPrefix}AR=\"${it.absolutePath}\"") }
        lld?.let { out.appendLine("${exportPrefix}LD=\"${it.absolutePath}\"") }
        out.appendLine("${exportPrefix}LDFLAGS=\"$NATIVE_LINK_FLAGS\"")
        if (File(runtimeRoot, "include/node").isDirectory) {
            out.appendLine("${exportPrefix}npm_package_config_node_gyp_nodedir=\"${runtimeRoot.absolutePath}\"")
        }
        out.appendLine("${exportPrefix}PKG_CONFIG_PATH=\"${libDir.absolutePath}/pkgconfig:${runtimeRoot.absolutePath}/share/pkgconfig\"")
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
        val preferredEditor =
            if (File(nativeLibDir, "libbin_nano.so").isFile) "nano" else "vi"

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
                    editor = $preferredEditor
                [init]
                    defaultBranch = main
            """.trimIndent())
        }
    }

    /**
     * Nano's Termux package is compiled with a fixed Termux prefix. The native
     * executable honors HOME and TERMINFO, but its packaged nanorc contains an
     * absolute /data/data/com.termux include. Keep that file as source evidence,
     * generate a prefix-correct runtime copy, and never overwrite user config.
     */
    private fun setupNanoConfiguration() {
        val nano = File(nativeLibDir, "libbin_nano.so")
        if (!nano.isFile) return

        val packagedNanorc = File(etcDir, "nanorc.termux")
        val syntaxDir = File(runtimeRoot, "share/nano")
        val terminfoEntry = File(runtimeRoot, "share/terminfo/x/xterm-256color")
        if (!packagedNanorc.isFile || !syntaxDir.isDirectory || !terminfoEntry.isFile) {
            Log.w(TAG, "Nano payload is incomplete; config/terminfo setup skipped")
            return
        }

        try {
            val portableNanorc = packagedNanorc.readText().replace(
                "/data/data/com.termux/files/usr/share/nano",
                syntaxDir.absolutePath
            )
            File(etcDir, "nanorc").writeText(portableNanorc)

            val userNanorc = File(homeDir, ".nanorc")
            if (!userNanorc.exists()) {
                userNanorc.writeText(portableNanorc)
            }
            Log.i(TAG, "Nano config ready; existing user .nanorc preserved")
        } catch (e: Exception) {
            Log.w(TAG, "Nano config setup failed: ${e.message}")
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
     * Activate the package capability policy without falsifying process.platform.
     * A stale preload from runtime v1.11 is removed during upgrades so packages
     * see Android/Bionic unless an artifact is explicitly verified by policy.
     */
    private fun setupRuntimePolicy() {
        val legacySpoof = File(libDir, "adev-platform-spoof.js")
        if (legacySpoof.exists() && !legacySpoof.delete()) {
            Log.w(TAG, "Could not remove legacy platform spoof: ${legacySpoof.absolutePath}")
        }
        val policy = File(libDir, "adev-runtime-policy.json")
        val preload = File(libDir, "adev-runtime-policy.js")
        if (!policy.isFile || !preload.isFile) {
            throw IOException("Runtime package capability policy is missing")
        }
        Log.i(TAG, "Android/Bionic package policy ready: ${policy.absolutePath}")
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

                ## Platform and package capability policy
                Node and npm report their real **android / arm64** host:

                    node -p "process.platform + ' ' + process.arch"
                    # => android arm64

                Resolution order is Android/Bionic artifact, verified static or
                musl artifact, source build, then an actionable unsupported error.
                Linux/glibc binaries are never selected by a global platform spoof.

                Check:
                    adev-doctor --verbose
                    adev-doctor --json
                    adev-resolve-package --package <name> --version <version> --json

                ## Linux tools (agents + terminal)
                - /system/bin toybox first (ls, cat, cp, …)
                - busybox multi-call for richer applets (tar, sed, awk, find, …)
                - Shell functions in `~/.adev-wrappers` (always sourced by interactive shells)
                - PATH trampolines under `${'$'}PREFIX/bin` for node/npm/npx/git/bash + key applets
                - Absolute ELFs: `${'$'}MOBILEIDE_NODE`, `${'$'}MOBILEIDE_GIT`, `${'$'}MOBILEIDE_BASH`, `${'$'}MOBILEIDE_BUSYBOX`

                Check: `adev-doctor`

                ## npm / typecheck / build
                    npm install
                    npm run typecheck   # or: adev-typecheck
                    npm run build       # or: adev-build
                    npm test            # or: adev-test
                    npm run lint        # or: adev-lint
                    tsc / eslint / vite / esbuild  # via npx wrappers

                ## Frontend / backend (essentials)
                Env is set for device servers:
                  HOST=0.0.0.0  BROWSER=none

                Seed projects (created once under workspaces/):
                  demo-web   Vite frontend   → npm install && npm run dev  (port 5173)
                  demo-api   Express API     → npm install && npm start    (port 3000)

                Preview: Output panel → Ports → Open (opens http://127.0.0.1:PORT)

                Shell helpers: adev-help | adev-vite | adev-next | projects

                ## Background terminal / processes (for OpenCode)
                App API (React Native):
                  ProcessNative.runShell(script, cwd)  — bash + agent env, streams output
                  ProcessNative.spawn(cmd, args, cwd)  — rewrites node/npm/git/applets
                  ProcessNative.getProcesses / kill / getActivePorts

                Non-interactive shell (OpenCode binary / any child):
                  BASH_ENV=${'$'}HOME/.adev-agent-env   # auto-loads wrappers + policy
                  SHELL=…/libbin_bash.so
                  . "${'$'}HOME/.adev-agent-env"         # if you start a bare sh

                ## What works
                - node, npm, npx, git HTTPS, curl HTTPS and BusyBox applets
                - node-gyp, Python, Make, Clang/LLD and bundled Node headers
                - Lifecycle scripts via adev-npm-shell (noexec-safe)
                - Native source builds with 16 KiB ELF alignment
                - Background builds / servers via ProcessNative

                ## Capability boundary
                A glibc-only Linux binary without an Android, verified static/musl,
                or source-build path is unsupported and diagnosed explicitly.
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
            caBundleFile.parentFile?.mkdirs()
            customCaDir.mkdirs()
            val sysCerts = File("/system/etc/security/cacerts")
            caBundleFile.bufferedWriter().use { w ->
                if (sysCerts.isDirectory) {
                    sysCerts.listFiles()?.forEach { c ->
                        if (c.isFile) {
                            try {
                                w.write(c.readText())
                                w.write("\n")
                            } catch (_: Exception) { }
                        }
                    }
                }
                customCaDir.listFiles()
                    ?.filter { it.isFile && it.extension == "pem" }
                    ?.sortedBy { it.name }
                    ?.forEach { certificate ->
                        w.write(certificate.readText())
                        w.write("\n")
                    }
            }
            Log.i(TAG, "Assembled CA bundle (${caBundleFile.length()} bytes)")
        } catch (e: Exception) {
            Log.w(TAG, "CA bundle assembly failed: ${e.message}")
        }
    }

    fun installGitCustomCa(reference: String, pem: String): String {
        require(reference.matches(Regex("^[A-Za-z0-9._-]{1,64}$"))) {
            "CA reference must be 1-64 safe characters"
        }
        require(pem.contains("BEGIN CERTIFICATE") && pem.contains("END CERTIFICATE")) {
            "A PEM X.509 certificate is required"
        }
        val certificate = CertificateFactory.getInstance("X.509").generateCertificate(
            ByteArrayInputStream(pem.toByteArray(Charsets.UTF_8))
        ) as X509Certificate
        certificate.checkValidity()
        customCaDir.mkdirs()
        val target = File(customCaDir, "$reference.pem").canonicalFile
        require(target.toPath().startsWith(customCaDir.canonicalFile.toPath())) {
            "Invalid custom CA path"
        }
        target.writeText(pem.trim() + "\n")
        setupCaBundle()
        return MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
            .joinToString(":") { "%02X".format(it) }
    }

    fun removeGitCustomCa(reference: String): Boolean {
        require(reference.matches(Regex("^[A-Za-z0-9._-]{1,64}$"))) {
            "Invalid CA reference"
        }
        val target = File(customCaDir, "$reference.pem").canonicalFile
        require(target.toPath().startsWith(customCaDir.canonicalFile.toPath())) {
            "Invalid custom CA path"
        }
        val removed = !target.exists() || target.delete()
        setupCaBundle()
        return removed
    }

    fun listGitCustomCas(): List<String> =
        customCaDir.listFiles()
            ?.filter { it.isFile && it.extension == "pem" }
            ?.map { it.nameWithoutExtension }
            ?.sorted()
            ?: emptyList()

    fun setGitProxy(proxyUrl: String?) {
        val normalized = proxyUrl?.trim().orEmpty()
        if (normalized.isNotEmpty()) {
            val uri = URI(normalized)
            require(uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank()) {
                "Proxy must be an http(s) URL with a host"
            }
            require(uri.userInfo.isNullOrBlank()) {
                "Proxy credentials must use a protected credential reference, not the URL"
            }
        }
        context.getSharedPreferences("adev_git_network", Context.MODE_PRIVATE)
            .edit()
            .putString("proxy", normalized)
            .apply()
    }

    fun getGitProxy(): String? =
        context.getSharedPreferences("adev_git_network", Context.MODE_PRIVATE)
            .getString("proxy", null)
            ?.takeIf { it.isNotBlank() }

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
        val marker = File(dir, ".adev-demo-v2")
        // Recreate seed files when missing or when demo template version changes
        if (dir.exists() && marker.exists()) return
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
        marker.writeText("v2\n")
        Log.i(TAG, "Created demo-web template")
    }

    private fun createDemoApiProject() {
        val dir = File(workspacesDir, "demo-api")
        val marker = File(dir, ".adev-demo-v2")
        if (dir.exists() && marker.exists()) return
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
              console.log(`demo-api listening on http://${'$'}{HOST}:${'$'}{PORT}`);
              console.log(`Try: http://127.0.0.1:${'$'}{PORT}/api/health`);
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
        marker.writeText("v2\n")
        Log.i(TAG, "Created demo-api template")
    }

    private fun getMkshrcContent(): String = """
        # A Dev Studio - mksh (short prompt for phone screens)
        export PS1='adev:${'$'}{PWD##*/}${'$'} '
        export PROMPT_DIRTRIM=1

        [ -f "${'$'}HOME/.adev-wrappers" ] && . "${'$'}HOME/.adev-wrappers" 2>/dev/null
        if command -v nano >/dev/null 2>&1; then
          export EDITOR=nano VISUAL=nano
        else
          export EDITOR=vi VISUAL=vi
        fi

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

        adev-help() {
          echo "adev-run-web  Vite demo :5173"
          echo "adev-run-api  Express   :3000"
          echo "adev-dev      npm run dev in current folder"
          echo "adev-doctor | projects | cproj <folder>"
        }
        adev-vite() { npx vite --host 0.0.0.0 --port 5173 "${'$'}@"; }
        adev-next() { next dev -H 0.0.0.0 -p 3000 "${'$'}@"; }
        cproj() {
          case "${'$'}1" in
            ""|*/*|*\\*|*\**|*\?*|*\[*|*\]*)
              echo "usage: cproj <exact-folder-name>" >&2
              return 64 ;;
          esac
          target="${'$'}(find "${workspacesDir.absolutePath}" -mindepth 1 -maxdepth 4 -type d -name "${'$'}1" -print -quit 2>/dev/null)"
          if [ -z "${'$'}target" ]; then
            echo "adev: project folder not found: ${'$'}1" >&2
            return 1
          fi
          cd "${'$'}target"
        }

        alias ll='ls -la'
        alias ..='cd ..'
        alias projects='cd ${workspacesDir.absolutePath}'
    """.trimIndent()

    private fun getBashrcContent(): String = """
        # A Dev Studio - bash (short prompt: folder name only — fits phones)
        export PS1='\[\033[32m\]adev\[\033[0m\]:\[\033[34m\]\W\[\033[0m\]${'$'} '
        export LANG=en_US.UTF-8
        export PROMPT_DIRTRIM=1

        [ -f "${'$'}HOME/.adev-wrappers" ] && . "${'$'}HOME/.adev-wrappers" 2>/dev/null
        if command -v nano >/dev/null 2>&1; then
          export EDITOR=nano VISUAL=nano
        else
          export EDITOR=vi VISUAL=vi
        fi

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
            echo "adev: ${'$'}cmd: not found" >&2
            return 127
        }

        adev-help() {
          echo "adev-run-web  Vite demo :5173"
          echo "adev-run-api  Express   :3000"
          echo "adev-dev      npm run dev here"
          echo "adev-next     Next.js  :3000"
          echo "adev-doctor | projects | cproj <folder>"
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
          next dev -H 0.0.0.0 -p "${'$'}p" "${'$'}@"
        }
        cproj() {
          case "${'$'}1" in
            ""|*/*|*\\*|*\**|*\?*|*\[*|*\]*)
              echo "usage: cproj <exact-folder-name>" >&2
              return 64 ;;
          esac
          local target
          target="${'$'}(find "${workspacesDir.absolutePath}" -mindepth 1 -maxdepth 4 -type d -name "${'$'}1" -print -quit 2>/dev/null)"
          if [ -z "${'$'}target" ]; then
            echo "adev: project folder not found: ${'$'}1" >&2
            return 1
          fi
          cd "${'$'}target"
        }

        alias ll='ls -la'
        alias ..='cd ..'
        alias projects='cd ${workspacesDir.absolutePath}'
        export HISTSIZE=2000
        export HISTFILE=${homeDir.absolutePath}/.bash_history
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

    fun getCapabilities(): RuntimeCapabilities {
        val makeLauncher = File(nativeLibDir, "libbin_adev_make.so")
        val makeRuntime = findNativeTool("libbin_make", ".so")
        val commandReadiness = linkedMapOf(
            "node" to File(nativeLibDir, "libbin_node.so").isFile,
            "npm" to File(libDir, "node_modules/npm/bin/npm-cli.js").isFile,
            "npx" to File(libDir, "node_modules/npm/bin/npx-cli.js").isFile,
            "node-gyp" to File(
                libDir,
                "node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
            ).isFile,
            "python" to (findNativeTool("libbin_python", ".so") != null),
            // Raw Termux Make is not a usable Android integration by itself:
            // its compiled shell points at com.termux. Both the payload and
            // the APK-native /system/bin/sh bridge are required.
            "make" to (makeLauncher.isFile && makeRuntime != null),
            "clang" to (findNativeTool("libbin_clang_", ".so") != null),
            "lld" to (findNativeTool("libbin_lld", ".so") != null),
            "git" to File(nativeLibDir, "libbin_git.so").isFile,
            "curl" to File(nativeLibDir, "libbin_curl.so").isFile,
            "bash" to File(nativeLibDir, "libbin_bash.so").isFile,
            "nano" to File(nativeLibDir, "libbin_nano.so").isFile,
            "busybox" to (
                File(nativeLibDir, "libbin_busybox.so").isFile &&
                    File(nativeLibDir, "libbin_adev_busybox.so").isFile
                ),
            "opencode" to (
                File(nativeLibDir, "libbin_opencode.so").isFile &&
                    File(nativeLibDir, "libbin_opencode_runtime.so").isFile
                ),
            "next" to File(libDir, "adev-next.js").isFile,
            "ssh" to (
                File(nativeLibDir, "libbin_dropbearmulti.so").isFile &&
                    File(libDir, "adev-ssh.js").isFile
                ),
            "git-credential-broker" to File(
                nativeLibDir,
                "libbin_adev_git_credential.so"
            ).isFile,
            "git-lfs" to File(nativeLibDir, "libbin_git_lfs.so").isFile,
            "adev-toolpack" to File(libDir, "adev-toolpack.js").isFile
        )
        val nativeBuildReady = listOf(
            "node-gyp", "python", "make", "clang", "lld"
        ).all { commandReadiness[it] == true } &&
            File(runtimeRoot, "include/node/node.h").isFile &&
            nativeSysrootHeadersReady()
        val npmShell = File(nativeLibDir, "libbin_adev_npm_shell.so")
        val termuxExec = listOf(
            "liblib_libtermux_exec_linker_ld_preload_so.so",
            "liblib_libtermux_exec_direct_ld_preload_so.so"
        ).any { File(nativeLibDir, it).isFile }

        return RuntimeCapabilities(
            runtimeVersion = CURRENT_RUNTIME_VERSION,
            platform = "android",
            libc = "bionic",
            abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown",
            androidApi = Build.VERSION.SDK_INT,
            packageResolutionOrder = listOf(
                "android-bionic",
                "verified-static-or-musl",
                "source-build",
                "unsupported"
            ),
            commands = commandReadiness,
            packageManagers = linkedMapOf(
                "npm" to (commandReadiness["npm"] == true),
                "npx" to (commandReadiness["npx"] == true),
                "corepack" to File(libDir, "node_modules/corepack/dist/corepack.js").isFile,
                "pnpm-offline" to File(
                    libDir,
                    "package-managers/pnpm-11.18.0/bin/pnpm.mjs"
                ).isFile,
                "yarn-offline" to File(
                    libDir,
                    "package-managers/yarn-4.18.0/bin/yarn.js"
                ).isFile,
                "bun" to false
            ),
            toolPacks = linkedMapOf(
                "native-c-cpp" to nativeBuildReady,
                "signed-catalog" to File(libDir, "adev-toolpacks.json").isFile,
                "cmake-ninja" to false,
                "rust-cargo" to false,
                "nasm" to false,
                "autotools-libtool" to false,
                "java" to false,
                "package-development-libraries" to false
            ),
            filesystems = linkedMapOf(
                "private-native-watch" to true,
                "shared-polling-watch" to true,
                "private-execution" to true,
                "shared-execution" to false
            ),
            frameworks = linkedMapOf(
                "node-server" to (commandReadiness["node"] == true),
                "structured-listen-events" to File(libDir, "adev-server-events.js").isFile,
                "verified-preview" to true,
                "next-webpack-wasm" to File(libDir, "adev-next.js").isFile,
                "opencode-diagnostics-arm64" to (commandReadiness["opencode"] == true),
                // The command is installed and exposes version/help/path
                // diagnostics, but real TUI/run/server modes abort inside the
                // available upstream Android Bun/OpenTUI payloads on-device.
                "opencode-interactive" to false,
                "opencode-agent-run" to false,
                "opencode-server" to false
            ),
            nativeBuildReady = nativeBuildReady,
            npmLifecycleReady = npmShell.isFile,
            termuxExecReady = termuxExec,
            privateWorkspaceExecution = true,
            sharedWorkspaceExecution = false,
            globalPlatformSpoof = false
        )
    }

    /**
     * Get the environment map for process execution
     */
    fun getEnvironment(workingDirectory: String? = null): Map<String, String> {
        val globalBin = File(npmGlobalDir, "bin").absolutePath
        val localBin = localBinDir.absolutePath
        // Prefer absolute path to bash ELF in nativeLibraryDir (exec-safe).
        val bashNative = File(nativeLibDir, "libbin_bash.so")
        val shell = when {
            bashNative.exists() -> bashNative.absolutePath
            File(binDir, "bash").exists() -> File(binDir, "bash").absolutePath
            else -> "/system/bin/sh"
        }
        val nanoNative = File(nativeLibDir, "libbin_nano.so")
        val preferredEditor =
            if (nanoNative.isFile) nanoNative.absolutePath else "vi"

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
                nativeLibDir.absolutePath,
                binDir.absolutePath,
                "${binDir.absolutePath}/git-core",
                globalBin,
                localBin
            ).joinToString(":"),
            "HOME" to homeDir.absolutePath,
            "TMPDIR" to tmpDir.absolutePath,
            "TEMP" to tmpDir.absolutePath,
            "TMP" to tmpDir.absolutePath,
            // Android has no writable FHS /tmp. Keep every native/JS spelling
            // on the same app-private directory before any child process starts.
            "BUN_TMPDIR" to tmpDir.absolutePath,
            "SQLITE_TMPDIR" to tmpDir.absolutePath,
            "XDG_RUNTIME_DIR" to tmpDir.absolutePath,
            // nativeForkPty intentionally clears the inherited zygote
            // environment. Restore Android identity variables explicitly so
            // Android-aware CLIs do not mis-detect this process as desktop Linux.
            "ANDROID_ROOT" to "/system",
            "ANDROID_DATA" to "/data",
            "TERMUX_VERSION" to "ADevStudio",
            "PREFIX" to runtimeRoot.absolutePath,
            "LD_LIBRARY_PATH" to "${libDir.absolutePath}:${nativeLibDir.absolutePath}",
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
            "USER" to "root",
            "LOGNAME" to "root",
            "SHELL" to shell,
            "EDITOR" to preferredEditor,
            "VISUAL" to preferredEditor,
            // Interactive mksh/dash load ENV; non-interactive bash loads BASH_ENV.
            "ENV" to "${homeDir.absolutePath}/.mkshrc",
            "BASH_ENV" to "${homeDir.absolutePath}/.adev-agent-env",
            "ADEV_AGENT_ENV" to "${homeDir.absolutePath}/.adev-agent-env",
            "ADEV_WRAPPERS" to "${homeDir.absolutePath}/.adev-wrappers",
            "TERM" to "xterm-256color",
            "TERMINFO" to File(runtimeRoot, "share/terminfo").absolutePath,
            "TERMINFO_DIRS" to File(runtimeRoot, "share/terminfo").absolutePath,
            "COLORTERM" to "truecolor",
            "LANG" to "en_US.UTF-8",
            "LC_ALL" to "en_US.UTF-8",
            "GIT_EXEC_PATH" to "${binDir.absolutePath}/git-core",
            "GIT_TEMPLATE_DIR" to gitTemplateDir.absolutePath,
            "GIT_SSH_COMMAND" to
                "${File(nativeLibDir, "libbin_node.so").absolutePath} " +
                File(libDir, "adev-ssh.js").absolutePath,
            "GIT_SSH_VARIANT" to "ssh",
            // Prefer HTTP/1.1 for flaky mobile TLS stacks with libcurl.
            "GIT_HTTP_LOW_SPEED_LIMIT" to "1000",
            "GIT_HTTP_LOW_SPEED_TIME" to "30",
            // Do NOT set HOSTNAME=adev — Next/Vite/http servers read HOSTNAME for bind/display.
            "MOBILEIDE_HOST_LABEL" to "adev",
            "MOBILEIDE_ROOT" to runtimeRoot.absolutePath,
            "MOBILEIDE_WORKSPACES" to workspacesDir.absolutePath,
            // Used by adev-npm-shell / agents to locate ELFs if PATH lookup fails.
            "MOBILEIDE_NATIVE_LIB" to nativeLibDir.absolutePath,
            "MOBILEIDE_NODE" to File(nativeLibDir, "libbin_node.so").absolutePath,
            "MOBILEIDE_GIT" to File(nativeLibDir, "libbin_git.so").absolutePath,
            "MOBILEIDE_BASH" to File(nativeLibDir, "libbin_bash.so").absolutePath,
            "MOBILEIDE_MAKE" to File(nativeLibDir, "libbin_adev_make.so").absolutePath,
            "MOBILEIDE_BUSYBOX" to
                File(nativeLibDir, "libbin_adev_busybox.so").absolutePath,
            "MOBILEIDE_BUSYBOX_RUNTIME" to
                File(nativeLibDir, "libbin_busybox.so").absolutePath,
            "MOBILEIDE_CURL" to File(nativeLibDir, "libbin_curl.so").absolutePath,
            "MOBILEIDE_NANO" to File(nativeLibDir, "libbin_nano.so").absolutePath,
            "MOBILEIDE_OPENCODE" to File(nativeLibDir, "libbin_opencode.so").absolutePath,
            "ADEV_RUNTIME_VERSION" to CURRENT_RUNTIME_VERSION,
            "ADEV_APP_VERSION" to appVersionName(),
            "ADEV_ABI" to (Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"),
            "ADEV_NATIVE_BUILD_API" to NATIVE_BUILD_API.toString(),
            "ADEV_PACKAGE_POLICY_FILE" to File(libDir, "adev-runtime-policy.json").absolutePath,
            "ADEV_PACKAGE_MANAGER_LOCK" to
                File(libDir, "adev-package-managers.json").absolutePath,
            "COREPACK_HOME" to File(cacheDir, "corepack").absolutePath,
            "ADEV_PLATFORM_SPOOF" to "disabled",
            "ADEV_NEXT_LAUNCHER" to File(libDir, "adev-next.js").absolutePath,
            "ADEV_NEXT_CACHE" to File(cacheDir, "next-swc").absolutePath,
            "ADEV_NPM_CLI" to File(libDir, "node_modules/npm/bin/npm-cli.js").absolutePath,
            // ---- Dev-server essentials (frontend + backend on device) ----
            // Bind all interfaces so the in-app browser / phone can hit the server.
            "HOST" to "0.0.0.0",
            // Next.js / many CLIs honor this for listen address.
            "HOSTNAME" to "0.0.0.0",
            // Don't try to open a desktop browser from the CLI.
            "BROWSER" to "none",
            // Keep npm progress bounded without falsifying TTY/CI behavior.
            "NPM_CONFIG_PROGRESS" to "false",
            "NPM_CONFIG_LOGLEVEL" to "warn",
            "npm_config_progress" to "false",
            "npm_config_loglevel" to "warn",
            // Vite / webpack friendliness
            "VITE_CJS_IGNORE_WARNING" to "true"
        )

        // Native Git obtains protected credentials through a loopback broker.
        // The session capability is inherited by app-launched children but no
        // stored token/private key is placed in a command line or React state.
        env.putAll(GitCredentialBroker.get(context).environment())
        val credentialHelper =
            File(nativeLibDir, "libbin_adev_git_credential.so").absolutePath
        val commandConfig = listOf(
            "credential.helper" to "",
            "credential.helper" to credentialHelper,
            "http.followRedirects" to "initial",
            "protocol.version" to "2"
        )
        env["GIT_CONFIG_COUNT"] = commandConfig.size.toString()
        commandConfig.forEachIndexed { index, (key, value) ->
            env["GIT_CONFIG_KEY_$index"] = key
            env["GIT_CONFIG_VALUE_$index"] = value
        }

        val watchPath = File(workingDirectory ?: workspacesDir.absolutePath)
        if (requiresPolling(watchPath)) {
            env["ADEV_WATCH_MODE"] = "polling"
            env["CHOKIDAR_USEPOLLING"] = "true"
            env["CHOKIDAR_INTERVAL"] = "1000"
            env["WATCHPACK_POLLING"] = "true"
        } else {
            env["ADEV_WATCH_MODE"] = "native"
        }

        getGitProxy()?.let { proxy ->
            env["HTTP_PROXY"] = proxy
            env["HTTPS_PROXY"] = proxy
            env["http_proxy"] = proxy
            env["https_proxy"] = proxy
        }

        // termux-exec >=2 requires the actual host app/rootfs contract. Without
        // these values it falls back to /data/data/com.termux and cannot repair
        // execve() of npm .bin scripts, producing spawn <tool> EACCES.
        val appDataDir = context.applicationInfo.dataDir
        env["TERMUX_APP__PACKAGE_NAME"] = context.packageName
        env["TERMUX_APP__DATA_DIR"] = appDataDir
        env["TERMUX_APP__LEGACY_DATA_DIR"] = "/data/data/${context.packageName}"
        env["TERMUX__ROOTFS"] = runtimeRoot.absolutePath
        env["TERMUX__ROOTFS_DIR"] = runtimeRoot.absolutePath
        env["TERMUX__HOME"] = homeDir.absolutePath
        env["TERMUX__PREFIX"] = runtimeRoot.absolutePath
        env["TERMUX__PREFIX__TMP_DIR"] = tmpDir.absolutePath
        env["ANDROID__BUILD_VERSION_SDK"] = Build.VERSION.SDK_INT.toString()
        selinuxProcessContext?.let { env["TERMUX__SE_PROCESS_CONTEXT"] = it }

        // Native addon build stack. Only emit paths for tools actually bundled;
        // absence is visible to adev-doctor and never masked by fake commands.
        findNativeTool("libbin_python", ".so")?.let {
            env["PYTHON"] = it.absolutePath
            env["NODE_GYP_FORCE_PYTHON"] = it.absolutePath
            env["npm_package_config_node_gyp_python"] = it.absolutePath
            env["PYTHONHOME"] = runtimeRoot.absolutePath
            findPythonLibDir()?.let { py ->
                env["PYTHONPATH"] = py.absolutePath
            }
        }
        findMakeCommand()?.let { env["MAKE"] = it.absolutePath }
        findNativeTool("libbin_clang_", ".so")?.let {
            val flags = clangDriverFlags()
            env["CC"] = "${it.absolutePath} $flags"
            env["CXX"] = "${it.absolutePath} --driver-mode=g++ $flags"
            env["CPATH"] = nativeSysrootIncludePath()
        }
        findNativeTool("libbin_llvm_ar", ".so")?.let { env["AR"] = it.absolutePath }
        findNativeTool("libbin_lld", ".so")?.let { env["LD"] = it.absolutePath }
        env["LDFLAGS"] = NATIVE_LINK_FLAGS
        if (File(runtimeRoot, "include/node").isDirectory) {
            env["npm_package_config_node_gyp_nodedir"] = runtimeRoot.absolutePath
        }
        val nodeGyp = File(libDir, "node_modules/npm/node_modules/node-gyp/bin/node-gyp.js")
        if (nodeGyp.isFile) {
            env["npm_config_node_gyp"] = nodeGyp.absolutePath
            env["NPM_CONFIG_NODE_GYP"] = nodeGyp.absolutePath
        }
        env["PKG_CONFIG_PATH"] =
            "${libDir.absolutePath}/pkgconfig:${runtimeRoot.absolutePath}/share/pkgconfig"

        // Load capability metadata into Node without changing process.platform.
        val runtimePolicy = File(libDir, "adev-runtime-policy.js")
        val serverEvents = File(libDir, "adev-server-events.js")
        val nodePreloads = listOf(runtimePolicy, serverEvents)
            .filter(File::exists)
            .map { "--require ${it.absolutePath}" }
        if (nodePreloads.isNotEmpty()) {
            val existing = env["NODE_OPTIONS"]?.trim().orEmpty()
            val missing = nodePreloads.filter { flag ->
                !existing.contains(flag.substringAfter("--require "))
            }
            env["NODE_OPTIONS"] = (missing + existing)
                .filter { it.isNotBlank() }
                .joinToString(" ")
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
            env["TERMUX_EXEC__EXECVE_CALL__INTERCEPT"] = "enable"
            env["TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE"] = "enable"
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
     * Emulated/shared Android storage is commonly FUSE-backed and cannot
     * provide the same recursive native watch guarantees as private storage.
     */
    fun requiresPolling(directory: File): Boolean {
        val path = try {
            directory.canonicalPath
        } catch (_: IOException) {
            directory.absolutePath
        }
        return path == "/sdcard" ||
            path.startsWith("/sdcard/") ||
            path == "/storage" ||
            path.startsWith("/storage/") ||
            path == "/mnt/media_rw" ||
            path.startsWith("/mnt/media_rw/")
    }

    private fun appVersionName(): String =
        try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown"
        } catch (_: Exception) {
            "unknown"
        }

    /**
     * Convert virtual path to real path
     */
    fun resolveVirtualPath(virtualPath: String): String {
        val mappings = listOf(
            VIRTUAL_BIN to binDir.absolutePath,
            VIRTUAL_HOME to homeDir.absolutePath,
            VIRTUAL_WORKSPACES to workspacesDir.absolutePath,
            VIRTUAL_TMP to tmpDir.absolutePath,
            VIRTUAL_CACHE to cacheDir.absolutePath,
            VIRTUAL_ROOT to runtimeRoot.absolutePath
        )
        mappings.forEach { (virtualRoot, realRoot) ->
            remapPath(virtualPath, virtualRoot, realRoot, "/")?.let { return it }
        }
        return virtualPath
    }

    /**
     * Convert real path to virtual path
     */
    fun toVirtualPath(realPath: String): String {
        val mappings = listOf(
            binDir.absolutePath to VIRTUAL_BIN,
            homeDir.absolutePath to VIRTUAL_HOME,
            workspacesDir.absolutePath to VIRTUAL_WORKSPACES,
            tmpDir.absolutePath to VIRTUAL_TMP,
            cacheDir.absolutePath to VIRTUAL_CACHE,
            runtimeRoot.absolutePath to VIRTUAL_ROOT
        )
        mappings.forEach { (realRoot, virtualRoot) ->
            remapPath(realPath, realRoot, virtualRoot, File.separator)?.let { return it }
        }
        return realPath
    }

    private fun remapPath(path: String, fromRoot: String, toRoot: String, separator: String): String? =
        when {
            path == fromRoot -> toRoot
            path.startsWith("$fromRoot$separator") -> toRoot + path.substring(fromRoot.length)
            else -> null
        }
}
