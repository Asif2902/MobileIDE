package com.mobileide.app.modules

import android.util.Log
import com.facebook.react.bridge.*
import org.eclipse.jgit.api.Git
import org.eclipse.jgit.api.ResetCommand
import org.eclipse.jgit.lib.Constants
import org.eclipse.jgit.lib.PersonIdent
import org.eclipse.jgit.lib.Repository
import org.eclipse.jgit.storage.file.FileRepositoryBuilder
import org.eclipse.jgit.transport.CredentialsProvider
import org.eclipse.jgit.transport.RefSpec
import org.eclipse.jgit.transport.URIish
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider
import java.io.File
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

    private var githubToken: String? = null
    private var githubUser: String? = null

    override fun getName(): String = MODULE_NAME

    private fun getCredentials(): CredentialsProvider? {
        val token = githubToken ?: return null
        val user = githubUser ?: "token"
        return UsernamePasswordCredentialsProvider(user, token)
    }

    private fun resolveRepoPath(path: String): String {
        if (path.isBlank()) return path
        return try {
            val rm = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            rm.resolveVirtualPath(path)
        } catch (_: Exception) {
            path
        }
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
        items?.forEach { arr.pushString(it ?: "") }
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
        githubUser = username
        githubToken = token
        Log.i(TAG, "Git credentials set for user: $username")
    }

    @ReactMethod
    fun clearCredentials() {
        githubUser = null
        githubToken = null
    }

    @ReactMethod
    fun hasCredentials(promise: Promise) {
        promise.resolve(githubToken != null)
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
            val dir = File(resolveRepoPath(destPath))
            if (dir.exists()) dir.deleteRecursively()
            dir.mkdirs()

            val cloneCommand = Git.cloneRepository()
                .setURI(url)
                .setDirectory(dir)

            getCredentials()?.let { cloneCommand.setCredentialsProvider(it) }
            cloneCommand.call().close()
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
                    addCommand.addFilepattern(files.getString(i) ?: ".")
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
                    val p = files.getString(i) ?: continue
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
                val pushCommand = git.push()
                    .setRemote(remote)
                    .setRefSpecs(RefSpec("$b:$b"))
                getCredentials()?.let { pushCommand.setCredentialsProvider(it) }
                val results = pushCommand.call()
                val messages = results.flatMap {
                    it.messages.split("\n").filter { m -> m.isNotBlank() }
                }
                promise.resolve(messages.joinToString("\n").ifEmpty { "Push successful" })
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
                val pullCommand = git.pull()
                    .setRemote(remote)
                    .setRemoteBranchName(b)
                getCredentials()?.let { pullCommand.setCredentialsProvider(it) }
                val result = pullCommand.call()
                val msg = if (result.isSuccessful) "Pull successful" else "Pull completed with issues"
                promise.resolve(msg)
            }
        }
    }

    @ReactMethod
    fun gitFetch(repoPath: String, remote: String, promise: Promise) {
        runGit(promise) {
            openRepo(repoPath).use { git ->
                val fetchCommand = git.fetch().setRemote(remote)
                getCredentials()?.let { fetchCommand.setCredentialsProvider(it) }
                fetchCommand.call()
                promise.resolve("Fetch successful")
            }
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
