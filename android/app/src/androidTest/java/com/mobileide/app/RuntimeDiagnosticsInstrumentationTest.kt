package com.mobileide.app

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mobileide.app.runtime.RuntimeManager
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Device-side developer diagnostics.
 *
 * This class lives in the androidTest source set, so it is never part of the
 * shipped application package. It runs a shell script supplied either inside
 * the instrumentation bundle (`-e adevDiagnosticScript`, preferred — scoped
 * storage makes adb-pushed files unreadable for the app on Android 11+) or
 * staged in the app's *external* files directory (`adb push`-able) with
 * exactly the environment [RuntimeManager.getEnvironment] hands to every other
 * ADEV process, then writes the transcript back to that directory.
 *
 * The point is to exercise the real runtime contract — the same env, the same
 * shell, the same PATH — instead of an approximation assembled by the test.
 */
@RunWith(AndroidJUnit4::class)
class RuntimeDiagnosticsInstrumentationTest {
    private fun diagnosticsDir(): File {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val external = context.getExternalFilesDir(null)
            ?: error("External files directory is unavailable")
        return File(external, "adev-diagnostics").apply { mkdirs() }
    }

    @Test
    fun runsRequestedDiagnosticScript() {
        val arguments = InstrumentationRegistry.getArguments()
        val name = arguments.getString("adevDiagnostic")?.trim().orEmpty()
        assumeTrue("No diagnostic script requested", name.isNotEmpty())
        assumeTrue(
            "Diagnostic name must be a plain file stem",
            name.matches(Regex("[A-Za-z0-9._-]{1,64}")) && !name.startsWith(".")
        )
        val timeoutMinutes = arguments.getString("adevTimeoutMinutes")?.toLongOrNull() ?: 30L

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = RuntimeManager(context)
        if (!manager.isRuntimeReady()) manager.initializeRuntime()

        // Preferred transport: the script arrives inside the instrumentation
        // bundle (`-e adevDiagnosticScript <text>` or its Base64 form
        // `adevDiagnosticScriptB64`, preferred — scoped storage makes
        // adb-pushed files unreadable for the app on Android 11+). The staged
        // file route stays available for devices where it works.
        val inlineBase64 = arguments.getString("adevDiagnosticScriptB64") ?: ""
        val inlineScript = when {
            inlineBase64.isNotEmpty() -> String(
                android.util.Base64.decode(inlineBase64, android.util.Base64.DEFAULT),
                Charsets.UTF_8
            )
            else -> arguments.getString("adevDiagnosticScript") ?: ""
        }
        assumeTrue("Inline diagnostic exceeds 256 KiB", inlineScript.length <= 256 * 1024)
        var source: String? = null
        if (inlineScript.isNotEmpty()) {
            source = inlineScript
        } else {
            val directory = diagnosticsDir()
            val script = File(directory, "$name.sh")
            assertTrue("Diagnostic script is missing: $script", script.isFile)
            source = script.readText()
        }

        // filesDir is noexec; copy the staged script somewhere the runtime shell
        // can read it and pass it as an argument rather than exec'ing it.
        val staged = File(manager.getTmpDir(), "adev-diagnostic-$name.sh")
        staged.writeText(source)

        val workspace = File(manager.getWorkspacesDir()).apply { mkdirs() }
        val shellCandidates = listOf(
            File(manager.getNativeLibDir(), "libbin_bash.so"),
            File("/system/bin/sh")
        )
        val shell = shellCandidates.first { it.isFile }
        val builder = ProcessBuilder(listOf(shell.absolutePath, staged.absolutePath))
            .directory(workspace)
            .redirectErrorStream(true)
        builder.environment().apply {
            clear()
            putAll(manager.getEnvironment(workspace.absolutePath))
        }

        val process = builder.start()
        process.outputStream.close()
        val reader = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "adev-diagnostic-output").apply { isDaemon = true }
        }
        val outputFuture = reader.submit<String> {
            process.inputStream.bufferedReader().use { it.readText() }
        }
        val transcript = StringBuilder()
        var exitCode = -1
        try {
            if (process.waitFor(timeoutMinutes, TimeUnit.MINUTES)) {
                exitCode = process.exitValue()
            } else {
                process.destroyForcibly()
                transcript.appendLine("adev-diagnostic: TIMEOUT after $timeoutMinutes minute(s)")
            }
            transcript.append(outputFuture.get(30, TimeUnit.SECONDS))
        } finally {
            if (process.isAlive) process.destroyForcibly()
            reader.shutdownNow()
        }
        transcript.appendLine()
        transcript.appendLine("adev-diagnostic-exit: $exitCode")
        File(diagnosticsDir(), "$name.out").writeText(transcript.toString())
        Log.i("AdevDiagnostic", "$name exited $exitCode")
        assertTrue("Diagnostic script $name exited $exitCode", exitCode == 0)
    }

    /** Dumps the authoritative runtime environment for inspection. */
    @Test
    fun writesRuntimeEnvironmentSnapshot() {
        assumeTrue(
            "Environment snapshot not requested",
            InstrumentationRegistry.getArguments().getString("adevEnvSnapshot") == "true"
        )
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = RuntimeManager(context)
        if (!manager.isRuntimeReady()) manager.initializeRuntime()
        val snapshot = manager.getEnvironment(manager.getWorkspacesDir())
            .toSortedMap()
            .entries
            .joinToString("\n") { "${it.key}=${it.value}" }
        File(diagnosticsDir(), "environment.out").writeText(snapshot + "\n")
    }
}
