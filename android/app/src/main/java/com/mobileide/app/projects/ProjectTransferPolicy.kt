package com.mobileide.app.projects

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.FileVisitResult
import java.nio.file.attribute.BasicFileAttributes

enum class ProjectTransferMode {
    SOURCE,
    FULL
}

enum class ProjectConflictPolicy {
    UNIQUE,
    MERGE,
    REPLACE,
    CANCEL
}

data class ProjectTransferOptions(
    val mode: ProjectTransferMode = ProjectTransferMode.SOURCE,
    val includeGit: Boolean = false,
    val includeHidden: Boolean = true,
    val includeSecrets: Boolean = false,
    val conflictPolicy: ProjectConflictPolicy = ProjectConflictPolicy.UNIQUE
)

data class WorkspaceAssessmentResult(
    val path: String,
    val privateWorkspace: Boolean,
    val sharedStorage: Boolean,
    val nativeBuilds: Boolean,
    val executableModes: Boolean,
    val symlinks: Boolean,
    val caseSensitiveNames: Boolean,
    val requiresPrivateImport: Boolean,
    val reason: String?
)

/**
 * Segment-aware workspace and external-storage policy shared by the React
 * bridge and the transfer engine. A path is a development workspace only when
 * it is below RuntimeManager's actual workspaces root; arbitrary filesDir
 * content is never advertised as a project.
 */
class WorkspaceLocationPolicy(
    private val workspacesRoot: File,
    externalRoots: Collection<File>
) {
    private val canonicalWorkspacesRoot = workspacesRoot.canonicalFile
    private val canonicalExternalRoots = externalRoots.mapNotNull { root ->
        try {
            root.canonicalFile
        } catch (_: IOException) {
            null
        }
    }.distinctBy { it.absolutePath }

    fun assess(path: File): WorkspaceAssessmentResult {
        val canonical = path.canonicalFile
        if (!canonical.isDirectory) throw IOException("Workspace is not a directory")
        val privateWorkspace = isWithin(canonical, canonicalWorkspacesRoot)
        val sharedStorage = canonicalExternalRoots.any { isWithin(canonical, it) }
        val reason = when {
            privateWorkspace -> null
            sharedStorage ->
                "This project is stored on Android shared storage. Some development tools require filesystem features that are unavailable here, including symbolic links. Import this project into the ADEV workspace to continue."
            else ->
                "This folder is outside the ADEV private workspace and cannot be used for full development safely. Import it into the ADEV workspace to continue."
        }
        return WorkspaceAssessmentResult(
            path = canonical.absolutePath,
            privateWorkspace = privateWorkspace,
            sharedStorage = sharedStorage,
            nativeBuilds = privateWorkspace,
            executableModes = privateWorkspace,
            symlinks = privateWorkspace,
            caseSensitiveNames = privateWorkspace,
            requiresPrivateImport = !privateWorkspace,
            reason = reason
        )
    }

    fun requireApprovedImportSource(path: File): File {
        val canonical = path.canonicalFile
        if (!canonical.isDirectory) throw IOException("Workspace is not a directory")
        if (!canonicalExternalRoots.any { isWithin(canonical, it) }) {
            throw SecurityException(
                "Raw project imports are limited to approved user-visible storage roots; use the Android folder picker for other locations."
            )
        }
        return canonical
    }

    fun requireProjectForExport(path: File): File {
        val canonical = path.canonicalFile
        if (!canonical.isDirectory) throw IOException("Project is not a directory")
        if (canonical.parentFile?.canonicalFile != canonicalWorkspacesRoot) {
            throw SecurityException(
                "Export source must be one project folder directly inside ${canonicalWorkspacesRoot.absolutePath}"
            )
        }
        return canonical
    }

    companion object {
        fun isWithin(file: File, root: File): Boolean {
            val childPath = file.canonicalFile.toPath()
            val rootPath = root.canonicalFile.toPath()
            return childPath == rootPath || childPath.startsWith(rootPath)
        }

        fun safeProjectName(value: String?): String {
            val normalized = value
                ?.trim()
                ?.replace(Regex("[^A-Za-z0-9._-]+"), "-")
                ?.trim('-', '.')
                ?.take(96)
                .orEmpty()
            return normalized.takeUnless { it.isEmpty() || it == "." || it == ".." }
                ?: "imported-project"
        }

        fun uniqueName(baseName: String, exists: (String) -> Boolean): String {
            if (!exists(baseName)) return baseName
            var suffix = 1
            while (exists("$baseName-$suffix")) suffix += 1
            return "$baseName-$suffix"
        }
    }
}

/** Copy policy shared by raw-path and SAF transfers. */
object ProjectTransferFilter {
    private val generatedDirectories = setOf(
        "node_modules",
        ".next",
        "dist",
        "build",
        ".cache",
        "coverage",
        ".gradle",
        "__pycache__",
        ".turbo",
        ".vite",
        "target"
    )

    private val exactSecretNames = setOf(
        ".env",
        ".npmrc",
        ".netrc",
        ".git-credentials",
        "credentials.json",
        "service-account.json",
        "wallet.json",
        "wallet.dat",
        "keystore.json",
        "id_rsa",
        "id_ed25519"
    )

