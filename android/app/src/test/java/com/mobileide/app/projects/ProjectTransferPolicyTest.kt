package com.mobileide.app.projects

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

class ProjectTransferPolicyTest {
    private lateinit var temporaryRoot: File
    private lateinit var workspacesRoot: File
    private lateinit var sharedRoot: File
    private lateinit var policy: WorkspaceLocationPolicy

    @Before
    fun setUp() {
        temporaryRoot = Files.createTempDirectory("adev-project-policy").toFile()
        workspacesRoot = File(temporaryRoot, "app/files/runtime/workspaces").apply { mkdirs() }
        sharedRoot = File(temporaryRoot, "storage/emulated/0").apply { mkdirs() }
        policy = WorkspaceLocationPolicy(workspacesRoot, listOf(sharedRoot))
    }

    @After
    fun tearDown() {
        temporaryRoot.deleteRecursively()
    }

    @Test
    fun assessmentUsesActualRuntimeWorkspacesInsteadOfAllPrivateAppFiles() {
        val privateProject = File(workspacesRoot, "private-app").apply { mkdirs() }
        val unrelatedPrivate = File(temporaryRoot, "app/files/cache/not-a-workspace").apply { mkdirs() }
        val sharedProject = File(sharedRoot, "Projects/shared-app").apply { mkdirs() }

        val privateAssessment = policy.assess(privateProject)
        assertTrue(privateAssessment.privateWorkspace)
        assertFalse(privateAssessment.requiresPrivateImport)
        assertTrue(privateAssessment.nativeBuilds)

        val unrelatedAssessment = policy.assess(unrelatedPrivate)
        assertFalse(unrelatedAssessment.privateWorkspace)
        assertFalse(unrelatedAssessment.sharedStorage)
        assertTrue(unrelatedAssessment.requiresPrivateImport)

        val sharedAssessment = policy.assess(sharedProject)
        assertTrue(sharedAssessment.sharedStorage)
        assertTrue(sharedAssessment.requiresPrivateImport)
        assertFalse(sharedAssessment.symlinks)
    }

    @Test
    fun rawImportsAreLimitedToApprovedVisibleRootsAndExportsToDirectProjects() {
        val approvedSource = File(sharedRoot, "Projects/app").apply { mkdirs() }
        val disallowedSource = File(temporaryRoot, "unapproved/app").apply { mkdirs() }
        assertEquals(approvedSource.canonicalFile, policy.requireApprovedImportSource(approvedSource))
        assertThrows(SecurityException::class.java) {
            policy.requireApprovedImportSource(disallowedSource)
        }

        val project = File(workspacesRoot, "app").apply { mkdirs() }
        val nested = File(project, "packages/mobile").apply { mkdirs() }
        assertEquals(project.canonicalFile, policy.requireProjectForExport(project))
        assertThrows(SecurityException::class.java) { policy.requireProjectForExport(nested) }
        assertThrows(SecurityException::class.java) { policy.requireProjectForExport(approvedSource) }
    }

    @Test
    fun sanitizesNamesAndCreatesDeterministicUniqueNames() {
        assertEquals("my-project", WorkspaceLocationPolicy.safeProjectName("../my project"))
        assertEquals("imported-project", WorkspaceLocationPolicy.safeProjectName("..."))
        val existing = setOf("app", "app-1", "app-2")
        assertEquals("app-3", WorkspaceLocationPolicy.uniqueName("app", existing::contains))
        assertEquals("fresh", WorkspaceLocationPolicy.uniqueName("fresh", existing::contains))
    }

    @Test
    fun sourceFullGitHiddenAndSecretSelectionsAreIndependent() {
        val source = ProjectTransferOptions(
            mode = ProjectTransferMode.SOURCE,
            includeGit = false,
            includeHidden = true,
            includeSecrets = false
        )
        assertFalse(ProjectTransferFilter.include("node_modules/pkg/index.js", false, source))
        assertFalse(ProjectTransferFilter.include(".git/config", false, source))
        assertTrue(ProjectTransferFilter.include(".github/workflows/ci.yml", false, source))
        assertFalse(ProjectTransferFilter.include(".env.production", false, source))
        assertTrue(ProjectTransferFilter.include(".env.example", false, source))

        val full = source.copy(
            mode = ProjectTransferMode.FULL,
            includeGit = true,
            includeHidden = false,
            includeSecrets = true
        )
        assertTrue(ProjectTransferFilter.include("node_modules/pkg/index.js", false, full))
        assertTrue(ProjectTransferFilter.include(".git/config", false, full))
        assertTrue(ProjectTransferFilter.include(".env.production", false, full))
        assertFalse(ProjectTransferFilter.include("src/.hidden/file.js", false, full))

        val everything = full.copy(includeHidden = true)
        assertTrue(ProjectTransferFilter.include(".git/config", false, everything))
        assertTrue(ProjectTransferFilter.include(".env.production", false, everything))

        val explicitPrivateFiles = full.copy(includeGit = true, includeSecrets = true)
        assertTrue(ProjectTransferFilter.include(".git/config", false, explicitPrivateFiles))
        assertTrue(ProjectTransferFilter.include(".env.production", false, explicitPrivateFiles))
        assertFalse(ProjectTransferFilter.include(".github/workflows/ci.yml", false, explicitPrivateFiles))
    }

    @Test
    fun scannerCountsIncludedContentAndDoesNotTraverseGeneratedDirectories() {
        val project = File(sharedRoot, "Projects/scanner").apply { mkdirs() }
        File(project, "src").mkdirs()
        File(project, "src/index.js").writeText("hello")
        File(project, "README.md").writeText("readme")
        File(project, ".env").writeText("SECRET=x")
        File(project, "node_modules/pkg").mkdirs()
        File(project, "node_modules/pkg/index.js").writeText("generated")

        val scan = RawProjectScanner.scan(project, ProjectTransferOptions())
        assertEquals(2, scan.totalFiles)
        assertEquals(11, scan.totalBytes)
        assertTrue(scan.skippedEntries >= 2)
        assertTrue(scan.entries.any { it.relativePath.replace('\\', '/') == "src/index.js" })
        assertFalse(scan.entries.any { it.relativePath.contains("node_modules") })
        assertFalse(scan.entries.any { it.relativePath.endsWith(".env") })
    }

    @Test
    fun scannerNeverFollowsSymbolicLinkEscapesWhenHostSupportsLinks() {
        val project = File(sharedRoot, "Projects/links").apply { mkdirs() }
        val outside = File(temporaryRoot, "outside").apply { mkdirs() }
        File(outside, "secret.txt").writeText("secret")
        val link = File(project, "escape").toPath()
        val created = try {
            Files.createSymbolicLink(link, outside.toPath())
            true
        } catch (_: Exception) {
            false
        }
        assumeTrue("Host does not permit symbolic-link creation", created)

        val scan = RawProjectScanner.scan(project, ProjectTransferOptions(mode = ProjectTransferMode.FULL))
        assertFalse(scan.entries.any { it.relativePath.contains("secret.txt") })
        assertTrue(scan.skippedEntries >= 1)
    }
}
