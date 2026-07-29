package com.mobileide.app.modules

import android.util.Log
import com.facebook.react.bridge.*
import com.mobileide.app.git.GitCredentialMetadata
import com.mobileide.app.git.GitCredentialStore
import com.mobileide.app.git.GitPolicy
import org.eclipse.jgit.api.Git
import org.eclipse.jgit.api.ResetCommand
import org.eclipse.jgit.lib.Constants
import org.eclipse.jgit.lib.PersonIdent
import org.eclipse.jgit.lib.Repository
import org.eclipse.jgit.storage.file.FileRepositoryBuilder
import org.eclipse.jgit.transport.URIish
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors

/**
 * Git via JGit. All work runs off the RN bridge thread so a slow/failed
 * operation cannot freeze or tear down the UI. Every public method catches
 * Throwable and always settles the Promise.
 */
class GitNativeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "GitNativeModule"
        private const val MODULE_NAME = "GitNativeModule"
    }

    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "adev-git-io").apply { isDaemon = true }
    }

    private val credentialStore = GitCredentialStore(reactContext.applicationContext)

    override fun getName(): String = MODULE_NAME

    private fun resolveRepoPath(path: String): String {
        if (path.isBlank()) return path
        return try {
            val rm = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            rm.resolveVirtualPath(path)
        } catch (_: Exception) {
            path
        }
    }

    private data class NativeGitResult(val exitCode: Int, val output: String)

    /**
     * Network Git operations use the bundled native CLI so the terminal and UI
     * share redirect/proxy/custom-CA/credential-helper/SSH/submodule behavior.
     * Secrets are provided by the native broker, never command arguments.
     */
    private fun runNativeGit(cwd: File, arguments: List<String>): NativeGitResult {
        val runtime = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
        val executable = File(runtime.getNativeLibDir(), "libbin_git.so")
        check(executable.isFile) { "Bundled native Git is unavailable" }
        val process = ProcessBuilder(listOf(executable.absolutePath) + arguments)
            .directory(cwd)
            .redirectErrorStream(true)
            .apply {
                environment().putAll(runtime.getEnvironment(cwd.absolutePath))
                environment()["GIT_TERMINAL_PROMPT"] = "0"
            }
            .start()
        val output = process.inputStream.bufferedReader().use { reader ->
            val builder = StringBuilder()
            val buffer = CharArray(8192)
            while (true) {
                val read = reader.read(buffer)
                if (read < 0) break
                if (builder.length < 1024 * 1024) {
                    builder.append(buffer, 0, minOf(read, 1024 * 1024 - builder.length))
                }
            }
            GitPolicy.redact(builder.toString(), emptyList())
        }
        if (!process.waitFor(5, TimeUnit.MINUTES)) {
            process.destroy()
            if (!process.waitFor(2, TimeUnit.SECONDS)) process.destroyForcibly()
            throw IllegalStateException("Git operation timed out")
        }
        return NativeGitResult(process.exitValue(), output.trim())
    }

    private fun requireNativeSuccess(result: NativeGitResult, operation: String): String {
        if (result.exitCode != 0) {
            throw IllegalStateException(
                "$operation failed (${result.exitCode}): " +
                    result.output.ifBlank { "no diagnostic output" }
            )
        }
        return result.output
    }

    /** Run git work off the bridge thread; always complete the promise. */
    private fun runGit(promise: Promise, block: () -> Unit) {
        io.execute {
            try {
                block()
            } catch (t: Throwable) {
                Log.e(TAG, "git op failed", t)
                try {
                    promise.reject("GIT_ERROR", t.message ?: t.javaClass.simpleName, t)
                } catch (e: Exception) {
                    Log.e(TAG, "promise.reject failed", e)
                }
            }
        }
    }

    /**
     * Open a work-tree repo. Do NOT use readEnvironment() — the app process
     * may have shell GIT_* vars that confuse JGit and cause native crashes.
     */
    private fun openRepo(repoPath: String): Git {
        val real = File(resolveRepoPath(repoPath)).canonicalFile
        val gitDir = File(real, Constants.DOT_GIT)
        if (!gitDir.exists()) {
            throw IllegalStateException("Not a git repository: ${real.absolutePath}")
        }
        // Prefer Git.open (sets work tree correctly). Fall back to builder.
        return try {
            Git.open(real)
        } catch (e: Exception) {
            Log.w(TAG, "Git.open failed, trying builder: ${e.message}")
            val repo: Repository = FileRepositoryBuilder()
                .setWorkTree(real)
                .setGitDir(gitDir)
                .setMustExist(true)
                .build()
            Git(repo)
        }
    }

    private fun isOpenableRepo(dir: File): Boolean {
        val gitMeta = File(dir, Constants.DOT_GIT)
        if (!gitMeta.exists()) return false
        return try {
            Git.open(dir).use { true }
        } catch (_: Throwable) {
            false
        }
    }

    private fun safeBranchName(git: Git): String {
        return try {
            val repo = git.repository
            // Prefer symbolic HEAD target (works for unborn branches)
            val head = repo.exactRef(Constants.HEAD)
            if (head != null && head.isSymbolic) {
                val target = head.target?.name
                if (target != null && target.startsWith(Constants.R_HEADS)) {
                    return target.removePrefix(Constants.R_HEADS)
                }
            }
            val full = repo.fullBranch
            if (!full.isNullOrBlank()) {
                return if (full.startsWith(Constants.R_HEADS)) {
                    full.removePrefix(Constants.R_HEADS)
                } else full
            }
            "main"
        } catch (_: Throwable) {
            "main"
        }
    }

    private fun stringArray(items: Collection<String>?): WritableArray {
        val arr = Arguments.createArray()
        items?.forEach { arr.pushString(it) }
        return arr
    }

    private fun emptyStatusMap(branch: String = "main"): WritableMap {
        return Arguments.createMap().apply {
            putArray("added", Arguments.createArray())
            putArray("changed", Arguments.createArray())
            putArray("removed", Arguments.createArray())
            putArray("untracked", Arguments.createArray())
            putArray("modified", Arguments.createArray())
            putArray("missing", Arguments.createArray())
            putArray("conflicting", Arguments.createArray())
            putBoolean("isClean", true)
            putString("branch", branch.ifBlank { "main" })
        }
    }

    // ==================== AUTH ====================

    @ReactMethod
    fun setCredentials(username: String, token: String) {
        credentialStore.putHttps(
            reference = "github-default",
            host = "github.com",
            username = username.ifBlank { "token" },
            password = token
        )
        Log.i(TAG, "Protected Git credential stored for github.com")
    }

    @ReactMethod
    fun clearCredentials() {
        credentialStore.remove("github-default")
    }

    @ReactMethod
    fun hasCredentials(promise: Promise) {
        promise.resolve(credentialStore.hasAny())
    }

    @ReactMethod
    fun storeHttpsCredential(
        reference: String,
        host: String,
        username: String,
        token: String,
        promise: Promise
    ) {
        runGit(promise) {
            val metadata = credentialStore.putHttps(reference, host, username, token)
            promise.resolve(metadataMap(metadata))
        }
    }

    @ReactMethod
    fun importSshIdentity(
        reference: String,
        hostPattern: String,
        username: String,
        privateKey: String,
        passphrase: String?,
        promise: Promise
    ) {
        runGit(promise) {
            val metadata = credentialStore.putSsh(
                reference,
                hostPattern,
                username,
                privateKey,
                passphrase
            )
            promise.resolve(metadataMap(metadata))
        }
    }

    @ReactMethod
    fun generateSshIdentity(
        reference: String,
        hostPattern: String,
        username: String,
        promise: Promise
    ) {
        runGit(promise) {
            val runtime = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            val keygen = File(runtime.getBinDir(), "dropbearkey")
            check(keygen.exists()) { "Bundled SSH key generator is unavailable" }
            val keyDir = File(reactApplicationContext.cacheDir, "git-keygen").canonicalFile
            check(keyDir.exists() || keyDir.mkdirs()) { "Could not create key workspace" }
            val privateFile = File(keyDir, "key-${UUID.randomUUID()}").canonicalFile
            check(privateFile.toPath().startsWith(keyDir.toPath())) { "Invalid key path" }
            try {
                val generate = ProcessBuilder(
                    keygen.absolutePath,
                    "-t",
                    "ed25519",
                    "-f",
                    privateFile.absolutePath
                )
                    .redirectErrorStream(true)
                    .apply { environment().putAll(runtime.getEnvironment(keyDir.absolutePath)) }
                    .start()
                val generateOutput = generate.inputStream.bufferedReader().use { it.readText() }
                if (!generate.waitFor(30, TimeUnit.SECONDS)) {
                    generate.destroyForcibly()
                    throw IllegalStateException("SSH key generation timed out")
                }
                check(generate.exitValue() == 0 && privateFile.isFile) {
                    "SSH key generation failed: ${generateOutput.trim()}"
                }
                val publicProcess = ProcessBuilder(
                    keygen.absolutePath,
                    "-y",
                    "-f",
                    privateFile.absolutePath
                )
                    .redirectErrorStream(true)
                    .apply { environment().putAll(runtime.getEnvironment(keyDir.absolutePath)) }
                    .start()
                val publicOutput = publicProcess.inputStream.bufferedReader().use { it.readText() }
                if (!publicProcess.waitFor(30, TimeUnit.SECONDS)) {
                    publicProcess.destroyForcibly()
                    throw IllegalStateException("SSH public-key extraction timed out")
                }
                check(publicProcess.exitValue() == 0) {
                    "SSH public-key extraction failed"
                }
                val publicKey = publicOutput.lineSequence()
                    .map(String::trim)
                    .firstOrNull {
                        it.startsWith("ssh-ed25519 ") || it.startsWith("ssh-rsa ")
                    }
                    ?: throw IllegalStateException("SSH key generator returned no public key")
                val metadata = credentialStore.putSsh(
                    reference,
                    hostPattern,
                    username,
                    privateFile.readText(),
                    null
                )
                promise.resolve(
                    metadataMap(metadata).apply {
                        putString("publicKey", publicKey)
                    }
                )
            } finally {
                if (privateFile.exists()) privateFile.delete()
            }
        }
    }

    @ReactMethod
    fun selectCredential(reference: String, promise: Promise) {
        runGit(promise) { promise.resolve(credentialStore.select(reference)) }
    }

    @ReactMethod
    fun removeCredential(reference: String, promise: Promise) {
        runGit(promise) { promise.resolve(credentialStore.remove(reference)) }
    }

    @ReactMethod
    fun listCredentials(promise: Promise) {
        runGit(promise) {
            val result = Arguments.createArray()
            credentialStore.list().forEach { result.pushMap(metadataMap(it)) }
            promise.resolve(result)
        }
    }

    @ReactMethod
    fun confirmKnownHost(
        host: String,
        keyType: String,
        keyBase64: String,
        promise: Promise
    ) {
        runGit(promise) {
            val fingerprint = credentialStore.putKnownHost(host, keyType, keyBase64)
            promise.resolve(
                Arguments.createMap().apply {
                    putString("host", GitPolicy.normalizeHost(host))
                    putString("fingerprint", fingerprint)
                }
            )
        }
    }

    @ReactMethod
    fun removeKnownHost(host: String, promise: Promise) {
        runGit(promise) { promise.resolve(credentialStore.removeKnownHost(host)) }
    }

    @ReactMethod
    fun listKnownHosts(promise: Promise) {
        runGit(promise) {
            val result = Arguments.createArray()
            credentialStore.listKnownHosts().forEach { known ->
                result.pushMap(
                    Arguments.createMap().apply {
                        putString("host", known.optString("host"))
                        putString("keyType", known.optString("keyType"))
                        putString("fingerprint", known.optString("fingerprint"))
                        putDouble("confirmedAt", known.optLong("confirmedAt").toDouble())
                    }
                )
            }
            promise.resolve(result)
        }
    }

    @ReactMethod
    fun installCustomCa(reference: String, pem: String, promise: Promise) {
        runGit(promise) {
            val runtime = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            promise.resolve(
                Arguments.createMap().apply {
                    putString("reference", reference)
                    putString("sha256", runtime.installGitCustomCa(reference, pem))
                }
            )
        }
    }

    @ReactMethod
    fun removeCustomCa(reference: String, promise: Promise) {
        runGit(promise) {
            val runtime = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            promise.resolve(runtime.removeGitCustomCa(reference))
        }
    }

    @ReactMethod
    fun listCustomCas(promise: Promise) {
        runGit(promise) {
            val runtime = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            val result = Arguments.createArray()
            runtime.listGitCustomCas().forEach(result::pushString)
            promise.resolve(result)
        }
    }

    @ReactMethod
    fun setProxy(proxyUrl: String?, promise: Promise) {
        runGit(promise) {
            val runtime = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            runtime.setGitProxy(proxyUrl)
            promise.resolve(runtime.getGitProxy())
        }
    }

    @ReactMethod
    fun getProxy(promise: Promise) {
        val runtime = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
        promise.resolve(runtime.getGitProxy())
    }

    private fun metadataMap(metadata: GitCredentialMetadata): WritableMap =
        Arguments.createMap().apply {
            putString("reference", metadata.reference)
            putString("kind", metadata.kind)
            putString("host", metadata.host)
            putString("username", metadata.username)
            putDouble("createdAt", metadata.createdAt.toDouble())
        }

    // ==================== REPO OPERATIONS ====================

    @ReactMethod
    fun gitInit(repoPath: String, promise: Promise) {
        runGit(promise) {
            if (repoPath.isBlank()) {
                promise.reject("GIT_INIT_ERROR", "No project path selected")
                return@runGit
            }
            val dir = File(resolveRepoPath(repoPath))
            if (!dir.exists() && !dir.mkdirs()) {
                promise.reject("GIT_INIT_ERROR", "Cannot create directory: ${dir.absolutePath}")
                return@runGit
            }

            // Already a valid repo → success (idempotent)
            if (isOpenableRepo(dir)) {
                Log.i(TAG, "git init: already a repository at ${dir.absolutePath}")
                promise.resolve(true)
                return@runGit
            }

            // Corrupt / half-written .git from a previous crash → remove and re-init
            val gitMeta = File(dir, Constants.DOT_GIT)
            if (gitMeta.exists()) {
                Log.w(TAG, "Removing corrupt .git at ${gitMeta.absolutePath}")
                gitMeta.deleteRecursively()
            }

            try {
                Git.init()
                    .setDirectory(dir)
                    .setInitialBranch("main")
                    .call()
                    .close()
            } catch (e: Throwable) {
                // Older JGit or FS quirks: init without branch name, then set HEAD
                Log.w(TAG, "init with main failed, fallback: ${e.message}")
                Git.init().setDirectory(dir).call().use { git ->
                    try {
                        val ref = git.repository.updateRef(Constants.HEAD)
                        ref.link(Constants.R_HEADS + "main")
                    } catch (e2: Throwable) {
                        Log.w(TAG, "Could not set HEAD to main: ${e2.message}")
                    }
                }
            }

            // Verify openable so the UI won't crash on next open
            if (!isOpenableRepo(dir)) {
                promise.reject("GIT_INIT_ERROR", "Init finished but repo is not openable")
                return@runGit
            }
            Log.i(TAG, "Initialized git repo at: ${dir.absolutePath}")
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun gitClone(url: String, destPath: String, promise: Promise) {
        runGit(promise) {
            val dir = File(resolveRepoPath(destPath)).canonicalFile
            if (dir.exists() && dir.listFiles()?.isNotEmpty() == true) {
                throw IllegalStateException(
                    "Clone destination already exists and is not empty: ${dir.absolutePath}"
                )
            }
            val parent = dir.parentFile
                ?: throw IllegalStateException("Clone destination has no parent")
            check(parent.exists() || parent.mkdirs()) {
                "Cannot create clone parent: ${parent.absolutePath}"
            }
            val result = runNativeGit(
                parent,
                listOf("clone", "--", url, dir.name)
            )
            requireNativeSuccess(result, "Clone")
            Log.i(TAG, "Cloned $url to ${dir.absolutePath}")
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun isGitRepo(repoPath: String, promise: Promise) {
        runGit(promise) {
            if (repoPath.isBlank()) {
                promise.resolve(false)
                return@runGit
            }
            val dir = File(resolveRepoPath(repoPath))
            // Only true if .git exists AND opens without crashing
            promise.resolve(isOpenableRepo(dir))
        }
    }

    // ==================== STATUS ====================

    @ReactMethod
    fun gitStatus(repoPath: String, promise: Promise) {
        runGit(promise) {
            try {
                openRepo(repoPath).use { git ->
                    val branch = safeBranchName(git)
                    val status = try {
                        git.status().call()
                    } catch (e: Throwable) {
                        Log.w(TAG, "status call failed: ${e.message}")
                        promise.resolve(emptyStatusMap(branch))
                        return@runGit
                    }
                    val result = Arguments.createMap().apply {
                        putArray("added", stringArray(status.added))
                        putArray("changed", stringArray(status.changed))
                        putArray("removed", stringArray(status.removed))
                        putArray("untracked", stringArray(status.untracked))
                        putArray("modified", stringArray(status.modified))
                        putArray("missing", stringArray(status.missing))
                        putArray("conflicting", stringArray(status.conflicting))
                        putBoolean("isClean", status.isClean)
                        putString("branch", branch)
                    }
                    promise.resolve(result)
                }
            } catch (e: Throwable) {
                Log.w(TAG, "gitStatus open failed: ${e.message}")
                // Never reject with a hard fail that bricks the tab
                promise.resolve(emptyStatusMap("main"))
            }
        }
    }

    // ==================== STAGE / UNSTAGE ====================

    @ReactMethod
    fun gitAdd(repoPath: String, files: ReadableArray, promise: Promise) {
        runGit(promise) {
            openRepo(repoPath).use { git ->
                val addCommand = git.add()
                for (i in 0 until files.size()) {
                    addCommand.addFilepattern(files.getString(i))
                }
                addCommand.call()
                promise.resolve(true)
            }
        }
    }

    @ReactMethod
    fun gitAddAll(repoPath: String, promise: Promise) {
        runGit(promise) {
            openRepo(repoPath).use { git ->
                git.add().addFilepattern(".").call()
                git.add().addFilepattern(".").setUpdate(true).call()
                promise.resolve(true)
            }
        }
    }

    @ReactMethod
    fun gitReset(repoPath: String, files: ReadableArray, promise: Promise) {
        runGit(promise) {
            openRepo(repoPath).use { git ->
                val resetCommand = git.reset().setMode(ResetCommand.ResetType.MIXED)
                for (i in 0 until files.size()) {
                    val p = files.getString(i)
                    resetCommand.addPath(p)
                }
                resetCommand.call()
                promise.resolve(true)
            }
        }
    }

    // ==================== COMMIT ====================

    @ReactMethod
    fun gitCommit(
        repoPath: String,
        message: String,
        authorName: String,
        authorEmail: String,
        promise: Promise
    ) {
        runGit(promise) {
            openRepo(repoPath).use { git ->
                val author = PersonIdent(
                    authorName.ifBlank { "Developer" },
                    authorEmail.ifBlank { "dev@local" }
                )
                val revCommit = git.commit()
                    .setMessage(message.ifBlank { "commit" })
                    .setAuthor(author)
                    .setCommitter(author)
                    .call()
                val result = Arguments.createMap().apply {
                    putString("id", revCommit?.name ?: "")
                    putString("shortId", revCommit?.name?.take(7) ?: "")
                    putString("message", revCommit?.shortMessage ?: message)
                }
                promise.resolve(result)
            }
        }
    }

    // ==================== PUSH / PULL ====================

    @ReactMethod
    fun gitPush(repoPath: String, remote: String, branch: String, promise: Promise) {
        runGit(promise) {
            openRepo(repoPath).use { git ->
                if (git.remoteList().call().none { it.name == remote }) {
                    promise.reject(
                        "GIT_PUSH_ERROR",
                        "No remote named '$remote'. Add one under Remote first."
                    )
                    return@runGit
                }
                if (git.repository.resolve(Constants.HEAD) == null) {
                    promise.reject("GIT_PUSH_ERROR", "No commits yet. Make a commit first, then push.")
                    return@runGit
                }
                val b = branch.ifBlank { safeBranchName(git) }
                val result = runNativeGit(
                    File(resolveRepoPath(repoPath)),
                    listOf("push", "--porcelain", remote, "$b:$b")
                )
                promise.resolve(requireNativeSuccess(result, "Push").ifBlank { "Push successful" })
            }
        }
    }

    @ReactMethod
    fun gitPull(repoPath: String, remote: String, branch: String, promise: Promise) {
        runGit(promise) {
            openRepo(repoPath).use { git ->
                if (git.remoteList().call().none { it.name == remote }) {
                    promise.reject(
                        "GIT_PULL_ERROR",
                        "No remote named '$remote'. Add one under Remote first."
                    )
                    return@runGit
                }
                val b = branch.ifBlank { safeBranchName(git) }
                val result = runNativeGit(
                    File(resolveRepoPath(repoPath)),
                    listOf("pull", "--ff-only", remote, b)
                )
                promise.resolve(requireNativeSuccess(result, "Pull").ifBlank { "Pull successful" })
            }
        }
    }

    @ReactMethod
    fun gitFetch(repoPath: String, remote: String, promise: Promise) {
        runGit(promise) {
            openRepo(repoPath).close()
            val result = runNativeGit(
                File(resolveRepoPath(repoPath)),
                listOf("fetch", "--prune", remote)
            )
            promise.resolve(requireNativeSuccess(result, "Fetch").ifBlank { "Fetch successful" })
        }
    }

    @ReactMethod
    fun gitSubmoduleUpdate(repoPath: String, recursive: Boolean, promise: Promise) {
        runGit(promise) {
            val args = mutableListOf("submodule", "update", "--init")
            if (recursive) args += "--recursive"
            val result = runNativeGit(File(resolveRepoPath(repoPath)), args)
            promise.resolve(
                requireNativeSuccess(result, "Submodule update").ifBlank {
                    "Submodules updated"
                }
            )
        }
    }

    @ReactMethod
    fun gitLfsPull(repoPath: String, promise: Promise) {
        runGit(promise) {
            val runtime = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            val lfs = File(runtime.getNativeLibDir(), "libbin_git_lfs.so")
            if (!lfs.isFile) {
                promise.reject(
                    "GIT_LFS_UNAVAILABLE",
                    "Git LFS requires the signed Android git-lfs feature pack; " +
                        "the current APK does not contain it."
                )
                return@runGit
            }
            val result = runNativeGit(File(resolveRepoPath(repoPath)), listOf("lfs", "pull"))
            promise.resolve(requireNativeSuccess(result, "Git LFS pull"))
        }
    }

    // ==================== LOG ====================

    @ReactMethod
    fun gitLog(repoPath: String, maxCount: Int, promise: Promise) {
        runGit(promise) {
            try {
                openRepo(repoPath).use { git ->
                    if (git.repository.resolve(Constants.HEAD) == null) {
                        promise.resolve(Arguments.createArray())
                        return@runGit
                    }
                    val commits = Arguments.createArray()
                    val n = if (maxCount > 0) maxCount else 30
                    git.log().setMaxCount(n).call().forEach { revCommit ->
                        val commitMap = Arguments.createMap().apply {
                            putString("id", revCommit.name ?: "")
                            putString("shortId", revCommit.name?.take(7) ?: "")
                            putString("message", revCommit.shortMessage ?: "")
                            putString("author", revCommit.authorIdent?.name ?: "")
                            putString("email", revCommit.authorIdent?.emailAddress ?: "")
                            putDouble("time", revCommit.commitTime.toDouble() * 1000.0)
                        }
                        commits.pushMap(commitMap)
                    }
                    promise.resolve(commits)
                }
            } catch (e: Throwable) {
                Log.w(TAG, "git log: ${e.message}")
                promise.resolve(Arguments.createArray())
            }
        }
    }

    // ==================== BRANCHES ====================

    @ReactMethod
    fun gitBranches(repoPath: String, promise: Promise) {
        runGit(promise) {
            try {
                openRepo(repoPath).use { git ->
                    val branches = Arguments.createArray()
                    val currentBranch = safeBranchName(git)
                    val listed = try {
                        git.branchList().call()
                    } catch (_: Throwable) {
                        emptyList()
                    }
                    if (listed.isEmpty()) {
                        branches.pushMap(Arguments.createMap().apply {
                            putString("name", currentBranch)
                            putBoolean("isCurrent", true)
                        })
                    } else {
                        listed.forEach { ref ->
                            val branchName = ref.name.removePrefix(Constants.R_HEADS)
                            branches.pushMap(Arguments.createMap().apply {
                                putString("name", branchName)
                                putBoolean("isCurrent", branchName == currentBranch)
                            })
                        }
                    }
                    promise.resolve(branches)
                }
            } catch (e: Throwable) {
                val fallback = Arguments.createArray()
                fallback.pushMap(Arguments.createMap().apply {
                    putString("name", "main")
                    putBoolean("isCurrent", true)
                })
                promise.resolve(fallback)
            }
        }
    }

    @ReactMethod
    fun gitCheckout(repoPath: String, branch: String, create: Boolean, promise: Promise) {
        runGit(promise) {
            openRepo(repoPath).use { git ->
                val checkoutCommand = git.checkout().setName(branch)
                if (create) checkoutCommand.setCreateBranch(true)
                checkoutCommand.call()
                promise.resolve(true)
            }
        }
    }

    // ==================== REMOTES ====================

    @ReactMethod
    fun gitRemotes(repoPath: String, promise: Promise) {
        runGit(promise) {
            try {
                openRepo(repoPath).use { git ->
                    val remotes = Arguments.createArray()
                    git.remoteList().call().forEach { remote ->
                        remotes.pushMap(Arguments.createMap().apply {
                            putString("name", remote.name ?: "")
                            putString("url", remote.urIs.firstOrNull()?.toString() ?: "")
                        })
                    }
                    promise.resolve(remotes)
                }
            } catch (e: Throwable) {
                promise.resolve(Arguments.createArray())
            }
        }
    }

    @ReactMethod
    fun gitAddRemote(repoPath: String, name: String, url: String, promise: Promise) {
        runGit(promise) {
            openRepo(repoPath).use { git ->
                git.remoteAdd().setName(name).setUri(URIish(url)).call()
                promise.resolve(true)
            }
        }
    }

    @ReactMethod
    fun gitSetRemoteUrl(repoPath: String, name: String, url: String, promise: Promise) {
        runGit(promise) {
            openRepo(repoPath).use { git ->
                git.remoteSetUrl().setRemoteName(name).setRemoteUri(URIish(url)).call()
                promise.resolve(true)
            }
        }
    }

    // ==================== DIFF ====================

    @ReactMethod
    fun gitDiff(repoPath: String, promise: Promise) {
        runGit(promise) {
            try {
                openRepo(repoPath).use { git ->
                    val status = git.status().call()
                    val diffFiles = Arguments.createArray()
                    fun push(path: String, st: String) {
                        diffFiles.pushMap(Arguments.createMap().apply {
                            putString("path", path)
                            putString("status", st)
                        })
                    }
                    (status.modified + status.changed).forEach { push(it, "modified") }
                    status.added.forEach { push(it, "added") }
                    status.untracked.forEach { push(it, "untracked") }
                    status.removed.forEach { push(it, "removed") }
                    promise.resolve(diffFiles)
                }
            } catch (e: Throwable) {
                promise.resolve(Arguments.createArray())
            }
        }
    }
}