    fun include(relativePath: String, directory: Boolean, options: ProjectTransferOptions): Boolean {
        val segments = relativePath
            .replace('\\', '/')
            .split('/')
            .filter { it.isNotEmpty() }
        if (segments.isEmpty()) return true
        if (segments.any { it == "." || it == ".." }) return false

        if (!options.includeGit && segments.any { it == ".git" }) return false
        if (!options.includeHidden && segments.anyIndexed { index, segment ->
                if (!segment.startsWith('.') || segment == ".git") return@anyIndexed false
                val secretFileOptIn =
                    index == segments.lastIndex && !directory &&
                        options.includeSecrets && isSensitiveFile(segment)
                !secretFileOptIn
            }
        ) return false
        if (options.mode == ProjectTransferMode.SOURCE &&
            segments.dropLast(if (directory) 0 else 1).any { it in generatedDirectories }
        ) {
            return false
        }
        if (options.mode == ProjectTransferMode.SOURCE && directory && segments.last() in generatedDirectories) {
            return false
        }
        if (!options.includeSecrets && !directory && isSensitiveFile(segments.last())) return false
        return true
    }

    private inline fun <T> List<T>.anyIndexed(predicate: (Int, T) -> Boolean): Boolean {
        indices.forEach { index -> if (predicate(index, this[index])) return true }
        return false
    }

    fun isSensitiveFile(fileName: String): Boolean {
        val lower = fileName.lowercase()
        if (lower in exactSecretNames) return true
        if (lower.startsWith(".env.") && lower !in setOf(".env.example", ".env.sample", ".env.template")) {
            return true
        }
        return lower.endsWith(".pem") ||
            lower.endsWith(".key") ||
            lower.endsWith(".p12") ||
            lower.endsWith(".pfx") ||
            lower.endsWith(".jks") ||
            lower.endsWith(".keystore") ||
            lower.startsWith("service-account-") && lower.endsWith(".json") ||
            lower.startsWith("wallet-") && lower.endsWith(".json")
    }
}

data class RawProjectEntry(
    val file: File,
    val relativePath: String,
    val directory: Boolean,
    val bytes: Long
)

data class RawProjectScan(
    val entries: List<RawProjectEntry>,
    val totalFiles: Long,
    val totalBytes: Long,
    val skippedEntries: Long
)

/**
 * Pure-JVM scanner used by the transfer service and unit tests. It never asks
 * walkFileTree to follow symbolic links and validates every real entry against
 * the selected root before publishing it to a copy plan.
 */
object RawProjectScanner {
    fun scan(
        root: File,
        options: ProjectTransferOptions,
        cancelCheck: () -> Unit = {}
    ): RawProjectScan {
        val canonicalRoot = root.canonicalFile
        if (!canonicalRoot.isDirectory) throw IOException("Project source is not a directory")
        val entries = mutableListOf<RawProjectEntry>()
        var files = 0L
        var bytes = 0L
        var skipped = 0L
        Files.walkFileTree(canonicalRoot.toPath(), object : SimpleFileVisitor<Path>() {
            override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                cancelCheck()
                if (dir != canonicalRoot.toPath() && Files.isSymbolicLink(dir)) {
                    skipped += 1
                    return FileVisitResult.SKIP_SUBTREE
                }
                val relative = canonicalRoot.toPath().relativize(dir).toString()
                if (relative.isNotEmpty() && !ProjectTransferFilter.include(relative, true, options)) {
                    skipped += 1
                    return FileVisitResult.SKIP_SUBTREE
                }
                if (relative.isNotEmpty()) {
                    val file = dir.toFile().canonicalFile
                    requireContained(file, canonicalRoot)
                    entries += RawProjectEntry(file, relative, true, 0)
                }
                return FileVisitResult.CONTINUE
            }

            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                cancelCheck()
                if (Files.isSymbolicLink(file) || attrs.isSymbolicLink) {
                    skipped += 1
                    return FileVisitResult.CONTINUE
                }
                val relative = canonicalRoot.toPath().relativize(file).toString()
                if (!ProjectTransferFilter.include(relative, false, options)) {
                    skipped += 1
                    return FileVisitResult.CONTINUE
                }
                val canonical = file.toFile().canonicalFile
                requireContained(canonical, canonicalRoot)
                val length = attrs.size().coerceAtLeast(0)
                entries += RawProjectEntry(canonical, relative, false, length)
                files += 1
                bytes += length
                return FileVisitResult.CONTINUE
            }

            override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult {
                throw exc
            }
        })
        return RawProjectScan(entries, files, bytes, skipped)
    }

    private fun requireContained(file: File, root: File) {
        if (!WorkspaceLocationPolicy.isWithin(file, root)) {
            throw SecurityException("Project entry escaped selected source: ${file.absolutePath}")
        }
        // Refuse special filesystem objects. They are neither normal source
        // files nor safely representable through Android SAF.
        val path = file.toPath()
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) &&
            !Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)
        ) {
            throw IOException("Unsupported project entry: ${file.absolutePath}")
        }
    }
}
