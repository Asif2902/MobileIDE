package com.mobileide.app.modules

import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.mobileide.app.process.ProcessManager
import com.mobileide.app.process.TaskRegistry
import com.mobileide.app.process.TaskSnapshot
import com.mobileide.app.process.TaskType
import com.mobileide.app.process.VerifiedPort
import kotlinx.coroutines.*

/**
 * Process Native Module
 * Provides background process management to React Native
 */
class ProcessNativeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "ProcessNative"
        private var processManager: ProcessManager? = null
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val taskRegistry = TaskRegistry.shared()
    private val portListener: (List<VerifiedPort>) -> Unit = { ports ->
        sendEvent("onTaskPortsChanged", Arguments.createMap().apply {
            putArray("ports", portsToArray(ports))
        })
    }

    init {
        taskRegistry.addPortListener(portListener)
    }

    override fun getName(): String = NAME

    private fun getProcessManager(): ProcessManager {
        if (processManager == null) {
            val runtimeManager = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            processManager = ProcessManager(runtimeManager)
        }
        return processManager!!
    }

    /**
     * Spawn a new process (rewrites node/npm/git/ls to exec-safe paths).
     */
    @ReactMethod
    fun spawn(command: String, args: ReadableArray, cwd: String?, promise: Promise) {
        scope.launch {
            try {
                val manager = getProcessManager()
                val argList = mutableListOf<String>()
                for (i in 0 until args.size()) {
                    argList.add(args.getString(i) ?: "")
                }

                val process = manager.spawnProcess(
                    command = command,
                    args = argList,
                    cwd = cwd,
                    onOutput = { processId, line ->
                        sendEvent("onProcessOutput", Arguments.createMap().apply {
                            putInt("processId", processId)
                            putInt("taskId", processId)
                            putString("data", line)
                            putString("stream", "stdout")
                        })
                    },
                    onError = { processId, line ->
                        sendEvent("onProcessOutput", Arguments.createMap().apply {
                            putInt("processId", processId)
                            putInt("taskId", processId)
                            putString("data", line)
                            putString("stream", "stderr")
                        })
                    },
                    onExit = { processId, exitCode ->
                        sendEvent("onProcessExit", Arguments.createMap().apply {
                            putInt("processId", processId)
                            putInt("taskId", processId)
                            putInt("exitCode", exitCode)
                        })
                    }
                )
                withContext(Dispatchers.Main) {
                    val result = Arguments.createMap().apply {
                        putInt("processId", process.id)
                        putInt("taskId", process.id)
                        putInt("pid", process.pid)
                        putString("command", process.getFullCommand())
                        putString("cwd", process.workingDirectory)
                    }
                    promise.resolve(result)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("PROCESS_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Run a shell script line in the background with ADEV wrappers loaded.
     * Used by agents / UI for: npm run build, tsc, long servers, etc.
     */
    @ReactMethod
    fun runShell(script: String, cwd: String?, promise: Promise) {
        scope.launch {
            try {
                val manager = getProcessManager()
                val process = manager.spawnShell(
                    script = script,
                    cwd = cwd,
                    onOutput = { processId, line ->
                        sendEvent("onProcessOutput", Arguments.createMap().apply {
                            putInt("processId", processId)
                            putInt("taskId", processId)
                            putString("data", line)
                            putString("stream", "stdout")
                        })
                    },
                    onError = { processId, line ->
                        sendEvent("onProcessOutput", Arguments.createMap().apply {
                            putInt("processId", processId)
                            putInt("taskId", processId)
                            putString("data", line)
                            putString("stream", "stderr")
                        })
                    },
                    onExit = { processId, exitCode ->
                        sendEvent("onProcessExit", Arguments.createMap().apply {
                            putInt("processId", processId)
                            putInt("taskId", processId)
                            putInt("exitCode", exitCode)
                        })
                    }
                )
                withContext(Dispatchers.Main) {
                    val result = Arguments.createMap().apply {
                        putInt("processId", process.id)
                        putInt("taskId", process.id)
                        putInt("pid", process.pid)
                        putString("command", script)
                        putString("cwd", process.workingDirectory)
                    }
                    promise.resolve(result)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("PROCESS_SHELL_ERROR", e.message)
                }
            }
        }
    }

    /**
     * First-class task start API. Task type is metadata used by Run/Preview
     * and diagnostics; all command execution still uses the Phase 1 resolver.
     */
    @ReactMethod
    fun startTask(
        type: String,
        command: String,
        args: ReadableArray,
        cwd: String?,
        persistent: Boolean,
        promise: Promise
    ) {
        scope.launch {
            try {
                val argList = (0 until args.size()).map { args.getString(it) ?: "" }
                val manager = getProcessManager()
                val requestedType = TaskType.from(type)
                val process = manager.spawnProcess(
                    command = command,
                    args = argList,
                    cwd = cwd,
                    taskType = requestedType,
                    persistent = persistent,
                    onOutput = { taskId, line ->
                        sendEvent("onProcessOutput", Arguments.createMap().apply {
                            putInt("processId", taskId)
                            putInt("taskId", taskId)
                            putString("data", line)
                            putString("stream", "stdout")
                        })
                    },
                    onError = { taskId, line ->
                        sendEvent("onProcessOutput", Arguments.createMap().apply {
                            putInt("processId", taskId)
                            putInt("taskId", taskId)
                            putString("data", line)
                            putString("stream", "stderr")
                        })
                    },
                    onExit = { taskId, exitCode ->
                        sendEvent("onProcessExit", Arguments.createMap().apply {
                            putInt("processId", taskId)
                            putInt("taskId", taskId)
                            putInt("exitCode", exitCode)
                        })
                    }
                )
                withContext(Dispatchers.Main) {
                    promise.resolve(Arguments.createMap().apply {
                        putInt("processId", process.id)
                        putInt("taskId", process.id)
                        putInt("pid", process.pid)
                        putString("type", requestedType.name)
                        putString("command", process.getFullCommand())
                        putString("cwd", process.workingDirectory)
                    })
                }
            } catch (error: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("TASK_START_ERROR", error.message, error)
                }
            }
        }
    }

    /**
     * Kill a process
     */
    @ReactMethod
    fun kill(processId: Int, promise: Promise) {
        try {
            val manager = getProcessManager()
            promise.resolve(manager.killProcess(processId))
        } catch (e: Exception) {
            promise.reject("PROCESS_KILL_ERROR", e.message)
        }
    }

    /**
     * Get all active processes
     */
    @ReactMethod
    fun getProcesses(promise: Promise) {
        try {
            val manager = getProcessManager()
            val processes = manager.getAllProcesses()
            
            val result = Arguments.createArray()
            processes.forEach { process ->
                result.pushMap(Arguments.createMap().apply {
                    putInt("id", process.id)
                    putInt("pid", process.pid)
                    putString("command", process.getFullCommand())
                    putString("cwd", process.workingDirectory)
                    putDouble("startTime", process.startTime.toDouble())
                    putDouble("uptime", process.getUptime().toDouble())
                    putBoolean("isRunning", process.isRunning)
                })
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("PROCESS_ERROR", e.message)
        }
    }

    @ReactMethod
    fun getTasks(includeExited: Boolean, promise: Promise) {
        try {
            val result = Arguments.createArray()
            getProcessManager().getTasks(includeExited).forEach {
                result.pushMap(taskToMap(it))
            }
            promise.resolve(result)
        } catch (error: Exception) {
            promise.reject("TASK_STATUS_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun getTaskLogs(taskId: Int, limit: Int, promise: Promise) {
        try {
            val result = Arguments.createArray()
            getProcessManager().getTaskLogs(taskId, limit).forEach { log ->
                result.pushMap(Arguments.createMap().apply {
                    putString("stream", log.stream)
                    putString("data", log.data)
                    putDouble("timestamp", log.timestamp.toDouble())
                })
            }
            promise.resolve(result)
        } catch (error: Exception) {
            promise.reject("TASK_LOG_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun stopTask(taskId: Int, promise: Promise) = kill(taskId, promise)

    @ReactMethod
    fun restartTask(taskId: Int, promise: Promise) {
        scope.launch {
            try {
                val process = getProcessManager().restartTask(
                    taskId = taskId,
                    onOutput = { restartedId, line ->
                        sendEvent("onProcessOutput", Arguments.createMap().apply {
                            putInt("processId", restartedId)
                            putInt("taskId", restartedId)
                            putString("data", line)
                            putString("stream", "stdout")
                        })
                    },
                    onError = { restartedId, line ->
                        sendEvent("onProcessOutput", Arguments.createMap().apply {
                            putInt("processId", restartedId)
                            putInt("taskId", restartedId)
                            putString("data", line)
                            putString("stream", "stderr")
                        })
                    },
                    onExit = { restartedId, exitCode ->
                        sendEvent("onProcessExit", Arguments.createMap().apply {
                            putInt("processId", restartedId)
                            putInt("taskId", restartedId)
                            putInt("exitCode", exitCode)
                        })
                    }
                )
                withContext(Dispatchers.Main) {
                    promise.resolve(Arguments.createMap().apply {
                        putInt("processId", process.id)
                        putInt("taskId", process.id)
                        putInt("pid", process.pid)
                        putString("command", process.getFullCommand())
                        putString("cwd", process.workingDirectory)
                    })
                }
            } catch (error: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("TASK_RESTART_ERROR", error.message, error)
                }
            }
        }
    }

    /**
     * Get active ports
     */
    @ReactMethod
    fun getActivePorts(promise: Promise) {
        try {
            val manager = getProcessManager()
            val ports = manager.getActivePorts()
            
            val result = Arguments.createArray()
            ports.forEach { result.pushMap(portToMap(it)) }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("PROCESS_ERROR", e.message)
        }
    }

    /**
     * Check if a port is active
     */
    @ReactMethod
    fun isPortActive(port: Int, promise: Promise) {
        try {
            val manager = getProcessManager()
            promise.resolve(manager.isPortActive(port))
        } catch (e: Exception) {
            promise.reject("PROCESS_ERROR", e.message)
        }
    }

    /**
     * Get monitored ports list
     */
    @ReactMethod
    fun getMonitoredPorts(promise: Promise) {
        val result = Arguments.createArray()
        ProcessManager.MONITORED_PORTS.forEach { port ->
            result.pushInt(port)
        }
        promise.resolve(result)
    }

    /**
     * Kill all processes
     */
    @ReactMethod
    fun killAll(promise: Promise) {
        try {
            val manager = getProcessManager()
            manager.killAllProcesses()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("PROCESS_ERROR", e.message)
        }
    }

    private fun sendEvent(eventName: String, params: WritableMap) {
        if (!reactApplicationContext.hasActiveReactInstance()) return
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    override fun invalidate() {
        super.invalidate()
        taskRegistry.removePortListener(portListener)
        processManager?.killAllProcesses()
        scope.cancel()
    }

    private fun taskToMap(task: TaskSnapshot): WritableMap =
        Arguments.createMap().apply {
            putInt("id", task.id)
            putInt("taskId", task.id)
            putInt("pid", task.pid)
            putInt("processGroupId", task.processGroupId)
            putString("type", task.type.name)
            putString("source", task.source.name)
            putString("command", task.command)
            putString("cwd", task.cwd)
            putBoolean("persistent", task.persistent)
            putDouble("startTime", task.startTime.toDouble())
            putDouble("uptime", (System.currentTimeMillis() - task.startTime).toDouble())
            putString("state", task.state.name)
            putBoolean("isRunning", task.isRunning)
            task.exitCode?.let { putInt("exitCode", it) } ?: putNull("exitCode")
            task.failure?.let { putString("failure", it) } ?: putNull("failure")
            putArray("ports", portsToArray(task.ports))
        }

    private fun portsToArray(ports: List<VerifiedPort>): WritableArray =
        Arguments.createArray().apply {
            ports.forEach { pushMap(portToMap(it)) }
        }

    private fun portToMap(port: VerifiedPort): WritableMap =
        Arguments.createMap().apply {
            putInt("port", port.port)
            putInt("processId", port.taskId)
            putInt("taskId", port.taskId)
            putInt("pid", port.pid)
            putInt("processGroupId", port.processGroupId)
            putString("url", port.url)
            putString("source", port.source)
            putString("state", port.state)
            putDouble("verifiedAt", port.verifiedAt.toDouble())
        }
}
