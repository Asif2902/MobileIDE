package com.mobileide.app.projects

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.net.URLConnection
import java.nio.file.Files
import java.nio.file.FileVisitResult
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

enum class ProjectTransferDirection {
    IMPORT,
    EXPORT
}

enum class ProjectTransferStatus {
    PLANNING,
    RUNNING,
    FINALIZING,
    COMPLETE,
    FAILED,
    CANCELLED
}

data class ProjectTransferSnapshot(
    val operationId: String,
    val direction: ProjectTransferDirection,
    val status: ProjectTransferStatus,
    val phase: String,
    val filesCopied: Long,
    val totalFiles: Long,
    val bytesCopied: Long,
    val totalBytes: Long,
    val skippedEntries: Long,
    val currentPath: String?
)

sealed class ProjectImportSource {
    abstract val displayName: String?

    data class RawPath(val root: File, override val displayName: String? = null) : ProjectImportSource()
    data class TreeUri(val uri: Uri, override val displayName: String? = null) : ProjectImportSource()
}

sealed class ProjectTransferResult {
    data class Import(
        val project: ProjectRecord,
        val path: String,
        val virtualPath: String
    ) : ProjectTransferResult()

    data class Export(
        val project: ProjectRecord,
        val destinationTreeUri: String,
        val projectDocumentUri: String,
        val exportedName: String
    ) : ProjectTransferResult()
}

interface ProjectTransferListener {
    fun onProgress(snapshot: ProjectTransferSnapshot)
    fun onComplete(snapshot: ProjectTransferSnapshot, result: ProjectTransferResult)
    fun onError(snapshot: ProjectTransferSnapshot, code: String, message: String)
}

private class ProjectTransferFailure(val code: String, message: String) : IOException(message)
private class ProjectTransferCancelled : IOException("Project transfer was cancelled")

private data class PlannedEntry(
    val relativePath: String,
    val directory: Boolean,
    val bytes: Long,
    val openInput: (() -> InputStream)?
)

private data class TransferPlan(
    val entries: List<PlannedEntry>,
    val totalFiles: Long,
    val totalBytes: Long,
    val skippedEntries: Long
)

/**
 * Lifecycle-owned import/export engine. Transfers run outside the UI thread,
 * publish bounded progress, support cancellation, and never follow raw-path
 * symbolic links. Private imports stage outside the visible workspaces root.
 */
