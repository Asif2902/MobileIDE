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
        private const val CURRENT_RUNTIME_VERSION = "1.5.0"
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
        setupNpmrc()

        onProgress?.invoke("Preparing certificates...", 0.95f)
        setupCaBundle()

        onProgress?.invoke("Creating workspace...", 0.97f)
        createGlobalDirs()
        createDefaultWorkspace()

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
     * Busybox is a multi-call binary: argv[0] selects the applet (ls, cat, …).
     * When embedded as libbin_busybox.so, create symlinks for the most useful
     * applets so a minimal userland is available without relying only on toybox.
     */
    private fun createBusyboxAliases() {
        val nativeLibDir = context.applicationInfo.nativeLibraryDir
        val busyboxLib = File(nativeLibDir, "libbin_busybox.so")
        if (!busyboxLib.exists()) {
            Log.d(TAG, "busybox not embedded; relying on /system/bin toybox")
            return
        }
        binDir.setWritable(true, false)
        // Keep names that do not clobber our own node/git/bash ELFs.
        val applets = listOf(
            "ls", "cat", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown",
            "touch", "find", "grep", "sed", "awk", "head", "tail", "wc", "sort", "uniq",
            "tr", "cut", "xargs", "tee", "diff", "which", "uname", "whoami", "id",
            "pwd", "clear", "sleep", "date", "base64", "md5sum", "sha256sum",
            "tar", "gzip", "gunzip", "bzip2", "xz", "wget", "vi", "less", "more",
            "ps", "kill", "killall", "pgrep", "pkill", "du", "df", "realpath",
            "dirname", "basename", "env", "printenv", "seq", "yes", "true", "false",
            "test", "echo", "printf"
        )
        var n = 0
        applets.forEach { name ->
            val link = File(binDir, name)
            // Never replace real primary tools we ship as dedicated ELFs.
            if (name == "bash" || name == "node" || name == "git") return@forEach
            try {
                if (link.exists() || isSymlink(link)) link.delete()
                Os.symlink(busyboxLib.absolutePath, link.absolutePath)
                n++
            } catch (e: Exception) {
                Log.e(TAG, "busybox alias $name failed", e)
            }
        }
        // Also expose the multi-call binary itself as `busybox`.
        try {
            val link = File(binDir, "busybox")
            if (link.exists() || isSymlink(link)) link.delete()
            Os.symlink(busyboxLib.absolutePath, link.absolutePath)
            n++
        } catch (e: Exception) {
            Log.e(TAG, "busybox self-link failed", e)
        }
        Log.i(TAG, "busybox applets linked: $n")
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
                # Skip optional native addons (utf-8-validate, bufferutil, …) so
                # installs succeed with pure-JS fallbacks when node-gyp is absent.
                optional=false
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

                ## What works
                - node, npm, npx, corepack (yarn/pnpm via corepack)
                - git (including HTTPS)
                - busybox applets (ls, cat, grep, tar, …) when busybox is embedded
                - pure JavaScript packages: `npm install lodash express typescript …`

                ## Global CLIs (`npm i -g tsc` etc.)
                - On Android, app data is noexec. We use termux-exec (LD_PRELOAD) so
                  shebang scripts can run, plus shell shims (`adev-rehash`).
                - After `npm i -g …`, run: `adev-rehash` (mksh) or open a new terminal.

                ## What will NOT install / build
                - Native addons that need node-gyp, python, make, gcc
                  (e.g. better-sqlite3, bcrypt, sharp, many @napi-rs packages)
                - Full desktop Linux toolchains (not bundled)
                - Optional native deps are skipped by default (`optional=false`) so
                  packages like `ws` use pure-JS fallbacks (utf-8-validate skipped)

                ## Tips
                - Prefer `npm install` (project-local) and `npx <tool>`
                - Lifecycle scripts run via `adev-npm-shell` (fixes Permission denied
                  on node_modules/.bin under Android noexec)
                - Platform packages (e.g. opencode-android-arm64) may need manual install
                - Use `node ./node_modules/<pkg>/bin/…` if a bin still fails
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

    private fun getMkshrcContent(): String = """
        # A Dev Studio - mksh configuration
        export PS1='adev:${'$'}PWD ${'$'} '
        export EDITOR=vi

        # Always run package managers through node (assets live under noexec).
        npm() { node "${'$'}PREFIX/lib/node_modules/npm/bin/npm-cli.js" "${'$'}@"; }
        npx() { node "${'$'}PREFIX/lib/node_modules/npm/bin/npx-cli.js" "${'$'}@"; }
        if [ -f "${'$'}PREFIX/lib/node_modules/corepack/dist/corepack.js" ]; then
          corepack() { node "${'$'}PREFIX/lib/node_modules/corepack/dist/corepack.js" "${'$'}@"; }
          yarn() { node "${'$'}PREFIX/lib/node_modules/corepack/dist/corepack.js" yarn "${'$'}@"; }
          pnpm() { node "${'$'}PREFIX/lib/node_modules/corepack/dist/corepack.js" pnpm "${'$'}@"; }
        fi

        command -v dbclient >/dev/null 2>&1 && ssh() { dbclient "${'$'}@"; }

        # Run a JS CLI file via node (shebang-safe on noexec).
        adev-node-bin() {
            local f="${'$'}1"; shift
            [ -f "${'$'}f" ] || return 127
            # Strip shebang and run with node if it looks like JS; else try node anyway.
            node "${'$'}f" "${'$'}@"
        }

        # mksh: function shims for global + common local bins. Re-run after npm i -g.
        adev-rehash() {
            shimf="${'$'}HOME/.adev-shims"
            : > "${'$'}shimf"
            for f in "${'$'}HOME/.npm-global/bin"/* "${'$'}HOME/.local/bin"/*; do
                [ -f "${'$'}f" ] || continue
                n=${'$'}{f##*/}
                case "${'$'}n" in npm|npx|node|corepack) continue ;; esac
                printf '%s() { node "%s" "${'$'}@"; }\n' "${'$'}n" "${'$'}f" >> "${'$'}shimf"
            done
            . "${'$'}shimf" 2>/dev/null
            echo "adev: rehashed global CLI shims"
        }
        adev-rehash 2>/dev/null

        alias ll='ls -la'
        alias la='ls -a'
        alias ..='cd ..'
        alias cls='clear'
        alias projects='cd ${workspacesDir.absolutePath}'

        echo "Welcome to A Dev Studio Terminal"
    """.trimIndent()

    private fun getBashrcContent(): String = """
        # A Dev Studio - bash configuration
        export PS1='\[\033[01;32m\]adev\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]${'$'} '
        export EDITOR=vi
        export LANG=en_US.UTF-8

        npm() { node "${'$'}PREFIX/lib/node_modules/npm/bin/npm-cli.js" "${'$'}@"; }
        npx() { node "${'$'}PREFIX/lib/node_modules/npm/bin/npx-cli.js" "${'$'}@"; }
        if [ -f "${'$'}PREFIX/lib/node_modules/corepack/dist/corepack.js" ]; then
          corepack() { node "${'$'}PREFIX/lib/node_modules/corepack/dist/corepack.js" "${'$'}@"; }
          yarn() { node "${'$'}PREFIX/lib/node_modules/corepack/dist/corepack.js" yarn "${'$'}@"; }
          pnpm() { node "${'$'}PREFIX/lib/node_modules/corepack/dist/corepack.js" pnpm "${'$'}@"; }
        fi

        command -v dbclient >/dev/null 2>&1 && ssh() { dbclient "${'$'}@"; }

        # Prefer node for any JS bin under global/local prefixes when the command
        # is not found as a real executable (PATH does not list noexec dirs first).
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
            # Project-local node_modules/.bin (common after npm install)
            if [ -f "./node_modules/.bin/${'$'}cmd" ]; then
                node "./node_modules/.bin/${'$'}cmd" "${'$'}@"
                return ${'$'}?
            fi
            echo "adev: ${'$'}cmd: command not found" >&2
            return 127
        }

        # Same rehash helper as mksh (optional explicit shims for builtins shadowing).
        adev-rehash() {
            hash -r 2>/dev/null
            echo "adev: bash hash cleared; globals resolve via command_not_found_handle + termux-exec"
        }

        alias ll='ls -la'
        alias la='ls -a'
        alias ..='cd ..'
        alias cls='clear'
        alias projects='cd ${workspacesDir.absolutePath}'

        export HISTSIZE=2000
        export HISTFILE=${homeDir.absolutePath}/.bash_history

        echo "Welcome to A Dev Studio Terminal"
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
        // Prefer the bundled bash (via its symlink) so command_not_found_handle works.
        val shell = File(binDir, "bash").let { if (it.exists()) it.absolutePath else "/system/bin/sh" }

        // PATH order is deliberate:
        // 1) bin/ — our exec-safe symlinks (node, git, bash, busybox applets)
        // 2) git-core helpers
        // 3) system tools
        // 4) npm global/local bins LAST — with termux-exec LD_PRELOAD they can
        //    run; if preload fails, shell shims / command_not_found still help.
        // Putting globals first caused Permission denied before shims could run.
        val env = mutableMapOf(
            "PATH" to listOf(
                binDir.absolutePath,
                "${binDir.absolutePath}/git-core",
                nativeLibDir,
                "/system/bin",
                "/system/xbin",
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
            // Skip optional native deps by default (ws fallbacks work without them).
            "NPM_CONFIG_OPTIONAL" to "false",
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
            "HOSTNAME" to "adev",
            "MOBILEIDE_ROOT" to runtimeRoot.absolutePath,
            "MOBILEIDE_WORKSPACES" to workspacesDir.absolutePath,
            // Used by adev-npm-shell to locate libbin_node.so if PATH node is missing.
            "MOBILEIDE_NATIVE_LIB" to nativeLibDir
        )

        // npm lifecycle: trampoline that runs JS bins via node (noexec-safe).
        val npmShellLink = File(binDir, "adev-npm-shell")
        val npmShellNative = File(nativeLibDir, "libbin_adev_npm_shell.so")
        val npmShellPath = when {
            npmShellLink.exists() -> npmShellLink.absolutePath
            npmShellNative.exists() -> npmShellNative.absolutePath
            else -> null
        }
        if (npmShellPath != null) {
            env["NPM_CONFIG_SCRIPT_SHELL"] = npmShellPath
            env["npm_config_script_shell"] = npmShellPath
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
