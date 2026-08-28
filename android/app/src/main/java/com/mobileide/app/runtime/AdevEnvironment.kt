package com.mobileide.app.runtime

import android.system.Os
import android.util.Log
import java.io.File

/**
 * The single authority for A Dev Studio's runtime environment contract.
 *
 * Every ADEV process — interactive shells, PTY sessions, Node, npm/npx, Python,
 * Git, Next.js, OpenCode, build workers and any subprocess they spawn — must see
 * the same values for the variables produced here. Before this class existed the
 * same assignments were re-derived in [RuntimeManager], in the generated shell
 * bootstrap files and again in the native launchers, so a process could inherit
 * a HOME from one source, an XDG cache directory from another and no TLS trust
 * store at all.
 *
 * Everything is derived from the *installed* runtime root and the application's
 * `nativeLibraryDir`, both resolved at runtime. No `/data/app/…` install
 * identifier is ever baked in permanently: those change on every reinstall, and
 * the generated bindings are rewritten when they do.
 *
 * The contract is published three ways so that a process which lost its
 * environment can still recover it:
 *
 *  1. [contract] — used directly by every process the app spawns.
 *  2. `etc/adev-env.sh` — sourced by the shell bootstrap files.
 *  3. `etc/adev-env.conf` — a flat `KEY=VALUE` file read by the native
 *     compatibility layer, which fills in only the variables a process lacks.
 */
