package com.mobileide.app.modules

import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.mobileide.app.filesystem.VirtualFileSystem
import kotlinx.coroutines.*

/**
 * FileSystem Native Module
 * Provides file system operations to React Native
 */
class FileSystemNativeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "FileSystemNative"
        private var fileSystem: VirtualFileSystem? = null
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val watchIds = mutableSetOf<String>()

    override fun getName(): String = NAME

    private fun getFileSystem(): VirtualFileSystem {
        if (fileSystem == null) {
            val runtimeManager = MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
            fileSystem = VirtualFileSystem(runtimeManager)
        }
        return fileSystem!!
    }

    /**
     * List directory contents
     */
    @ReactMethod
    fun listDir(path: String, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                val entries = fs.listDir(path)
                
                val result = Arguments.createArray()
                entries.forEach { entry ->
                    result.pushMap(Arguments.createMap().apply {
                        putString("name", entry.name)
                        putString("path", entry.path)
                        putBoolean("isDirectory", entry.isDirectory)
                        putDouble("size", entry.size.toDouble())
                        putDouble("modifiedTime", entry.modifiedTime.toDouble())
                        putBoolean("isHidden", entry.isHidden)
                    })
                }
                
                withContext(Dispatchers.Main) {
                    promise.resolve(result)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Read file content
     */
    @ReactMethod
    fun readFile(path: String, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                val content = fs.readFile(path)
                withContext(Dispatchers.Main) {
                    promise.resolve(content)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_READ_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Write file content
     */
    @ReactMethod
    fun writeFile(path: String, content: String, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                fs.writeFile(path, content)
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_WRITE_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Append to file
     */
    @ReactMethod
    fun appendFile(path: String, content: String, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                fs.appendFile(path, content)
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_APPEND_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Create directory
     */
    @ReactMethod
    fun mkdir(path: String, recursive: Boolean, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                fs.mkdir(path, recursive)
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_MKDIR_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Create empty file
     */
    @ReactMethod
    fun touch(path: String, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                fs.touch(path)
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_TOUCH_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Rename/move file or directory
     */
    @ReactMethod
    fun rename(oldPath: String, newPath: String, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                fs.rename(oldPath, newPath)
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_RENAME_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Copy file or directory
     */
    @ReactMethod
    fun copy(sourcePath: String, destPath: String, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                fs.copy(sourcePath, destPath)
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_COPY_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Delete file or directory
     */
    @ReactMethod
    fun delete(path: String, recursive: Boolean, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                fs.delete(path, recursive)
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_DELETE_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Get file stats
     */
    @ReactMethod
    fun stat(path: String, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                val entry = fs.stat(path)
                
                val result = Arguments.createMap().apply {
                    putString("name", entry.name)
                    putString("path", entry.path)
                    putBoolean("isDirectory", entry.isDirectory)
                    putDouble("size", entry.size.toDouble())
                    putDouble("modifiedTime", entry.modifiedTime.toDouble())
                    putBoolean("isHidden", entry.isHidden)
                    putBoolean("isReadable", entry.isReadable)
                    putBoolean("isWritable", entry.isWritable)
                    putBoolean("isExecutable", entry.isExecutable)
                }
                
                withContext(Dispatchers.Main) {
                    promise.resolve(result)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_STAT_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Check if path exists
     */
    @ReactMethod
    fun exists(path: String, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                val exists = fs.exists(path)
                withContext(Dispatchers.Main) {
                    promise.resolve(exists)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.resolve(false)
                }
            }
        }
    }

    /**
     * Search for files
     */
    @ReactMethod
    fun search(rootPath: String, pattern: String, maxResults: Int, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                val results = fs.search(rootPath, pattern, maxResults)
                
                val resultArray = Arguments.createArray()
                results.forEach { entry ->
                    resultArray.pushMap(Arguments.createMap().apply {
                        putString("name", entry.name)
                        putString("path", entry.path)
                        putBoolean("isDirectory", entry.isDirectory)
                        putDouble("size", entry.size.toDouble())
                    })
                }
                
                withContext(Dispatchers.Main) {
                    promise.resolve(resultArray)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_SEARCH_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Search file contents (grep)
     */
    @ReactMethod
    fun grep(rootPath: String, pattern: String, maxResults: Int, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                val results = fs.grep(rootPath, pattern, maxResults)
                
                val resultArray = Arguments.createArray()
                results.forEach { result ->
                    resultArray.pushMap(Arguments.createMap().apply {
                        putString("file", result.file)
                        putInt("line", result.line)
                        putString("content", result.content)
                        putString("match", result.match)
                    })
                }
                
                withContext(Dispatchers.Main) {
                    promise.resolve(resultArray)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_GREP_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Watch directory for changes
     */
    @ReactMethod
    fun watchDirectory(path: String, promise: Promise) {
        try {
            val fs = getFileSystem()
            val watchId = fs.watchDirectory(path) { event ->
                sendEvent("onFileChange", Arguments.createMap().apply {
                    putString("type", event.type.name)
                    putString("path", event.path)
                })
            }
            watchIds.add(watchId)
            promise.resolve(watchId)
        } catch (e: Exception) {
            promise.reject("FS_WATCH_ERROR", e.message)
        }
    }

    /**
     * Stop watching directory
     */
    @ReactMethod
    fun stopWatching(watchId: String, promise: Promise) {
        try {
            val fs = getFileSystem()
            fs.stopWatching(watchId)
            watchIds.remove(watchId)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("FS_WATCH_ERROR", e.message)
        }
    }

    /**
     * Get workspaces list
     */
    @ReactMethod
    fun getWorkspaces(promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                val workspaces = fs.getWorkspaces()
                
                val result = Arguments.createArray()
                workspaces.forEach { entry ->
                    result.pushMap(Arguments.createMap().apply {
                        putString("name", entry.name)
                        putString("path", entry.path)
                        putDouble("modifiedTime", entry.modifiedTime.toDouble())
                    })
                }
                
                withContext(Dispatchers.Main) {
                    promise.resolve(result)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_ERROR", e.message)
                }
            }
        }
    }

    /**
     * Open a real external folder (e.g. under /storage/emulated/0) and return
     * its entries. Requires all-files access to have been granted.
     */
    @ReactMethod
    fun openExternalFolder(path: String, promise: Promise) {
        scope.launch {
            try {
                val fs = getFileSystem()
                val entries = fs.openExternalFolder(path)

                val result = Arguments.createArray()
                entries.forEach { entry ->
                    result.pushMap(Arguments.createMap().apply {
                        putString("name", entry.name)
                        putString("path", entry.path)
                        putBoolean("isDirectory", entry.isDirectory)
                        putDouble("size", entry.size.toDouble())
                        putDouble("modifiedTime", entry.modifiedTime.toDouble())
                        putBoolean("isHidden", entry.isHidden)
                    })
                }

                withContext(Dispatchers.Main) {
                    promise.resolve(result)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("FS_ERROR", e.message)
                }
            }
        }
    }

    private fun sendEvent(eventName: String, params: WritableMap) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    override fun invalidate() {
        super.invalidate()
        fileSystem?.stopAllWatchers()
        scope.cancel()
    }
}