class ProjectTransferManager(
    context: Context,
    private val workspacePolicy: WorkspaceLocationPolicy,
    private val workspacesRoot: File,
    private val virtualWorkspacesRoot: String,
    private val registry: ProjectRegistry,
    private val listener: ProjectTransferListener
) {
    private val appContext = context.applicationContext
    private val resolver: ContentResolver = appContext.contentResolver
    private val stagingRoot = File(appContext.filesDir, "project-transfers")
    private val executor = Executors.newFixedThreadPool(2) { runnable ->
        Thread(runnable, "adev-project-transfer").apply { isDaemon = true }
    }
    private val operations = ConcurrentHashMap<String, Operation>()
    private val finalizationLock = Any()

    private class Operation(
        val id: String,
        val direction: ProjectTransferDirection
    ) {
        val cancelled = AtomicBoolean(false)
        val filesCopied = AtomicLong(0)
        val totalFiles = AtomicLong(0)
        val bytesCopied = AtomicLong(0)
        val totalBytes = AtomicLong(0)
        val skippedEntries = AtomicLong(0)
        private val lastProgressNanos = AtomicLong(0)
        @Volatile var status: ProjectTransferStatus = ProjectTransferStatus.PLANNING
        @Volatile var phase: String = "planning"
        @Volatile var currentPath: String? = null

        fun snapshot() = ProjectTransferSnapshot(
            operationId = id,
            direction = direction,
            status = status,
            phase = phase,
            filesCopied = filesCopied.get(),
            totalFiles = totalFiles.get(),
            bytesCopied = bytesCopied.get(),
            totalBytes = totalBytes.get(),
            skippedEntries = skippedEntries.get(),
            currentPath = currentPath
        )

        fun shouldEmit(force: Boolean): Boolean {
            if (force) {
                lastProgressNanos.set(System.nanoTime())
                return true
            }
            val now = System.nanoTime()
            val previous = lastProgressNanos.get()
            return now - previous >= 100_000_000L && lastProgressNanos.compareAndSet(previous, now)
        }
    }

    fun beginImport(
        source: ProjectImportSource,
        requestedName: String?,
        options: ProjectTransferOptions,
        completion: ((Result<ProjectTransferResult.Import>) -> Unit)? = null
    ): String {
        val operation = Operation(UUID.randomUUID().toString(), ProjectTransferDirection.IMPORT)
        operations[operation.id] = operation
        executor.execute {
            try {
                val result = importProject(operation, source, requestedName, options)
                operation.status = ProjectTransferStatus.COMPLETE
                operation.phase = "complete"
                operation.currentPath = null
                emit(operation, force = true)
                listener.onComplete(operation.snapshot(), result)
                completion?.invoke(Result.success(result))
            } catch (_: ProjectTransferCancelled) {
                operation.status = ProjectTransferStatus.CANCELLED
                operation.phase = "cancelled"
                operation.currentPath = null
                emit(operation, force = true)
                listener.onError(operation.snapshot(), "TRANSFER_CANCELLED", "Project transfer was cancelled")
                completion?.invoke(Result.failure(ProjectTransferCancelled()))
            } catch (error: Exception) {
                operation.status = ProjectTransferStatus.FAILED
                operation.phase = "failed"
                operation.currentPath = null
                emit(operation, force = true)
                val code = (error as? ProjectTransferFailure)?.code ?: "PROJECT_IMPORT_ERROR"
                listener.onError(operation.snapshot(), code, error.message ?: error.javaClass.simpleName)
                completion?.invoke(Result.failure(error))
            }
        }
        return operation.id
    }

    fun beginExport(
        workspacePath: File,
        destinationTreeUri: Uri,
        requestedName: String?,
        options: ProjectTransferOptions
    ): String {
        val operation = Operation(UUID.randomUUID().toString(), ProjectTransferDirection.EXPORT)
        operations[operation.id] = operation
        executor.execute {
            try {
                val result = exportProject(
                    operation,
                    workspacePath,
                    destinationTreeUri,
                    requestedName,
                    options
                )
                operation.status = ProjectTransferStatus.COMPLETE
                operation.phase = "complete"
                operation.currentPath = null
                emit(operation, force = true)
                listener.onComplete(operation.snapshot(), result)
            } catch (_: ProjectTransferCancelled) {
                operation.status = ProjectTransferStatus.CANCELLED
                operation.phase = "cancelled"
                operation.currentPath = null
                emit(operation, force = true)
                listener.onError(operation.snapshot(), "TRANSFER_CANCELLED", "Project transfer was cancelled")
            } catch (error: Exception) {
                operation.status = ProjectTransferStatus.FAILED
                operation.phase = "failed"
                operation.currentPath = null
                emit(operation, force = true)
                val code = (error as? ProjectTransferFailure)?.code ?: "PROJECT_EXPORT_ERROR"
                listener.onError(operation.snapshot(), code, error.message ?: error.javaClass.simpleName)
            }
        }
        return operation.id
    }

    fun snapshot(operationId: String): ProjectTransferSnapshot? = operations[operationId]?.snapshot()

    fun cancel(operationId: String): Boolean {
        val operation = operations[operationId] ?: return false
        if (operation.status in setOf(
                ProjectTransferStatus.COMPLETE,
                ProjectTransferStatus.FAILED,
                ProjectTransferStatus.CANCELLED
            )
        ) return false
        operation.cancelled.set(true)
        return true
    }

    fun close() {
        operations.values.forEach { it.cancelled.set(true) }
        executor.shutdownNow()
    }

    private fun importProject(
        operation: Operation,
        source: ProjectImportSource,
        requestedName: String?,
        options: ProjectTransferOptions
    ): ProjectTransferResult.Import {
        checkCancelled(operation)
        val sourceName = source.displayName?.takeIf { it.isNotBlank() } ?: when (source) {
            is ProjectImportSource.RawPath -> source.root.name
            is ProjectImportSource.TreeUri ->
                DocumentFile.fromTreeUri(appContext, source.uri)?.name ?: "imported-project"
        }
        val baseName = WorkspaceLocationPolicy.safeProjectName(requestedName ?: sourceName)
        operation.phase = "scanning"
        emit(operation, force = true)
        val plan = when (source) {
            is ProjectImportSource.RawPath ->
                planRaw(operation, workspacePolicy.requireApprovedImportSource(source.root), options)
            is ProjectImportSource.TreeUri -> planTree(operation, source.uri, options)
        }
        applyPlanTotals(operation, plan)
        checkCancelled(operation)

        val staging = File(stagingRoot, operation.id)
        deleteTreeNoFollow(staging)
        if (!staging.mkdirs()) throw IOException("Cannot create private import staging directory")
        try {
            operation.status = ProjectTransferStatus.RUNNING
            operation.phase = "copying"
            emit(operation, force = true)
            copyPlanToPrivate(operation, plan, staging)
            checkCancelled(operation)

            operation.status = ProjectTransferStatus.FINALIZING
            operation.phase = "finalizing"
            operation.currentPath = null
            emit(operation, force = true)
            val destination = finalizePrivateImport(operation, staging, baseName, options.conflictPolicy)
            val virtualPath = "$virtualWorkspacesRoot/${destination.name}"
            val sourceKind = if (source is ProjectImportSource.RawPath) "rawPath" else "treeUri"
            val project = registry.upsert(
                ProjectRecord(
                    id = UUID.randomUUID().toString(),
                    workspacePath = destination.canonicalPath,
                    virtualPath = virtualPath,
                    projectName = destination.name,
                    importedAt = System.currentTimeMillis(),
                    projectType = ProjectTypeDetector.detect(destination),
                    originalSourceKind = sourceKind,
                    originalImportedPath = (source as? ProjectImportSource.RawPath)?.root?.canonicalPath,
                    originalTreeUri = (source as? ProjectImportSource.TreeUri)?.uri?.toString()
                )
            )
            return ProjectTransferResult.Import(project, destination.absolutePath, virtualPath)
        } finally {
            deleteTreeNoFollow(staging)
        }
    }

    private fun exportProject(
        operation: Operation,
        requestedWorkspace: File,
        destinationTreeUri: Uri,
        requestedName: String?,
        options: ProjectTransferOptions
    ): ProjectTransferResult.Export {
        val workspace = workspacePolicy.requireProjectForExport(requestedWorkspace)
        val destinationTree = DocumentFile.fromTreeUri(appContext, destinationTreeUri)
            ?: throw ProjectTransferFailure("SAF_TREE_UNAVAILABLE", "Selected export folder is unavailable")
        if (!destinationTree.isDirectory || !destinationTree.canWrite()) {
            throw ProjectTransferFailure("SAF_TREE_NOT_WRITABLE", "Selected export folder is not writable")
        }
        operation.phase = "scanning"
        emit(operation, force = true)
        val plan = planRaw(operation, workspace, options)
        applyPlanTotals(operation, plan)
        checkCancelled(operation)

        val baseName = WorkspaceLocationPolicy.safeProjectName(requestedName ?: workspace.name)
        operation.status = ProjectTransferStatus.RUNNING
        operation.phase = "copying"
        emit(operation, force = true)

        var temporary: DocumentFile? = null
        val destination: DocumentFile
        val exportedName: String
        if (options.conflictPolicy == ProjectConflictPolicy.MERGE) {
            exportedName = baseName
            destination = destinationTree.findFile(exportedName)?.also {
                if (!it.isDirectory) {
                    throw ProjectTransferFailure(
                        "EXPORT_CONFLICT",
                        "A non-folder item named $exportedName already exists"
                    )
                }
            } ?: destinationTree.createDirectory(exportedName)
                ?: throw IOException("Cannot create export folder $exportedName")
        } else {
            exportedName = when (options.conflictPolicy) {
                ProjectConflictPolicy.UNIQUE -> WorkspaceLocationPolicy.uniqueName(baseName) {
                    destinationTree.findFile(it) != null
                }
                ProjectConflictPolicy.CANCEL -> {
                    if (destinationTree.findFile(baseName) != null) {
                        throw ProjectTransferFailure("EXPORT_CONFLICT", "Export destination $baseName already exists")
                    }
                    baseName
                }
                ProjectConflictPolicy.REPLACE -> baseName
                ProjectConflictPolicy.MERGE -> error("handled above")
            }
            val temporaryName = WorkspaceLocationPolicy.uniqueName("ADEV-export-${operation.id}-tmp") {
                destinationTree.findFile(it) != null
            }
            temporary = destinationTree.createDirectory(temporaryName)
                ?: throw IOException("Cannot create SAF export staging folder")
            destination = temporary
        }

        try {
            copyPlanToDocument(operation, plan, destination)
            checkCancelled(operation)
            operation.status = ProjectTransferStatus.FINALIZING
            operation.phase = "finalizing"
            operation.currentPath = null
            emit(operation, force = true)
            val published = if (options.conflictPolicy == ProjectConflictPolicy.MERGE) {
                destination
            } else {
                publishSafDirectory(
                    destinationTree,
                    requireNotNull(temporary),
                    exportedName,
                    options.conflictPolicy
                )
            }
            temporary = null
            val virtualPath = "$virtualWorkspacesRoot/${workspace.name}"
            val record = registry.recordExport(
                registry.ensure(workspace, virtualPath),
                destinationTreeUri.toString()
            )
            return ProjectTransferResult.Export(
                project = record,
                destinationTreeUri = destinationTreeUri.toString(),
                projectDocumentUri = published.uri.toString(),
                exportedName = exportedName
            )
        } finally {
            temporary?.delete()
        }
    }

    private fun planRaw(
        operation: Operation,
        root: File,
        options: ProjectTransferOptions
    ): TransferPlan {
        val scan = RawProjectScanner.scan(root, options) { checkCancelled(operation) }
        return TransferPlan(
            entries = scan.entries.map { entry ->
                PlannedEntry(
                    relativePath = entry.relativePath,
                    directory = entry.directory,
                    bytes = entry.bytes,
                    openInput = if (entry.directory) null else ({ FileInputStream(entry.file) })
                )
            },
            totalFiles = scan.totalFiles,
            totalBytes = scan.totalBytes,
            skippedEntries = scan.skippedEntries
        )
    }

    private fun planTree(
        operation: Operation,
        treeUri: Uri,
        options: ProjectTransferOptions
    ): TransferPlan {
        val tree = DocumentFile.fromTreeUri(appContext, treeUri)
            ?: throw ProjectTransferFailure("SAF_TREE_UNAVAILABLE", "Selected project folder is unavailable")
        if (!tree.isDirectory || !tree.canRead()) {
            throw ProjectTransferFailure("SAF_TREE_NOT_READABLE", "Selected project folder is not readable")
        }
        val entries = mutableListOf<PlannedEntry>()
        val visited = mutableSetOf<String>()
        var files = 0L
        var bytes = 0L
        var skipped = 0L

        fun visit(directory: DocumentFile, prefix: String, depth: Int) {
            if (depth > 128) throw IOException("Project tree exceeds maximum directory depth")
            if (!visited.add(directory.uri.toString())) {
                throw IOException("Project document tree contains a cycle")
            }
            directory.listFiles().forEach { child ->
                checkCancelled(operation)
                val name = requireSafeDocumentName(child.name)
                val relative = if (prefix.isEmpty()) name else "$prefix/$name"
                if (child.isDirectory) {
                    if (!ProjectTransferFilter.include(relative, true, options)) {
                        skipped += 1
                    } else {
                        entries += PlannedEntry(relative, true, 0, null)
                        visit(child, relative, depth + 1)
                    }
                } else if (child.isFile) {
                    if (!ProjectTransferFilter.include(relative, false, options)) {
                        skipped += 1
                    } else {
                        val length = child.length().coerceAtLeast(0)
                        val uri = child.uri
                        entries += PlannedEntry(relative, false, length) {
                            resolver.openInputStream(uri)
                                ?: throw IOException("Cannot read document $relative")
                        }
                        files += 1
                        bytes += length
                    }
                } else {
                    skipped += 1
                }
            }
        }
        visit(tree, "", 0)
        return TransferPlan(entries, files, bytes, skipped)
    }

    private fun copyPlanToPrivate(operation: Operation, plan: TransferPlan, destination: File) {
        plan.entries.forEach { entry ->
            checkCancelled(operation)
            operation.currentPath = entry.relativePath
            if (entry.directory) {
                val directory = containedTarget(destination, entry.relativePath)
                if (!directory.mkdirs() && !directory.isDirectory) {
                    throw IOException("Cannot create imported directory ${entry.relativePath}")
                }
            } else {
                val target = containedTarget(destination, entry.relativePath)
                target.parentFile?.let { parent ->
                    if (!parent.mkdirs() && !parent.isDirectory) {
                        throw IOException("Cannot create imported parent directory")
                    }
                }
                requireNotNull(entry.openInput).invoke().use { input ->
                    target.outputStream().use { output -> copyStream(operation, input, output) }
                }
                operation.filesCopied.incrementAndGet()
            }
            emit(operation, force = !entry.directory)
        }
    }

    private fun copyPlanToDocument(
        operation: Operation,
        plan: TransferPlan,
        destination: DocumentFile
    ) {
        val directories = mutableMapOf("" to destination)
        plan.entries.forEach { entry ->
            checkCancelled(operation)
            operation.currentPath = entry.relativePath
            if (entry.directory) {
                ensureDocumentDirectory(destination, directories, entry.relativePath)
            } else {
                val normalized = entry.relativePath.replace('\\', '/')
                val parentPath = normalized.substringBeforeLast('/', "")
                val fileName = requireSafeDocumentName(normalized.substringAfterLast('/'))
                val parent = ensureDocumentDirectory(destination, directories, parentPath)
                parent.findFile(fileName)?.let { existing ->
                    if (!existing.delete()) throw IOException("Cannot replace exported file $normalized")
                }
                val mime = URLConnection.guessContentTypeFromName(fileName) ?: "application/octet-stream"
                val document = parent.createFile(mime, fileName)
                    ?: throw IOException("Cannot create exported file $normalized")
                requireNotNull(entry.openInput).invoke().use { input ->
                    resolver.openOutputStream(document.uri, "w")?.use { output ->
                        copyStream(operation, input, output)
                    } ?: throw IOException("Cannot write exported file $normalized")
                }
                operation.filesCopied.incrementAndGet()
            }
            emit(operation, force = !entry.directory)
        }
    }

    private fun ensureDocumentDirectory(
        root: DocumentFile,
        cache: MutableMap<String, DocumentFile>,
        path: String
    ): DocumentFile {
        val normalized = path.replace('\\', '/').trim('/')
        if (normalized.isEmpty()) return root
        cache[normalized]?.let { return it }
        var current = root
        var currentPath = ""
        normalized.split('/').forEach { rawSegment ->
            val segment = requireSafeDocumentName(rawSegment)
            currentPath = if (currentPath.isEmpty()) segment else "$currentPath/$segment"
            current = cache[currentPath] ?: current.findFile(segment)?.also {
                if (!it.isDirectory) throw IOException("Export path conflicts with file $currentPath")
            } ?: current.createDirectory(segment)
                ?: throw IOException("Cannot create export directory $currentPath")
            cache[currentPath] = current
        }
        return current
    }

    private fun finalizePrivateImport(
        operation: Operation,
        staging: File,
        baseName: String,
        conflictPolicy: ProjectConflictPolicy
    ): File = synchronized(finalizationLock) {
        checkCancelled(operation)
        if (!workspacesRoot.mkdirs() && !workspacesRoot.isDirectory) {
            throw IOException("Cannot create private workspace root")
        }
        val targetName = when (conflictPolicy) {
            ProjectConflictPolicy.UNIQUE -> WorkspaceLocationPolicy.uniqueName(baseName) {
                File(workspacesRoot, it).exists()
            }
            else -> baseName
        }
        val destination = File(workspacesRoot, targetName).canonicalFile
        if (destination.parentFile != workspacesRoot.canonicalFile) {
            throw SecurityException("Import destination escaped private workspaces")
        }
        when (conflictPolicy) {
            ProjectConflictPolicy.CANCEL -> {
                if (destination.exists()) {
                    throw ProjectTransferFailure("IMPORT_CONFLICT", "Private project $targetName already exists")
                }
                moveDirectory(staging, destination)
            }
            ProjectConflictPolicy.UNIQUE -> moveDirectory(staging, destination)
            ProjectConflictPolicy.REPLACE -> replacePrivateDirectory(staging, destination)
            ProjectConflictPolicy.MERGE -> {
                if (!destination.exists()) moveDirectory(staging, destination)
                else {
                    if (!destination.isDirectory) {
                        throw ProjectTransferFailure("IMPORT_CONFLICT", "$targetName exists and is not a folder")
                    }
                    mergePrivateDirectory(staging, destination)
                }
            }
        }
        destination
    }

    private fun replacePrivateDirectory(staging: File, destination: File) {
        if (!destination.exists()) {
            moveDirectory(staging, destination)
            return
        }
        val backup = File(workspacesRoot, ".replace-${UUID.randomUUID()}")
        if (!destination.renameTo(backup)) throw IOException("Cannot stage existing project for replacement")
        try {
            moveDirectory(staging, destination)
            deleteTreeNoFollow(backup)
        } catch (error: Exception) {
            deleteTreeNoFollow(destination)
            backup.renameTo(destination)
            throw error
        }
    }

    private fun mergePrivateDirectory(staging: File, destination: File) {
        staging.walkBottomUp().forEach { source ->
            val relative = staging.toPath().relativize(source.toPath()).toString()
            if (relative.isEmpty()) return@forEach
            val target = containedTarget(destination, relative)
            if (source.isDirectory) {
                if (!target.mkdirs() && !target.isDirectory) throw IOException("Cannot merge directory $relative")
            } else {
                target.parentFile?.mkdirs()
                Files.move(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        }
        deleteTreeNoFollow(staging)
    }

    private fun moveDirectory(source: File, destination: File) {
        if (destination.exists()) throw ProjectTransferFailure("IMPORT_CONFLICT", "${destination.name} already exists")
        if (!source.renameTo(destination)) {
            throw IOException("Cannot finalize private workspace import")
        }
    }

    /** Delete a transfer-owned tree without traversing directory symlinks. */
    private fun deleteTreeNoFollow(root: File) {
        val rootPath = root.toPath()
        if (!Files.exists(rootPath, LinkOption.NOFOLLOW_LINKS)) return
        Files.walkFileTree(rootPath, object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                Files.deleteIfExists(file)
                return FileVisitResult.CONTINUE
            }

            override fun postVisitDirectory(directory: Path, error: IOException?): FileVisitResult {
                if (error != null) throw error
                Files.deleteIfExists(directory)
                return FileVisitResult.CONTINUE
            }
        })
    }

    private fun publishSafDirectory(
        parent: DocumentFile,
        staging: DocumentFile,
        finalName: String,
        conflictPolicy: ProjectConflictPolicy
    ): DocumentFile {
        val existing = parent.findFile(finalName)
        if (conflictPolicy == ProjectConflictPolicy.REPLACE && existing != null) {
            val backupName = WorkspaceLocationPolicy.uniqueName("ADEV-backup-$finalName") {
                parent.findFile(it) != null
            }
            if (!existing.renameTo(backupName)) {
                throw IOException("Selected document provider cannot safely replace $finalName")
            }
            if (!staging.renameTo(finalName)) {
                parent.findFile(backupName)?.renameTo(finalName)
                throw IOException("Selected document provider could not publish replacement $finalName")
            }
            parent.findFile(backupName)?.delete()
            return parent.findFile(finalName)
                ?: throw IOException("Published export folder is not visible")
        }
        if (existing != null) {
            throw ProjectTransferFailure("EXPORT_CONFLICT", "Export destination $finalName already exists")
        }
        if (!staging.renameTo(finalName)) {
            throw IOException("Selected document provider cannot finalize export folder $finalName")
        }
        return parent.findFile(finalName)
            ?: throw IOException("Published export folder is not visible")
    }

    private fun copyStream(operation: Operation, input: InputStream, output: java.io.OutputStream) {
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            checkCancelled(operation)
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
            operation.bytesCopied.addAndGet(count.toLong())
            emit(operation, force = false)
        }
        output.flush()
    }

    private fun containedTarget(root: File, relativePath: String): File {
        val target = File(root, relativePath).canonicalFile
        if (!WorkspaceLocationPolicy.isWithin(target, root)) {
            throw SecurityException("Transfer path escaped destination: $relativePath")
        }
        return target
    }

    private fun requireSafeDocumentName(value: String?): String {
        val name = value?.trim().orEmpty()
        if (name.isEmpty() || name == "." || name == ".." ||
            name.contains('/') || name.contains('\\') || name.contains('\u0000')
        ) {
            throw IOException("Document provider returned an unsafe file name")
        }
        return name
    }

    private fun applyPlanTotals(operation: Operation, plan: TransferPlan) {
        operation.totalFiles.set(plan.totalFiles)
        operation.totalBytes.set(plan.totalBytes)
        operation.skippedEntries.set(plan.skippedEntries)
        emit(operation, force = true)
    }

    private fun checkCancelled(operation: Operation) {
        if (operation.cancelled.get() || Thread.currentThread().isInterrupted) {
            throw ProjectTransferCancelled()
        }
    }

    private fun emit(operation: Operation, force: Boolean) {
        if (operation.shouldEmit(force)) listener.onProgress(operation.snapshot())
    }
}
