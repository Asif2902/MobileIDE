package com.mobileide.app

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mobileide.app.process.AdevProcessLauncher
import com.mobileide.app.process.ProcessManager
import com.mobileide.app.pty.PtySessionManager
import com.mobileide.app.runtime.RuntimeManager
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** End-to-end validation of the separately delivered Linux ARM64 backend. */
@RunWith(AndroidJUnit4::class)
class LinuxExecutionInstrumentationTest {
    private data class Result(val status: Int, val output: String)

    private fun installLinuxRuntime(manager: RuntimeManager): String {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val tmp = File(manager.getTmpDir(), "linux-runtime-instrumentation").apply {
            deleteRecursively()
            mkdirs()
        }
        // The test APK transports the exact release bytes under an opaque suffix
        // because AAPT otherwise inflates files named *.gz.
        val archive = File(tmp, "adev-linux-aarch64-v1.2.0.tar.gz")
        instrumentation.context.assets
            .open("adev-linux-aarch64-v1.2.0.pack")
            .use { input -> archive.outputStream().use(input::copyTo) }
        val index = File(tmp, "adev-linux-index.json")
        context.assets.open("runtime/lib/adev-linux.json")
            .use { input -> index.outputStream().use(input::copyTo) }

        val node = File(manager.getNativeLibDir(), "libbin_node.so")
        val runtimeCli = File(manager.getLibDir(), "adev-runtime-cli.js")
        val install = ProcessBuilder(
            node.absolutePath,
            runtimeCli.absolutePath,
            "runtime",
            "install",
            "linux"
        )
            .directory(tmp)
            .redirectErrorStream(true)
        install.environment().apply {
            clear()
            putAll(manager.getEnvironment(tmp.absolutePath))
            put("ADEV_LINUX_ARCHIVE_FILE", archive.absolutePath)
            put("ADEV_LINUX_INDEX_FILE", index.absolutePath)
        }
        val installProcess = install.start()
        val installOutput = installProcess.inputStream.bufferedReader().use { it.readText() }
        assertTrue("linux install timed out", installProcess.waitFor(3, TimeUnit.MINUTES))
        assertEquals(installOutput, 0, installProcess.exitValue())
        assertTrue(installOutput, installOutput.contains("static ARM64 ELF ok"))
        return installOutput
    }

    private fun run(
        manager: ProcessManager,
        command: String,
        args: List<String>,
        cwd: File,
        timeoutSeconds: Long = 120
    ): Result {
        val lines = java.util.Collections.synchronizedList(mutableListOf<String>())
        val exited = CountDownLatch(1)
        var status = -1
        manager.spawnProcess(
            command = command,
            args = args,
            cwd = cwd.absolutePath,
            onOutput = { _, line -> lines.add(line) },
            onError = { _, line -> lines.add(line) },
            onExit = { _, code -> status = code; exited.countDown() }
        )
        assertTrue("$command timed out", exited.await(timeoutSeconds, TimeUnit.SECONDS))
        Thread.sleep(50)
        return Result(status, lines.joinToString("\n"))
    }

    @Test
    fun optionalPackInstallsAndAutomaticallyRunsStaticArm64Elf() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val manager = RuntimeManager(context)
        // Force an in-place support-file refresh. Instrumentation commonly
        // reinstalls an APK with the same versionCode, so the normal app upgrade
        // fingerprint is intentionally not a reliable test trigger here.
        manager.initializeRuntime()

        installLinuxRuntime(manager)
        val tmp = File(manager.getTmpDir(), "linux-runtime-instrumentation")

        val linuxRoot = File(manager.getRuntimeRoot(), "linux")
        val probe = File(linuxRoot, "probes/static-aarch64")
        assertTrue("linux backend missing", File(linuxRoot, "bin/qemu-aarch64").isFile)
        assertTrue("static probe missing", probe.isFile)

        val runner = ProcessManager(manager)
        val automatic = run(runner, probe.absolutePath, emptyList(), tmp)
        assertEquals(automatic.output, 0, automatic.status)
        assertTrue(automatic.output, automatic.output.contains("adev-linux-static-ok"))

        val explicit = run(runner, "linux-run", listOf(probe.absolutePath), tmp)
        assertEquals(explicit.output, 0, explicit.status)
        assertTrue(explicit.output, explicit.output.contains("adev-linux-static-ok"))

