package com.mobileide.app.process

import android.util.Log
import com.mobileide.app.runtime.RuntimeManager
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * ProcessManager handles spawning and managing background processes
 * like dev servers, builds, and other long-running tasks.
 */
class ProcessManager(private val runtimeManager: RuntimeManager) {

    companion object {
        private const val TAG = "ProcessManager"
        
        // Common dev server ports to monitor
        val MONITORED_PORTS = listOf(3000, 3001, 4173, 5173, 8000, 8080)
        
        // Patterns that indicate a server has started
        val SERVER_START_PATTERNS = listOf(
            Regex("listening on.*:(\\d+)", RegexOption.IGNORE_CASE),
            Regex("Local:\\s+https?://localhost:(\\d+)", RegexOption.IGNORE_CASE),
            Regex("ready on.*:(\\d+)", RegexOption.IGNORE_CASE),
            Regex("started server on.*:(\\d+)", RegexOption.IGNORE_CASE),
            Regex("Server running at.*:(\\d+)", RegexOption.IGNORE_CASE),
            Regex("VITE.*ready.*localhost:(\\d+)", RegexOption.IGNORE_CASE),
            Regex("Next\\.js.*localhost:(\\d+)", RegexOption.IGNORE_CASE)
        )
    }

    private val processes = ConcurrentHashMap<Int, ManagedProcess>()
    private val processIdCounter = AtomicInteger(0)
    private val activePorts = ConcurrentHashMap<Int, Int>() // port -> processId

    /**
     * Spawn a new process with the runtime environment
     */
    fun spawnProcess(
        command: String,
        args: List<String> = emptyList(),
        cwd: String? = null,
        onOutput: ((String) -> Unit)? = null,
        onError: ((String) -> Unit)? = null,
        onExit: ((Int) -> Unit)? = null
    ): ManagedProcess {
        val processId = processIdCounter.incrementAndGet()
        val workingDir = File(cwd ?: runtimeManager.getWorkspacesDir())
        
        // Build command
        val fullCommand = mutableListOf(command)
        fullCommand.addAll(args)
        
        Log.i(TAG, "Spawning process $processId: ${fullCommand.joinToString(" ")}")
        
        val processBuilder = ProcessBuilder(fullCommand)
            .directory(workingDir)
            .redirectErrorStream(false)
        
        // Set environment
        val env = processBuilder.environment()
        env.clear()
        env.putAll(runtimeManager.getEnvironment())
        
        val process = processBuilder.start()
        
        val managedProcess = ManagedProcess(
            id = processId,
            process = process,
            command = command,
            args = args,
            workingDirectory = workingDir.absolutePath,
            startTime = System.currentTimeMillis()
        )
        
        processes[processId] = managedProcess
        
        // Start output readers
        startOutputReader(managedProcess, onOutput, onError)
        
        // Monitor for exit
        Thread {
            val exitCode = process.waitFor()
            managedProcess.exitCode = exitCode
            managedProcess.isRunning = false
            
            // Remove port mapping
            activePorts.entries.removeIf { it.value == processId }
            
            onExit?.invoke(exitCode)
            Log.i(TAG, "Process $processId exited with code $exitCode")
        }.start()
        
        return managedProcess
    }

    /**
     * Start reading stdout/stderr from process
     */
    private fun startOutputReader(
        managedProcess: ManagedProcess,
        onOutput: ((String) -> Unit)?,
        onError: ((String) -> Unit)?
    ) {
        // stdout reader
        Thread {
            BufferedReader(InputStreamReader(managedProcess.process.inputStream)).use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    line?.let {
                        managedProcess.outputBuffer.add(it)
                        onOutput?.invoke(it)
                        detectPortFromOutput(managedProcess.id, it)
                    }
                }
            }
        }.start()
        
        // stderr reader
        Thread {
            BufferedReader(InputStreamReader(managedProcess.process.errorStream)).use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    line?.let {
                        managedProcess.errorBuffer.add(it)
                        onError?.invoke(it)
                        detectPortFromOutput(managedProcess.id, it)
                    }
                }
            }
        }.start()
    }

    /**
     * Detect if output indicates a server has started on a port
     */
    private fun detectPortFromOutput(processId: Int, output: String) {
        for (pattern in SERVER_START_PATTERNS) {
            val match = pattern.find(output)
            if (match != null) {
                val port = match.groupValues[1].toIntOrNull()
                if (port != null) {
                    activePorts[port] = processId
                    Log.i(TAG, "Detected server on port $port (process $processId)")
                }
            }
        }
    }

    /**
     * Get a managed process by ID
     */
    fun getProcess(processId: Int): ManagedProcess? = processes[processId]

    /**
     * Get all active processes
     */
    fun getAllProcesses(): List<ManagedProcess> = processes.values.filter { it.isRunning }

    /**
     * Kill a process and its children
     */
    fun killProcess(processId: Int) {
        processes[processId]?.let { managedProcess ->
            // Kill process tree
            killProcessTree(managedProcess.process)
            managedProcess.isRunning = false
            
            // Remove port mapping
            activePorts.entries.removeIf { it.value == processId }
            
            Log.i(TAG, "Killed process $processId")
        }
    }

    /**
     * Kill a process and all its children
     */
    private fun killProcessTree(process: Process) {
        try {
            // On Android, we need to kill the process group
            val pid = getPid(process)
            if (pid > 0) {
                // Kill process group
                android.os.Process.killProcess(pid)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error killing process tree", e)
        }
        process.destroyForcibly()
    }

    /**
     * Get PID from Process object using reflection
     */
    private fun getPid(process: Process): Int {
        return try {
            val field = process.javaClass.getDeclaredField("pid")
            field.isAccessible = true
            field.getInt(process)
        } catch (e: Exception) {
            -1
        }
    }

    /**
     * Get all active ports
     */
    fun getActivePorts(): Map<Int, Int> = activePorts.toMap()

    /**
     * Check if a port is active
     */
    fun isPortActive(port: Int): Boolean = activePorts.containsKey(port)

    /**
     * Get process ID for a port
     */
    fun getProcessForPort(port: Int): Int? = activePorts[port]

    /**
     * Kill all processes
     */
    fun killAllProcesses() {
        processes.keys.toList().forEach { killProcess(it) }
    }
}

/**
 * Represents a managed background process
 */
data class ManagedProcess(
    val id: Int,
    val process: Process,
    val command: String,
    val args: List<String>,
    val workingDirectory: String,
    val startTime: Long,
    var isRunning: Boolean = true,
    var exitCode: Int? = null,
    val outputBuffer: MutableList<String> = mutableListOf(),
    val errorBuffer: MutableList<String> = mutableListOf()
) {
    fun getFullCommand(): String = listOf(command).plus(args).joinToString(" ")
    
    fun getUptime(): Long = System.currentTimeMillis() - startTime
}
