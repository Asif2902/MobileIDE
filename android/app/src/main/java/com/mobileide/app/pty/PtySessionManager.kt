package com.mobileide.app.pty

import android.util.Log
import com.mobileide.app.runtime.RuntimeManager
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * PtySessionManager manages multiple PTY terminal sessions.
 * Each session runs in its own process with isolated environment.
 */
class PtySessionManager(private val runtimeManager: RuntimeManager) {

    companion object {
        private const val TAG = "PtySessionManager"
        private const val DEFAULT_COLS = 80
        private const val DEFAULT_ROWS = 24
        private const val READ_BUFFER_SIZE = 8192
        var isNativeLoaded = false
            private set

        init {
            try {
                System.loadLibrary("mobileide-pty")
                isNativeLoaded = true
            } catch (e: UnsatisfiedLinkError) {
                Log.w(TAG, "Native PTY library not available: ${e.message}")
                isNativeLoaded = false
            }
        }
    }

    private val sessions = ConcurrentHashMap<Int, PtySession>()
    private val sessionIdCounter = AtomicInteger(0)

    /**
     * Create a new PTY session with a shell process
     */
    @Throws(IOException::class)
    fun createSession(
        cols: Int = DEFAULT_COLS,
        rows: Int = DEFAULT_ROWS,
        cwd: String? = null,
        extraEnv: Map<String, String>? = null
    ): PtySession {
        val sessionId = sessionIdCounter.incrementAndGet()
        val workingDir = cwd ?: runtimeManager.getWorkspacesDir()

        // Build environment
        val env = runtimeManager.getEnvironment().toMutableMap()
        extraEnv?.let { env.putAll(it) }

        // Pick a backend: native PTY when the JNI lib is available, otherwise
        // fall back to a plain ProcessBuilder shell so the terminal still works
        // (and never hard-crashes the app when the native lib is missing).
        val backend: TerminalBackend = if (PtyProcess.isNativeLoaded) {
            val shellPath = "${runtimeManager.getBinDir()}/bash"
            val args = arrayOf(shellPath, "--login")
            NativePtyBackend(
                createPtyProcess(sessionId, shellPath, args, env, workingDir, cols, rows)
            )
        } else {
            Log.w(TAG, "Native PTY unavailable; using ProcessBuilder shell fallback")
            ProcessShellBackend(resolveFallbackShell(), env, workingDir)
        }

        val session = PtySession(
            id = sessionId,
            backend = backend,
            workingDirectory = workingDir,
            cols = cols,
            rows = rows
        )

        sessions[sessionId] = session
        Log.i(TAG, "Created terminal session $sessionId (cwd: $workingDir, native=${PtyProcess.isNativeLoaded})")

        return session
    }

    /**
     * Resolve a usable shell binary for the fallback backend.
     */
    private fun resolveFallbackShell(): String {
        val candidates = listOf(
            "${runtimeManager.getBinDir()}/bash",
            "/system/bin/sh",
            "/bin/sh"
        )
        return candidates.firstOrNull { File(it).exists() } ?: "/system/bin/sh"
    }

    /**
     * Create the actual PTY process using native code
     */
    private fun createPtyProcess(
        sessionId: Int,
        shellPath: String,
        args: Array<String>,
        env: Map<String, String>,
        cwd: String,
        cols: Int,
        rows: Int
    ): PtyProcess {
        val envArray = env.map { "${it.key}=${it.value}" }.toTypedArray()
        
        // Call native forkpty
        val result = nativeForkPty(sessionId, shellPath, args, envArray, cwd, cols, rows)
        
        if (result[0] < 0) {
            throw IOException("Failed to create PTY: error code ${result[0]}")
        }
        
        val masterFd = result[0]
        val pid = result[1]
        
        return PtyProcess(sessionId, masterFd, pid)
    }

    /**
     * Get a session by ID
     */
    fun getSession(sessionId: Int): PtySession? = sessions[sessionId]

    /**
     * Get all active sessions
     */
    fun getAllSessions(): List<PtySession> = sessions.values.toList()

    /**
     * Write input to a session
     */
    @Throws(IOException::class)
    fun writeToSession(sessionId: Int, data: String) {
        val session = sessions[sessionId] ?: throw IOException("Session $sessionId not found")
        session.backend.write(data)
    }