        val childScript =
            "const{spawnSync}=require('node:child_process');" +
                "const r=spawnSync(process.argv[1],[],{encoding:'utf8'});" +
                "if(r.status!==0)throw(r.error||new Error(r.stderr));" +
                "process.stdout.write(r.stdout)"
        val child = run(runner, "node", listOf("-e", childScript, probe.absolutePath), tmp)
        assertEquals(child.output, 0, child.status)
        assertTrue(child.output, child.output.contains("adev-linux-static-ok"))

        val nodeStillWorks = run(
            runner,
            "node",
            listOf("-e", "console.log('bionic-default-ok')"),
            tmp
        )
        assertEquals(nodeStillWorks.output, 0, nodeStillWorks.status)
        assertTrue(nodeStillWorks.output, nodeStillWorks.output.contains("bionic-default-ok"))
    }

    /** Validate execution, DNS, TCP, and TLS through the installed Linux backend. */
    @Test
    fun runtimeDoctorPassesLinuxNetworkProbes() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val manager = RuntimeManager(instrumentation.targetContext)
        manager.initializeRuntime()
        installLinuxRuntime(manager)

        val result = run(
            ProcessManager(manager),
            "adev",
            listOf("runtime", "doctor", "--json"),
            File(manager.getWorkspacesDir()),
            timeoutSeconds = 2 * 60
        )
        instrumentation.sendStatus(
            2,
            Bundle().apply {
                putString("stream", "[linux-runtime-doctor] status=${result.status}\n${result.output}\n")
            }
        )
        assertEquals(result.output, 0, result.status)
        assertTrue(result.output, result.output.contains("\"ok\": true"))
        assertTrue(result.output, result.output.contains("\"dns\""))
        assertTrue(result.output, result.output.contains("\"tcp\""))
        assertTrue(result.output, result.output.contains("\"tls\""))
    }

    /**
     * Opt-in network validation for real npm packages whose CLI payload is an
     * optional Linux ARM64 alias. The package comes from the instrumentation
     * argument so production compatibility code never names a particular CLI.
     */
    @Test
    fun normalNpmInstallResolvesPortableLinuxArm64CliPayload() {
        val packageSpec = InstrumentationRegistry.getArguments()
            .getString("adevLinuxNpmPackage")
            .orEmpty()
            .trim()
        val command = InstrumentationRegistry.getArguments()
            .getString("adevLinuxNpmCommand")
            .orEmpty()
            .trim()
        assumeTrue("set -e adevLinuxNpmPackage=<package>@<version>", packageSpec.isNotEmpty())
        assumeTrue("set -e adevLinuxNpmCommand=<command>", command.isNotEmpty())

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = RuntimeManager(context)
        manager.initializeRuntime()
        installLinuxRuntime(manager)

        val runner = ProcessManager(manager)
        val workspace = File(manager.getWorkspacesDir())
        val install = run(
            runner,
            "npm",
            listOf("install", "--global", packageSpec),
            workspace,
            timeoutSeconds = 20 * 60
        )
        assertEquals(install.output, 0, install.status)
        assertTrue(
            install.output,
            install.output.contains("ADEV linux: installed")
        )

        val version = run(runner, command, listOf("--version"), workspace, timeoutSeconds = 5 * 60)
        assertEquals(version.output, 0, version.status)
        assertTrue("empty CLI version output", version.output.isNotBlank())
    }

    /** Execute an already-installed CLI by its normal command name. */
    @Test
    fun installedLinuxCliUsesAutomaticExecutionBackend() {
        val command = InstrumentationRegistry.getArguments()
            .getString("adevLinuxCommand")
            .orEmpty()
            .trim()
        assumeTrue("set -e adevLinuxCommand=<command>", command.isNotEmpty())

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = RuntimeManager(context)
        manager.initializeRuntime()
        installLinuxRuntime(manager)

        val result = run(
            ProcessManager(manager),
            command,
            listOf("--version"),
            File(manager.getWorkspacesDir()),
            timeoutSeconds = 5 * 60
        )
        assertEquals(result.output, 0, result.status)
        assertTrue("empty CLI version output", result.output.isNotBlank())
    }

    /**
     * Opt-in field diagnostic for an already-installed Linux CLI. QEMU's own
     * syscall tracer is required here because host strace cannot ptrace a
     * linux-user guest. Output is streamed through instrumentation status so
     * it can be captured from a non-debuggable phone-test APK.
     */
    @Test
    fun traceInstalledLinuxCliThroughAutomaticBackend() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        val command = arguments.getString("adevLinuxTraceCommand").orEmpty().trim()
        assumeTrue("set -e adevLinuxTraceCommand=<command>", command.isNotEmpty())
        val commandArgs = arguments.getString("adevLinuxTraceArgs")
            .orEmpty()
            .split(Regex("[,\\u001f]"))
            .filter { it.isNotEmpty() }

        val context = instrumentation.targetContext
        val manager = RuntimeManager(context)
        manager.initializeRuntime()
        val launcher = AdevProcessLauncher(manager)
        val spec = launcher.command(command, commandArgs)
        val process = ProcessBuilder(spec.processBuilderCommand())
            .directory(File(manager.getWorkspacesDir()))
            .redirectErrorStream(true)
            .apply {
                environment().apply {
                    clear()
                    putAll(launcher.environment(manager.getWorkspacesDir()))
                    put("QEMU_STRACE", "1")
                    put("ADEV_LINUX_TRACE", "1")
                }
            }
            .start()

        val output = StringBuilder()
        val reader = Thread {
            try {
                process.inputStream.bufferedReader().useLines { lines ->
                    lines.forEach { line ->
                        if (output.length < 4 * 1024 * 1024) output.appendLine(line)
                    }
                }
            } catch (_: java.io.InterruptedIOException) {
                // destroyForcibly() closes a blocking pipe on some Android
                // vendors. The buffered trace collected before timeout is the
                // diagnostic result, so this is an expected shutdown path.
            } catch (_: java.io.IOException) {}
        }.apply { start() }
        val completed = process.waitFor(45, TimeUnit.SECONDS)
        if (!completed) process.destroyForcibly()
        reader.join(5_000)
        val status = if (completed) process.exitValue() else 124
        val lines = output.lines()
        val selected = lines.filter {
            it.contains("SIGSYS", ignoreCase = true) ||
                it.contains("Bad system call", ignoreCase = true) ||
                it.contains("Unknown syscall", ignoreCase = true) ||
                it.contains("resolv", ignoreCase = true) ||
                it.contains("/etc/hosts", ignoreCase = true) ||
                it.contains("cert", ignoreCase = true) ||
                it.contains("ssl", ignoreCase = true) ||
                it.contains("socket(", ignoreCase = true) ||
                it.contains("connect(", ignoreCase = true) ||
                it.contains("sendto(", ignoreCase = true) ||
                it.contains("recvfrom(", ignoreCase = true) ||
                it.contains("https", ignoreCase = true) ||
                it.contains("auth", ignoreCase = true)
        } + lines.takeLast(80)
        instrumentation.sendStatus(
            2,
            Bundle().apply {
                putString(
                    "stream",
                    "[linux-trace] command=$command status=$status completed=$completed\n" +
                        selected.distinct().joinToString("\n") + "\n"
                )
            }
        )
        assertTrue("$command timed out\n$output", completed)
    }

    /**
     * Exercise a long-running CLI until it proves a requested startup/network
     * milestone. The command and expectations are instrumentation arguments,
     * keeping this reusable for any optional Linux tool without product names
     * or service URLs in ADEV's compatibility implementation.
     */
    @Test
    fun installedLinuxCliReachesExpectedRuntimeMilestone() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        val command = arguments.getString("adevLinuxSmokeCommand").orEmpty().trim()
        val expected = arguments.getString("adevLinuxSmokeExpected").orEmpty()
        assumeTrue("set -e adevLinuxSmokeCommand=<command>", command.isNotEmpty())
        assumeTrue("set -e adevLinuxSmokeExpected=<text>", expected.isNotEmpty())
        val commandArgs = arguments.getString("adevLinuxSmokeArgs")
            .orEmpty()
            .split(Regex("[,\\u001f]"))
            .filter { it.isNotEmpty() }
        val forbidden = arguments.getString("adevLinuxSmokeForbidden")
            .orEmpty()
            .split(Regex("[,\\u001f]"))
            .filter { it.isNotEmpty() }

        val manager = RuntimeManager(instrumentation.targetContext)
        manager.initializeRuntime()
        val launcher = AdevProcessLauncher(manager)
        val spec = launcher.command(command, commandArgs)
        val process = ProcessBuilder(spec.processBuilderCommand())
            .directory(File(manager.getWorkspacesDir()))
            .redirectErrorStream(true)
            .apply {
                environment().apply {
                    clear()
                    putAll(launcher.environment(manager.getWorkspacesDir()))
                }
            }
            .start()
        val output = StringBuilder()
        val reader = Thread {
            try {
                process.inputStream.bufferedReader().useLines { lines ->
                    lines.forEach { line ->
                        synchronized(output) {
                            if (output.length < 1024 * 1024) output.appendLine(line)
                        }
                    }
                }
            } catch (_: java.io.InterruptedIOException) {
            } catch (_: java.io.IOException) {}
        }.apply { start() }

        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
        var reached = false
        while (System.nanoTime() < deadline && process.isAlive) {
            reached = synchronized(output) { output.contains(expected, ignoreCase = true) }
            if (reached) break
            Thread.sleep(100)
        }
        process.destroyForcibly()
        process.waitFor(5, TimeUnit.SECONDS)
        reader.join(5_000)
        val result = synchronized(output) { output.toString() }
        reached = reached || result.contains(expected, ignoreCase = true)
        instrumentation.sendStatus(
            2,
            Bundle().apply {
                putString(
                    "stream",
                    "[linux-runtime-smoke] command=$command reached=$reached\n" +
                        result.takeLast(4_000) + "\n"
                )
            }
        )
        assertTrue("$command did not reach: $expected\n$result", reached)
        forbidden.forEach { text ->
            assertTrue(
                "$command produced forbidden output: $text\n$result",
                !result.contains(text, ignoreCase = true)
            )
        }
    }

    /** Reproduce Linux CLI failures in the exact native PTY used by Terminal. */
    @Test
    fun traceInstalledLinuxCliInsideTerminalPty() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val command = InstrumentationRegistry.getArguments()
            .getString("adevLinuxTraceCommand")
            .orEmpty()
            .trim()
        assumeTrue("set -e adevLinuxTraceCommand=<command>", command.isNotEmpty())
        require(command.matches(Regex("[A-Za-z0-9._+/-]+"))) { "unsafe diagnostic command" }

        val manager = RuntimeManager(instrumentation.targetContext)
        manager.initializeRuntime()
        val sessions = PtySessionManager(manager)
        val session = sessions.createSession(
            cols = 120,
            rows = 40,
            cwd = manager.getWorkspacesDir(),
            extraEnv = mapOf("QEMU_STRACE" to "1", "ADEV_LINUX_TRACE" to "1")
        )
        val output = StringBuilder()
        val finished = CountDownLatch(1)
        val reader = Thread {
            val buffer = ByteArray(8192)
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
            try {
                while (output.length < 4 * 1024 * 1024 && System.nanoTime() < deadline) {
                    val count = session.backend.read(buffer)
                    if (count <= 0) {
                        Thread.sleep(20)
                        continue
                    }
                    val chunk = String(buffer, 0, count, Charsets.UTF_8)
                    // Minimal terminal-emulator response used by interactive
                    // TUIs when they query the cursor with CSI 6 n.
                    if (chunk.contains("\u001b[6n")) {
                        sessions.writeToSession(session.id, "\u001b[1;1R")
                    }
                    var sawExitMarker = false
                    synchronized(output) {
                        output.append(chunk)
                        sawExitMarker = output.contains("ADEV_TRACE_EXIT:")
                    }
                    if (sawExitMarker) break
                }
            } finally {
                finished.countDown()
            }
        }.apply { start() }
        sessions.writeToSession(session.id, "$command; printf '\\nADEV_%s_EXIT:%s\\n' TRACE \$?\r")
        finished.await(45, TimeUnit.SECONDS)
        sessions.destroySession(session.id)
        reader.join(5_000)

        val normalized = synchronized(output) { output.toString().replace("\r", "") }
        val lines = normalized.lines()
        val selected = lines.filter {
            it.contains("SIGSYS", ignoreCase = true) ||
                it.contains("Bad system call", ignoreCase = true) ||
                it.contains("unknown syscall", ignoreCase = true) ||
                it.contains("seccomp", ignoreCase = true)
        } + lines.takeLast(80)
        instrumentation.sendStatus(
            2,
            Bundle().apply {
                putString("stream", "[linux-pty-trace]\n${selected.distinct().joinToString("\n")}\n")
            }
        )
        assertTrue("terminal trace produced no output", normalized.isNotBlank())
    }
}
