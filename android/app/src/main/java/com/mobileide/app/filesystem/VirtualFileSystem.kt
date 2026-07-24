package com.mobileide.app.filesystem

import android.os.FileObserver
import android.util.Log
import com.mobileide.app.runtime.RuntimeManager
import java.io.File
import java.io.IOException

/**
 * VirtualFileSystem provides scoped file operations within the runtime root.
 * All paths are resolved relative to the runtime root, creating a sandboxed
 * Linux-like filesystem experience.
 */
class VirtualFileSystem(private val runtimeManager: RuntimeManager) {

    companion object {
        private const val TAG = "VirtualFileSystem"
        private const val MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB limit for reading
    }

    private val watchers = mutableMapOf<String, FileObserver>()

    /**
     * Resolve a virtual path to a real file, ensuring it's within the sandbox
     */
    private fun resolvePath(virtualPath: String): File {
        val realPath = runtimeManager.resolveVirtualPath(virtualPath)
        val file = File(realPath)
        
        // Security check: allow the runtime sandbox, the read-only system tree,
        // and (when the user has granted all-files access) real external storage
        // so CLI tools and the editor can operate on real project folders.
        //
        // Compare canonical paths on both sides. context.filesDir reports the
        // /data/user/0/<pkg> path, but File.canonicalPath resolves the
        // /data/user/0 -> /data/data symlink, so a raw startsWith check wrongly
        // rejects every runtime path as "outside sandbox".
        val canonicalPath = file.canonicalPath
        val runtimeRoot = try {
            File(runtimeManager.getRuntimeRoot()).canonicalPath
        } catch (e: IOException) {
            runtimeManager.getRuntimeRoot()
        }
        val allowedPrefixes = listOf(
            runtimeRoot,
            "/system",
            "/storage",
            "/sdcard",
            "/mnt",
            "/data/data",
            "/data/user"
        )
        
        if (allowedPrefixes.none { canonicalPath.startsWith(it) }) {
            throw SecurityException("Access denied: path outside sandbox")
        }
        
        return file
    }

    /**
     * List directory contents
     */
    fun listDir(virtualPath: String): List<FileEntry> {
        val dir = resolvePath(virtualPath)
        
        if (!dir.exists()) {
            throw IOException("Directory not found: $virtualPath")
        }
        if (!dir.isDirectory) {
            throw IOException("Not a directory: $virtualPath")
        }
        
        return dir.listFiles()?.map { file ->
            FileEntry(
                name = file.name,
                path = runtimeManager.toVirtualPath(file.absolutePath),
                isDirectory = file.isDirectory,
                size = if (file.isFile) file.length() else 0,
                modifiedTime = file.lastModified(),
                isHidden = file.name.startsWith(".")
            )
        }?.sortedWith(compareByDescending<FileEntry> { it.isDirectory }.thenBy { it.name.lowercase() })
            ?: emptyList()
    }

    /**
     * Read file content
     */
    fun readFile(virtualPath: String): String {
        val file = resolvePath(virtualPath)
        
        if (!file.exists()) {
            throw IOException("File not found: $virtualPath")
        }
        if (!file.isFile) {
            throw IOException("Not a file: $virtualPath")
        }
        if (file.length() > MAX_FILE_SIZE) {
            throw IOException("File too large: ${file.length()} bytes (max: $MAX_FILE_SIZE)")
        }
        
        return file.readText(Charsets.UTF_8)
    }

    /**
     * Read file as base64 (for binary files)
     */
    fun readFileBase64(virtualPath: String): String {
        val file = resolvePath(virtualPath)
        
        if (!file.exists()) {
            throw IOException("File not found: $virtualPath")
        }
        
        return android.util.Base64.encodeToString(file.readBytes(), android.util.Base64.NO_WRAP)
    }

    /**
     * Write content to file
     */
    fun writeFile(virtualPath: String, content: String) {
        val file = resolvePath(virtualPath)
        
        // Create parent directories if needed
        file.parentFile?.mkdirs()
        
        file.writeText(content, Charsets.UTF_8)
        Log.d(TAG, "Wrote ${content.length} chars to $virtualPath")
    }

    /**
     * Write base64 content to file
     */
    fun writeFileBase64(virtualPath: String, base64Content: String) {
        val file = resolvePath(virtualPath)
        file.parentFile?.mkdirs()
        
        val bytes = android.util.Base64.decode(base64Content, android.util.Base64.NO_WRAP)
        file.writeBytes(bytes)
    }