    /**
     * Resize a session's terminal
     */
    fun resizeSession(sessionId: Int, cols: Int, rows: Int) {
        sessions[sessionId]?.let { session ->
            session.resize(cols, rows)
        }
    }

    /**
     * Destroy a session and cleanup
     */
    fun destroySession(sessionId: Int) {
        sessions.remove(sessionId)?.let { session ->
            session.close()
            Log.i(TAG, "Destroyed PTY session $sessionId")
        }
    }

    /**
     * Destroy all sessions
     */
    fun destroyAllSessions() {
        sessions.keys.toList().forEach { destroySession(it) }
    }

    /**
     * Check if a session is still alive
     */
    fun isSessionAlive(sessionId: Int): Boolean {
        return sessions[sessionId]?.isAlive() ?: false
    }

    // Native method for forkpty
    private external fun nativeForkPty(
        sessionId: Int,
        shellPath: String,
        args: Array<String>,
        env: Array<String>,
        cwd: String,
        cols: Int,
        rows: Int
    ): IntArray // Returns [masterFd, pid]


}

/**
 * Represents a single terminal session backed by either a native PTY
 * or a ProcessBuilder shell fallback.
 */
data class PtySession(
    val id: Int,
    val backend: TerminalBackend,
    var workingDirectory: String,
    var cols: Int,
    var rows: Int,
    var title: String = "Terminal $id",
    val createdAt: Long = System.currentTimeMillis()
) {
    fun resize(newCols: Int, newRows: Int) {
        cols = newCols
        rows = newRows
        backend.resize(newCols, newRows)
    }

    fun isAlive(): Boolean = backend.isAlive()

    fun close() {
        backend.close()
    }
}

/**
 * Abstraction over a terminal I/O backend so the manager can transparently
 * use the native PTY or a fallback shell.
 */
interface TerminalBackend {
    fun write(data: String)
    fun read(buffer: ByteArray): Int
    fun resize(cols: Int, rows: Int)
    fun isAlive(): Boolean
    fun getExitCode(): Int?
    fun close()
}

/**
 * Native PTY backend (real pseudo-terminal via JNI).
 */
class NativePtyBackend(private val ptyProcess: PtyProcess) : TerminalBackend {
    override fun write(data: String) = ptyProcess.write(data)
    override fun read(buffer: ByteArray): Int = ptyProcess.read(buffer)
    override fun resize(cols: Int, rows: Int) = ptyProcess.resize(cols, rows)
    override fun isAlive(): Boolean = ptyProcess.isProcessAlive()
    override fun getExitCode(): Int? = ptyProcess.getExitCode()
    override fun close() = ptyProcess.close()
}

/**
 * Fallback backend using java.lang.Process. Not a real TTY (no job control
 * or window resize), but runs commands and streams output so the terminal
 * remains usable when the native PTY library is unavailable.
 */
class ProcessShellBackend(
    shellPath: String,
    env: Map<String, String>,
    cwd: String
) : TerminalBackend {
    private val process: Process
    private val stdin: OutputStream
    private val stdout: InputStream

    init {
        val builder = ProcessBuilder(shellPath, "-i")
        builder.redirectErrorStream(true)
        val dir = File(cwd)
        if (dir.isDirectory) {
            builder.directory(dir)
        }
        val environment = builder.environment()
        env.forEach { (key, value) -> environment[key] = value }
        environment["TERM"] = "xterm-256color"
        process = builder.start()
        stdin = process.outputStream
        stdout = process.inputStream
    }

    override fun write(data: String) {
        stdin.write(data.toByteArray(Charsets.UTF_8))
        stdin.flush()
    }

    override fun read(buffer: ByteArray): Int {
        return try {
            stdout.read(buffer)
        } catch (e: IOException) {
            -1
        }
    }

    override fun resize(cols: Int, rows: Int) {
        // No PTY: nothing to resize.
    }

    override fun isAlive(): Boolean = process.isAlive

    override fun getExitCode(): Int? = try {
        if (process.isAlive) null else process.exitValue()
    } catch (e: IllegalThreadStateException) {
        null
    }

    override fun close() {
        try {
            stdin.close()
        } catch (e: Exception) {
            // ignore
        }
        process.destroy()
    }
}
