package com.mobileide.app.filesystem

import java.io.File
import java.io.IOException

/**
 * Segment-aware containment checks. String prefix checks are unsafe because
 * `/root-other` starts with `/root` and symlinks can escape an allowed tree.
 */
internal object PathPolicy {
    @Throws(IOException::class)
    fun canonical(file: File): File = file.canonicalFile

    @Throws(IOException::class)
    fun isWithin(file: File, root: File): Boolean {
        val childPath = canonical(file).toPath()
        val rootPath = canonical(root).toPath()
        return childPath == rootPath || childPath.startsWith(rootPath)
    }
}
