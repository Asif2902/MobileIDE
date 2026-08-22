package com.mobileide.app.projects

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ProjectRegistryTest {
    private lateinit var root: File
    private lateinit var project: File
    private lateinit var registryFile: File

    @Before
    fun setUp() {
        root = Files.createTempDirectory("adev-project-registry").toFile()
        project = File(root, "workspaces/demo").apply { mkdirs() }
        registryFile = File(root, "metadata/project-registry.properties")
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    @Test
    fun persistsImportProvenanceAndExportHistoryOutsideProject() {
        File(project, "package.json").writeText("{}")
        val registry = ProjectRegistry(registryFile)
        val record = registry.upsert(
            ProjectRecord(
                id = "record-1",
                workspacePath = project.canonicalPath,
                virtualPath = "/root/workspaces/demo",
                projectName = "demo",
                importedAt = 1234L,
                projectType = "node",
                originalSourceKind = "treeUri",
                originalTreeUri = "content://provider/tree/source"
            )
        )
        val exported = registry.recordExport(record, "content://provider/tree/export")

        val reloaded = ProjectRegistry(registryFile).findByWorkspace(project.absolutePath)
        assertNotNull(reloaded)
        assertEquals("record-1", reloaded?.id)
        assertEquals("content://provider/tree/source", reloaded?.originalTreeUri)
        assertEquals("content://provider/tree/export", reloaded?.lastExportUri)
        assertTrue((reloaded?.lastExportAt ?: 0L) >= exported.importedAt)
        assertTrue(registryFile.isFile)
        assertFalse(registryFile.canonicalPath.startsWith(project.canonicalPath + File.separator))
    }

    @Test
    fun ensureReusesExistingProjectIdentity() {
        val registry = ProjectRegistry(registryFile)
        val first = registry.ensure(project, "/root/workspaces/demo")
        val second = registry.ensure(project, "/root/workspaces/demo")
        assertEquals(first.id, second.id)
        assertEquals(1, registry.list().size)
    }

    @Test
    fun replacementImportCannotLeaveDuplicateMetadataForOneWorkspace() {
        val registry = ProjectRegistry(registryFile)
        registry.upsert(
            ProjectRecord(
                id = "old",
                workspacePath = project.canonicalPath,
                virtualPath = "/root/workspaces/demo",
                projectName = "demo",
                importedAt = 1,
                projectType = "node"
            )
        )
        registry.upsert(
            ProjectRecord(
                id = "replacement",
                workspacePath = project.canonicalPath,
                virtualPath = "/root/workspaces/demo",
                projectName = "demo",
                importedAt = 2,
                projectType = "nextjs"
            )
        )

        assertEquals(listOf("replacement"), registry.list().map { it.id })
    }

    @Test
    fun detectsCommonProjectTypes() {
        File(project, "next.config.mjs").writeText("export default {}")
        assertEquals("nextjs", ProjectTypeDetector.detect(project))
        File(project, "next.config.mjs").delete()
        File(project, "vite.config.ts").writeText("export default {}")
        assertEquals("vite", ProjectTypeDetector.detect(project))
        File(project, "vite.config.ts").delete()
        File(project, "package.json").writeText("{}")
        assertEquals("node", ProjectTypeDetector.detect(project))
    }
}
