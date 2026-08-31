package com.mobileide.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mobileide.app.process.ProcessManager
import com.mobileide.app.runtime.RuntimeManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Device tests for the actual agent/background command path. */
@RunWith(AndroidJUnit4::class)
class AgentProcessInstrumentationTest {
    private data class Result(val status: Int, val output: String)

    private fun run(
        manager: ProcessManager,
        command: String,
        args: List<String>,
        cwd: File,
        timeoutSeconds: Long = 90
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
            onExit = { _, code ->
                status = code
                exited.countDown()
            }
        )
        assertTrue("$command timed out", exited.await(timeoutSeconds, TimeUnit.SECONDS))
        // The output readers can observe EOF immediately after the waiter.
        Thread.sleep(50)
        return Result(status, lines.joinToString("\n"))
    }

    @Test
    fun agentRunnerUsesTerminalLauncherAndPythonVenvHasPip() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val runtime = RuntimeManager(context)
        if (!runtime.isRuntimeReady()) runtime.initializeRuntime()
        val runner = ProcessManager(runtime)
        val workspace = File(runtime.getTmpDir(), "agent-runner-instrumentation").apply {
            deleteRecursively()
            mkdirs()
        }

        val checks = listOf(
            "bash" to listOf("--version"),
            "node" to listOf("--version"),
            "npm" to listOf("--version"),
            "git" to listOf("--version"),
            "python" to listOf("--version")
        )
        checks.forEach { (command, args) ->
            val result = run(runner, command, args, workspace)
            assertEquals("$command failed:\n${result.output}", 0, result.status)
            assertTrue("$command returned no version", result.output.isNotBlank())
        }

        val prefixBash = File(runtime.getBinDir(), "bash").absolutePath
        assertEquals(0, run(runner, prefixBash, listOf("--version"), workspace).status)
        assertEquals(
            0,
            run(
                runner,
                "node",
                listOf("-e", "console.log('agent subprocess works')"),
                workspace
            ).status
        )

        assertEquals(0, run(runner, "git", listOf("init"), workspace).status)
        assertEquals(0, run(runner, "git", listOf("status", "--short"), workspace).status)

        val childProbe =
            "const {spawnSync}=require('node:child_process');" +
                "for(const c of [['bash',['--version']],['python',['--version']]," +
                "['npm',['--version']]]){" +
                "const r=spawnSync(c[0],c[1],{encoding:'utf8'});" +
                "if(r.status!==0)throw new Error(c[0]+': '+(r.error||r.stderr));}" +
                "console.log('node child processes work')"
        val children = run(runner, "node", listOf("-e", childProbe), workspace)
        assertEquals(children.output, 0, children.status)
        assertTrue(children.output, children.output.contains("node child processes work"))

        val createVenv = run(
            runner,
            "python",
            listOf("-m", "venv", "test"),
            workspace,
            timeoutSeconds = 180
        )
        assertEquals(createVenv.output, 0, createVenv.status)
        val pip = run(
            runner,
            "test/bin/python",
            listOf("-m", "pip", "--version"),
            workspace
        )
        assertEquals(pip.output, 0, pip.status)
        assertTrue(pip.output, pip.output.contains("pip "))
    }
}
