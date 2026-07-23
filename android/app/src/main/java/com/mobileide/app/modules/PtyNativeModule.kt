package com.mobileide.app.modules

import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.mobileide.app.pty.PtySessionManager
import kotlinx.coroutines.*
import java.io.IOException

/**
 * PTY Native Module
 * Provides terminal/PTY functionality to React Native
 */
class PtyNativeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "PtyNative"
        private var sessionManager: PtySessionManager? = null
        private const val READ_BUFFER_SIZE = 8192
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val readJobs = mutableMapOf<Int, Job>()

    override fun getName(): String = NAME

    private fun getSessionManager(): PtySessionManager {
        if (sessionManager == null) {
            val runtimeManager = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            sessionManager = PtySessionManager(runtimeManager)
        }
        return sessionManager!!
    }

    /**
     * Create a new terminal session
     */
    @ReactMethod
    fun createSession(cols: Int, rows: Int, cwd: String?, promise: Promise) {
        scope.launch {
            try {
                val manager = getSessionManager()
                val session = manager.createSession(
                    cols = if (cols > 0) cols else 80,
                    rows = if (rows > 0) rows else 24,
                    cwd = cwd
                )
                
                // Start reading output
                startReading(session.id)
                
                withContext(Dispatchers.Main) {
                    val result = Arguments.createMap().apply {
                        putInt("sessionId", session.id)
                        putString("cwd", session.workingDirectory)
                        putInt("cols", session.cols)
                        putInt("rows", session.rows)
                    }
                    promise.resolve(result)
                }
            } catch (e: Throwable) {
                withContext(Dispatchers.Main) {
                    promise.reject("PTY_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Write input to terminal
     */
    @ReactMethod
    fun write(sessionId: Int, data: String, promise: Promise) {
        scope.launch {
            try {
                val manager = getSessionManager()
                manager.writeToSession(sessionId, data)
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Throwable) {
                withContext(Dispatchers.Main) {
                    promise.reject("PTY_WRITE_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Resize terminal
     */
    @ReactMethod
    fun resize(sessionId: Int, cols: Int, rows: Int, promise: Promise) {
        try {
            val manager = getSessionManager()
            manager.resizeSession(sessionId, cols, rows)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("PTY_RESIZE_ERROR", e.message)
        }
    }

    /**
     * Destroy terminal session
     */
    @ReactMethod
    fun destroySession(sessionId: Int, promise: Promise) {
        try {
            // Stop reading
            readJobs.remove(sessionId)?.cancel()
            
            val manager = getSessionManager()
            manager.destroySession(sessionId)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("PTY_DESTROY_ERROR", e.message)
        }
    }

    /**
     * Get all active sessions
     */
    @ReactMethod
    fun getSessions(promise: Promise) {
        try {
            val manager = getSessionManager()
            val sessions = manager.getAllSessions()
            
            val result = Arguments.createArray()
            sessions.forEach { session ->
                result.pushMap(Arguments.createMap().apply {
                    putInt("id", session.id)
                    putString("title", session.title)
                    putString("cwd", session.workingDirectory)
                    putInt("cols", session.cols)
                    putInt("rows", session.rows)
                    putBoolean("isAlive", session.isAlive())
                    putDouble("createdAt", session.createdAt.toDouble())
                })
            }
            promise.resolve(result)
        } catch (e: Throwable) {
            promise.reject("PTY_ERROR", e.message)
        }
    }

    /**
     * Check if session is alive
     */
    @ReactMethod
    fun isSessionAlive(sessionId: Int, promise: Promise) {
        try {
            val manager = getSessionManager()
            promise.resolve(manager.isSessionAlive(sessionId))
        } catch (e: Throwable) {
            promise.reject("PTY_ERROR", e.message)
        }
    }

    /**
     * Send Ctrl+C to session
     */
    @ReactMethod
    fun sendInterrupt(sessionId: Int, promise: Promise) {
        scope.launch {
            try {
                val manager = getSessionManager()
                manager.writeToSession(sessionId, "\u0003") // Ctrl+C
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Throwable) {
                withContext(Dispatchers.Main) {
                    promise.reject("PTY_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Send Ctrl+Z to session
     */
    @ReactMethod
    fun sendSuspend(sessionId: Int, promise: Promise) {
        scope.launch {
            try {
                val manager = getSessionManager()
                manager.writeToSession(sessionId, "\u001A") // Ctrl+Z
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Throwable) {
                withContext(Dispatchers.Main) {
                    promise.reject("PTY_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Send Ctrl+D (EOF) to session
     */
    @ReactMethod
    fun sendEOF(sessionId: Int, promise: Promise) {
        scope.launch {
            try {
                val manager = getSessionManager()
                manager.writeToSession(sessionId, "\u0004") // Ctrl+D
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Throwable) {
                withContext(Dispatchers.Main) {
                    promise.reject("PTY_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Send Tab key to session
     */
    @ReactMethod
    fun sendTab(sessionId: Int, promise: Promise) {
        scope.launch {
            try {
                val manager = getSessionManager()
                manager.writeToSession(sessionId, "\t")
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Throwable) {
                withContext(Dispatchers.Main) {
                    promise.reject("PTY_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Start reading output from a session
     */
    private fun startReading(sessionId: Int) {
        val job = scope.launch {
            val manager = getSessionManager()
            val session = manager.getSession(sessionId) ?: return@launch
            val buffer = ByteArray(READ_BUFFER_SIZE)
            
            while (isActive && session.isAlive()) {
                try {
                    val bytesRead = session.backend.read(buffer)
                    
                    if (bytesRead > 0) {
                        val output = String(buffer, 0, bytesRead, Charsets.UTF_8)
                        
                        withContext(Dispatchers.Main) {
                            sendEvent("onTerminalOutput", Arguments.createMap().apply {
                                putInt("sessionId", sessionId)
                                putString("data", output)
                            })
                        }
                    } else if (bytesRead == 0) {
                        // No data available, small delay
                        delay(10)
                    } else {
                        // PTY closed
                        break
                    }
                } catch (e: Throwable) {
                    break
                }
            }
            
            // Session ended
            withContext(Dispatchers.Main) {
                sendEvent("onTerminalExit", Arguments.createMap().apply {
                    putInt("sessionId", sessionId)
                    putInt("exitCode", session.backend.getExitCode() ?: -1)
                })
            }
        }
        
        readJobs[sessionId] = job
    }

    /**
     * Send event to JavaScript
     */
    private fun sendEvent(eventName: String, params: WritableMap) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    override fun invalidate() {
        super.invalidate()
        readJobs.values.forEach { it.cancel() }
        readJobs.clear()
        sessionManager?.destroyAllSessions()
        scope.cancel()
    }
}
