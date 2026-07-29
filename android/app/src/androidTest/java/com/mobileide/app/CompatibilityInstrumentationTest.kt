package com.mobileide.app

import android.system.Os
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class CompatibilityInstrumentationTest {
    @Test
    fun privateWorkspacePreservesAndroidBuildSemantics() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.filesDir, "phase5-instrumentation").apply {
            deleteRecursively()
            check(mkdirs())
        }
        try {
            val upper = File(root, "CaseSensitive").apply { writeText("upper") }
            val lower = File(root, "casesensitive").apply { writeText("lower") }
            assertNotEquals(upper.canonicalPath, lower.canonicalPath)
            assertEquals("upper", upper.readText())
            assertEquals("lower", lower.readText())

            val executable = File(root, "native-build-script").apply {
                writeText("#!/system/bin/sh\nexit 0\n")
            }
            Os.chmod(executable.absolutePath, 0b111101101)
            assertTrue(executable.canExecute())

            val link = File(root, "workspace-link")
            Os.symlink(upper.absolutePath, link.absolutePath)
            assertEquals(upper.canonicalPath, link.canonicalPath)
            assertTrue(link.canonicalPath.startsWith(root.canonicalPath + File.separator))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun packageVersionUsesTheReleaseVersionAuthority() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        assertEquals(BuildConfig.VERSION_NAME, info.versionName)
    }
}
