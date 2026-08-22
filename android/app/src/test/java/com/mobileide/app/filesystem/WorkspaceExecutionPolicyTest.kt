package com.mobileide.app.filesystem

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceExecutionPolicyTest {
    @Test
    fun classifiesAndroidSharedAliasesWithoutTreatingPrivateStorageAsShared() {
        assertTrue(WorkspaceExecutionPolicy.isSharedPath("/storage/emulated/0/Download/app"))
        assertTrue(WorkspaceExecutionPolicy.isSharedPath("/sdcard/Projects/app"))
        assertTrue(WorkspaceExecutionPolicy.isSharedPath("/storage/self/primary/Documents/app"))
        assertTrue(WorkspaceExecutionPolicy.isSharedPath("/storage/ABCD-1234/Projects/app"))
        assertTrue(WorkspaceExecutionPolicy.isSharedPath("/mnt/media_rw/ABCD-1234/app"))
        assertFalse(
            WorkspaceExecutionPolicy.isSharedPath(
                "/data/user/0/com.mobileide.app/files/runtime/workspaces/app"
            )
        )
    }

    @Test
    fun gatesFilesystemMutationsButKeepsViewingAndDiagnosticsAvailable() {
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("npm", listOf("install")))
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("pnpm", listOf("add", "zod")))
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("npm", listOf("run", "build")))
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("npm", listOf("start")))
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("npm", listOf("--silent", "install")))
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("pnpm", listOf("--filter", "app", "build")))
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("yarn", listOf("dev")))
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("corepack", listOf("yarn", "install")))
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("next", listOf("dev")))
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("node-gyp", listOf("rebuild")))
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("git", listOf("-C", ".", "checkout", "main")))
        assertTrue(WorkspaceExecutionPolicy.requiresPrivateWorkspace("libbin_adev_make.so", emptyList()))
        assertTrue(WorkspaceExecutionPolicy.shellRequiresPrivateWorkspace("command npm install"))
        assertTrue(WorkspaceExecutionPolicy.shellRequiresPrivateWorkspace("echo ok; next dev"))

        assertFalse(WorkspaceExecutionPolicy.requiresPrivateWorkspace("npm", listOf("--version")))
        assertFalse(WorkspaceExecutionPolicy.requiresPrivateWorkspace("npm", listOf("list")))
        assertFalse(WorkspaceExecutionPolicy.requiresPrivateWorkspace("next", listOf("--help")))
        assertFalse(WorkspaceExecutionPolicy.requiresPrivateWorkspace("next", listOf("dev", "--help")))
        assertFalse(WorkspaceExecutionPolicy.requiresPrivateWorkspace("clang", listOf("--version")))
        assertFalse(WorkspaceExecutionPolicy.requiresPrivateWorkspace("git", listOf("status")))
        assertFalse(WorkspaceExecutionPolicy.shellRequiresPrivateWorkspace("git status && npm --version"))
        assertFalse(WorkspaceExecutionPolicy.requiresPrivateWorkspace("node", listOf("index.js")))
        assertFalse(WorkspaceExecutionPolicy.requiresPrivateWorkspace("cat", listOf("README.md")))
    }
}
