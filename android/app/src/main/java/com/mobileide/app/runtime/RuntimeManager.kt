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
import java.nio.file.Files
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
        private const val RUNTIME_NATIVE_LIBRARY_DIR_FILE = ".runtime_native_library_dir"
        // Build-time index of packaged files that still carry the Termux prefix.
        private const val PREFIX_RETARGET_FILE = "prefix-retarget.json"
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

    /**
     * The authority for every variable in the runtime environment contract.
     * RuntimeManager owns tool configuration; AdevEnvironment owns identity,
     * search paths, temporary/XDG directories and TLS trust so that shells,
     * native launchers, Node, Python and their subprocesses cannot drift apart.
     */
    private val adevEnv: AdevEnvironment by lazy { AdevEnvironment(runtimeRoot, nativeLibDir) }
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
        if (!isRuntimeContentReady()) return false
        return installPathBindingsCurrent(requireMarker = true)
    }

    /** Runtime assets are current even if APK-native absolute paths need rebinding. */
    private fun isRuntimeContentReady(): Boolean {
        return try {
            val versionFile = File(runtimeRoot, RUNTIME_VERSION_FILE)
            if (!versionFile.isFile) return false
            if (versionFile.readText().trim() != CURRENT_RUNTIME_VERSION) return false
            if (!binDir.isDirectory) return false
            if (!binDir.canWrite() || !binDir.canExecute()) return false
            if (!runtimeSupportAssetsComplete()) return false

            // Re-initialize whenever the bundled binary/library set changes, even if
            // the version string is unchanged. The fingerprint of native-map.json
            // (shipped in the APK) is compared against the fingerprint captured at the
            // last successful init; a mismatch means .so files were added/changed and
            // the symlink farm must be rebuilt. This self-heals the case where a newer
            // APK adds shared libraries but reuses the same runtime version.
            val stored = File(runtimeRoot, RUNTIME_FINGERPRINT_FILE)
            if (!stored.isFile) return false
            val current = assetNativeMapFingerprint() ?: return false
            stored.readText().trim() == current
        } catch (e: Exception) {
            Log.w(TAG, "Runtime readiness metadata is unreadable: ${e.message}")
            false
        }
    }

    /**
     * Verify every generated file that embeds Android's randomized install path.
     * The marker is a completion record, not the source of truth: a partial
     * refresh cannot become ready merely because the marker was written.
     */
    private fun installPathBindingsCurrent(requireMarker: Boolean): Boolean {
        return try {
            if (requireMarker) {
                val marker = File(runtimeRoot, RUNTIME_NATIVE_LIBRARY_DIR_FILE)
                if (!marker.isFile || marker.readText().trim() != nativeLibDir.absolutePath) {
                    return false
                }
            }

            val generatedTextBindings = mutableListOf(
                File(homeDir, ".adev-wrappers"),
                File(homeDir, ".adev-agent-env")
            )
            if (!generatedTextBindings.all { file ->
                if (!file.isFile) return@all false
                val content = file.readText()
                if (!content.contains(nativeLibDir.absolutePath)) return@all false

                // Generated binding files may contain several APK-native tools,
                // but every /data/app path must belong to this exact install.
                var position = content.indexOf("/data/app/")
                while (position >= 0) {
                    if (!content.regionMatches(
                            position,
                            nativeLibDir.absolutePath,
                            0,
                            nativeLibDir.absolutePath.length
                        )
                    ) {
                        return@all false
                    }
                    position = content.indexOf("/data/app/", position + 1)
                }
                true
            }) return false

            // Every core public command must resolve to the one APK-native
            // launcher, never to a script below filesDir. A stale/missing link
            // recreates the exact terminal-vs-agent split this layer prevents.
            val envNative = File(nativeLibDir, "libbin_adev_env.so")
            if (!envNative.isFile) return false
            val nativeAliases = mutableListOf(
                "env", "bash", "sh", "node", "npm", "npx", "node-gyp", "git"
            )
            if (findNativeTool("libbin_python", ".so") != null) {
                nativeAliases += "python"
                nativeAliases += "python3"
            }
            if (File(nativeLibDir, "libbin_opencode.so").isFile) nativeAliases += "opencode"
            if (File(nativeLibDir, "libbin_adev_xdg_open.so").isFile) nativeAliases += "xdg-open"
            if (!nativeAliases.all { name ->
                listOf(File(binDir, name), File(adevEnv.shimDir, name)).all { link ->
                    link.isFile &&
                        link.canExecute() &&
                        Files.isSymbolicLink(link.toPath()) &&
                        link.canonicalFile == envNative.canonicalFile
                }
            }) return false

            // The native recovery layer reads this flat file. Validate the
            // current install paths before reporting readiness; otherwise an
            // APK reinstall can leave children loading an old LD_PRELOAD path.
            val contractFile = File(etcDir, AdevEnvironment.CONF_NAME)
            if (!contractFile.isFile) return false
            val contract = contractFile.readText()
            if (!contract.contains("PREFIX=${runtimeRoot.absolutePath}\n")) return false
            if (!contract.contains(adevEnv.shimDir.absolutePath)) return false
            if (!contract.contains("LD_LIBRARY_PATH=${libDir.absolutePath}:${nativeLibDir.absolutePath}")) {
                return false
            }
            if (contract.contains("/com.termux/")) return false

            true
        } catch (e: Exception) {
            Log.w(TAG, "Runtime executable binding validation failed: ${e.message}")
            false
        }
    }

    /**
     * Files whose absence makes the extracted runtime unusable even when its
     * version/fingerprint markers happen to exist. Extraction used to log and
     * swallow an IOException, so a truncated Python or npm tree could be marked
     * ready and remain broken across every app restart.
     */
    private fun runtimeSupportAssetsComplete(): Boolean {
        val required = listOf(
            File(runtimeRoot, NATIVE_MAP_FILE),
            File(runtimeRoot, PREFIX_RETARGET_FILE),
            File(libDir, "node_modules/npm/bin/npm-cli.js"),
            File(libDir, "node_modules/npm/bin/npx-cli.js"),
            File(libDir, "adev-node-preload.js"),
            File(libDir, "adev-child-process-compat.js"),
            File(libDir, "adev-native-addon-lifecycle.js"),
            File(libDir, "adev-node-cli.js"),
            File(libDir, "adev-cli-compat.json"),
            File(libDir, "adev-native-addons/node-pty/1.2.0-beta.15/android-arm64/pty.node"),
            File(libDir, "adev-native-addons/koffi/3.1.6/android-arm64/koffi.node"),
            File(libDir, "node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.4.node.wasm"),
            File(libDir, "adev-runtime-env-test.js")
        )
        if (!required.all { it.isFile && it.length() > 0L }) return false

        val pythonLib = findPythonLibDir()
        if (findNativeTool("libbin_python", ".so") != null) {
            if (pythonLib == null) return false
            val pythonRequired = listOf(
                File(pythonLib, "zipfile/_path/__init__.py"),
                File(pythonLib, "importlib/metadata/__init__.py"),
                File(pythonLib, "subprocess.py")
            )
            if (!pythonRequired.all { it.isFile && it.length() > 0L }) return false
        }
        return true
    }

    /**
     * SHA-256 of the native-map.json bundled in the APK assets. Detects when the
     * runtime binary/library set has changed between app upgrades so the symlink
     * farm is rebuilt even if CURRENT_RUNTIME_VERSION was not bumped.
     */
    private fun assetNativeMapFingerprint(): String? {
        return try {
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            listOf(
                NATIVE_MAP_FILE,
                "runtime-lock.json",
                "lib/adev-node-preload.js",
                "lib/adev-child-process-compat.js",
                "lib/adev-native-addon-lifecycle.js",
                "lib/adev-runtime-cli.js",
                // The catalog pins all Android addon/WASM artifact hashes. Hash
                // it and its launcher rather than reading 11 MiB on every app
                // readiness check.
                "lib/adev-node-cli.js",
                "lib/adev-cli-compat.json",
                // Agent-facing guide: refresh extracted copy whenever edited.
                "share/adev/SKILL.md"
            ).forEach { relativePath ->
                digest.update(relativePath.toByteArray(Charsets.UTF_8))
                context.assets.open("$RUNTIME_DIR/$relativePath").use { stream ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val count = stream.read(buffer)
                        if (count < 0) break
                        digest.update(buffer, 0, count)
                    }
                }
            }
            val runtimeContent = digest.digest().joinToString("") { "%02x".format(it) }
            // The packaged runtime is more than its native-map paths. The signed
            // lock captures helper-binary bytes, while these preload assets
            // define child-process behavior. Hash both so an upgrade refreshes
            // changed bindings and JavaScript even before a version bump.
            "$runtimeContent:${BuildConfig.VERSION_CODE}:${BuildConfig.VERSION_NAME}"
        } catch (e: Exception) {
            Log.w(TAG, "Could not fingerprint the packaged runtime: ${e.message}")
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

        if (isRuntimeContentReady()) {
            onProgress?.invoke("Refreshing Android executable paths...", 0.1f)
            refreshInstallPathBindings()
            onProgress?.invoke("Runtime ready!", 1.0f)
            Log.i(TAG, "Runtime executable paths rebound to ${nativeLibDir.absolutePath}")
            return
        }

        onProgress?.invoke("Creating directories...", 0.05f)
        createDirectoryStructure()
        restoreBinWritability()

        // Mirror verified task ports to a file the netstat/ss/lsof trampolines
        // render — Android 10+ hides /proc/net from apps, so shell tools cannot
        // enumerate sockets from the kernel.
        com.mobileide.app.process.TaskRegistry.portSnapshotFile =
            File(runtimeRoot, "tmp/adev-ports.json")

        onProgress?.invoke("Extracting runtime files...", 0.1f)
        extractRuntimeAssets(onProgress)

        // aapt omits underscore-prefixed asset directories. The packaging
        // pipeline stores CPython's ensurepip payload under a safe transport
        // name; restore the distribution-owned `_bundled` directory before
        // Python or venv can observe the runtime.
        restorePythonEnsurepipAssets()

        // Before anything reads the sysroot, make its recorded install prefix
        // this app rather than the Termux package it was built against.
        retargetPackagedPrefixes()

        onProgress?.invoke("Setting permissions...", 0.8f)
        setExecutablePermissions()

        onProgress?.invoke("Linking native binaries...", 0.85f)
        buildSymlinkFarm()
        createDropbearAliases()
        createGitRemoteAliases()
        createBusyboxAliases()
        createNpmShellAlias()
        refreshOptionalGlibcBindings()
        // Replace key bin/* symlinks with shebang trampolines so OpenCode / agents
        // can exec node|npm|git via PATH (termux-exec runs scripts on noexec).
        createPathTrampolines()

        onProgress?.invoke("Finalizing runtime permissions...", 0.9f)
        finalizeBinPermissions()

        // The trust store is assembled before the environment contract is
        // published: SSL_CERT_FILE and its siblings are only advertised once a
        // parsed, non-empty CA bundle actually exists on disk.
        onProgress?.invoke("Preparing certificates...", 0.92f)
        setupCaBundle()

        onProgress?.invoke("Configuring environment...", 0.93f)
        adevEnv.writeContractFiles()
        setupEnvironment()
        setupNanoConfiguration()
        setupRuntimePolicy()
        setupShellWrappers()
        setupNpmrc()

        if (!installPathBindingsCurrent(requireMarker = false)) {
            throw IOException("Generated runtime executable bindings are incomplete")
        }

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
        writeNativeLibraryDirBinding()

        onProgress?.invoke("Runtime ready!", 1.0f)
        Log.i(TAG, "Runtime initialization complete")
    }

    /**
     * Recreate only install-location-dependent state after an APK upgrade.
     * User workspaces, caches, package installs, and extracted runtime content
     * remain untouched.
     */
    private fun refreshInstallPathBindings() {
        createDirectoryStructure()
        ensureWorkspaceHomeLink()
        restoreBinWritability()
        // Runtime upgrades normally preserve extracted assets. Reconcile the
        // independently packaged ensurepip payload here so an APK upgrade fixes
        // existing installations without deleting workspaces or caches.
        restorePythonEnsurepipAssets()
        buildSymlinkFarm()
        createDropbearAliases()
        createGitRemoteAliases()
        createBusyboxAliases()
        createNpmShellAlias()
        refreshOptionalGlibcBindings()
        createPathTrampolines()
        setExecutablePermissions()
        setupShellWrappers()
        finalizeBinPermissions()
        // The trust store and the published environment contract both embed the
        // current install paths, so an upgrade must rewrite them here too. A
        // previously failed CA assembly is repaired on the next launch instead of
        // leaving TLS verification permanently broken.
        setupCaBundle()
        adevEnv.writeContractFiles()
        if (!installPathBindingsCurrent(requireMarker = false)) {
            throw IOException("Refreshed runtime executable bindings are incomplete")
        }
        writeNativeLibraryDirBinding()
    }

    private fun writeNativeLibraryDirBinding() {
        val marker = File(runtimeRoot, RUNTIME_NATIVE_LIBRARY_DIR_FILE)
        val temporary = File(runtimeRoot, "$RUNTIME_NATIVE_LIBRARY_DIR_FILE.tmp")
        temporary.writeText(nativeLibDir.absolutePath + "\n")
        Os.rename(temporary.absolutePath, marker.absolutePath)
    }

    /**
     * An APK update moves nativeLibraryDir. Keep an already-installed optional
     * glibc pack intact, but atomically rebind its loader and generic runner to
     * the current APK-native executable anchor. No download or user action is
     * required, and Bionic remains the default runtime.
     */
    private fun refreshOptionalGlibcBindings() {
        val glibcRoot = File(runtimeRoot, "glibc")
        if (!File(glibcRoot, "manifest.json").isFile) return
        val loader = File(nativeLibDir, "libbin_adev_glibc_ld.so")
        val launcher = File(nativeLibDir, "libbin_adev_glibc_loader.so")
        if (!loader.isFile || !launcher.isFile) return

        val glibcLib = File(glibcRoot, "lib").apply { mkdirs() }
        val glibcBin = File(glibcRoot, "bin").apply { mkdirs() }
        fun replaceLink(link: File, target: String) {
            try {
                if (link.exists() || Files.isSymbolicLink(link.toPath())) link.delete()
                Os.symlink(target, link.absolutePath)
            } catch (error: Exception) {
                Log.w(TAG, "Optional glibc binding ${link.name} failed: ${error.message}")
            }
        }
        replaceLink(File(glibcLib, "ld-linux-aarch64.so.1"), launcher.absolutePath)
        replaceLink(File(glibcBin, "ld.so"), "../lib/ld-linux-aarch64.so.1")

        val runner = File(glibcBin, "glibc-run")
        runner.writeText(
            "#!/system/bin/sh\n" +
                "ADEV_GLIBC_ROOT=\"${glibcRoot.absolutePath}\"\n" +
                "unset LD_PRELOAD\n" +
                "export ADEV_ENV_AUTOFILL=0\n" +
                "export LD_LIBRARY_PATH=\"\$ADEV_GLIBC_ROOT/lib\"\n" +
                "export GCONV_PATH=\"\$ADEV_GLIBC_ROOT/lib/gconv\"\n" +
                "if [ \"\$#\" -eq 0 ]; then echo \"usage: glibc-run <program> [args...]\" >&2; exit 64; fi\n" +
                "ADEV_GLIBC_PROGRAM=\"\$1\"\n" +
                "shift\n" +
                "case \"\$ADEV_GLIBC_PROGRAM\" in\n" +
                "  */*) ;;\n" +
                "  *)\n" +
                "    if [ -f \"\$ADEV_GLIBC_ROOT/bin/\$ADEV_GLIBC_PROGRAM\" ]; then\n" +
                "      ADEV_GLIBC_PROGRAM=\"\$ADEV_GLIBC_ROOT/bin/\$ADEV_GLIBC_PROGRAM\"\n" +
                "    else\n" +
                "      ADEV_GLIBC_PROGRAM=\"\$(command -v \"\$ADEV_GLIBC_PROGRAM\")\" || exit 127\n" +
                "    fi\n" +
                "    ;;\n" +
                "esac\n" +
                "exec \"${launcher.absolutePath}\" " +
                "--library-path \"\$ADEV_GLIBC_ROOT/lib\" \"\$ADEV_GLIBC_PROGRAM\" \"\$@\"\n"
        )
        try {
            Os.chmod(runner.absolutePath, 0b111101101) // 0755
        } catch (_: Exception) {
            runner.setExecutable(true, true)
        }
    }

    /** Restore owner write access before replacing packaged bin entries. */
    private fun restoreBinWritability() {
        if (!binDir.exists()) return
        fun walk(f: File) {
            if (Files.isSymbolicLink(f.toPath())) return
            try {
                Os.chmod(
                    f.absolutePath,
                    if (f.isDirectory) 0b111000000 else 0b111101101
                ) // directories 0700, files 0755
            } catch (_: Exception) {
                f.setWritable(true, true)
                f.setReadable(true, true)
                if (f.isDirectory || f.isFile) f.setExecutable(true, true)
            }
            if (f.isDirectory) f.listFiles()?.forEach { walk(it) }
        }
        walk(binDir)
    }

    /**
     * Create the runtime directory structure
     */
    private fun createDirectoryStructure() {
        // Every directory the environment contract promises exists — including
        // the XDG base directories and $HOME/.cache, which Next.js probes before
        // deciding a platform is unsupported.
        adevEnv.ensureDirectories()
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
            throw e
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
     * Restore CPython's packaged ensurepip wheels after Android asset
     * extraction.  Wheel names and versions come entirely from the Python
     * distribution; ADEV never pins or rewrites a pip version here.
     */
    private fun restorePythonEnsurepipAssets() {
        val pythonName = Regex("""python\d+\.\d+""")
        val assetManager = context.assets
        val packagedHomes = try {
            assetManager.list("runtime/lib")
                .orEmpty()
                .filter { it.matches(pythonName) }
        } catch (_: IOException) {
            emptyList()
        }
        val installedHomes = libDir.listFiles()
            ?.filter { it.isDirectory && it.name.matches(pythonName) }
            ?.map { it.name }
            .orEmpty()

        (packagedHomes + installedHomes).distinct().forEach { homeName ->
            val pythonHome = File(libDir, homeName).apply { mkdirs() }
            val ensurepip = File(pythonHome, "ensurepip")
            val transported = File(ensurepip, "adev-bundled")
            val bundled = File(ensurepip, "_bundled").apply { mkdirs() }
            val assetPath = "runtime/lib/$homeName/ensurepip/adev-bundled"
            val packagedEntries = try {
                assetManager.list(assetPath).orEmpty().filter { it.endsWith(".whl") }
            } catch (_: IOException) {
                emptyList()
            }
            val installedEntries = bundled.listFiles()
                ?.filter { it.isFile && it.extension == "whl" }
                ?.map { it.name }
                .orEmpty()
            if (packagedEntries.isNotEmpty() && packagedEntries.toSet() != installedEntries.toSet()) {
                transported.deleteRecursively()
                bundled.deleteRecursively()
                ensurepip.mkdirs()
                extractAssetRecursive(assetManager, assetPath, ensurepip)
            }
            if (!transported.isDirectory) return@forEach
            bundled.mkdirs()
            transported.listFiles().orEmpty().forEach { source ->
                val destination = File(bundled, source.name)
                if (source.isDirectory) {
                    source.copyRecursively(destination, overwrite = true)
                } else {
                    source.copyTo(destination, overwrite = true)
                }
            }
            transported.deleteRecursively()
            val wheels = bundled.listFiles()
                ?.filter { it.isFile && it.extension == "whl" }
                .orEmpty()
            if (wheels.isEmpty()) {
                throw IOException(
                    "Packaged Python ${pythonHome.name} has no ensurepip wheel payload"
                )
            }
            Log.i(
                TAG,
                "Restored ${wheels.size} distribution ensurepip wheel(s) for ${pythonHome.name}"
            )
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
            "ls", "cat", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown", "install",
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
            val lld = findUnixLinkerCommand()
            val pkgConfig = findNativeTool("libbin_pkg_config", ".so")
            val curl = File(nativeLibDir, "libbin_curl.so")
            val nano = File(nativeLibDir, "libbin_nano.so")
            val ripgrep = File(nativeLibDir, "libbin_rg.so")
            val openCode = File(nativeLibDir, "libbin_opencode.so")
            val xdgOpen = File(nativeLibDir, "libbin_adev_xdg_open.so")
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
            val runtimeCli = File(libDir, "adev-runtime-cli.js")
            val nodeCliLauncher = File(libDir, "adev-node-cli.js")
            val glibcLoader = File(nativeLibDir, "libbin_adev_glibc_ld.so")
            val phase3Test = File(libDir, "adev-phase3-test.js")
            val environmentTest = File(libDir, "adev-runtime-env-test.js")
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

            val envContract = File(etcDir, AdevEnvironment.SHELL_NAME).absolutePath
            val sb = StringBuilder()
            sb.appendLine("# Generated by RuntimeManager — do not edit by hand")
            sb.appendLine("# Exec ELFs from nativeLibraryDir (exec-safe). filesDir is noexec.")
            // The contract comes first so a shell started with a partial or
            // cleared environment still has HOME, PATH, PREFIX, TMPDIR, the XDG
            // directories and the TLS trust store before any wrapper runs.
            sb.appendLine("[ -f \"$envContract\" ] && . \"$envContract\"")
            sb.appendLine("export ADEV_WRAPPERS=\"\$HOME/.adev-wrappers\"")
            sb.appendLine()

            // Use the same physical-path policy as PATH trampolines so normal,
            // `command`, env, and background routes reject before npm creates
            // partial output on Android shared storage.
            val workspaceGuard = File(binDir, ".adev-workspace-guard").absolutePath
            sb.appendLine("adev-workspace-guard() { . \"$workspaceGuard\"; adev_guard \"\$@\"; }")
            sb.appendLine("adev-require-private-workspace() { adev-workspace-guard generic \"\$@\"; }")
            sb.appendLine()

            if (hasNode) {
                sb.appendLine("node() { \"$node\" \"\$@\"; }")
                sb.appendLine("npm() { adev-workspace-guard npm \"\$@\" || return \$?; \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npm-cli.js\" \"\$@\"; }")
                sb.appendLine("npx() { adev-workspace-guard npx \"\$@\" || return \$?; \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npx-cli.js\" \"\$@\"; }")
                if (nodeGyp.exists()) {
                    sb.appendLine("node-gyp() { adev-workspace-guard native \"\$@\" || return \$?; \"$node\" \"${nodeGyp.absolutePath}\" \"\$@\"; }")
                }
                sb.appendLine("if [ -f \"${packageManagerLauncher.absolutePath}\" ]; then")
                sb.appendLine("  corepack() { adev-workspace-guard corepack \"\$@\" || return \$?; \"$node\" \"${packageManagerLauncher.absolutePath}\" corepack \"\$@\"; }")
                sb.appendLine("  yarn() { adev-workspace-guard yarn \"\$@\" || return \$?; \"$node\" \"${packageManagerLauncher.absolutePath}\" yarn \"\$@\"; }")
                sb.appendLine("  pnpm() { adev-workspace-guard pnpm \"\$@\" || return \$?; \"$node\" \"${packageManagerLauncher.absolutePath}\" pnpm \"\$@\"; }")
                sb.appendLine("fi")
                if (bunBoundary.exists()) {
                    sb.appendLine("bun() { \"$node\" \"${bunBoundary.absolutePath}\" \"\$@\"; }")
                }
                if (sshLauncher.exists()) {
                    sb.appendLine("ssh() { \"$node\" \"${sshLauncher.absolutePath}\" \"\$@\"; }")
                }
                if (runtimeCli.exists()) {
                    sb.appendLine("adev() { \"$node\" \"${runtimeCli.absolutePath}\" \"\$@\"; }")
                }
                if (nodeCliLauncher.exists()) {
                    // --expose-internals must be a real Node CLI argument. Keep
                    // the authoritative single-entry NODE_OPTIONS untouched.
                    sb.appendLine("dsh() { \"$node\" --expose-internals \"${nodeCliLauncher.absolutePath}\" dsh \"\$@\"; }")
                }
                sb.appendLine("tsc() { adev-require-private-workspace \"\$@\" || return \$?; \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npx-cli.js\" --no-install tsc \"\$@\" 2>/dev/null || \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npx-cli.js\" --yes tsc \"\$@\"; }")
                sb.appendLine("eslint() { adev-require-private-workspace \"\$@\" || return \$?; \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npx-cli.js\" --no-install eslint \"\$@\" 2>/dev/null || \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npx-cli.js\" --yes eslint \"\$@\"; }")
                sb.appendLine("vite() { adev-workspace-guard vite \"\$@\" || return \$?; \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npx-cli.js\" --no-install vite \"\$@\" 2>/dev/null || \"$node\" \"\$PREFIX/lib/node_modules/npm/bin/npx-cli.js\" --yes vite \"\$@\"; }")
                if (nextLauncher.exists()) {
                    sb.appendLine("next() { adev-workspace-guard next \"\$@\" || return \$?; \"$node\" \"${nextLauncher.absolutePath}\" \"\$@\"; }")
                }
                sb.appendLine()
            }
            python?.let {
                sb.appendLine("python() { \"${it.absolutePath}\" \"\$@\"; }")
                sb.appendLine("python3() { \"${it.absolutePath}\" \"\$@\"; }")
            }
            make?.let { sb.appendLine("make() { adev-workspace-guard native \"\$@\" || return \$?; \"${it.absolutePath}\" \"\$@\"; }") }
            clang?.let {
                val common = clangDriverFlags(clangResourceDir)
                sb.appendLine("clang() { adev-workspace-guard native \"\$@\" || return \$?; \"${it.absolutePath}\" $common \"\$@\"; }")
                sb.appendLine("cc() { adev-workspace-guard native \"\$@\" || return \$?; \"${it.absolutePath}\" $common \"\$@\"; }")
                sb.appendLine("clang++() { adev-workspace-guard native \"\$@\" || return \$?; \"${it.absolutePath}\" --driver-mode=g++ $common \"\$@\"; }")
                sb.appendLine("c++() { adev-workspace-guard native \"\$@\" || return \$?; \"${it.absolutePath}\" --driver-mode=g++ $common \"\$@\"; }")
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
            if (ripgrep.exists()) {
                sb.appendLine("rg() { \"${ripgrep.absolutePath}\" \"\$@\"; }")
            }
            if (openCode.exists()) {
                sb.appendLine("opencode() { \"${openCode.absolutePath}\" \"\$@\"; }")
            }
            if (xdgOpen.exists()) {
                sb.appendLine("xdg-open() { \"${xdgOpen.absolutePath}\" \"\$@\"; }")
            }
            if (python != null || make != null || clang != null) sb.appendLine()
            if (hasGit) {
                sb.appendLine("git() { adev-workspace-guard git \"\$@\" || return \$?; \"$git\" \"\$@\"; }")
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
            if (glibcLoader.isFile) {
                sb.appendLine("glibc-run() {")
                sb.appendLine("  [ -f \"\$PREFIX/glibc/manifest.json\" ] || { echo \"glibc runtime is not installed; run: adev runtime install glibc\" >&2; return 69; }")
                sb.appendLine("  \"\$PREFIX/glibc/bin/glibc-run\" \"\$@\"")
                sb.appendLine("}")
                sb.appendLine()
            }

            if (hasBusybox) {
                sb.appendLine("busybox() { \"$busyboxDispatcher\" \"\$@\"; }")
                // Pure-shell install emulation — BusyBox install segfaults (139)
                // via matchpathcon/selabel_file_init as app UID cannot access
                // file_contexts. Emulate with cp/chmod/mkdir only (no BusyBox).
                sb.appendLine("install() {")
                sb.appendLine("  adev_install_mode=755")
                sb.appendLine("  adev_install_directory=0")
                sb.appendLine("  adev_install_target=\"\"")
                sb.appendLine("  while [ \"\$#\" -gt 0 ]; do")
                sb.appendLine("    case \"\$1\" in")
                sb.appendLine("      -m) adev_install_mode=\"\$2\"; shift 2 ;;")
                sb.appendLine("      -m*) adev_install_mode=\"\${1#-m}\"; shift ;;")
                sb.appendLine("      -D) adev_install_directory=1; shift ;;")
                sb.appendLine("      -Dm) adev_install_directory=1; adev_install_mode=\"\$2\"; shift 2 ;;")
                sb.appendLine("      -Dm*) adev_install_directory=1; adev_install_mode=\"\${1#-Dm}\"; shift ;;")
                sb.appendLine("      -t) adev_install_target=\"\$2\"; shift 2 ;;")
                sb.appendLine("      -t*) adev_install_target=\"\${1#-t}\"; shift ;;")
                sb.appendLine("      --) shift; break ;;")
                sb.appendLine("      -*) echo \"install: unknown option \$1\" >&2; return 64 ;;")
                sb.appendLine("      *) break ;;")
                sb.appendLine("    esac")
                sb.appendLine("  done")
                sb.appendLine("  if [ -n \"\$adev_install_target\" ]; then")
                sb.appendLine("    mkdir -p \"\$adev_install_target\" || return \$?")
                sb.appendLine("    for adev_install_src in \"\$@\"; do")
                sb.appendLine("      cp -f \"\$adev_install_src\" \"\$adev_install_target/\" || return \$?")
                sb.appendLine("      chmod \"\$adev_install_mode\" \"\$adev_install_target/\$(basename \"\$adev_install_src\")\" || return \$?")
                sb.appendLine("    done")
                sb.appendLine("    return 0")
                sb.appendLine("  fi")
                sb.appendLine("  eval \"adev_install_dest=\\\${\$#}\"")
                sb.appendLine("  if [ \"\$adev_install_directory\" -eq 1 ]; then")
                sb.appendLine("    mkdir -p \"\$(dirname \"\$adev_install_dest\")\" || return \$?")
                sb.appendLine("  fi")
                sb.appendLine("  adev_install_count=\$#")
                sb.appendLine("  if [ \"\$adev_install_count\" -eq 2 ]; then")
                sb.appendLine("    cp -f \"\$1\" \"\$adev_install_dest\" || return \$?")
                sb.appendLine("    if [ -d \"\$adev_install_dest\" ]; then")
                sb.appendLine("      chmod \"\$adev_install_mode\" \"\$adev_install_dest/\$(basename \"\$1\")\" || return \$?")
                sb.appendLine("    else")
                sb.appendLine("      chmod \"\$adev_install_mode\" \"\$adev_install_dest\" || return \$?")
                sb.appendLine("    fi")
                sb.appendLine("    return 0")
                sb.appendLine("  fi")
                sb.appendLine("  mkdir -p \"\$adev_install_dest\" || return \$?")
                sb.appendLine("  for adev_install_src in \"\$@\"; do")
                sb.appendLine("    [ \"\$adev_install_src\" = \"\$adev_install_dest\" ] && break")
                sb.appendLine("    cp -f \"\$adev_install_src\" \"\$adev_install_dest/\" || return \$?")
                sb.appendLine("    chmod \"\$adev_install_mode\" \"\$adev_install_dest/\$(basename \"\$adev_install_src\")\" || return \$?")
                sb.appendLine("  done")
                sb.appendLine("}")
                // Fall back only when BusyBox could not *run* the applet (127 /
                // 126), never on a non-zero exit status. Chaining with || meant
                // `grep` finding no match, or `diff` reporting a difference, ran
                // the same command up to three times and then reported a missing
                // /system/xbin helper instead of the real result.
                sb.appendLine("adev_applet() {")
                sb.appendLine("  adev_applet_name=\"\$1\"; shift")
                sb.appendLine("  \"$busyboxDispatcher\" \"\$adev_applet_name\" \"\$@\"")
                sb.appendLine("  adev_applet_status=\$?")
                sb.appendLine("  if [ \"\$adev_applet_status\" -ge 126 ] && [ \"\$adev_applet_status\" -le 127 ] && [ -x \"/system/bin/\$adev_applet_name\" ]; then")
                sb.appendLine("    \"/system/bin/\$adev_applet_name\" \"\$@\"")
                sb.appendLine("    adev_applet_status=\$?")
                sb.appendLine("  fi")
                sb.appendLine("  return \$adev_applet_status")
                sb.appendLine("}")
                applets.forEach { ap ->
                    sb.appendLine("$ap() { adev_applet $ap \"\$@\"; }")
                }
                // BusyBox clear commonly emits only CSI 2J, which leaves
                // xterm scrollback and ADEV's copy buffer intact. Emit the
                // standard erase-display + erase-saved-lines contract. This
                // writes display bytes only; it never signals the PTY or an
                // active SSH child.
                sb.appendLine("clear() { printf '\\033[H\\033[2J\\033[3J'; }")
                sb.appendLine()
            }

            // Dev server helpers (bind 0.0.0.0 so phone browser / Output → Open works)
            sb.appendLine("adev-typecheck() { npm run typecheck 2>/dev/null || npm run check 2>/dev/null || npx --yes tsc --noEmit \"\$@\"; }")
            sb.appendLine("adev-build() { npm run build \"\$@\"; }")
            sb.appendLine("adev-test() { npm test \"\$@\"; }")
            sb.appendLine("adev-lint() { npm run lint 2>/dev/null || npx --yes eslint . \"\$@\"; }")
            sb.appendLine("adev-dev() { adev-require-private-workspace || return \$?; npm run dev -- --host 0.0.0.0 \"\$@\" 2>/dev/null || npm start \"\$@\"; }")
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
            if (hasNode && environmentTest.exists()) {
                sb.appendLine(
                    "adev-env-test() { \"$node\" \"${environmentTest.absolutePath}\" \"\$@\"; }"
                )
            }

            val out = File(homeDir, ".adev-wrappers")
            out.writeText(sb.toString())

            // Non-interactive agent bootstrap (OpenCode / background tools).
            // Also used as BASH_ENV so `bash -c '…'` loads tools without -i/-l.
            val agentEnv = StringBuilder()
            agentEnv.appendLine("# ADEV agent bootstrap — source: . \"\$HOME/.adev-agent-env\"")
            agentEnv.appendLine("# Auto-loaded for non-interactive bash via BASH_ENV")
            // PREFIX, HOME, PATH, TMPDIR, XDG and TLS all come from the one
            // published contract instead of being restated here, where they
            // used to drift from RuntimeManager.getEnvironment().
            agentEnv.appendLine("[ -f \"$envContract\" ] && . \"$envContract\"")
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
            if (ripgrep.exists()) {
                agentEnv.appendLine("export MOBILEIDE_RG=\"${ripgrep.absolutePath}\"")
            }
            if (xdgOpen.exists()) {
                agentEnv.appendLine("export MOBILEIDE_XDG_OPEN=\"${xdgOpen.absolutePath}\"")
            }
            agentEnv.appendLine("export TERMINFO=\"${File(runtimeRoot, "share/terminfo").absolutePath}\"")
            agentEnv.appendLine("export TERMINFO_DIRS=\"${File(runtimeRoot, "share/terminfo").absolutePath}\"")
            agentEnv.appendLine("export HOST=0.0.0.0")
            // Display/bind hostname. 0.0.0.0 is not a valid URL host in Chrome;
            // Node listen is rewritten to dual-stack `::` so localhost still works.
            agentEnv.appendLine("export HOSTNAME=127.0.0.1")
            // Generic Android URL bridge — foreign CLIs (gh, Go $BROWSER
            // users, xdg-open lookups) open http(s) links through the app.
            agentEnv.appendLine("export BROWSER=adev-open-url")
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
            // Exactly one --require, naming the single preload entry module.
            // Next.js re-serialises NODE_OPTIONS for its dev/build workers and
            // joins repeated values for the same option with a space, so a
            // second --require becomes one unresolvable module path.
            agentEnv.appendLine("adev_node_options=\"\${NODE_OPTIONS:-}\"")
            agentEnv.appendLine("case \"\$adev_node_options\" in *adev-node-preload.js*) ;; *) [ -f \"\$PREFIX/lib/adev-node-preload.js\" ] && adev_node_options=\"--require \$PREFIX/lib/adev-node-preload.js \$adev_node_options\" ;; esac")
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
            val envLauncher = File(nativeLibDir, "libbin_adev_env.so")
            val python = findNativeTool("libbin_python", ".so")
            val make = findMakeCommand()
            val clang = findNativeTool("libbin_clang_", ".so")
            val llvmAr = findNativeTool("libbin_llvm_ar", ".so")
            val lld = findUnixLinkerCommand()
            val pkgConfig = findNativeTool("libbin_pkg_config", ".so")
            val curl = File(nativeLibDir, "libbin_curl.so")
            val nano = File(nativeLibDir, "libbin_nano.so")
            val ripgrep = File(nativeLibDir, "libbin_rg.so")
            val openCode = File(nativeLibDir, "libbin_opencode.so")
            val xdgOpen = File(nativeLibDir, "libbin_adev_xdg_open.so")
            // APK-native launchers that foreign processes must be able to exec
            // directly (GitHub CLI and other static binaries do fork/exec on
            // PATH entries without a shell).
            val gitLauncher = File(nativeLibDir, "libbin_adev_git_launcher.so")
            val secretCli = File(nativeLibDir, "libbin_adev_secret.so")
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
            val runtimeCli = File(libDir, "adev-runtime-cli.js")
            val nodeCliLauncher = File(libDir, "adev-node-cli.js")
            val glibcLoader = File(nativeLibDir, "libbin_adev_glibc_ld.so")
            val phase3Test = File(libDir, "adev-phase3-test.js")
            val environmentTest = File(libDir, "adev-runtime-env-test.js")
            val openCodeUpdater = File(libDir, "adev-opencode-update.js")

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

            if (node.exists() && openCodeUpdater.exists()) {
                writeScript(
                    "adev-opencode-update",
                    "#!/system/bin/sh\nexec \"${node.absolutePath}\" \"${openCodeUpdater.absolutePath}\" \"\$@\"\n"
                )
            }
            if (node.exists() && runtimeCli.exists()) {
                writeScript(
                    "adev",
                    "#!/system/bin/sh\nexec \"${node.absolutePath}\" \"${runtimeCli.absolutePath}\" \"\$@\"\n"
                )
            }
            if (node.exists() && nodeCliLauncher.exists()) {
                writeScript(
                    "dsh",
                    "#!/system/bin/sh\n" +
                        "exec \"${node.absolutePath}\" --expose-internals " +
                        "\"${nodeCliLauncher.absolutePath}\" dsh \"\$@\"\n"
                )
            }
            if (glibcLoader.isFile) {
                writeScript(
                    "glibc-run",
                    "#!/system/bin/sh\n" +
                        "[ -f \"\$PREFIX/glibc/manifest.json\" ] || { echo \"glibc runtime is not installed; run: adev runtime install glibc\" >&2; exit 69; }\n" +
                        "exec \"\$PREFIX/glibc/bin/glibc-run\" \"\$@\"\n"
                )
            }

            val workspaceGuard = File(binDir, ".adev-workspace-guard").absolutePath
            writeScript(
                ".adev-workspace-guard",
                """#!/system/bin/sh
adev_guard_is_shared() {
  physical="${'$'}(pwd -P 2>/dev/null || pwd)"
  case "${'$'}physical/" in
    /storage/*|/sdcard/*|/mnt/media_rw/*|/mnt/runtime/*) return 0 ;;
    *) return 1 ;;
  esac
}
adev_guard_is_diagnostic() {
  for argument in "${'$'}@"; do
    case "${'$'}argument" in --help|-h|--version|-v) return 0 ;; esac
  done
  return 1
}
adev_guard_first_command() {
  skip=0
  for argument in "${'$'}@"; do
    if [ "${'$'}skip" = 1 ]; then skip=0; continue; fi
    case "${'$'}argument" in
      --prefix|--workspace|--registry|--cache|--userconfig|--filter|--dir|--cwd|-c|-C|-w)
        skip=1 ;;
      --) ;;
      -*) ;;
      *) printf '%s' "${'$'}argument"; return 0 ;;
    esac
  done
}
adev_guard() {
  tool="${'$'}1"; shift
  adev_guard_is_shared || return 0
  adev_guard_is_diagnostic "${'$'}@" && return 0
  sub="${'$'}(adev_guard_first_command "${'$'}@")"
  case "${'$'}tool:${'$'}sub" in
    npm:|npm:help|npm:view|npm:info|npm:search|npm:list|npm:ls|npm:outdated|npm:doctor|npm:config) return 0 ;;
    pnpm:help|pnpm:why|pnpm:list|pnpm:ls|pnpm:info|pnpm:view|pnpm:outdated|pnpm:config) return 0 ;;
    yarn:help|yarn:why|yarn:list|yarn:ls|yarn:info|yarn:view|yarn:outdated|yarn:config) return 0 ;;
    git:|git:status|git:log|git:diff|git:show|git:rev-parse|git:describe|git:ls-files|git:ls-tree|git:grep|git:blame|git:shortlog) return 0 ;;
    generic:*) ;;
    npm:*|npx:*|pnpm:*|pnpx:*|yarn:*|corepack:*|next:*|vite:*|native:*|git:*) ;;
    *) return 0 ;;
  esac
  echo "This project is stored on Android shared storage. Some development tools require filesystem features that are unavailable here, including symbolic links. Import this project into the ADEV workspace to continue." >&2
  return 73
}
""".trimIndent() + "\n"
            )

            fun guarded(tool: String, command: String): String =
                "#!/system/bin/sh\n. \"$workspaceGuard\"\nadev_guard $tool \"\$@\" || exit \$?\n$command\n"

            if (node.exists()) {
                val n = node.absolutePath
                writeScript("node", "#!/system/bin/sh\nexec \"$n\" \"\$@\"\n")
                if (npmCli.exists()) {
                    writeScript(
                        "npm",
                        guarded("npm", "exec \"$n\" \"${npmCli.absolutePath}\" \"\$@\"")
                    )
                }
                if (npxCli.exists()) {
                    writeScript(
                        "npx",
                        guarded("npx", "exec \"$n\" \"${npxCli.absolutePath}\" \"\$@\"")
                    )
                }
                if (nodeGyp.exists()) {
                    writeScript(
                        "node-gyp",
                        guarded("native", "exec \"$n\" \"${nodeGyp.absolutePath}\" \"\$@\"")
                    )
                }
                if (corepackJs.exists() && packageManagerLauncher.exists()) {
                    val launcher = packageManagerLauncher.absolutePath
                    writeScript("corepack", guarded("corepack", "exec \"$n\" \"$launcher\" corepack \"\$@\""))
                    writeScript("yarn", guarded("yarn", "exec \"$n\" \"$launcher\" yarn \"\$@\""))
                    writeScript("yarnpkg", guarded("yarn", "exec \"$n\" \"$launcher\" yarn \"\$@\""))
                    writeScript("pnpm", guarded("pnpm", "exec \"$n\" \"$launcher\" pnpm \"\$@\""))
                    writeScript("pnpx", guarded("pnpx", "exec \"$n\" \"$launcher\" pnpm dlx \"\$@\""))
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
                        guarded("next", "exec \"$n\" \"${nextLauncher.absolutePath}\" \"\$@\"")
                    )
                    writeScript(
                        "adev-next",
                        guarded("next", "exec \"$n\" \"${nextLauncher.absolutePath}\" \"\$@\"")
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
                if (environmentTest.exists()) {
                    writeScript(
                        "adev-env-test",
                        "#!/system/bin/sh\nexec \"$n\" \"${environmentTest.absolutePath}\" \"\$@\"\n"
                    )
                }
            }
            if (git.exists()) {
                // Foreign executables — GitHub CLI, Go/Rust binaries, anything
                // that fork/execs a PATH entry without a shell — cannot run the
                // shell-script trampoline below: it lives on Android's noexec
                // app storage and fails EACCES before its shebang is read.
                // A symlink in the shim directory resolves to this exec-safe
                // APK-native launcher, which applies the same shared-storage
                // guard as interactive shells and then execs Git in place.
                if (gitLauncher.isFile) {
                    adevEnv.shimDir.mkdirs()
                    adevEnv.shimDir.setWritable(true, false)
                    try {
                        val link = File(adevEnv.shimDir, "git")
                        if (link.exists() || isSymlink(link)) link.delete()
                        Os.symlink(gitLauncher.absolutePath, link.absolutePath)
                    } catch (e: Exception) {
                        Log.w(TAG, "git launcher shim failed: ${e.message}")
                    }
                }
                writeScript("git", guarded("git", "exec \"${git.absolutePath}\" \"\$@\""))
            }
            if (bash.exists()) {
                writeScript("bash", "#!/system/bin/sh\nexec \"${bash.absolutePath}\" \"\$@\"\n")
            }
            // termux-exec translates #!/bin/sh to $PREFIX/bin/sh. Keep this
            // explicit bridge even though /system/bin is earlier on normal PATH.
            writeScript("sh", "#!/system/bin/sh\nexec /system/bin/sh \"\$@\"\n")
            writeScript(
                "clear",
                "#!/system/bin/sh\nprintf '\\033[H\\033[2J\\033[3J'\n"
            )

            // `env` must be ADEV's, not Toybox's, for every caller.
            //
            // /system/bin comes first on PATH so Android's own ls/cat/… keep
            // working, but /system/bin/env is Toybox: it execs its command
            // itself, never loads ADEV's exec compatibility layer, and therefore
            // cannot run a `#!` script stored on the app's noexec data
            // directory. `env node script.js` — the shebang of essentially every
            // global npm CLI — failed with EACCES whenever the caller was not
            // already an ADEV binary. Publishing ADEV's env as a real ELF in a
            // shim directory ahead of /system/bin fixes the resolution for
            // shells, Node, Python and any system tool alike.
            if (envLauncher.isFile) {
                adevEnv.shimDir.mkdirs()
                adevEnv.shimDir.setWritable(true, false)
                listOf(File(binDir, "env"), File(adevEnv.shimDir, "env")).forEach { link ->
                    try {
                        if (link.exists() || isSymlink(link)) link.delete()
                        Os.symlink(envLauncher.absolutePath, link.absolutePath)
                    } catch (e: Exception) {
                        Log.w(TAG, "env shim ${link.absolutePath} failed: ${e.message}")
                    }
                }
            }
            if (busyboxRuntime.exists() && busyboxDispatcher.exists()) {
                val bb = busyboxDispatcher.absolutePath
                writeScript("busybox", "#!/system/bin/sh\nexec \"$bb\" \"\$@\"\n")
                // termux-exec rewrites #!/usr/bin/env to $PREFIX/bin/env. That
                // path is claimed above by ADEV's native env, which must be a
                // real executable: native callers reject a script interpreter as
                // bad ELF, and BusyBox's internal env exec bypasses ADEV's
                // recursive shebang resolver. Only fall back to the applet when
                // the native launcher is missing from this build.
                if (!envLauncher.isFile) {
                    writeScript("env", "#!/system/bin/sh\nexec \"$bb\" env \"\$@\"\n")
                }
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
                // Pure-shell install — BusyBox install segfaults (see shell function
                // above). Provide /bin/install as a shell script using cp/chmod.
                writeScript(
                    "install",
                    "#!/system/bin/sh\n" +
                        "adev_install_mode=755\n" +
                        "adev_install_directory=0\n" +
                        "adev_install_target=\"\"\n" +
                        "while [ \"\$#\" -gt 0 ]; do\n" +
                        "  case \"\$1\" in\n" +
                        "    -m) adev_install_mode=\"\$2\"; shift 2 ;;\n" +
                        "    -m*) adev_install_mode=\"\${1#-m}\"; shift ;;\n" +
                        "    -D) adev_install_directory=1; shift ;;\n" +
                        "    -Dm) adev_install_directory=1; adev_install_mode=\"\$2\"; shift 2 ;;\n" +
                        "    -Dm*) adev_install_directory=1; adev_install_mode=\"\${1#-Dm}\"; shift ;;\n" +
                        "    -t) adev_install_target=\"\$2\"; shift 2 ;;\n" +
                        "    -t*) adev_install_target=\"\${1#-t}\"; shift ;;\n" +
                        "    --) shift; break ;;\n" +
                        "    -*) echo \"install: unknown option \$1\" >&2; exit 64 ;;\n" +
                        "    *) break ;;\n" +
                        "  esac\n" +
                        "done\n" +
                        "if [ -n \"\$adev_install_target\" ]; then\n" +
                        "  mkdir -p \"\$adev_install_target\" || exit \$?\n" +
                        "  for adev_install_src in \"\$@\"; do\n" +
                        "    cp -f \"\$adev_install_src\" \"\$adev_install_target/\" || exit \$?\n" +
                        "    chmod \"\$adev_install_mode\" \"\$adev_install_target/\$(basename \"\$adev_install_src\")\" || exit \$?\n" +
                        "  done\n" +
                        "  exit 0\n" +
                        "fi\n" +
                        "eval \"adev_install_dest=\\\${\$#}\"\n" +
                        "if [ \"\$adev_install_directory\" -eq 1 ]; then\n" +
                        "  mkdir -p \"\$(dirname \"\$adev_install_dest\")\" || exit \$?\n" +
                        "fi\n" +
                        "adev_install_count=\$#\n" +
                        "if [ \"\$adev_install_count\" -eq 2 ]; then\n" +
                        "  cp -f \"\$1\" \"\$adev_install_dest\" || exit \$?\n" +
                        "  if [ -d \"\$adev_install_dest\" ]; then\n" +
                        "    chmod \"\$adev_install_mode\" \"\$adev_install_dest/\$(basename \"\$1\")\" || exit \$?\n" +
                        "  else\n" +
                        "    chmod \"\$adev_install_mode\" \"\$adev_install_dest\" || exit \$?\n" +
                        "  fi\n" +
                        "  exit 0\n" +
                        "fi\n" +
                        "mkdir -p \"\$adev_install_dest\" || exit \$?\n" +
                        "for adev_install_src in \"\$@\"; do\n" +
                        "  [ \"\$adev_install_src\" = \"\$adev_install_dest\" ] && break\n" +
                        "  cp -f \"\$adev_install_src\" \"\$adev_install_dest/\" || exit \$?\n" +
                        "  chmod \"\$adev_install_mode\" \"\$adev_install_dest/\$(basename \"\$adev_install_src\")\" || exit \$?\n" +
                        "done\n"
                )
            }
            python?.let {
                val p = it.absolutePath
                writeScript("python", "#!/system/bin/sh\nexec \"$p\" \"\$@\"\n")
                writeScript("python3", "#!/system/bin/sh\nexec \"$p\" \"\$@\"\n")
            }
            make?.let {
                writeScript("make", guarded("native", "exec \"${it.absolutePath}\" \"\$@\""))
            }
            clang?.let {
                val common = clangDriverFlags(clangResourceDir)
                val c = it.absolutePath
                writeScript("clang", guarded("native", "exec \"$c\" $common \"\$@\""))
                writeScript("cc", guarded("native", "exec \"$c\" $common \"\$@\""))
                writeScript("gcc", guarded("native", "exec \"$c\" $common \"\$@\""))
                writeScript("clang++", guarded("native", "exec \"$c\" --driver-mode=g++ $common \"\$@\""))
                writeScript("c++", guarded("native", "exec \"$c\" --driver-mode=g++ $common \"\$@\""))
                writeScript("g++", guarded("native", "exec \"$c\" --driver-mode=g++ $common \"\$@\""))
            }
            llvmAr?.let {
                writeScript("ar", guarded("native", "exec \"${it.absolutePath}\" \"\$@\""))
            }
            lld?.let {
                writeScript("ld.lld", guarded("native", "exec \"${it.absolutePath}\" \"\$@\""))
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
            if (ripgrep.exists()) {
                // OpenCode calls which("rg") before considering its desktop
                // download cache. Replace the noexec filesDir symlink with a
                // termux-exec-compatible script that enters the APK-native PIE.
                writeScript("rg", "#!/system/bin/sh\nexec \"${ripgrep.absolutePath}\" \"\$@\"\n")
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
            if (xdgOpen.exists()) {
                writeScript(
                    "xdg-open",
                    "#!/system/bin/sh\nexec \"${xdgOpen.absolutePath}\" \"\$@\"\n"
                )
                // Generic Android URL bridge for any CLI tool:
                //   adev-open-url https://example.com
                writeScript(
                    "adev-open-url",
                    "#!/system/bin/sh\nexec \"${xdgOpen.absolutePath}\" \"\$@\"\n"
                )
                // Browser-opening libraries (Go's $BROWSER handling, xdg-open
                // lookups) fork/exec these names directly. Scripts on the
                // noexec data directory fail EACCES for them, so both names
                // also exist as exec-safe symlinks to the ELF in the shim
                // directory that leads PATH.
                adevEnv.shimDir.mkdirs()
                adevEnv.shimDir.setWritable(true, false)
                listOf("adev-open-url", "xdg-open").forEach { name ->
                    try {
                        val link = File(adevEnv.shimDir, name)
                        if (link.exists() || isSymlink(link)) link.delete()
                        Os.symlink(xdgOpen.absolutePath, link.absolutePath)
                    } catch (e: Exception) {
                        Log.w(TAG, "$name url-opener shim failed: ${e.message}")
                    }
                }
            }
            if (secretCli.isFile) {
                // Generic secure secret store for CLI tools:
                //   printf '%s' "$TOKEN" | adev-secret set gh:token
                //   adev-secret get gh:token
                writeScript(
                    "adev-secret",
                    "#!/system/bin/sh\nexec \"${secretCli.absolutePath}\" \"\$@\"\n"
                )
                adevEnv.shimDir.mkdirs()
                adevEnv.shimDir.setWritable(true, false)
                try {
                    val link = File(adevEnv.shimDir, "adev-secret")
                    if (link.exists() || isSymlink(link)) link.delete()
                    Os.symlink(secretCli.absolutePath, link.absolutePath)
                } catch (e: Exception) {
                    Log.w(TAG, "adev-secret shim failed: ${e.message}")
                }
            }

            // Core public commands must be real Android-executable entrypoints,
            // not scripts below filesDir. Both the stable $PREFIX/bin paths and
            // PATH-leading aliases enter the same native multicall launcher
            // used by ProcessManager and the interactive PTY.
            if (envLauncher.isFile) {
                adevEnv.shimDir.mkdirs()
                val nativeAliases = listOf(
                    "bash", "sh", "node", "npm", "npx", "node-gyp", "python", "python3",
                    "git", "opencode", "curl", "nano", "rg", "make", "xdg-open",
                    "busybox", "corepack", "yarn", "yarnpkg", "pnpm", "pnpx",
                    "next", "adev-next"
                )
                nativeAliases.forEach { name ->
                    listOf(File(binDir, name), File(adevEnv.shimDir, name)).forEach { link ->
                        try {
                            if (link.exists() || isSymlink(link)) link.delete()
                            Os.symlink(envLauncher.absolutePath, link.absolutePath)
                        } catch (e: Exception) {
                            Log.w(TAG, "native launcher alias ${link.absolutePath} failed: ${e.message}")
                        }
                    }
                }
            }

            // netstat/ss/lsof: Android 10+ hides /proc/net from apps (SELinux),
            // so busybox/toybox variants always die with EACCES. Render the
            // TaskRegistry snapshot of app-owned listening servers instead —
            // same command names, honest output, no permission errors.
            val portsCli = File(libDir, "adev-ports-cli.js")
            if (node.exists() && portsCli.isFile) {
                adevEnv.shimDir.mkdirs()
                listOf("netstat", "ss", "lsof").forEach { tool ->
                    val body = "#!/system/bin/sh\nexec \"${node.absolutePath}\" " +
                        "\"${portsCli.absolutePath}\" $tool \"\$@\"\n"
                    writeScript(tool, body)
                    // Also ahead of /system/bin: toybox ships broken variants
                    // there and runtime/bin comes AFTER /system/bin in PATH.
                    try {
                        val shim = File(adevEnv.shimDir, tool)
                        if (shim.exists()) shim.delete()
                        shim.writeText(body)
                        Os.chmod(shim.absolutePath, 0b111101101)
                    } catch (e: Exception) {
                        Log.w(TAG, "$tool shim failed: ${e.message}")
                    }
                }
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

    /**
     * Always expose LLVM's Unix/ELF personality. The relocated Termux payload
     * is named libbin_lld.so, so the generic multi-call driver cannot infer
     * `ld.lld` from argv[0] when Clang or a build system launches it directly.
     */
    private fun findUnixLinkerCommand(): File? {
        val launcher = File(nativeLibDir, "libbin_adev_ld_lld.so")
        val runtime = findNativeTool("libbin_lld", ".so")
        return launcher.takeIf { it.isFile && runtime != null }
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

    private fun nativeCxxIncludeDir(): File =
        File(runtimeRoot, "include/c++/v1")

    private fun clangDriverFlags(resourceDir: File? = findClangResourceDir()): String {
        val prefix = runtimeRoot.absolutePath
        val systemIncludes = nativeSysrootIncludeDirs()
            .joinToString(" ") { "-isystem ${it.absolutePath}" }
        val cxxIncludes = nativeCxxIncludeDir()
            .takeIf(File::isDirectory)
            ?.absolutePath
            ?.let { "-isystem $it" }
            .orEmpty()
        val resource = resourceDir?.absolutePath?.let { " -resource-dir $it" }.orEmpty()
        val linker = findUnixLinkerCommand()
            ?.absolutePath
            ?.let { " --ld-path=$it" }
            .orEmpty()
        return "--target=$NATIVE_BUILD_TRIPLE$NATIVE_BUILD_API " +
            "--sysroot=$prefix $cxxIncludes $systemIncludes -L$prefix/lib -B$prefix/lib" +
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
        val lld = findUnixLinkerCommand()
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
            if (nativeCxxIncludeDir().isDirectory) {
                out.appendLine("${exportPrefix}CPLUS_INCLUDE_PATH=\"${nativeCxxIncludeDir().absolutePath}\"")
            }
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
     * Keep packaged commands executable while preserving the standard writable
     * $PREFIX/bin contract used by CLI installers. Android's app sandbox and
     * owner-only 0700 directory mode provide the boundary; making bin read-only
     * prevents legitimate tools such as `install -m 755 ... "$PREFIX/bin"`.
     */
    private fun finalizeBinPermissions() {
        fun walk(file: File) {
            if (Files.isSymbolicLink(file.toPath())) return
            try {
                Os.chmod(
                    file.absolutePath,
                    if (file.isDirectory) 0b111000000 else 0b111101101
                ) // directories 0700, files 0755
            } catch (_: Exception) {
                file.setReadable(true, true)
                file.setWritable(true, true)
                file.setExecutable(true, true)
            }
            if (file.isDirectory) file.listFiles()?.forEach { walk(it) }
        }
        if (binDir.exists()) walk(binDir)
        Log.i(TAG, "Runtime bin directory ready for owner-managed CLI installs")
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
        ensureWorkspaceHomeLink()
    }

    /**
     * Keep projects discoverable from the normal shell home without merging
     * user projects with npm, Git, and shell configuration files. The runtime
     * documentation has always advertised ~/workspaces, so this link is part
     * of the public shell layout rather than a convenience alias.
     *
     * Never replace a real user-created directory. A stale app-owned symlink
     * is safe to repair after an APK/runtime-path change.
     */
    private fun ensureWorkspaceHomeLink() {
        val link = File(homeDir, "workspaces")
        try {
            if (Files.isSymbolicLink(link.toPath())) {
                val currentTarget = Files.readSymbolicLink(link.toPath()).toString()
                val resolvedTarget = if (File(currentTarget).isAbsolute) {
                    File(currentTarget)
                } else {
                    File(link.parentFile, currentTarget)
                }
                if (resolvedTarget.canonicalFile == workspacesDir.canonicalFile) return
                Files.delete(link.toPath())
            } else if (link.exists()) {
                Log.w(TAG, "Preserving existing non-symlink shell path: ${link.absolutePath}")
                return
            }

            Os.symlink(workspacesDir.absolutePath, link.absolutePath)
            Log.i(TAG, "Shell workspace link ready: ${link.absolutePath} -> ${workspacesDir.absolutePath}")
        } catch (e: Exception) {
            Log.w(TAG, "Could not create shell workspace link: ${e.message}")
        }
    }

    /**
     * Point the packaged sysroot at this installation instead of Termux.
     *
     * ADEV bundles headers, pkg-config metadata and build configuration produced
     * by the Termux toolchain, and those artifacts have
     * `/data/data/com.termux/files/usr` compiled into them: `paths.h` names it as
     * `_PATH_DEFPATH` and `_PATH_TMP`, every `.pc` file uses it as `prefix=`, and
     * node's `config.gypi` records it as the install root. That package is not
     * installed here and never will be, so a native addon build resolved include
     * and library paths that do not exist.
     *
     * The affected files are indexed at build time by
     * `scripts/generate-prefix-retarget.mjs`; only those are rewritten, because
     * reading the whole 8,500-file sysroot on device would cost seconds at every
     * install.
     */
    private fun retargetPackagedPrefixes() {
        val index = File(runtimeRoot, PREFIX_RETARGET_FILE)
        if (!index.isFile) {
            Log.w(TAG, "No packaged prefix index; sysroot paths left as shipped")
            return
        }
        try {
            val manifest = JSONObject(index.readText())
            val packagedPrefix = manifest.optString("packagedPrefix")
            if (packagedPrefix.isEmpty()) return
            val files = manifest.optJSONArray("files") ?: return
            var rewritten = 0
            for (position in 0 until files.length()) {
                val relative = files.optString(position)
                if (relative.isEmpty() || relative.contains("..")) continue
                val target = File(runtimeRoot, relative)
                if (!target.isFile) continue
                val original = try {
                    target.readText()
                } catch (_: Exception) {
                    continue
                }
                // Detect-and-repair only: both stale prefixes mark packaged
                // files needing retarget; neither is ever an install default.
                if (!original.contains(packagedPrefix) &&
                    !original.contains("/data/data/com.termux/files")
                ) continue
                var updated = original
                if (original.contains(packagedPrefix)) updated = updated.replace(packagedPrefix, runtimeRoot.absolutePath)
                if (original.contains("/data/data/com.termux/files")) {
                    updated = updated.replace("/data/data/com.termux/files", runtimeRoot.absolutePath)
                }
                target.writeText(updated)
                rewritten++
            }
            Log.i(TAG, "Retargeted $rewritten packaged sysroot files to ${runtimeRoot.absolutePath}")
        } catch (e: Exception) {
            Log.w(TAG, "Packaged prefix retargeting failed: ${e.message}")
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
                  HOST=0.0.0.0  BROWSER=adev-open-url
                (dev servers do not auto-open; CLIs that open links — gh, Go
                tools honoring BROWSER — launch the Android browser instead)

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
            // Android 14 moved the platform trust store into the Conscrypt APEX.
            // Read every layout that exists so the bundle is complete on both.
            val systemStores = AdevEnvironment.SYSTEM_CERT_DIRECTORIES
                .map(::File)
                .filter { it.isDirectory }
            var certificates = 0
            val temporary = File(caBundleFile.parentFile, "${caBundleFile.name}.tmp")
            temporary.bufferedWriter().use { writer ->
                val emit = { file: File ->
                    try {
                        // Android's trust anchors are PEM followed by an OpenSSL
                        // text dump. Copying the file verbatim leaves that prose
                        // in the bundle; some TLS stacks stop at the first block
                        // they cannot parse, which is indistinguishable from an
                        // empty trust store. Emit certificate blocks only.
                        extractPemCertificates(file.readText()).forEach { pem ->
                            writer.write(pem)
                            writer.write("\n")
                            certificates++
                        }
                    } catch (_: Exception) {
                        // A single unreadable anchor must not void the bundle.
                    }
                }
                systemStores.forEach { store ->
                    store.listFiles()?.sortedBy { it.name }?.forEach { if (it.isFile) emit(it) }
                }
                customCaDir.listFiles()
                    ?.filter { it.isFile && it.extension == "pem" }
                    ?.sortedBy { it.name }
                    ?.forEach(emit)
            }
            if (certificates == 0) {
                temporary.delete()
                Log.w(
                    TAG,
                    "No trust anchors found in ${systemStores.joinToString()}; " +
                        "leaving the existing CA bundle in place"
                )
                return
            }
            Os.rename(temporary.absolutePath, caBundleFile.absolutePath)
            caBundleFile.setReadable(true, false)
            Log.i(TAG, "Assembled CA bundle: $certificates certificates, ${caBundleFile.length()} bytes")
        } catch (e: Exception) {
            Log.w(TAG, "CA bundle assembly failed: ${e.message}")
        }
    }

    /**
     * Return each PEM certificate block in [text], without any surrounding
     * human-readable metadata. Anything outside a BEGIN/END pair is discarded.
     */
    private fun extractPemCertificates(text: String): List<String> {
        val begin = "-----BEGIN CERTIFICATE-----"
        val end = "-----END CERTIFICATE-----"
        val blocks = mutableListOf<String>()
        var cursor = text.indexOf(begin)
        while (cursor >= 0) {
            val close = text.indexOf(end, cursor)
            if (close < 0) break
            blocks += text.substring(cursor, close + end.length).trim()
            cursor = text.indexOf(begin, close + end.length)
        }
        return blocks
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
                allowedHosts: true,
                watch: { usePolling: true, interval: 1000 }
              },
              preview: { host: '0.0.0.0', port: 4173, allowedHosts: true }
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
            case "${'$'}cmd" in
                next|vite|webpack|rollup|esbuild|turbo|nx|tsc|eslint|node-gyp|node-gyp-build|cmake|ninja|cargo|rustc)
                    adev-require-private-workspace || return ${'$'}? ;;
            esac
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
        val openCodeLauncher = File(nativeLibDir, "libbin_opencode.so")
        val openCodePayload = File(nativeLibDir, "libbin_opencode_runtime.so")
        val openCodeCompat = File(nativeLibDir, "liblib_adev_opencode_compat.so")
        val openCodeTagfix = File(nativeLibDir, "liblib_opencode_tagfix.so")
        val openCodeOpenTui = File(nativeLibDir, "liblib_opencode_opentui.so")
        val openCodeRuntimeReady = listOf(
            openCodeLauncher,
            openCodePayload,
            openCodeCompat,
            openCodeTagfix,
            openCodeOpenTui,
            File(nativeLibDir, "libbin_rg.so")
        ).all { it.isFile }
        val commandReadiness = linkedMapOf(
            "node" to File(nativeLibDir, "libbin_node.so").isFile,
            "env" to File(nativeLibDir, "libbin_adev_env.so").isFile,
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
            "lld" to (findUnixLinkerCommand() != null),
            "git" to File(nativeLibDir, "libbin_git.so").isFile,
            "curl" to File(nativeLibDir, "libbin_curl.so").isFile,
            "bash" to File(nativeLibDir, "libbin_bash.so").isFile,
            "nano" to File(nativeLibDir, "libbin_nano.so").isFile,
            "rg" to File(nativeLibDir, "libbin_rg.so").isFile,
            "xdg-open" to File(nativeLibDir, "libbin_adev_xdg_open.so").isFile,
            "adev-open-url" to File(nativeLibDir, "libbin_adev_xdg_open.so").isFile,
            "foreign-git-exec" to File(nativeLibDir, "libbin_adev_git_launcher.so").isFile,
            "secret-cli" to File(nativeLibDir, "libbin_adev_secret.so").isFile,
            "busybox" to (
                File(nativeLibDir, "libbin_busybox.so").isFile &&
                    File(nativeLibDir, "libbin_adev_busybox.so").isFile
                ),
            // OpenCode is ready only when the launcher, pinned payload, upstream
            // libraries, and ADEV's process-scoped /tmp remap are all packaged.
            "opencode" to openCodeRuntimeReady,
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
            "adev-toolpack" to File(libDir, "adev-toolpack.js").isFile,
            "adev" to File(libDir, "adev-runtime-cli.js").isFile,
            "glibc-run" to (
                File(libDir, "adev-runtime-cli.js").isFile &&
                    File(nativeLibDir, "libbin_adev_glibc_loader.so").isFile &&
                    File(nativeLibDir, "libbin_adev_glibc_ld.so").isFile
                )
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
        val recursiveShebangResolver =
            File(nativeLibDir, "liblib_adev_exec_compat.so").isFile
        commandReadiness["recursive-shebang"] = recursiveShebangResolver && termuxExec

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
                "glibc-optional" to (
                    File(libDir, "adev-runtime-cli.js").isFile &&
                        File(nativeLibDir, "libbin_adev_glibc_loader.so").isFile &&
                        File(nativeLibDir, "libbin_adev_glibc_ld.so").isFile
                    ),
                "glibc-installed" to File(runtimeRoot, "glibc/manifest.json").isFile,
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
                "opencode-launcher" to openCodeLauncher.isFile,
                "opencode-temp-remap" to openCodeCompat.isFile,
                "opencode-runtime-ready" to openCodeRuntimeReady,
                "opencode-device-certified" to false,
                "opencode-native-diagnostics" to openCodeRuntimeReady,
                "opencode-payload-arm64" to openCodePayload.isFile,
                // Retain the legacy key for consumers of the v5 capability
                // surface while making its ARM64 payload condition explicit.
                "opencode-diagnostics-arm64" to (
                    openCodeRuntimeReady
                    ),
                // These booleans describe the installed execution path. Device
                // certification remains a separate, deliberately false gate
                // until version/help/run/serve/web/TUI pass on a connected phone.
                "opencode-interactive" to openCodeRuntimeReady,
                "opencode-agent-run" to openCodeRuntimeReady,
                "opencode-server" to openCodeRuntimeReady
            ),
            nativeBuildReady = nativeBuildReady,
            npmLifecycleReady = npmShell.isFile,
            termuxExecReady = termuxExec && recursiveShebangResolver,
            privateWorkspaceExecution = true,
            sharedWorkspaceExecution = false,
            globalPlatformSpoof = false
        )
    }

    /**
     * Get the environment map for process execution
     */
    fun getEnvironment(workingDirectory: String? = null): Map<String, String> {
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

        // HOME, PATH, PREFIX, TMPDIR/TMP/TEMP, the XDG base directories,
        // LD_LIBRARY_PATH, NODE_PATH, the TLS trust store and the single Node
        // preload all come from AdevEnvironment so that shells, native
        // launchers and this map can never disagree. Everything below is
        // tool-specific configuration layered on top of that contract.
        val env = mutableMapOf<String, String>()
        env.putAll(adevEnv.contract())
        env.putAll(mapOf(
            // OpenCode reports the workspace root as its picker home while
            // retaining this path for XDG/Git/npm/credential state.
            "ADEV_CONFIG_HOME" to homeDir.absolutePath,
            // Android has no writable FHS /tmp. Keep every native/JS spelling
            // on the same app-private directory before any child process starts.
            "BUN_TMPDIR" to tmpDir.absolutePath,
            "SQLITE_TMPDIR" to tmpDir.absolutePath,
            // nativeForkPty intentionally clears the inherited zygote
            // environment. Restore Android identity variables explicitly so
            // Android-aware CLIs do not mis-detect this process as desktop Linux.
            "ANDROID_ROOT" to "/system",
            "ANDROID_DATA" to "/data",
            "TERMUX_VERSION" to "ADevStudio",
            "NPM_CONFIG_PREFIX" to npmGlobalDir.absolutePath,
            "NPM_CONFIG_CACHE" to cacheDir.absolutePath,
            "NPM_CONFIG_USERCONFIG" to File(homeDir, ".npmrc").absolutePath,
            // Avoid interactive update noise and optional fund prompts on mobile.
            "NPM_CONFIG_UPDATE_NOTIFIER" to "false",
            "NPM_CONFIG_FUND" to "false",
            "NPM_CONFIG_AUDIT" to "false",
            "USER" to "root",
            "LOGNAME" to "root",
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
            "GIT_CONFIG_GLOBAL" to File(homeDir, ".gitconfig").absolutePath,
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
            // Used by adev-npm-shell / agents to locate ELFs if PATH lookup fails.
            "MOBILEIDE_NODE" to File(nativeLibDir, "libbin_node.so").absolutePath,
            "MOBILEIDE_GIT" to File(nativeLibDir, "libbin_git.so").absolutePath,
            "MOBILEIDE_BASH" to File(nativeLibDir, "libbin_bash.so").absolutePath,
            "MOBILEIDE_MAKE" to File(nativeLibDir, "libbin_adev_make.so").absolutePath,
            "MOBILEIDE_BUSYBOX" to
                File(nativeLibDir, "libbin_adev_busybox.so").absolutePath,
            "MOBILEIDE_ENV" to File(nativeLibDir, "libbin_adev_env.so").absolutePath,
            "MOBILEIDE_BUSYBOX_RUNTIME" to
                File(nativeLibDir, "libbin_busybox.so").absolutePath,
            "MOBILEIDE_CURL" to File(nativeLibDir, "libbin_curl.so").absolutePath,
            "MOBILEIDE_NANO" to File(nativeLibDir, "libbin_nano.so").absolutePath,
            "MOBILEIDE_RG" to File(nativeLibDir, "libbin_rg.so").absolutePath,
            "ADEV_OPENCODE_RG" to File(nativeLibDir, "libbin_rg.so").absolutePath,
            "MOBILEIDE_OPENCODE" to File(nativeLibDir, "libbin_opencode.so").absolutePath,
            "MOBILEIDE_XDG_OPEN" to
                File(nativeLibDir, "libbin_adev_xdg_open.so").absolutePath,
            "ADEV_OPENCODE_XDG_OPEN" to
                File(nativeLibDir, "libbin_adev_xdg_open.so").absolutePath,
            "ADEV_GIT_LAUNCHER" to File(nativeLibDir, "libbin_adev_git_launcher.so").absolutePath,
            "ADEV_SECRET_CLI" to File(nativeLibDir, "libbin_adev_secret.so").absolutePath,
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
            // HOST asks frameworks to bind the wildcard. adev-listen-compat
            // then upgrades 0.0.0.0/localhost to dual-stack `::` so Chrome's
            // IPv6 localhost (::1) and 127.0.0.1 both reach the server.
            "HOST" to "0.0.0.0",
            // Next.js reads HOSTNAME for bind *and* printed URLs. 0.0.0.0 is
            // not a valid URL in Android Chrome.
            "HOSTNAME" to "127.0.0.1",
            // Generic Android URL bridge: ACTION_VIEW through the app's
            // authenticated broker. Foreign CLIs discover it the standard way
            // — $BROWSER for GitHub CLI / Go programs, xdg-open for the rest.
            "BROWSER" to "adev-open-url",
            // npm progress is NOT forced off: on a real PTY (terminal) the
            // spinner/reify bar animates; npm disables progress on non-TTY
            // streams itself, so piped/agent runs stay quiet automatically.
            "NPM_CONFIG_LOGLEVEL" to "warn",
            "npm_config_loglevel" to "warn",
            // Vite / webpack friendliness
            "VITE_CJS_IGNORE_WARNING" to "true"
        ))

        // Native Git obtains protected credentials through a loopback broker.
        // The session capability is inherited by app-launched children but no
        // stored token/private key is placed in a command line or React state.
        env.putAll(GitCredentialBroker.get(context).environment())
        env.putAll(ExternalUrlBroker.get(context).environment())
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
            if (nativeCxxIncludeDir().isDirectory) {
                env["CPLUS_INCLUDE_PATH"] = nativeCxxIncludeDir().absolutePath
            }
        }
        findNativeTool("libbin_llvm_ar", ".so")?.let { env["AR"] = it.absolutePath }
        findUnixLinkerCommand()?.let { env["LD"] = it.absolutePath }
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

        // NODE_OPTIONS is owned by AdevEnvironment and always carries exactly one
        // --require (lib/adev-node-preload.js), which loads the capability
        // policy, the server-event reporter and the Next.js SWC bridge itself.
        // Next.js re-serialises NODE_OPTIONS for its dev/build workers and joins
        // repeated option values with a space, so a second --require would turn
        // into one unresolvable module path and kill every worker.

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
        val termuxExecPreload = preloadCandidates.firstOrNull { it.exists() }
        val recursiveShebangPreload =
            File(nativeLibDir, "liblib_adev_exec_compat.so").takeIf { it.isFile }
        if (termuxExecPreload != null) {
            // ADEV's resolver must be first: it follows interpreter chains
            // such as npm-cli -> /usr/bin/env -> shell wrapper -> Node ELF.
            // termux-exec then applies Android noexec/system-linker handling.
            env["LD_PRELOAD"] = listOfNotNull(
                recursiveShebangPreload?.absolutePath,
                termuxExecPreload.absolutePath
            ).joinToString(":")
            env["TERMUX_EXEC__EXECVE_CALL__INTERCEPT"] = "enable"
            env["TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE"] = "enable"
        }

        // TLS trust is part of the environment contract (SSL_CERT_FILE,
        // REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE, NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO,
        // PIP_CERT and SSL_CERT_DIR). Verification is never disabled here or
        // anywhere else in the runtime.
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
