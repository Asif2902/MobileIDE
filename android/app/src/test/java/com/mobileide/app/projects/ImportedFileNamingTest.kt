package com.mobileide.app.projects

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test

class ImportedFileNamingTest {
    @Test
    fun `sanitizes provider paths without changing extensions or dotfiles`() {
        assertEquals("app.ts", ImportedFileNaming.sanitize("../../app.ts"))
        assertEquals(".env", ImportedFileNaming.sanitize(".env"))
        assertEquals("image.png", ImportedFileNaming.sanitize("folder\\image.png"))
        assertEquals("imported-file", ImportedFileNaming.sanitize(".."))
    }

    @Test
    fun `creates a unique sibling name while preserving extension`() {
        val directory = Files.createTempDirectory("adev-file-import").toFile()
        try {
            directory.resolve("config.json").writeText("one")
            directory.resolve("config (1).json").writeText("two")
            assertEquals(
                "config (2).json",
                ImportedFileNaming.uniqueDestination(directory, "config.json").name
            )
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun `creates a unique dotfile without inventing an extension`() {
        val directory = Files.createTempDirectory("adev-dotfile-import").toFile()
        try {
            directory.resolve(".env").writeText("one")
            assertEquals(
                ".env (1)",
                ImportedFileNaming.uniqueDestination(directory, ".env").name
            )
        } finally {
            directory.deleteRecursively()
        }
    }
}