    /**
     * Append content to file
     */
    fun appendFile(virtualPath: String, content: String) {
        val file = resolvePath(virtualPath)
        file.parentFile?.mkdirs()
        file.appendText(content, Charsets.UTF_8)
    }

    /**
     * Create directory
     */
    fun mkdir(virtualPath: String, recursive: Boolean = true) {
        val dir = resolvePath(virtualPath)
        
        val success = if (recursive) dir.mkdirs() else dir.mkdir()
        if (!success && !dir.exists()) {
            throw IOException("Failed to create directory: $virtualPath")
        }
    }

    /**
     * Create empty file
     */
    fun touch(virtualPath: String) {
        val file = resolvePath(virtualPath)
        file.parentFile?.mkdirs()
        
        if (!file.exists()) {
            file.createNewFile()
        } else {
            file.setLastModified(System.currentTimeMillis())
        }
    }

    /**
     * Rename/move file or directory
     */
    fun rename(oldPath: String, newPath: String) {
        val oldFile = resolvePath(oldPath)
        val newFile = resolvePath(newPath)
        
        if (!oldFile.exists()) {
            throw IOException("Source not found: $oldPath")
        }
        
        newFile.parentFile?.mkdirs()
        
        if (!oldFile.renameTo(newFile)) {
            throw IOException("Failed to rename: $oldPath -> $newPath")
        }
    }

    /**
     * Copy file or directory
     */
    fun copy(sourcePath: String, destPath: String) {
        val source = resolvePath(sourcePath)
        val dest = resolvePath(destPath)
        
        if (!source.exists()) {
            throw IOException("Source not found: $sourcePath")
        }
        
        source.copyRecursively(dest, overwrite = true)
    }

    /**
     * Delete file or directory
     */
    fun delete(virtualPath: String, recursive: Boolean = true) {
        val file = resolvePath(virtualPath)
        
        if (!file.exists()) {
            return // Already deleted
        }
        
        // Prevent deleting protected directories
        val protectedPaths = listOf(
            runtimeManager.getBinDir(),
            runtimeManager.getLibDir()
        )
        
        if (protectedPaths.any { file.absolutePath.startsWith(it) }) {
            throw SecurityException("Cannot delete protected runtime files")
        }
        
        val success = if (recursive) file.deleteRecursively() else file.delete()
        if (!success) {
            throw IOException("Failed to delete: $virtualPath")
        }
    }

    /**
     * Get file/directory stats
     */
    fun stat(virtualPath: String): FileEntry {
        val file = resolvePath(virtualPath)
        
        if (!file.exists()) {
            throw IOException("Path not found: $virtualPath")
        }
        
        return FileEntry(
            name = file.name,
            path = runtimeManager.toVirtualPath(file.absolutePath),
            isDirectory = file.isDirectory,
            size = if (file.isFile) file.length() else 0,
            modifiedTime = file.lastModified(),
            isHidden = file.name.startsWith("."),
            isReadable = file.canRead(),
            isWritable = file.canWrite(),
            isExecutable = file.canExecute()
        )
    }

