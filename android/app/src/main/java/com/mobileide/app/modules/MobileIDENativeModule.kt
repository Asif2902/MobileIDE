package com.mobileide.app.modules

import android.content.Intent
import android.net.Uri
import com.facebook.react.bridge.*
import com.mobileide.app.runtime.RuntimeManager
import kotlinx.coroutines.*

/**
 * Main MobileIDE Native Module
 * Provides runtime management and core IDE functionality
 */
class MobileIDENativeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "MobileIDENative"
        private var runtimeManager: RuntimeManager? = null
        
        fun getRuntimeManager(context: ReactApplicationContext): RuntimeManager {
            if (runtimeManager == null) {
                runtimeManager = RuntimeManager(context)
            }
            return runtimeManager!!
        }
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun getName(): String = NAME

    /**
     * Check if runtime is ready
     */
    @ReactMethod
    fun isRuntimeReady(promise: Promise) {
        try {
            val manager = getRuntimeManager(reactApplicationContext)
            promise.resolve(manager.isRuntimeReady())
        } catch (e: Exception) {
            promise.reject("RUNTIME_ERROR", e.message)
        }
    }

    /**
     * Initialize the runtime (extract binaries, setup environment)
     */
    @ReactMethod
    fun initializeRuntime(promise: Promise) {
        scope.launch {
            try {
                val manager = getRuntimeManager(reactApplicationContext)
                
                if (manager.isRuntimeReady()) {
                    withContext(Dispatchers.Main) {
                        promise.resolve(true)
                    }
                    return@launch
                }
                
                manager.initializeRuntime { message, progress ->
                    // Send progress events to JS
                    sendEvent("onRuntimeProgress", Arguments.createMap().apply {
                        putString("message", message)
                        putDouble("progress", progress.toDouble())
                    })
                }
                
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("RUNTIME_INIT_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Get runtime root path
     */
    @ReactMethod
    fun getRuntimeRoot(promise: Promise) {
        try {
            val manager = getRuntimeManager(reactApplicationContext)
            promise.resolve(manager.getRuntimeRoot())
        } catch (e: Exception) {
            promise.reject("RUNTIME_ERROR", e.message)
        }
    }

    /**
     * Get all runtime paths
     */
    @ReactMethod
    fun getRuntimePaths(promise: Promise) {
        try {
            val manager = getRuntimeManager(reactApplicationContext)
            val paths = Arguments.createMap().apply {
                putString("root", manager.getRuntimeRoot())
                putString("bin", manager.getBinDir())
                putString("lib", manager.getLibDir())
                putString("home", manager.getHomeDir())
                putString("workspaces", manager.getWorkspacesDir())
                putString("tmp", manager.getTmpDir())
                putString("cache", manager.getCacheDir())
                putString("etc", manager.getEtcDir())
            }
            promise.resolve(paths)
        } catch (e: Exception) {
            promise.reject("RUNTIME_ERROR", e.message)
        }
    }

    /**
     * Get virtual paths (what user sees)
     */
    @ReactMethod
    fun getVirtualPaths(promise: Promise) {
        val paths = Arguments.createMap().apply {
            putString("root", RuntimeManager.VIRTUAL_ROOT)
            putString("bin", RuntimeManager.VIRTUAL_BIN)
            putString("home", RuntimeManager.VIRTUAL_HOME)
            putString("workspaces", RuntimeManager.VIRTUAL_WORKSPACES)
            putString("tmp", RuntimeManager.VIRTUAL_TMP)
            putString("cache", RuntimeManager.VIRTUAL_CACHE)
        }
        promise.resolve(paths)
    }

    /**
     * Resolve virtual path to real path
     */
    @ReactMethod
    fun resolvePath(virtualPath: String, promise: Promise) {
        try {
            val manager = getRuntimeManager(reactApplicationContext)
            promise.resolve(manager.resolveVirtualPath(virtualPath))
        } catch (e: Exception) {
            promise.reject("PATH_ERROR", e.message)
        }
    }

    /**
     * Convert real path to virtual path
     */
    @ReactMethod
    fun toVirtualPath(realPath: String, promise: Promise) {
        try {
            val manager = getRuntimeManager(reactApplicationContext)
            promise.resolve(manager.toVirtualPath(realPath))
        } catch (e: Exception) {
            promise.reject("PATH_ERROR", e.message)
        }
    }

    /**
     * Get runtime environment variables
     */
    @ReactMethod
    fun getEnvironment(promise: Promise) {
        try {
            val manager = getRuntimeManager(reactApplicationContext)
            val env = manager.getEnvironment()
            val envMap = Arguments.createMap()
            env.forEach { (key, value) ->
                envMap.putString(key, value)
            }
            promise.resolve(envMap)
        } catch (e: Exception) {
            promise.reject("ENV_ERROR", e.message)
        }
    }

    /**
     * Get app version info
     */
    @ReactMethod
    fun getVersionInfo(promise: Promise) {
        try {
            val packageInfo = reactApplicationContext.packageManager
                .getPackageInfo(reactApplicationContext.packageName, 0)
            
            val info = Arguments.createMap().apply {
                putString("versionName", packageInfo.versionName)
                putInt("versionCode", packageInfo.longVersionCode.toInt())
                putString("packageName", reactApplicationContext.packageName)
            }
            promise.resolve(info)
        } catch (e: Exception) {
            promise.reject("VERSION_ERROR", e.message)
        }
    }

    /**
     * Open a URL in the system browser (or app that handles http/https).
     * Used to preview Vite/Express dev servers on the device.
     */
    @ReactMethod
    fun openUrl(url: String, promise: Promise) {
        try {
            val uri = Uri.parse(url)
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") {
                promise.reject("URL_ERROR", "Only http/https URLs are allowed")
                return
            }
            val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("URL_ERROR", e.message, e)
        }
    }

    /**
     * Send event to JavaScript
     */
    private fun sendEvent(eventName: String, params: WritableMap) {
        reactApplicationContext
            .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    override fun invalidate() {
        super.invalidate()
        scope.cancel()
    }
}
