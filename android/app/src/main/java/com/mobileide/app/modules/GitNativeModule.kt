package com.mobileide.app.modules

import android.util.Log
import com.facebook.react.bridge.*
import org.eclipse.jgit.api.Git
import org.eclipse.jgit.api.ResetCommand
import org.eclipse.jgit.lib.PersonIdent
import org.eclipse.jgit.lib.Repository
import org.eclipse.jgit.storage.file.FileRepositoryBuilder
import org.eclipse.jgit.transport.CredentialsProvider
import org.eclipse.jgit.transport.RefSpec
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider
import java.io.File

/**
 * GitNativeModule - Full git integration using JGit (pure Java).
 * Provides: init, status, add, commit, push, pull, clone, log, branch, remote operations.
 */
class GitNativeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "GitNativeModule"
        private const val MODULE_NAME = "GitNativeModule"
    }

    override fun getName(): String = MODULE_NAME

    private var githubToken: String? = null
    private var githubUser: String? = null

    private fun getCredentials(): CredentialsProvider? {
        val token = githubToken ?: return null
        val user = githubUser ?: "token"
        return UsernamePasswordCredentialsProvider(user, token)
    }

    /**
     * Resolve virtual IDE paths (/root/workspaces/...) to real filesDir paths
     * so JGit always opens a real directory regardless of what the JS side sends.
     */
    private fun resolveRepoPath(path: String): String {
        return try {
            val rm = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            rm.resolveVirtualPath(path)
        } catch (_: Exception) {
            path
        }
    }

    private fun openRepo(repoPath: String): Git {
        val real = resolveRepoPath(repoPath)
        val gitDir = File(real, ".git")
        if (!gitDir.exists()) {
            throw Exception("Not a git repository: $real (from $repoPath)")
        }
        val repository: Repository = FileRepositoryBuilder()
            .setGitDir(gitDir)
            .readEnvironment()
            .findGitDir()
            .build()
        return Git(repository)
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
        try {
            if (repoPath.isBlank()) {
                promise.reject("GIT_INIT_ERROR", "No project path selected")
                return
            }
            val dir = File(resolveRepoPath(repoPath))
            if (!dir.exists()) dir.mkdirs()
            // Already a repo → success (idempotent; no crash)
            val existing = File(dir, ".git")
            if (existing.exists() && existing.isDirectory) {
                Log.i(TAG, "git init: already a repository at ${dir.absolutePath}")
                promise.resolve(true)
                return
            }
            Git.init().setDirectory(dir).setInitialBranch("main").call().close()
            Log.i(TAG, "Initialized git repo at: ${dir.absolutePath}")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "git init failed", e)
            promise.reject("GIT_INIT_ERROR", e.message ?: "git init failed")
        }
    }

    /** Safe branch name for empty (unborn HEAD) repos — never returns null. */
    private fun safeBranchName(git: Git): String {
        return try {
            val name = git.repository.branch
            if (!name.isNullOrBlank()) return name
            val head = git.repository.exactRef("HEAD")
            val target = head?.target?.name
            when {
                target != null && target.startsWith("refs/heads/") ->
                    target.removePrefix("refs/heads/")
                else -> "main"
            }
        } catch (_: Exception) {
            "main"
        }
    }

    private fun stringArray(items: Collection<String>?): WritableArray {
        val arr = Arguments.createArray()
        items?.forEach { arr.pushString(it) }
        return arr
    }

    @ReactMethod
    fun gitClone(url: String, destPath: String, promise: Promise) {
        try {
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
        } catch (e: Exception) {
            Log.e(TAG, "git clone failed", e)
            promise.reject("GIT_CLONE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun isGitRepo(repoPath: String, promise: Promise) {
        val gitDir = File(resolveRepoPath(repoPath), ".git")
        promise.resolve(gitDir.exists() && gitDir.isDirectory)
    }

    // ==================== STATUS ====================

    @ReactMethod
    fun gitStatus(repoPath: String, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                val status = git.status().call()
                val result = Arguments.createMap().apply {
                    putArray("added", stringArray(status.added))
                    putArray("changed", stringArray(status.changed))
                    putArray("removed", stringArray(status.removed))
                    putArray("untracked", stringArray(status.untracked))
                    putArray("modified", stringArray(status.modified))
                    putArray("missing", stringArray(status.missing))
                    putArray("conflicting", stringArray(status.conflicting))
                    putBoolean("isClean", status.isClean)
                    // Empty repos have unborn HEAD — putString(null) crashes RN bridge
                    putString("branch", safeBranchName(git))
                }
                promise.resolve(result)
            }
        } catch (e: Exception) {
            Log.e(TAG, "git status failed", e)
            // Empty / brand-new repo: return a clean default instead of hard-failing the UI
            try {
                openRepo(repoPath).use { git ->
                    val result = Arguments.createMap().apply {
                        putArray("added", Arguments.createArray())
                        putArray("changed", Arguments.createArray())
                        putArray("removed", Arguments.createArray())
                        putArray("untracked", Arguments.createArray())
                        putArray("modified", Arguments.createArray())
                        putArray("missing", Arguments.createArray())
                        putArray("conflicting", Arguments.createArray())
                        putBoolean("isClean", true)
                        putString("branch", safeBranchName(git))
                    }
                    promise.resolve(result)
                    return
                }
            } catch (_: Exception) { }
            promise.reject("GIT_STATUS_ERROR", e.message ?: "git status failed")
        }
    }

    // ==================== STAGE / UNSTAGE ====================

    @ReactMethod
    fun gitAdd(repoPath: String, files: ReadableArray, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                val addCommand = git.add()
                for (i in 0 until files.size()) {
                    addCommand.addFilepattern(files.getString(i) ?: ".")
                }
                addCommand.call()
                promise.resolve(true)
            }
        } catch (e: Exception) {
            Log.e(TAG, "git add failed", e)
            promise.reject("GIT_ADD_ERROR", e.message)
        }
    }

    @ReactMethod
    fun gitAddAll(repoPath: String, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                git.add().addFilepattern(".").call()
                // Also stage deletions
                git.add().addFilepattern(".").setUpdate(true).call()
                promise.resolve(true)
            }
        } catch (e: Exception) {
            Log.e(TAG, "git add --all failed", e)
            promise.reject("GIT_ADD_ERROR", e.message)
        }
    }

    @ReactMethod
    fun gitReset(repoPath: String, files: ReadableArray, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                val resetCommand = git.reset()
                for (i in 0 until files.size()) {
                    resetCommand.addPath(files.getString(i) ?: continue)
                }
                resetCommand.call()
                promise.resolve(true)
            }
        } catch (e: Exception) {
            Log.e(TAG, "git reset failed", e)
            promise.reject("GIT_RESET_ERROR", e.message)
        }
    }

    // ==================== COMMIT ====================

    @ReactMethod
    fun gitCommit(repoPath: String, message: String, authorName: String, authorEmail: String, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                val author = PersonIdent(authorName, authorEmail)
                val revCommit = git.commit()
                    .setMessage(message)
                    .setAuthor(author)
                    .setCommitter(author)
                    .call()
                val result = Arguments.createMap().apply {
                    putString("id", revCommit.name)
                    putString("shortId", revCommit.name.take(7))
                    putString("message", revCommit.shortMessage)
                }
                promise.resolve(result)
            }
        } catch (e: Exception) {
            Log.e(TAG, "git commit failed", e)
            promise.reject("GIT_COMMIT_ERROR", e.message)
        }
    }

    // ==================== PUSH / PULL ====================

    @ReactMethod
    fun gitPush(repoPath: String, remote: String, branch: String, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                if (git.remoteList().call().none { it.name == remote }) {
                    promise.reject(
                        "GIT_PUSH_ERROR",
                        "No remote named '$remote'. Add one under Remote (GitHub optional)."
                    )
                    return
                }
                if (git.repository.resolve("HEAD") == null) {
                    promise.reject(
                        "GIT_PUSH_ERROR",
                        "No commits yet. Make a commit first, then push."
                    )
                    return
                }
                val pushCommand = git.push()
                    .setRemote(remote)
                    .setRefSpecs(RefSpec("$branch:$branch"))

                getCredentials()?.let { pushCommand.setCredentialsProvider(it) }

                val results = pushCommand.call()
                val messages = results.flatMap { it.messages.split("\n").filter { m -> m.isNotBlank() } }
                Log.i(TAG, "Pushed to $remote/$branch")
                promise.resolve(messages.joinToString("\n").ifEmpty { "Push successful" })
            }
        } catch (e: Exception) {
            Log.e(TAG, "git push failed", e)
            promise.reject("GIT_PUSH_ERROR", e.message ?: "push failed")
        }
    }

    @ReactMethod
    fun gitPull(repoPath: String, remote: String, branch: String, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                if (git.remoteList().call().none { it.name == remote }) {
                    promise.reject(
                        "GIT_PULL_ERROR",
                        "No remote named '$remote'. Add one under Remote first."
                    )
                    return
                }
                val pullCommand = git.pull()
                    .setRemote(remote)
                    .setRemoteBranchName(branch)

                getCredentials()?.let { pullCommand.setCredentialsProvider(it) }

                val result = pullCommand.call()
                val msg = if (result.isSuccessful) "Pull successful" else "Pull completed with issues"
                promise.resolve(msg)
            }
        } catch (e: Exception) {
            Log.e(TAG, "git pull failed", e)
            promise.reject("GIT_PULL_ERROR", e.message ?: "pull failed")
        }
    }

    @ReactMethod
    fun gitFetch(repoPath: String, remote: String, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                val fetchCommand = git.fetch().setRemote(remote)
                getCredentials()?.let { fetchCommand.setCredentialsProvider(it) }
                fetchCommand.call()
                promise.resolve("Fetch successful")
            }
        } catch (e: Exception) {
            Log.e(TAG, "git fetch failed", e)
            promise.reject("GIT_FETCH_ERROR", e.message)
        }
    }

    // ==================== LOG ====================

    @ReactMethod
    fun gitLog(repoPath: String, maxCount: Int, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                // No commits yet (fresh init) → empty list, not an error
                if (git.repository.resolve("HEAD") == null) {
                    promise.resolve(Arguments.createArray())
                    return
                }
                val logCommand = git.log().setMaxCount(maxCount)
                val commits = Arguments.createArray()
                logCommand.call().forEach { revCommit ->
                    val commitMap = Arguments.createMap().apply {
                        putString("id", revCommit.name)
                        putString("shortId", revCommit.name.take(7))
                        putString("message", revCommit.shortMessage ?: "")
                        putString("author", revCommit.authorIdent?.name ?: "")
                        putString("email", revCommit.authorIdent?.emailAddress ?: "")
                        putDouble("time", revCommit.commitTime.toDouble() * 1000)
                    }
                    commits.pushMap(commitMap)
                }
                promise.resolve(commits)
            }
        } catch (e: Exception) {
            Log.w(TAG, "git log empty or failed: ${e.message}")
            promise.resolve(Arguments.createArray())
        }
    }

    // ==================== BRANCHES ====================

    @ReactMethod
    fun gitBranches(repoPath: String, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                val branches = Arguments.createArray()
                val currentBranch = safeBranchName(git)
                val listed = git.branchList().call()
                if (listed.isEmpty()) {
                    // Unborn HEAD after bare init — still show current branch name
                    val branchMap = Arguments.createMap().apply {
                        putString("name", currentBranch)
                        putBoolean("isCurrent", true)
                    }
                    branches.pushMap(branchMap)
                } else {
                    listed.forEach { ref ->
                        val branchName = ref.name.removePrefix("refs/heads/")
                        val branchMap = Arguments.createMap().apply {
                            putString("name", branchName)
                            putBoolean("isCurrent", branchName == currentBranch)
                        }
                        branches.pushMap(branchMap)
                    }
                }
                promise.resolve(branches)
            }
        } catch (e: Exception) {
            Log.w(TAG, "git branch list failed: ${e.message}")
            val fallback = Arguments.createArray()
            val branchMap = Arguments.createMap().apply {
                putString("name", "main")
                putBoolean("isCurrent", true)
            }
            fallback.pushMap(branchMap)
            promise.resolve(fallback)
        }
    }

    @ReactMethod
    fun gitCheckout(repoPath: String, branch: String, create: Boolean, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                val checkoutCommand = git.checkout().setName(branch)
                if (create) {
                    checkoutCommand.setCreateBranch(true)
                }
                checkoutCommand.call()
                promise.resolve(true)
            }
        } catch (e: Exception) {
            Log.e(TAG, "git checkout failed", e)
            promise.reject("GIT_CHECKOUT_ERROR", e.message)
        }
    }

    // ==================== REMOTES ====================

    @ReactMethod
    fun gitRemotes(repoPath: String, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                val remotes = Arguments.createArray()
                git.remoteList().call().forEach { remote ->
                    val remoteMap = Arguments.createMap().apply {
                        putString("name", remote.name)
                        putString("url", remote.urIs.firstOrNull()?.toString() ?: "")
                    }
                    remotes.pushMap(remoteMap)
                }
                promise.resolve(remotes)
            }
        } catch (e: Exception) {
            Log.e(TAG, "git remote list failed", e)
            promise.reject("GIT_REMOTE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun gitAddRemote(repoPath: String, name: String, url: String, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                git.remoteAdd().setName(name).setUri(org.eclipse.jgit.transport.URIish(url)).call()
                promise.resolve(true)
            }
        } catch (e: Exception) {
            Log.e(TAG, "git remote add failed", e)
            promise.reject("GIT_REMOTE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun gitSetRemoteUrl(repoPath: String, name: String, url: String, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                git.remoteSetUrl().setRemoteName(name).setRemoteUri(org.eclipse.jgit.transport.URIish(url)).call()
                promise.resolve(true)
            }
        } catch (e: Exception) {
            Log.e(TAG, "git remote set-url failed", e)
            promise.reject("GIT_REMOTE_ERROR", e.message)
        }
    }

    // ==================== DIFF ====================

    @ReactMethod
    fun gitDiff(repoPath: String, promise: Promise) {
        try {
            openRepo(repoPath).use { git ->
                val status = git.status().call()
                val diffFiles = Arguments.createArray()
                // Combine modified + changed + untracked for display
                (status.modified + status.changed).forEach { file ->
                    val item = Arguments.createMap().apply {
                        putString("path", file)
                        putString("status", "modified")
                    }
                    diffFiles.pushMap(item)
                }
                status.added.forEach { file ->
                    val item = Arguments.createMap().apply {
                        putString("path", file)
                        putString("status", "added")
                    }
                    diffFiles.pushMap(item)
                }
                status.untracked.forEach { file ->
                    val item = Arguments.createMap().apply {
                        putString("path", file)
                        putString("status", "untracked")
                    }
                    diffFiles.pushMap(item)
                }
                status.removed.forEach { file ->
                    val item = Arguments.createMap().apply {
                        putString("path", file)
                        putString("status", "removed")
                    }
                    diffFiles.pushMap(item)
                }
                promise.resolve(diffFiles)
            }
        } catch (e: Exception) {
            Log.w(TAG, "git diff empty or failed: ${e.message}")
            promise.resolve(Arguments.createArray())
        }
    }

    // ==================== HELPERS ====================

    private fun toArray(set: Set<String>): WritableArray {
        val array = Arguments.createArray()
        set.forEach { array.pushString(it) }
        return array
    }
}