    /**
     * Check if path exists
     */
    fun exists(virtualPath: String): Boolean {
        return try {
            resolvePath(virtualPath).exists()
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Search for files matching a pattern
     */
    fun search(rootPath: String, pattern: String, maxResults: Int = 100): List<FileEntry> {
        val root = resolvePath(rootPath)
        val results = mutableListOf<FileEntry>()
        val regex = try {
            Regex(pattern, RegexOption.IGNORE_CASE)
        } catch (e: Exception) {
            Regex(Regex.escape(pattern), RegexOption.IGNORE_CASE)
        }
        
        fun searchRecursive(dir: File) {
            if (results.size >= maxResults) return
            
            dir.listFiles()?.forEach { file ->
                if (results.size >= maxResults) return@forEach
                
                if (regex.containsMatchIn(file.name)) {
                    results.add(FileEntry(
                        name = file.name,
                        path = runtimeManager.toVirtualPath(file.absolutePath),
                        isDirectory = file.isDirectory,
                        size = if (file.isFile) file.length() else 0,
                        modifiedTime = file.lastModified(),
                        isHidden = file.name.startsWith(".")
                    ))
                }
                
                if (file.isDirectory && !file.name.startsWith(".") && file.name != "node_modules") {
                    searchRecursive(file)
                }
            }
        }
        
        if (root.isDirectory) {
            searchRecursive(root)
        }
        
        return results
    }

    /**
     * Search file contents (grep)
     */
    fun grep(rootPath: String, pattern: String, maxResults: Int = 50): List<GrepResult> {
        val root = resolvePath(rootPath)
        val results = mutableListOf<GrepResult>()
        val regex = try {
            Regex(pattern)
        } catch (e: Exception) {
            Regex(Regex.escape(pattern))
        }
        
        fun grepRecursive(dir: File) {
            if (results.size >= maxResults) return
            
            dir.listFiles()?.forEach { file ->
                if (results.size >= maxResults) return@forEach
                
                if (file.isFile && file.length() < 1024 * 1024) { // Skip large files
                    try {
                        file.readLines().forEachIndexed { index, line ->
                            if (results.size >= maxResults) return@forEachIndexed
                            
                            if (regex.containsMatchIn(line)) {
                                results.add(GrepResult(
                                    file = runtimeManager.toVirtualPath(file.absolutePath),
                                    line = index + 1,
                                    content = line.trim(),
                                    match = regex.find(line)?.value ?: ""
                                ))
                            }
                        }
                    } catch (e: Exception) {
                        // Skip binary files
                    }
                } else if (file.isDirectory && !file.name.startsWith(".") && file.name != "node_modules") {
                    grepRecursive(file)
                }
            }
        }
        
        if (root.isDirectory) {
            grepRecursive(root)
        }
        
        return results
    }

    /**
     * Start watching a directory for changes
     */
    fun watchDirectory(virtualPath: String, callback: (FileEvent) -> Unit): String {
        val dir = resolvePath(virtualPath)
        val watchId = virtualPath.hashCode().toString()
        
        // Stop existing watcher
        stopWatching(watchId)
        
        @Suppress("DEPRECATION")
        val observer = object : FileObserver(dir.absolutePath, ALL_EVENTS) {
            override fun onEvent(event: Int, path: String?) {
                if (path == null) return
                
                val eventType = when {
                    event and CREATE != 0 -> FileEventType.CREATE
                    event and DELETE != 0 -> FileEventType.DELETE
                    event and MODIFY != 0 -> FileEventType.MODIFY
                    event and MOVED_FROM != 0 -> FileEventType.MOVE
                    event and MOVED_TO != 0 -> FileEventType.MOVE
                    else -> return
                }
                
                callback(FileEvent(
                    type = eventType,
                    path = runtimeManager.toVirtualPath(File(dir, path).absolutePath)
                ))
            }
        }
        
        observer.startWatching()
        watchers[watchId] = observer
        
        return watchId
    }

    /**
     * Stop watching a directory
     */
    fun stopWatching(watchId: String) {
        watchers.remove(watchId)?.stopWatching()
    }

    /**
     * Stop all watchers
     */
    fun stopAllWatchers() {
        watchers.values.forEach { it.stopWatching() }
        watchers.clear()
    }

    /**
     * Get workspace directories
     */
    fun getWorkspaces(): List<FileEntry> {
        return listDir(RuntimeManager.VIRTUAL_WORKSPACES)
            .filter { it.isDirectory }
    }

    /**
     * Open an external (real) folder, e.g. under /storage/emulated/0.
     * Requires all-files access to have been granted; the sandbox check in
     * resolvePath permits /storage, /sdcard and /mnt paths.
     */
    fun openExternalFolder(realPath: String): List<FileEntry> {
        val dir = resolvePath(realPath)
        if (!dir.exists()) throw IOException("Folder not found: $realPath")
        if (!dir.isDirectory) throw IOException("Not a directory: $realPath")

        return dir.listFiles()?.map { file ->
            FileEntry(
                name = file.name,
                path = file.absolutePath,
                isDirectory = file.isDirectory,
                size = if (file.isFile) file.length() else 0,
                modifiedTime = file.lastModified(),
                isHidden = file.name.startsWith("."),
                isReadable = file.canRead(),
                isWritable = file.canWrite(),
                isExecutable = file.canExecute()
            )
        }?.sortedWith(compareByDescending<FileEntry> { it.isDirectory }.thenBy { it.name.lowercase() })
            ?: emptyList()
    }
}

/**
 * Represents a file or directory entry
 */
data class FileEntry(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val size: Long,
    val modifiedTime: Long,
    val isHidden: Boolean = false,
    val isReadable: Boolean = true,
    val isWritable: Boolean = true,
    val isExecutable: Boolean = false
)

/**
 * Represents a grep search result
 */
data class GrepResult(
    val file: String,
    val line: Int,
    val content: String,
    val match: String
)

/**
 * File system event
 */
data class FileEvent(
    val type: FileEventType,
    val path: String
)

enum class FileEventType {
    CREATE, DELETE, MODIFY, MOVE
}
