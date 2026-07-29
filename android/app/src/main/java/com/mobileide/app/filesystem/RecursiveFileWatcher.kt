package com.mobileide.app.filesystem

import android.os.FileObserver
import android.util.Log
import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap

/**
 * Recursive FileObserver for private Android workspaces.
 *
 * FileObserver itself watches one directory. This class maintains one observer
 * per real directory, adds newly-created directories, avoids following
 * symlinks outside the workspace, and rebuilds registrations after inotify
 * queue overflow.
 */
internal interface WorkspaceWatcher {
    fun start()
    fun stop()
}

internal class RecursiveFileWatcher(
    private val root: File,
    private val toVirtualPath: (String) -> String,
    private val callback: (FileEvent) -> Unit
) : WorkspaceWatcher {
    companion object {
        private const val TAG = "RecursiveFileWatcher"
        private const val IN_Q_OVERFLOW = 0x00004000
        private const val IN_IGNORED = 0x00008000
        private const val MASK = FileObserver.ALL_EVENTS or IN_Q_OVERFLOW
    }

    private val observers = ConcurrentHashMap<String, FileObserver>()
    @Volatile private var stopped = false

    override fun start() {
        require(root.isDirectory) { "Watch path is not a directory: ${root.absolutePath}" }
        addTree(root)
    }

    override fun stop() {
        stopped = true
        observers.values.forEach {
            try {
                it.stopWatching()
            } catch (_: Exception) {
                // Already stopped by the kernel.
            }
        }
        observers.clear()
    }

    private fun addTree(directory: File) {
        if (stopped || !directory.isDirectory || isSymlink(directory)) return
        val canonical = try {
            directory.canonicalFile
        } catch (_: Exception) {
            return
        }
        if (!isWithinRoot(canonical)) return
        addDirectory(canonical)
        canonical.listFiles()
            ?.filter { it.isDirectory && !isSymlink(it) }
            ?.forEach(::addTree)
    }

    @Suppress("DEPRECATION")
    private fun addDirectory(directory: File) {
        if (observers.containsKey(directory.absolutePath)) return
        val observer = object : FileObserver(directory.absolutePath, MASK) {
            override fun onEvent(rawEvent: Int, relativePath: String?) {
                if (stopped) return
                if (rawEvent and IN_Q_OVERFLOW != 0) {
                    callback(FileEvent(FileEventType.OVERFLOW, toVirtualPath(root.absolutePath)))
                    rebuild()
                    return
                }

                val event = rawEvent and FileObserver.ALL_EVENTS
                val target = relativePath?.let { File(directory, it) } ?: directory
                when {
                    event and (CREATE or MOVED_TO) != 0 -> {
                        callback(FileEvent(
                            if (event and CREATE != 0) FileEventType.CREATE else FileEventType.MOVE,
                            toVirtualPath(target.absolutePath)
                        ))
                        if (target.isDirectory && !isSymlink(target)) addTree(target)
                    }
                    event and (DELETE or DELETE_SELF) != 0 ->
                        callback(FileEvent(FileEventType.DELETE, toVirtualPath(target.absolutePath)))
                    event and (MOVED_FROM or MOVE_SELF) != 0 ->
                        callback(FileEvent(FileEventType.MOVE, toVirtualPath(target.absolutePath)))
                    event and (MODIFY or CLOSE_WRITE or ATTRIB) != 0 ->
                        callback(FileEvent(FileEventType.MODIFY, toVirtualPath(target.absolutePath)))
                }
                if (event and (DELETE_SELF or MOVE_SELF) != 0 || rawEvent and IN_IGNORED != 0) {
                    observers.remove(directory.absolutePath)?.stopWatching()
                }
            }
        }
        val previous = observers.putIfAbsent(directory.absolutePath, observer)
        if (previous == null) observer.startWatching()
    }

    @Synchronized
    private fun rebuild() {
        if (stopped) return
        observers.values.forEach {
            try {
                it.stopWatching()
            } catch (_: Exception) {
                // best effort
            }
        }
        observers.clear()
        try {
            addTree(root)
        } catch (error: Exception) {
            Log.w(TAG, "Watcher recovery failed: ${error.message}")
        }
    }

    private fun isWithinRoot(file: File): Boolean {
        val rootPath = root.canonicalFile.toPath()
        return file.toPath().startsWith(rootPath)
    }

    private fun isSymlink(file: File): Boolean =
        try {
            Files.isSymbolicLink(file.toPath())
        } catch (_: Exception) {
            true
        }
}
