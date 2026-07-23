package com.mobileide.app.runtime

import android.content.Context
import android.content.res.AssetManager
import android.system.Os
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * RuntimeManager handles extraction and management of the bundled developer runtime.
 * The runtime includes Node.js, Bash, Git, and core utilities for ARM64 Android.
 * 
 * Runtime root structure:
 * {filesDir}/runtime/
 * ├── bin/          (read-only executables)
 * ├── lib/          (shared libraries)
 * ├── home/         (user home directory)
 * ├── workspaces/   (all projects)
 * ├── tmp/          (temporary files)
 * ├── cache/        (npm cache, etc.)
 * └── etc/          (minimal config)
 */
class RuntimeManager(private val context: Context) {

    companion object {
        private const val TAG = "RuntimeManager"
        private const val RUNTIME_DIR = "runtime"
        private const val RUNTIME_VERSION_FILE = ".runtime_version"
        private const val CURRENT_RUNTIME_VERSION = "1.0.0"
        
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

    /**
     * Check if runtime is already installed and up-to-date
     */
    fun isRuntimeReady(): Boolean {
        val versionFile = File(runtimeRoot, RUNTIME_VERSION_FILE)
        if (!versionFile.exists()) return false
        
        val installedVersion = versionFile.readText().trim()
        return installedVersion == CURRENT_RUNTIME_VERSION && binDir.exists() && binDir.isDirectory
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
        
        onProgress?.invoke("Extracting binaries...", 0.1f)
        extractRuntimeAssets(onProgress)
        
        onProgress?.invoke("Setting permissions...", 0.85f)
        setExecutablePermissions()
        
        onProgress?.invoke("Protecting runtime...", 0.9f)
        protectBinDirectory()
        
        onProgress?.invoke("Configuring environment...", 0.95f)
        setupEnvironment()
        
        // Mark runtime as installed
        File(runtimeRoot, RUNTIME_VERSION_FILE).writeText(CURRENT_RUNTIME_VERSION)
        
        onProgress?.invoke("Runtime ready!", 1.0f)
        Log.i(TAG, "Runtime initialization complete")
    }

    /**
     * Create the runtime directory structure
     */
    private fun createDirectoryStructure() {
        listOf(runtimeRoot, binDir, libDir, homeDir, workspacesDir, tmpDir, cacheDir, etcDir).forEach { dir ->
            if (!dir.exists()) {
                dir.mkdirs()
                Log.d(TAG, "Created directory: ${dir.absolutePath}")
            }
        }
    }

    /**
     * Extract runtime binaries from APK assets to runtime directory
     */
    private fun extractRuntimeAssets(onProgress: ((String, Float) -> Unit)? = null) {
        val assetManager = context.assets
        val runtimeAssetPath = "runtime"
        
        try {
            val assets = assetManager.list(runtimeAssetPath) ?: emptyArray()
            if (assets.isEmpty()) {
                Log.w(TAG, "No runtime assets found - creating placeholder binaries")
                createPlaceholderBinaries()
                return
            }
            
            val totalAssets = assets.size.toFloat()
            assets.forEachIndexed { index, assetName ->
                val progress = 0.1f + (0.75f * (index / totalAssets))
                onProgress?.invoke("Extracting $assetName...", progress)
                extractAssetRecursive(assetManager, "$runtimeAssetPath/$assetName", runtimeRoot)
            }
        } catch (e: IOException) {
            Log.e(TAG, "Error extracting runtime assets", e)
            // Create placeholder binaries for development
            createPlaceholderBinaries()
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
     * Create placeholder scripts for development when real binaries aren't bundled.
     * In production, real ARM64 binaries would be in assets.
     */
    private fun createPlaceholderBinaries() {
        Log.w(TAG, "Creating placeholder runtime - bundle real binaries for production")
        
        // Create a basic bash wrapper that uses system shell
        val bashScript = File(binDir, "bash")
        bashScript.writeText("""
            #!/system/bin/sh
            # MobileIDE Bash wrapper
            # In production, this is a real bash binary
            exec /system/bin/sh "$@"
        """.trimIndent())
        
        val shLink = File(binDir, "sh")
        shLink.writeText("""
            #!/system/bin/sh
            exec /system/bin/sh "$@"
        """.trimIndent())
        
        // Create node placeholder (would be real binary in production)
        val nodeScript = File(binDir, "node")
        nodeScript.writeText("""
            #!/system/bin/sh
            echo "MobileIDE Node.js Runtime"
            echo "Node placeholder - bundle real node binary for production"
            echo "Version: v20.0.0-mobileide"
        """.trimIndent())
        
        // Create npm placeholder
        val npmScript = File(binDir, "npm")
        npmScript.writeText("""
            #!/system/bin/sh
            echo "npm placeholder - bundle real npm for production"
        """.trimIndent())
        
        // Create common utility wrappers
        listOf("ls", "cat", "mkdir", "rm", "cp", "mv", "grep", "echo", "pwd", "cd").forEach { cmd ->
            val script = File(binDir, cmd)
            script.writeText("""
                #!/system/bin/sh
                exec /system/bin/$cmd "$@" 2>/dev/null || echo "$cmd: command available"
            """.trimIndent())
        }
    }

    /**
     * Set executable permissions on all binaries in bin/ and subdirectories
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
        // Create .bashrc
        val bashrc = File(homeDir, ".bashrc")
        bashrc.writeText(getBashrcContent())
        
        // Create .profile
        val profile = File(homeDir, ".profile")
        profile.writeText(getProfileContent())
        
        // Create minimal /etc files for git
        val passwd = File(etcDir, "passwd")
        passwd.writeText("root:x:0:0:root:${homeDir.absolutePath}:/bin/bash\n")
        
        val group = File(etcDir, "group")
        group.writeText("root:x:0:\n")
        
        // Create git config
        val gitconfig = File(homeDir, ".gitconfig")
        if (!gitconfig.exists()) {
            gitconfig.writeText("""
                [user]
                    name = MobileIDE User
                    email = user@mobileide.local
                [core]
                    editor = nano
                [init]
                    defaultBranch = main
            """.trimIndent())
        }
    }

    private fun getBashrcContent(): String = """
        # MobileIDE Bash Configuration
        export PS1='\[\033[01;32m\]mobileide\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
        export EDITOR=nano
        export LANG=en_US.UTF-8
        
        # Aliases
        alias ll='ls -la'
        alias la='ls -a'
        alias ..='cd ..'
        alias ...='cd ../..'
        alias cls='clear'
        
        # Node.js
        alias npm='npm --prefix ${VIRTUAL_ROOT}'
        alias node='${VIRTUAL_BIN}/node'
        
        # Quick commands
        alias projects='cd ${VIRTUAL_WORKSPACES}'
        alias home='cd ${VIRTUAL_HOME}'
        
        # History
        export HISTSIZE=1000
        export HISTFILE=${homeDir.absolutePath}/.bash_history
        
        echo "Welcome to MobileIDE Terminal"
        echo "Type 'help' for available commands"
    """.trimIndent()

    private fun getProfileContent(): String = """
        # MobileIDE Profile
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

    /**
     * Get the environment map for process execution
     */
    fun getEnvironment(): Map<String, String> {
        return mapOf(
            "PATH" to "${binDir.absolutePath}:${binDir.absolutePath}/git-core:/system/bin:/system/xbin",
            "HOME" to homeDir.absolutePath,
            "TMPDIR" to tmpDir.absolutePath,
            "PREFIX" to runtimeRoot.absolutePath,
            "NODE_PATH" to "${runtimeRoot.absolutePath}/lib/node_modules",
            "NPM_CONFIG_PREFIX" to runtimeRoot.absolutePath,
            "NPM_CONFIG_CACHE" to cacheDir.absolutePath,
            "USER" to "root",
            "SHELL" to "${binDir.absolutePath}/bash",
            "TERM" to "xterm-256color",
            "LANG" to "en_US.UTF-8",
            "LC_ALL" to "en_US.UTF-8",
            "GIT_EXEC_PATH" to "${binDir.absolutePath}/git-core",
            "MOBILEIDE_ROOT" to runtimeRoot.absolutePath,
            "MOBILEIDE_WORKSPACES" to workspacesDir.absolutePath
        )
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
