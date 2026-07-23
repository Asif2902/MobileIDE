package com.mobileide.app.pty

import android.util.Log
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException

/**
 * PtyProcess manages a pseudo-terminal session with a child process.
 * Uses native JNI calls for PTY operations (openpty, forkpty, ioctl).
 */
class PtyProcess(
    val sessionId: Int,
    private val masterFd: Int,
    val pid: Int
) {
    companion object {
        private const val TAG = "PtyProcess"
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

    private var isAlive = true
    private var exitCode: Int? = null

    // Native methods implemented in C++
    external fun nativeClose(fd: Int)
    external fun nativeWaitFor(pid: Int): Int
    external fun nativeKill(pid: Int, signal: Int)

    /**
     * Write data to the PTY master (user input)
     */
    @Throws(IOException::class)
    fun write(data: ByteArray) {
        if (!isAlive) throw IOException("Session is closed")
        nativeWrite(masterFd, data, data.size)
    }

    /**
     * Write string to PTY
     */
    @Throws(IOException::class)
    fun write(data: String) {
        write(data.toByteArray(Charsets.UTF_8))
    }

    /**
     * Read data from PTY master (process output)
     */
    @Throws(IOException::class)
    fun read(buffer: ByteArray): Int {
        if (!isAlive) return -1
        return nativeRead(masterFd, buffer, buffer.size)
    }

    /**
     * Resize the terminal window
     */
    fun resize(cols: Int, rows: Int) {
        if (isAlive) {
            nativeResize(masterFd, cols, rows)
        }
    }

    /**
     * Check if the process is still running
     */
    fun isProcessAlive(): Boolean {
        if (!isAlive) return false
        val status = nativeCheckAlive(pid)
        if (status >= 0) {
            isAlive = false
            exitCode = status
        }
        return isAlive
    }

    /**
     * Get the exit code if process has terminated
     */
    fun getExitCode(): Int? = exitCode

    /**
     * Send a signal to the process (e.g., SIGINT, SIGTERM)
     */
    fun signal(sig: Int) {
        if (isAlive) {
            nativeKill(pid, sig)
        }
    }

    /**
     * Kill the process
     */
    fun kill() {
        signal(9) // SIGKILL
    }

    /**
     * Close the PTY session and cleanup
     */
    fun close() {
        if (isAlive) {
            isAlive = false
            kill()
            nativeClose(masterFd)
            Log.d(TAG, "PTY session $sessionId closed")
        }
    }

    // Native method declarations
    private external fun nativeWrite(fd: Int, data: ByteArray, length: Int)
    private external fun nativeRead(fd: Int, buffer: ByteArray, length: Int): Int
    private external fun nativeResize(fd: Int, cols: Int, rows: Int)
    private external fun nativeCheckAlive(pid: Int): Int


}
