package com.mobileide.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mobileide.app.pty.PtySessionManager
import com.mobileide.app.runtime.RuntimeManager
import java.io.File
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Verifies that terminal-emulator protocol replies retain exact PTY bytes. */
@RunWith(AndroidJUnit4::class)
class TerminalProtocolInstrumentationTest {
    @Test
    fun oscPaletteResponseIsFramedAndConsumedByTheRequester() {
        val manager = RuntimeManager(InstrumentationRegistry.getInstrumentation().targetContext)
        manager.initializeRuntime()
        val fixture = File(manager.getTmpDir(), "osc-response-fixture.py")
        fixture.writeText(
            """
            import os
            import sys
            import termios

            fd = 0
            old = termios.tcgetattr(fd)
            mode = termios.tcgetattr(fd)
            mode[3] &= ~(termios.ICANON | termios.ECHO)
            termios.tcsetattr(fd, termios.TCSANOW, mode)
            try:
                sys.stdout.buffer.write(b'\x1b]4;5;?\x1b\\')
                sys.stdout.buffer.flush()
                response = b''
                while not response.endswith(b'\x1b\\') and len(response) < 512:
                    response += os.read(fd, 1)
                print('\nADEV_OSC_RESPONSE:' + response.hex(), flush=True)
            finally:
                termios.tcsetattr(fd, termios.TCSANOW, old)
            """.trimIndent()
        )

        val sessions = PtySessionManager(manager)
        val session = sessions.createSession(100, 30, manager.getWorkspacesDir())
        val output = StringBuilder()
        val response = "\u001b]4;5;rgb:c5c5/8686/c0c0\u001b\\".toByteArray(Charsets.US_ASCII)
        var replied = false
        val reader = Thread {
            val buffer = ByteArray(8192)
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            while (System.nanoTime() < deadline) {
                val count = session.backend.read(buffer)
                if (count <= 0) continue
                val chunk = String(buffer, 0, count, Charsets.UTF_8)
                synchronized(output) { output.append(chunk) }
                if (!replied && chunk.contains("\u001b]4;5;?\u001b\\")) {
                    sessions.writeBytesToSession(session.id, response)
                    replied = true
                }
                if (synchronized(output) { output.contains("ADEV_SHELL_ALIVE") }) break
            }
        }.apply { start() }

        sessions.writeToSession(session.id, "python ${fixture.absolutePath}\r")
        val expectedHex = response.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val responseDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < responseDeadline &&
            !synchronized(output) { output.contains("ADEV_OSC_RESPONSE:$expectedHex") }) {
            Thread.sleep(25)
        }
        sessions.writeToSession(session.id, "printf 'ADEV_SHELL_ALIVE\\n'\r")
        reader.join(10_000)
        sessions.destroySession(session.id)

        val result = synchronized(output) { output.toString() }
        assertTrue("terminal query was not observed\n$result", replied)
        assertTrue("OSC response bytes were changed\n$result", result.contains("ADEV_OSC_RESPONSE:$expectedHex"))
        assertTrue("shell did not remain usable after OSC reply\n$result", result.contains("ADEV_SHELL_ALIVE"))
        assertTrue("OSC payload leaked as a shell command\n$result", !result.contains("command not found"))
    }
}
