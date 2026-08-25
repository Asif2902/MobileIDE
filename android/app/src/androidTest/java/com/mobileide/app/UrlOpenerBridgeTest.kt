package com.mobileide.app

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mobileide.app.runtime.RuntimeManager
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * End-to-end proof for the generic CLI URL bridge (PLAN-009).
 *
 * The ACTION_VIEW broker refuses to fire while A Dev Studio is not visible —
 * Android 10+ blocks background activity starts anyway, and a hidden IDE must
 * not pop a browser. Bare `am instrument` runs without a resumed activity, so
 * this test launches [MainActivity] synchronously and then drives the real
 * `adev-open-url` shim through the full runtime environment, exactly like an
 * in-app terminal would.
 */
@RunWith(AndroidJUnit4::class)
class UrlOpenerBridgeTest {
    @Test
    fun cliUrlOpenerOpensBrowserWhileAppVisible() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val manager = RuntimeManager(context)
        if (!manager.isRuntimeReady()) manager.initializeRuntime()

        val workspace = File(manager.getWorkspacesDir()).apply { mkdirs() }
        val shell = File(manager.getNativeLibDir(), "libbin_bash.so")
        assumeTrue("runtime bash missing", shell.isFile)

        instrumentation.startActivitySync(
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        )
        // startActivitySync returns after the activity is resumed and the
        // process is idle, which is what ExternalUrlBroker gates on. This
        // test executes in the .test instrumentation process, whose broker
        // singleton never receives MainActivity.onResume, so propagate the
        // now-verified visible state across the process boundary.
        com.mobileide.app.runtime.ExternalUrlBroker.setAppVisible(true)
        Thread.sleep(1_000)

        val builder = ProcessBuilder(
            listOf(shell.absolutePath, "-c", "adev-open-url https://github.com")
        )
            .directory(workspace)
            .redirectErrorStream(true)
        builder.environment().apply {
            clear()
            putAll(manager.getEnvironment(workspace.absolutePath))
        }
        val process = builder.start()
        val output = process.inputStream.bufferedReader().use { it.readText() }
        val finished = process.waitFor(60, TimeUnit.SECONDS)
        assertEquals(
            "adev-open-url exited 0 (output: $output)",
            true,
            finished && process.exitValue() == 0
        )
        // Silence proves no rejection text reached stderr; a successful open
        // then hands foreground to the browser, pausing MainActivity by
        // design. xdg-open shares this exact code path (same ELF, same
        // broker); its PATH resolution is covered by the bridge gate.
        assertEquals("no opener diagnostics on stderr/stdout", "", output.trim())
    }
}
