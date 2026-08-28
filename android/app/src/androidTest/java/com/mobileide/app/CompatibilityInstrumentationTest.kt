package com.mobileide.app

import android.system.Os
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mobileide.app.runtime.RuntimeManager
import java.io.ByteArrayOutputStream
import java.io.InterruptedIOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class CompatibilityInstrumentationTest {
    private data class CommandResult(val exitCode: Int, val output: String)

    private fun runRuntimeCommand(
        manager: RuntimeManager,
        arguments: List<String>,
        workingDirectory: File,
        timeoutMinutes: Long
    ): CommandResult {
        val node = File(manager.getNativeLibDir(), "libbin_node.so")
        check(node.isFile) { "APK-native Node executable is missing: $node" }
        val command = listOf(node.absolutePath) + arguments
        val processBuilder = ProcessBuilder(command)
            .directory(workingDirectory)
            .redirectErrorStream(true)
        processBuilder.environment().apply {
            clear()
            putAll(manager.getEnvironment(workingDirectory.absolutePath))
        }
        val process = processBuilder.start()
        val readerExecutor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "adev-instrumentation-output").apply { isDaemon = true }
        }
        val outputFuture = readerExecutor.submit<String> {
            process.inputStream.bufferedReader().use { it.readText() }
        }
        try {
            check(process.waitFor(timeoutMinutes, TimeUnit.MINUTES)) {
                process.destroyForcibly()
                "Runtime command timed out after $timeoutMinutes minutes: ${command.joinToString(" ")}"
            }
            val output = outputFuture.get(10, TimeUnit.SECONDS)
            Log.i("AdevCompatibility", output.takeLast(32 * 1024))
            return CommandResult(process.exitValue(), output)
        } finally {
            if (process.isAlive) process.destroyForcibly()
            readerExecutor.shutdownNow()
        }
    }

    private fun networkMatrixRequested(): Boolean =
        InstrumentationRegistry.getArguments().getString("adevNetwork") == "true"

    private fun runOpenCodeEnvironmentMatrix(network: Boolean) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = RuntimeManager(context)
        // A local phone-test APK may deliberately reuse the release version
        // while changing a shipped suite. Opt-in refresh simulates the normal
        // versioned upgrade extraction without deleting workspaces or caches.
        if (InstrumentationRegistry.getArguments().getString("adevRefreshRuntime") == "true") {
            File(context.filesDir, "runtime/.runtime_fingerprint").delete()
        }
        if (!manager.isRuntimeReady()) manager.initializeRuntime()
        val workspace = File(manager.getWorkspacesDir(), ".adev-opencode-environment").apply {
            mkdirs()
            check(isDirectory)
        }
        try {
            val launcher = File(manager.getNativeLibDir(), "libbin_opencode.so")
            assertTrue("OpenCode Android launcher is missing", launcher.isFile)
            val command = mutableListOf(launcher.absolutePath, "--adev-runtime-env-test")
            if (network) command += "--network"
            val processBuilder = ProcessBuilder(command)
                .directory(workspace)
                .redirectErrorStream(true)
            processBuilder.environment().apply {
                clear()
                putAll(manager.getEnvironment(workspace.absolutePath))
            }
            val process = processBuilder.start()
            val readerExecutor = Executors.newSingleThreadExecutor { runnable ->
                Thread(runnable, "adev-opencode-environment-output").apply { isDaemon = true }
            }
            val outputFuture = readerExecutor.submit<String> {
                process.inputStream.bufferedReader().use { it.readText() }
            }
            try {
                assertTrue(
                    "OpenCode runtime environment suite timed out",
                    process.waitFor(if (network) 10 else 5, TimeUnit.MINUTES)
                )
                val output = outputFuture.get(10, TimeUnit.SECONDS)
                Log.i("AdevCompatibility", output.takeLast(32 * 1024))
                assertEquals(
                    "OpenCode runtime environment suite failed:\n${output.takeLast(32 * 1024)}",
                    0,
                    process.exitValue()
                )
                val expected = if (network) {
                    "23/23 runtime environment checks passed"
                } else {
                    "22/22 runtime environment checks passed"
                }
                assertTrue(
                    "Missing $expected:\n${output.takeLast(32 * 1024)}",
                    output.contains(expected)
                )
            } finally {
                if (process.isAlive) process.destroyForcibly()
                readerExecutor.shutdownNow()
            }
        } finally {
            workspace.deleteRecursively()
        }
    }

    private fun runPhase5Matrix(network: Boolean) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = RuntimeManager(context)
        if (!manager.isRuntimeReady()) manager.initializeRuntime()
        val workspace = File(manager.getWorkspacesDir(), ".adev-instrumentation").apply {
            mkdirs()
            check(isDirectory)
        }
        try {
            val harness = File(manager.getLibDir(), "adev-phase5-test.js")
            assertTrue("Phase 5 device harness is missing", harness.isFile)
            val arguments = mutableListOf(harness.absolutePath)
            if (network) arguments += "--network"
            val result = runRuntimeCommand(
                manager = manager,
                arguments = arguments,
                workingDirectory = workspace,
                timeoutMinutes = if (network) 60 else 30
            )
            assertEquals(
                "${if (network) "Network" else "Offline"} developer-runtime matrix failed:\n" +
                    result.output.takeLast(32 * 1024),
                0,
                result.exitCode
            )
        } finally {
            workspace.deleteRecursively()
        }
    }

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
    fun prefixBinIsOwnerWritableForCliInstallers() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = RuntimeManager(context)
        if (!manager.isRuntimeReady()) manager.initializeRuntime()
        val workspace = File(manager.getWorkspacesDir(), ".adev-prefix-bin-test").apply {
            mkdirs()
            check(isDirectory)
        }
        val shellScript = """
            set -eu
            touch_target="${'$'}PREFIX/bin/test-file"
            trap 'rm -f "${'$'}touch_target"' EXIT
            touch "${'$'}touch_target"
            printf '#!/system/bin/sh\necho ok\n' > "${'$'}touch_target"
            chmod 755 "${'$'}touch_target"
            test -w "${'$'}PREFIX/bin"
            test -f "${'$'}touch_target"
            test -x "${'$'}touch_target"
        """.trimIndent()
        try {
            val javascript =
                "const r=require('child_process').spawnSync(process.env.SHELL," +
                    "['-c',process.argv[1]],{stdio:'inherit',env:process.env});" +
                    "process.exit(r.status??1)"
            val result = runRuntimeCommand(
                manager,
                listOf("-e", javascript, shellScript),
                workspace,
                5
            )
            assertEquals(
                "A CLI installer could not write to ${manager.getBinDir()}:\n${result.output}",
                0,
                result.exitCode
            )
            assertTrue("Runtime bin must remain owner-writable", File(manager.getBinDir()).canWrite())
        } finally {
            workspace.deleteRecursively()
        }
    }

    @Test
    fun packageVersionUsesTheReleaseVersionAuthority() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        assertEquals(BuildConfig.VERSION_NAME, info.versionName)
    }

    /**
     * Runs the shipped offline device matrix inside the target application's
     * UID. This works for the release-mode phoneTest variant without relying on
     * `adb run-as`, and covers doctor, three native-addon APIs, install/rebuild/
     * direct node-gyp/load cycles, Node server cleanup, local Git, offline
     * pnpm/Yarn, the Bun boundary, and the signed runtime lock.
     */
    @Test
    fun bundledDeveloperRuntimePassesOfflineDeviceMatrix() {
        assumeFalse("Network matrix requested", networkMatrixRequested())
        runPhase5Matrix(network = false)
    }

    /** Opt in with -Pandroid.testInstrumentationRunnerArguments.adevNetwork=true. */
    @Test
    fun bundledDeveloperRuntimePassesNetworkFrameworkMatrix() {
        assumeTrue("Network matrix not requested", networkMatrixRequested())
        runPhase5Matrix(network = true)
    }

    @Test
    fun openCodeExecutionEnvironmentPassesRuntimeContract() {
        assumeFalse("Network matrix requested", networkMatrixRequested())
        runOpenCodeEnvironmentMatrix(network = false)
    }

    @Test
    fun openCodeExecutionEnvironmentPassesNetworkRuntimeContract() {
        assumeTrue("Network matrix not requested", networkMatrixRequested())
        runOpenCodeEnvironmentMatrix(network = true)
    }

    @Test
    fun openCodeTuiStartsWithoutBundledAssetLoaderCrash() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = RuntimeManager(context)
        if (!manager.isRuntimeReady()) manager.initializeRuntime()
        val workspace = File(manager.getWorkspacesDir(), ".adev-opencode-tui-smoke").apply {
            mkdirs()
            check(isDirectory)
        }
        val launcher = File(manager.getNativeLibDir(), "libbin_opencode.so")
        val process = ProcessBuilder(launcher.absolutePath)
            .directory(workspace)
            .redirectErrorStream(true)
            .apply {
                environment().apply {
                    clear()
                    putAll(manager.getEnvironment(workspace.absolutePath))
                }
            }
            .start()
        val outputExecutor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "adev-opencode-tui-smoke-output").apply { isDaemon = true }
        }
        val outputFuture = outputExecutor.submit<String> {
            val captured = ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            try {
                process.inputStream.use { stream ->
                    while (true) {
                        val count = stream.read(buffer)
                        if (count < 0) break
                        captured.write(buffer, 0, count)
                    }
                }
            } catch (_: InterruptedIOException) {
                // Android interrupts a blocked pipe read when the still-running TUI
                // is forcibly stopped after the startup observation window.
            }
            captured.toString(Charsets.UTF_8.name())
        }
        try {
            val exitedDuringStartup = process.waitFor(4, TimeUnit.SECONDS)
            if (!exitedDuringStartup) {
                process.destroyForcibly()
                process.waitFor(5, TimeUnit.SECONDS)
            }
            val output = outputFuture.get(10, TimeUnit.SECONDS)
            Log.i("AdevCompatibility", output.takeLast(32 * 1024))
            assertFalse(
                "OpenCode exited during TUI startup:\n${output.takeLast(32 * 1024)}",
                exitedDuringStartup
            )
            assertFalse(output.contains("normalizeLoadedFilePath"))
            assertFalse(output.contains("loadedPath.startsWith"))
        } finally {
            if (process.isAlive) process.destroyForcibly()
            outputExecutor.shutdownNow()
            workspace.deleteRecursively()
        }
    }

    /**
     * Optional upgrade-safe check for an existing private project. Invoke with
     * `adevProject` set to a path relative to the private workspaces root. The
     * command is fixed (npm install/rebuild/load); the argument cannot inject a
     * shell command or escape app storage.
     */
    @Test
    fun requestedPrivateProjectPassesNpmInstallAndNativeRebuild() {
        val projectRelative = InstrumentationRegistry.getArguments()
            .getString("adevProject")
            ?.trim()
            .orEmpty()
        assumeTrue("No existing project requested", projectRelative.isNotEmpty())

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = RuntimeManager(context)
        if (!manager.isRuntimeReady()) manager.initializeRuntime()
        val workspaces = File(manager.getWorkspacesDir()).canonicalFile
        val project = File(workspaces, projectRelative).canonicalFile
        assertTrue(
            "Requested project escaped the private workspace root: $project",
            project.path.startsWith(workspaces.path + File.separator)
        )
        assertTrue("Requested project directory is missing: $project", project.isDirectory)
        assertTrue("Requested project has no package.json", File(project, "package.json").isFile)

        val npmCli = File(manager.getLibDir(), "node_modules/npm/bin/npm-cli.js")
        val install = runRuntimeCommand(
            manager,
            listOf(
                npmCli.absolutePath,
                "install",
                "--foreground-scripts",
                "--no-audit",
                "--no-fund"
            ),
            project,
            60
        )
        assertEquals(
            "Existing-project npm install failed:\n${install.output.takeLast(32 * 1024)}",
            0,
            install.exitCode
        )

        val rebuild = runRuntimeCommand(
            manager,
            listOf(
                npmCli.absolutePath,
                "rebuild",
                "bufferutil",
                "utf-8-validate",
                "--foreground-scripts"
            ),
            project,
            30
        )
        assertEquals(
            "Existing-project native rebuild failed:\n${rebuild.output.takeLast(32 * 1024)}",
            0,
            rebuild.exitCode
        )

        val load = runRuntimeCommand(
            manager,
            listOf(
                "-e",
                "require('bufferutil');require('utf-8-validate');" +
                    "process.stdout.write('existing-native-addons-ok\\n')"
            ),
            project,
            5
        )
        assertEquals(
            "Existing-project native addons did not load:\n${load.output.takeLast(32 * 1024)}",
            0,
            load.exitCode
        )
    }
}
