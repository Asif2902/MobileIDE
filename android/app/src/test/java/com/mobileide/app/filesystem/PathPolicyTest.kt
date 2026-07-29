package com.mobileide.app.filesystem

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PathPolicyTest {
    @Test
    fun acceptsRootAndNestedPathsButRejectsPrefixSiblingAndTraversal() {
        val parent = Files.createTempDirectory("adev-path-policy").toFile()
        try {
            val root = File(parent, "runtime").apply { mkdirs() }
            val nested = File(root, "workspaces/demo/index.js")
            val prefixSibling = File(parent, "runtime-escape/secret")
            val traversal = File(root, "../outside")

            assertTrue(PathPolicy.isWithin(root, root))
            assertTrue(PathPolicy.isWithin(nested, root))
            assertFalse(PathPolicy.isWithin(prefixSibling, root))
            assertFalse(PathPolicy.isWithin(traversal, root))
        } finally {
            parent.deleteRecursively()
        }
    }
}