class AdevEnvironment(
    private val runtimeRoot: File,
    private val nativeLibDir: File
) {
    val binDir: File = File(runtimeRoot, "bin")
    val libDir: File = File(runtimeRoot, "lib")
    val homeDir: File = File(runtimeRoot, "home")
    val workspacesDir: File = File(runtimeRoot, "workspaces")
    val tmpDir: File = File(runtimeRoot, "tmp")
    val cacheDir: File = File(runtimeRoot, "cache")
    val etcDir: File = File(runtimeRoot, "etc")
    val glibcDir: File = File(runtimeRoot, "glibc")

    /**
     * Commands ADEV must own even though `/system/bin` deliberately comes first
     * on PATH. Android's Toybox `env` cannot exec a `#!` script that lives on the
     * app's noexec data directory, and it never loads ADEV's exec compatibility
     * layer, so `env node …` failed with EACCES for every caller that was not
     * itself an ADEV binary. Entries here are symlinks to real ELF executables in
     * `nativeLibraryDir`, which any process can exec.
     */
    val shimDir: File = File(binDir, "adev-shims")

    val npmGlobalDir: File = File(homeDir, ".npm-global")
    val localBinDir: File = File(homeDir, ".local/bin")

    /** XDG base directories. Android supplies none of these. */
    val configHome: File = File(homeDir, ".config")
    val dataHome: File = File(homeDir, ".local/share")
    val stateHome: File = File(homeDir, ".local/state")

    /**
     * Next.js probes `os.homedir()/.cache` and `os.tmpdir()` on unrecognised
     * platforms and calls `process.exit(0)` when neither exists, which surfaces
     * as `Unsupported platform: android`. Keeping this directory present is part
     * of the contract, not an optimisation.
     */
    val homeCacheDir: File = File(homeDir, ".cache")

    val caBundleFile: File = File(etcDir, "ssl/certs/ca-bundle.crt")
    val nodePreload: File = File(libDir, "adev-node-preload.js")

    /**
     * A shell any process can exec directly. `bin/bash` is only a trampoline on
     * the noexec data directory, so it is never a valid answer for callers such
     * as Python's `posix_spawn` that exec the value without a shell of their own.
     */
    private val executableShell: String
        get() = File(nativeLibDir, "libbin_bash.so")
            .takeIf { it.isFile }
            ?.absolutePath
            ?: SYSTEM_SHELL

    private fun findPythonExecutable(): File? =
        nativeLibDir.listFiles()
            ?.filter { it.isFile && it.name.startsWith("libbin_python") && it.name.endsWith(".so") }
            ?.sortedBy { it.name }
            ?.firstOrNull()

    private fun findPythonLibDir(): File? =
        libDir.listFiles()
            ?.filter { it.isDirectory && it.name.matches(Regex("""python\d+\.\d+""")) }
            ?.sortedByDescending { it.name }
            ?.firstOrNull()

    private fun findTermuxExecPreload(): File? = listOf(
        File(nativeLibDir, "liblib_libtermux_exec_linker_ld_preload_so.so"),
        File(nativeLibDir, "liblib_libtermux_exec_direct_ld_preload_so.so"),
        File(libDir, "libtermux-exec-linker-ld-preload.so"),
        File(libDir, "libtermux-exec-direct-ld-preload.so")
    ).firstOrNull { it.isFile }

    private fun inferPackageName(): String? {
        val path = runtimeRoot.absolutePath
        // /data/user/0/<pkg>/files/runtime or /data/data/<pkg>/files/runtime
        val regex = Regex("""/(?:user/0|data)/([^/]+)/files/runtime""")
        return regex.find(path)?.groupValues?.getOrNull(1)?.takeIf { it.contains('.') }
    }

    private fun selinuxContext(): String? = try {
        val raw = File("/proc/self/attr/current").readBytes()
        val end = raw.indexOf(0).let { if (it >= 0) it else raw.size }
        String(raw, 0, end, Charsets.US_ASCII).trim().takeIf { v ->
            v.isNotEmpty() && v.all { ch -> ch.isLetterOrDigit() || ch in "_:,.-" }
        }
    } catch (_: Exception) { null }

    /** Directories the contract promises exist and are writable. */
    fun ensureDirectories() {
        listOf(
            runtimeRoot, binDir, libDir, homeDir, workspacesDir, tmpDir, cacheDir,
            etcDir, shimDir, configHome, dataHome, stateHome, homeCacheDir,
            npmGlobalDir, File(npmGlobalDir, "bin"), File(npmGlobalDir, "lib/node_modules"),
            localBinDir, caBundleFile.parentFile ?: etcDir
        ).forEach { directory ->
            if (!directory.exists() && !directory.mkdirs() && !directory.isDirectory) {
                Log.w(TAG, "Could not create runtime directory: ${directory.absolutePath}")
            }
            try {
                // Private runtime directories must remain writable/traversable by
                // the app UID. Java's setWritable(true, false) changes only the
                // write bits and previously produced modes such as 0722/0500.
                Os.chmod(directory.absolutePath, 0b111000000) // 0700
            } catch (_: Exception) {
                directory.setReadable(false, false)
                directory.setWritable(false, false)
                directory.setExecutable(false, false)
                directory.setReadable(true, true)
                directory.setWritable(true, true)
                directory.setExecutable(true, true)
            }
        }
    }

    /**
     * PATH order, most significant first:
     *  1. ADEV shims — the few commands whose Android system version breaks the
     *     runtime contract.
     *  2. `/system/bin` — Toybox `ls`/`cat`/… are correct and must not be
     *     shadowed by runtime symlinks.
     *  3. `nativeLibraryDir` — the only app-owned directory Android permits
     *     exec from.
     *  4. runtime `bin` and the Git helper directory.
     *  5. user-installed global and local CLIs.
     */
    fun path(): String = listOf(
        shimDir.absolutePath,
        "/system/bin",
        nativeLibDir.absolutePath,
        binDir.absolutePath,
        File(binDir, "git-core").absolutePath,
        File(npmGlobalDir, "bin").absolutePath,
        localBinDir.absolutePath
    ).joinToString(":")

    /**
     * The authoritative variables. Callers layer tool-specific values on top but
     * must not restate anything defined here.
     */
    fun contract(): LinkedHashMap<String, String> {
        val runtime = runtimeRoot.absolutePath
        val tmp = tmpDir.absolutePath
        val values = linkedMapOf(
            "ADEV_RUNTIME" to runtime,
            // PREFIX is how every bundled tool built for a Unix prefix (npm, Git,
            // Python, the Next launcher) locates the rest of ADEV.
            "PREFIX" to runtime,
            "HOME" to homeDir.absolutePath,
            "PATH" to path(),
            "TMPDIR" to tmp,
            "TMP" to tmp,
            "TEMP" to tmp,
            "XDG_CACHE_HOME" to cacheDir.absolutePath,
            "XDG_CONFIG_HOME" to configHome.absolutePath,
            "XDG_DATA_HOME" to dataHome.absolutePath,
            "XDG_STATE_HOME" to stateHome.absolutePath,
            "XDG_RUNTIME_DIR" to tmp,
            "LD_LIBRARY_PATH" to "${libDir.absolutePath}:${nativeLibDir.absolutePath}",
            "NODE_PATH" to listOf(
                "${libDir.absolutePath}/node_modules",
                "${npmGlobalDir.absolutePath}/lib/node_modules"
            ).joinToString(":"),
            "SHELL" to executableShell,
            // Android has no /bin/sh. Python's shell=True, GNU make and the exec
            // compatibility layer resolve their shell through this value instead
            // of a stale Termux package path.
            "ADEV_PYTHON_SHELL" to executableShell,
            "MOBILEIDE_ROOT" to runtime,
            "MOBILEIDE_NATIVE_LIB" to nativeLibDir.absolutePath,
            "MOBILEIDE_WORKSPACES" to workspacesDir.absolutePath
        )

        // The optional Linux/glibc runtime is deliberately not added to PATH or
        // LD_LIBRARY_PATH. Modern Android forbids executing downloaded ELF files
        // from filesDir, so the APK carries only this genuine glibc loader anchor
        // in nativeLibraryDir. `adev runtime install glibc` verifies that exact
        // loader hash and links the separately downloaded pack to it.
        File(nativeLibDir, "libbin_adev_glibc_ld.so")
            .takeIf { it.isFile }
            ?.let { loader ->
                values["MOBILEIDE_GLIBC_LOADER"] = loader.absolutePath
                values["ADEV_GLIBC_ROOT"] = glibcDir.absolutePath
                File(nativeLibDir, "libbin_adev_glibc_loader.so")
                    .takeIf { it.isFile }
                    ?.let { launcher ->
                        values["MOBILEIDE_GLIBC_LAUNCHER"] = launcher.absolutePath
                    }
            }

        // TLS. The bundled Python and OpenSSL were built for a Termux prefix and
        // their compiled-in default store (`…/com.termux/files/usr/etc/tls`) does
        // not exist here, so an unset SSL_CERT_FILE means every verified HTTPS
        // request fails. The bundle is assembled from the device trust store; it
        // is never bypassed by disabling verification.
        if (caBundleFile.isFile && caBundleFile.length() > 0) {
            val bundle = caBundleFile.absolutePath
            values["SSL_CERT_FILE"] = bundle
            values["REQUESTS_CA_BUNDLE"] = bundle
            values["CURL_CA_BUNDLE"] = bundle
            values["NODE_EXTRA_CA_CERTS"] = bundle
            values["GIT_SSL_CAINFO"] = bundle
            values["PIP_CERT"] = bundle
        }
        systemCertDirectory()?.let { store ->
            values["SSL_CERT_DIR"] = store
            values["GIT_SSL_CAPATH"] = store
        }

        // Exactly one --require. Next.js parses NODE_OPTIONS, joins repeated
        // option values with a space and re-serialises them before spawning its
        // dev/build workers, so a second --require becomes one unresolvable
        // module path and every worker exits immediately.
        if (nodePreload.isFile) {
            values["NODE_OPTIONS"] = "--require ${nodePreload.absolutePath}"
        }

        // LD_PRELOAD chain for recursive shebang + noexec handling. Every process
        // must inherit the same chain, otherwise a child spawned by OpenCode/Bun
        // would see a shell-script interpreter on noexec storage as EACCES.
        val termuxExecPreload = findTermuxExecPreload()
        val execCompat = File(nativeLibDir, "liblib_adev_exec_compat.so").takeIf { it.isFile }
        if (termuxExecPreload != null) {
            val preload = listOfNotNull(execCompat?.absolutePath, termuxExecPreload.absolutePath).joinToString(":")
            values["LD_PRELOAD"] = preload
            values["TERMUX_EXEC__EXECVE_CALL__INTERCEPT"] = "enable"
            values["TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE"] = "enable"
        } else if (execCompat != null) {
            values["LD_PRELOAD"] = execCompat.absolutePath
        }

        // Python toolchain. The shim bin/python re-exec's the native ELF, but the
        // interpreter still needs its homes to locate the stdlib via PREFIX.
        findPythonExecutable()?.let { py ->
            values["PYTHON"] = py.absolutePath
            values["NODE_GYP_FORCE_PYTHON"] = py.absolutePath
            values["npm_package_config_node_gyp_python"] = py.absolutePath
            values["PYTHONHOME"] = runtime
            findPythonLibDir()?.let { lib -> values["PYTHONPATH"] = lib.absolutePath }
        }
        // Minimal TERMUX contract so termux-exec knows this is ADEV, not Termux.
        // These are the same values RuntimeManager layers on top; putting them in the
        // authoritative contract means a child that only recovered via adev-env.conf
        // (e.g. an OpenCode tool) still resolves correctly.
        inferPackageName()?.let { pkg ->
            values["TERMUX_APP__PACKAGE_NAME"] = pkg
            val userData = "/data/user/0/$pkg"
            val legacyData = "/data/data/$pkg"
            // Prefer the dataDir that actually exists for this install.
            val dataDir = when {
                File(userData).isDirectory -> userData
                File(legacyData).isDirectory -> legacyData
                else -> userData
            }
            values["TERMUX_APP__DATA_DIR"] = dataDir
            values["TERMUX_APP__LEGACY_DATA_DIR"] = legacyData
        }
        values["TERMUX__ROOTFS"] = runtime
        values["TERMUX__ROOTFS_DIR"] = runtime
        values["TERMUX__HOME"] = homeDir.absolutePath
        values["TERMUX__PREFIX"] = runtime
        values["TERMUX__PREFIX__TMP_DIR"] = tmp
        try {
            values["ANDROID__BUILD_VERSION_SDK"] = android.os.Build.VERSION.SDK_INT.toString()
        } catch (_: Exception) { }
        selinuxContext()?.let { values["TERMUX__SE_PROCESS_CONTEXT"] = it }

        return values
    }

    /** Publishes the contract for shells and for the native recovery layer. */
    fun writeContractFiles() {
        val values = contract()
        try {
            etcDir.mkdirs()
            File(etcDir, CONF_NAME).writeText(
                buildString {
                    appendLine("# Generated by AdevEnvironment - do not edit by hand.")
                    appendLine("# Flat KEY=VALUE runtime contract. Values never contain newlines.")
                    values.forEach { (key, value) -> appendLine("$key=$value") }
                }
            )
            File(etcDir, SHELL_NAME).writeText(shellContract(values))
        } catch (e: Exception) {
            Log.w(TAG, "Could not publish the runtime environment contract: ${e.message}")
        }
    }

    /**
     * A POSIX bootstrap that is safe to source repeatedly, at any point in a
     * session, in any shell.
     *
     * It supplies a valid default for anything unset and repairs values that
     * point at a Termux installation this app does not have, but it never
     * discards a working value a caller deliberately set. PATH is treated as a
     * set of required entries rather than a single string so that sourcing this
     * file inside `npm run` cannot drop the `node_modules/.bin` directory npm
     * just prepended.
     */
    private fun shellContract(values: Map<String, String>): String = buildString {
        appendLine("# Generated by AdevEnvironment - do not edit by hand.")
        appendLine("# The A Dev Studio runtime environment contract.")
        appendLine("# Safe to source more than once; existing valid values are kept.")
        appendLine()
        appendLine("adev_env_default() {")
        appendLine("  adev_env_name=\"\$1\"")
        appendLine("  eval \"adev_env_current=\\\${\$adev_env_name-}\"")
        appendLine("  case \"\$adev_env_current\" in")
        appendLine("    '') ;;")
        // Anything still addressed to the Termux packages is stale here: this is
        // A Dev Studio, com.termux is not installed, and those paths never exist.
        appendLine("    */com.termux/*) ;;")
        appendLine("    *) return 0 ;;")
        appendLine("  esac")
        appendLine("  eval \"\$adev_env_name=\\\$2\"")
        appendLine("  export \"\$adev_env_name\"")
        appendLine("}")
        appendLine()
        appendLine("adev_path_prepend() {")
        appendLine("  case \":\${PATH-}:\" in")
        appendLine("    *\":\$1:\"*) ;;")
        appendLine("    *) PATH=\"\$1\${PATH:+:\$PATH}\" ;;")
        appendLine("  esac")
        appendLine("}")
        appendLine()
        values.forEach { (key, value) ->
            if (key == "PATH") return@forEach
            appendLine("adev_env_default $key ${shellQuote(value)}")
        }
        appendLine()
        appendLine("# Reverse order: the first contract entry ends up first on PATH.")
        values["PATH"]?.split(":")?.reversed()?.forEach { entry ->
            appendLine("adev_path_prepend ${shellQuote(entry)}")
        }
        appendLine("export PATH")
        appendLine("unset adev_env_name adev_env_current")
    }

    companion object {
        private const val TAG = "AdevEnvironment"
        const val CONF_NAME = "adev-env.conf"
        const val SHELL_NAME = "adev-env.sh"
        const val SYSTEM_SHELL = "/system/bin/sh"

        /**
         * Android 14 moved the trust store into the Conscrypt APEX. Both layouts
         * hold plain PEM files; whichever exists is a valid `SSL_CERT_DIR`.
         */
        val SYSTEM_CERT_DIRECTORIES = listOf(
            "/apex/com.android.conscrypt/cacerts",
            "/system/etc/security/cacerts"
        )

        fun systemCertDirectory(): String? =
            SYSTEM_CERT_DIRECTORIES.firstOrNull { File(it).isDirectory }

        /** Single-quote for POSIX shells, escaping embedded single quotes. */
        fun shellQuote(value: String): String {
            val quote = "'"
            val escaped = value.replace(quote, quote + "\\" + quote + quote)
            return quote + escaped + quote
        }
    }
}
