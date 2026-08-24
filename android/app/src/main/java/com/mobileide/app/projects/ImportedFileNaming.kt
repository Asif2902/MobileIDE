package com.mobileide.app.projects

import java.io.File

/** Filename policy shared by Storage Access Framework document imports. */
object ImportedFileNaming {
    private const val FALLBACK_NAME = "imported-file"

    fun sanitize(displayName: String?): String {
        val leaf = displayName
            ?.substringAfterLast('/')
            ?.substringAfterLast('\\')
            ?.replace(Regex("[\\u0000-\\u001f\\u007f]"), "")
            ?.trim()
            ?.takeIf { it.isNotEmpty() && it != "." && it != ".." }
            ?: FALLBACK_NAME
        return leaf.take(240).ifEmpty { FALLBACK_NAME }
    }

    fun uniqueDestination(directory: File, displayName: String?): File {
        val safeName = sanitize(displayName)
        var candidate = File(directory, safeName)
        if (!candidate.exists()) return candidate

        val dot = safeName.lastIndexOf('.')
        val hasExtension = dot > 0 && dot < safeName.lastIndex
        val stem = if (hasExtension) safeName.substring(0, dot) else safeName
        val extension = if (hasExtension) safeName.substring(dot) else ""
        var suffix = 1
        do {
            candidate = File(directory, "$stem ($suffix)$extension")
            suffix += 1
        } while (candidate.exists())
        return candidate
    }
}
