package com.mobileide.app.projects

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Properties
import java.util.UUID

data class ProjectRecord(
    val id: String,
    val workspacePath: String,
    val virtualPath: String,
    val projectName: String,
    val importedAt: Long,
    val projectType: String,
    val originalSourceKind: String? = null,
    val originalImportedPath: String? = null,
    val originalTreeUri: String? = null,
    val lastExportUri: String? = null,
    val lastExportAt: Long? = null
)

/**
 * App-private project metadata registry. It intentionally lives outside every
 * project so source/full exports cannot accidentally include ADEV state or
 * credential references. Persistence uses a temporary sibling and atomic move
 * where the filesystem supports it.
 */
class ProjectRegistry(private val registryFile: File) {
    companion object {
        private const val SCHEMA_VERSION = "1"
        private const val SCHEMA_KEY = "schemaVersion"
        private const val PREFIX = "project."
    }

    @Synchronized
    fun list(): List<ProjectRecord> = readRecords().sortedBy { it.projectName.lowercase() }

    @Synchronized
    fun findByWorkspace(workspacePath: String): ProjectRecord? {
        val canonical = File(workspacePath).canonicalPath
        return readRecords().firstOrNull {
            try {
                File(it.workspacePath).canonicalPath == canonical
            } catch (_: IOException) {
                false
            }
        }
    }

    @Synchronized
    fun upsert(record: ProjectRecord): ProjectRecord {
        val records = readRecords().associateBy { it.id }.toMutableMap()
        val canonicalWorkspace = File(record.workspacePath).canonicalPath
        records.entries.removeAll { (id, existing) ->
            id != record.id && runCatching {
                File(existing.workspacePath).canonicalPath == canonicalWorkspace
            }.getOrDefault(false)
        }
        records[record.id] = record
        writeRecords(records.values)
        return record
    }

    @Synchronized
    fun ensure(
        workspace: File,
        virtualPath: String,
        projectType: String = ProjectTypeDetector.detect(workspace)
    ): ProjectRecord {
        findByWorkspace(workspace.absolutePath)?.let { return it }
        return upsert(
            ProjectRecord(
                id = UUID.randomUUID().toString(),
                workspacePath = workspace.canonicalPath,
                virtualPath = virtualPath,
                projectName = workspace.name,
                importedAt = System.currentTimeMillis(),
                projectType = projectType
            )
        )
    }

    @Synchronized
    fun recordExport(record: ProjectRecord, destinationTreeUri: String): ProjectRecord {
        val updated = record.copy(
            lastExportUri = destinationTreeUri,
            lastExportAt = System.currentTimeMillis()
        )
        return upsert(updated)
    }

    private fun readRecords(): List<ProjectRecord> {
        if (!registryFile.isFile) return emptyList()
        val properties = Properties()
        FileInputStream(registryFile).use(properties::load)
        val schema = properties.getProperty(SCHEMA_KEY)
        if (schema != SCHEMA_VERSION) {
            throw IOException("Unsupported project registry schema: ${schema ?: "missing"}")
        }
        val ids = properties.stringPropertyNames()
            .asSequence()
            .filter { it.startsWith(PREFIX) }
            .mapNotNull { key -> key.removePrefix(PREFIX).substringBefore('.').takeIf(String::isNotEmpty) }
            .toSet()
        return ids.mapNotNull { id -> decodeRecord(properties, id) }
    }

    private fun decodeRecord(properties: Properties, id: String): ProjectRecord? {
        fun value(name: String): String? = properties.getProperty("$PREFIX$id.$name")
        val workspacePath = value("workspacePath") ?: return null
        val virtualPath = value("virtualPath") ?: return null
        val projectName = value("projectName") ?: return null
        val importedAt = value("importedAt")?.toLongOrNull() ?: return null
        val projectType = value("projectType") ?: "unknown"
        return ProjectRecord(
            id = id,
            workspacePath = workspacePath,
            virtualPath = virtualPath,
            projectName = projectName,
            importedAt = importedAt,
            projectType = projectType,
            originalSourceKind = value("originalSourceKind"),
            originalImportedPath = value("originalImportedPath"),
            originalTreeUri = value("originalTreeUri"),
            lastExportUri = value("lastExportUri"),
            lastExportAt = value("lastExportAt")?.toLongOrNull()
        )
    }

    private fun writeRecords(records: Collection<ProjectRecord>) {
        registryFile.parentFile?.let { parent ->
            if (!parent.mkdirs() && !parent.isDirectory) {
                throw IOException("Cannot create project metadata directory")
            }
        }
        val properties = Properties().apply { setProperty(SCHEMA_KEY, SCHEMA_VERSION) }
        records.forEach { record ->
            fun put(name: String, value: Any?) {
                if (value != null) properties.setProperty("$PREFIX${record.id}.$name", value.toString())
            }
            put("workspacePath", record.workspacePath)
            put("virtualPath", record.virtualPath)
            put("projectName", record.projectName)
            put("importedAt", record.importedAt)
            put("projectType", record.projectType)
            put("originalSourceKind", record.originalSourceKind)
            put("originalImportedPath", record.originalImportedPath)
            put("originalTreeUri", record.originalTreeUri)
            put("lastExportUri", record.lastExportUri)
            put("lastExportAt", record.lastExportAt)
        }
        val temporary = File(registryFile.parentFile, ".${registryFile.name}.${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temporary).use { output ->
                properties.store(output, "ADEV project registry; no credentials or project contents")
                output.fd.sync()
            }
            try {
                Files.move(
                    temporary.toPath(),
                    registryFile.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING
                )
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(
                    temporary.toPath(),
                    registryFile.toPath(),
                    StandardCopyOption.REPLACE_EXISTING
                )
            }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }
}

object ProjectTypeDetector {
    fun detect(project: File): String = when {
        listOf("next.config.js", "next.config.mjs", "next.config.ts").any { File(project, it).isFile } -> "nextjs"
        listOf("vite.config.js", "vite.config.mjs", "vite.config.ts").any { File(project, it).isFile } -> "vite"
        File(project, "package.json").isFile -> "node"
        listOf("pyproject.toml", "requirements.txt", "setup.py").any { File(project, it).isFile } -> "python"
        File(project, ".git").isDirectory -> "git"
        else -> "generic"
    }
}
