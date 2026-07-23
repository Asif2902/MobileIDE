package com.mobileide.app.modules

import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.mobileide.app.process.ProcessManager
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

    override fun getName(): String = NAME

    private fun getProcessManager(): ProcessManager {
        if (processManager == null) {
            val runtimeManager = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            processManager = ProcessManager(runtimeManager)
        }
        return processManager!!
    }

    /**
     * Spawn a new process
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
                
                val pidHolder = intArrayOf(-1)
                val process = manager.spawnProcess(
                    command = command,
                    args = argList,
                    cwd = cwd,
                    onOutput = { line ->
                        sendEvent("onProcessOutput", Arguments.createMap().apply {
                            putInt("processId", pidHolder[0])
                            putString("data", line)
                            putString("stream", "stdout")
                        })
                    },
                    onError = { line ->
                        sendEvent("onProcessOutput", Arguments.createMap().apply {
                            putInt("processId", pidHolder[0])
                            putString("data", line)
                            putString("stream", "stderr")
                        })
                    },
                    onExit = { exitCode ->
                        sendEvent("onProcessExit", Arguments.createMap().apply {
                            putInt("processId", pidHolder[0])
                            putInt("exitCode", exitCode)
                        })
                    }
                )
                pidHolder[0] = process.id
                
                withContext(Dispatchers.Main) {
                    val result = Arguments.createMap().apply {
                        putInt("processId", process.id)
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
     * Kill a process
     */
    @ReactMethod
    fun kill(processId: Int, promise: Promise) {
        try {
            val manager = getProcessManager()
            manager.killProcess(processId)
            promise.resolve(true)
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

    /**
     * Get active ports
     */
    @ReactMethod
    fun getActivePorts(promise: Promise) {
        try {
            val manager = getProcessManager()
            val ports = manager.getActivePorts()
            
            val result = Arguments.createArray()
            ports.forEach { (port, processId) ->
                result.pushMap(Arguments.createMap().apply {
                    putInt("port", port)
                    putInt("processId", processId)
                })
            }
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
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    override fun invalidate() {
        super.invalidate()
        processManager?.killAllProcesses()
        scope.cancel()
    }
}
