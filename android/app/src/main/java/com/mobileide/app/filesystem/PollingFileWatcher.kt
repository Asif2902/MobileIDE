package com.mobileide.app.filesystem

import java.io.File
import java.nio.file.Files
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Recursive fallback for shared/FUSE storage, where inotify/FileObserver
 * delivery is incomplete on many Android devices.
 */
internal class PollingFileWatcher(
    private val root: File,
    private val toVirtualPath: (String) -> String,
    private val callback: (FileEvent) -> Unit
) : WorkspaceWatcher {
    private data class Stamp(val directory: Boolean, val modified: Long, val size: Long)

    private val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "adev-shared-storage-watch").apply { isDaemon = true }
    }
    @Volatile private var snapshot = emptyMap<String, Stamp>()

    override fun start() {
        require(root.isDirectory) { "Watch path is not a directory: ${root.absolutePath}" }
        snapshot = scan()
        executor.scheduleWithFixedDelay(::poll, 1, 1, TimeUnit.SECONDS)
    }

    override fun stop() {
        executor.shutdownNow()
    }

    private fun poll() {
        val previous = snapshot
        val current = scan()
        current.forEach { (path, stamp) ->
            val old = previous[path]
            when {
                old == null -> callback(FileEvent(FileEventType.CREATE, toVirtualPath(path)))
                old != stamp -> callback(FileEvent(FileEventType.MODIFY, toVirtualPath(path)))
            }
        }
        previous.keys.filter { it !in current }.forEach { path ->
            callback(FileEvent(FileEventType.DELETE, toVirtualPath(path)))
        }
        snapshot = current
    }

    private fun scan(): Map<String, Stamp> {
        val result = mutableMapOf<String, Stamp>()
        fun visit(file: File) {
            if (isSymlink(file)) return
            val canonical = try {
                file.canonicalFile
            } catch (_: Exception) {
                return
            }
            if (!canonical.toPath().startsWith(root.canonicalFile.toPath())) return
            result[canonical.absolutePath] =
                Stamp(canonical.isDirectory, canonical.lastModified(), canonical.length())
            if (canonical.isDirectory) canonical.listFiles()?.forEach(::visit)
        }
        visit(root)
        return result
    }

    private fun isSymlink(file: File): Boolean =
        try {
            Files.isSymbolicLink(file.toPath())
        } catch (_: Exception) {
            true
        }
}
