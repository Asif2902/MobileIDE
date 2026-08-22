package com.mobileide.app.modules

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.documentfile.provider.DocumentFile
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.mobileide.app.projects.ProjectConflictPolicy
import com.mobileide.app.projects.ProjectImportSource
import com.mobileide.app.projects.ProjectRecord
import com.mobileide.app.projects.ProjectRegistry
import com.mobileide.app.projects.ProjectTransferListener
import com.mobileide.app.projects.ProjectTransferManager
import com.mobileide.app.projects.ProjectTransferMode
import com.mobileide.app.projects.ProjectTransferOptions
import com.mobileide.app.projects.ProjectTransferResult
import com.mobileide.app.projects.ProjectTransferSnapshot
import com.mobileide.app.projects.WorkspaceLocationPolicy
import java.io.File
import java.io.IOException

/**
 * Android project-location and transfer bridge. Raw shared-storage opening is
 * retained for quick editing, while development imports and exports use a
 * capability-aware, cancellable transfer service and SAF tree permissions.
 */
class StorageNativeModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "StorageNative"
        private const val REQUEST_IMPORT_TREE = 0xADE1
        private const val REQUEST_EXPORT_TREE = 0xADE2
        const val EVENT_TRANSFER_PROGRESS = "onProjectTransferProgress"
        const val EVENT_TRANSFER_COMPLETE = "onProjectTransferComplete"
        const val EVENT_TRANSFER_ERROR = "onProjectTransferError"
    }

    private val pickerLock = Any()
    private val pendingPickers = mutableMapOf<Int, Promise>()

    private val runtimeManager by lazy {
        MobileIDENativeModule.getRuntimeManager(reactApplicationContext)
    }

    private val workspacesRoot by lazy {
        File(runtimeManager.getWorkspacesDir()).canonicalFile
    }

    private val workspacePolicy by lazy {
        WorkspaceLocationPolicy(workspacesRoot, approvedExternalRoots())
    }

    private val projectRegistry by lazy {
        ProjectRegistry(File(reactApplicationContext.filesDir, "adev-projects/project-registry.properties"))
    }

    private val transferManagerDelegate = lazy {
        ProjectTransferManager(
            context = reactApplicationContext,
            workspacePolicy = workspacePolicy,
            workspacesRoot = workspacesRoot,
            virtualWorkspacesRoot = com.mobileide.app.runtime.RuntimeManager.VIRTUAL_WORKSPACES,
            registry = projectRegistry,
            listener = object : ProjectTransferListener {
                override fun onProgress(snapshot: ProjectTransferSnapshot) {
                    sendEvent(EVENT_TRANSFER_PROGRESS, snapshotMap(snapshot))
                }

                override fun onComplete(
                    snapshot: ProjectTransferSnapshot,
                    result: ProjectTransferResult
                ) {
                    sendEvent(EVENT_TRANSFER_COMPLETE, snapshotMap(snapshot).apply {
                        putMap("result", transferResultMap(result))
                    })
                }

                override fun onError(
                    snapshot: ProjectTransferSnapshot,
                    code: String,
                    message: String
                ) {
                    sendEvent(EVENT_TRANSFER_ERROR, snapshotMap(snapshot).apply {
                        putString("code", code)
                        putString("message", message)
                    })
                }
            }
        )
    }
    private val transferManager by transferManagerDelegate

    private val activityListener = object : BaseActivityEventListener() {
        override fun onActivityResult(
            activity: Activity,
            requestCode: Int,
            resultCode: Int,
            data: Intent?
        ) {
            if (requestCode != REQUEST_IMPORT_TREE && requestCode != REQUEST_EXPORT_TREE) return
            val promise = synchronized(pickerLock) { pendingPickers.remove(requestCode) } ?: return
            if (resultCode != Activity.RESULT_OK || data?.data == null) {
                promise.resolve(null)
                return
            }
            val uri = requireNotNull(data.data)
            val requiredFlag = if (requestCode == REQUEST_EXPORT_TREE) {
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            } else {
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            }
            val grantedFlags = data.flags and (
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                )
            if (grantedFlags and requiredFlag == 0) {
                promise.reject(
                    "TREE_PERMISSION_ERROR",
                    if (requestCode == REQUEST_EXPORT_TREE) {
                        "Selected folder did not grant write access"
                    } else {
                        "Selected folder did not grant read access"
                    }
                )
                return
            }
            try {
                reactApplicationContext.contentResolver.takePersistableUriPermission(uri, grantedFlags)
                val tree = DocumentFile.fromTreeUri(reactApplicationContext, uri)
                    ?: throw IOException("Selected document tree is unavailable")
                promise.resolve(Arguments.createMap().apply {
                    putString("kind", "treeUri")
                    putString("value", uri.toString())
                    putString("displayName", tree.name ?: "Selected folder")
                    putBoolean("canRead", tree.canRead())
                    putBoolean("canWrite", tree.canWrite())
                })
            } catch (error: Exception) {
                promise.reject(
                    "TREE_PERMISSION_ERROR",
                    "ADEV could not retain access to the selected folder: ${error.message}",
                    error
                )
            }
        }
    }

    init {
        reactContext.addActivityEventListener(activityListener)
    }

    override fun getName(): String = NAME

    @ReactMethod
    fun hasAllFilesAccess(promise: Promise) {
        try {
            promise.resolve(
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    Environment.isExternalStorageManager()
                } else {
                    true
                }
            )
        } catch (error: Exception) {
            promise.reject("STORAGE_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun requestAllFilesAccess(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                promise.resolve(true)
                return
            }
            val intent = try {
                Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:${reactApplicationContext.packageName}")
                )
            } catch (_: Exception) {
                Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
            }
            val activity = reactApplicationContext.currentActivity
            if (activity != null) activity.startActivity(intent)
            else reactApplicationContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            promise.resolve(true)
        } catch (_: Exception) {
            try {
                reactApplicationContext.startActivity(
                    Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
                promise.resolve(true)
            } catch (error: Exception) {
                promise.reject("STORAGE_ERROR", error.message, error)
            }
        }
    }

    @ReactMethod
    fun listExternalRoots(promise: Promise) {
        try {
            val result = Arguments.createArray()
            val primary = Environment.getExternalStorageDirectory()
            val roots = LinkedHashMap<String, String>()
            roots["Internal Storage"] = primary.absolutePath
            listOf("Download", "Documents", "Projects", "Git", "DCIM", "Desktop", "AndroidIDEProjects")
                .forEach { name ->
                    File(primary, name).takeIf(File::isDirectory)?.let { roots[name] = it.absolutePath }
                }
            roots.forEach { (name, path) ->
                result.pushMap(Arguments.createMap().apply {
                    putString("name", name)
                    putString("path", path)
                })
            }
            promise.resolve(result)
        } catch (error: Exception) {
            promise.reject("STORAGE_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun pickProjectTree(promise: Promise) = launchTreePicker(REQUEST_IMPORT_TREE, promise)

    @ReactMethod
    fun pickExportTree(promise: Promise) = launchTreePicker(REQUEST_EXPORT_TREE, promise)

    @ReactMethod
    fun assessWorkspace(realPath: String, promise: Promise) {
        try {
            val assessment = workspacePolicy.assess(File(realPath))
            promise.resolve(Arguments.createMap().apply {
                putString("path", assessment.path)
                putBoolean("privateWorkspace", assessment.privateWorkspace)
                putBoolean("sharedStorage", assessment.sharedStorage)
                putBoolean("nativeBuilds", assessment.nativeBuilds)
                putBoolean("executableModes", assessment.executableModes)
                putBoolean("symlinks", assessment.symlinks)
                putBoolean("caseSensitiveNames", assessment.caseSensitiveNames)
                putBoolean("requiresPrivateImport", assessment.requiresPrivateImport)
                assessment.reason?.let { putString("reason", it) }
            })
        } catch (error: Exception) {
            promise.reject("WORKSPACE_ASSESS_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun beginImport(
        source: ReadableMap,
        requestedName: String?,
        options: ReadableMap?,
        promise: Promise
    ) {
        try {
            val operationId = transferManager.beginImport(
                parseImportSource(source),
                requestedName,
                parseTransferOptions(options)
            )
            promise.resolve(operationId)
        } catch (error: Exception) {
            promise.reject("PROJECT_IMPORT_START_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun beginExport(
        workspacePath: String,
        destinationTreeUri: String,
        requestedName: String?,
        options: ReadableMap?,
        promise: Promise
    ) {
        try {
            val operationId = transferManager.beginExport(
                File(runtimeManager.resolveVirtualPath(workspacePath)),
                Uri.parse(destinationTreeUri),
                requestedName,
                parseTransferOptions(options)
            )
            promise.resolve(operationId)
        } catch (error: Exception) {
            promise.reject("PROJECT_EXPORT_START_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun getTransfer(operationId: String, promise: Promise) {
        val snapshot = transferManager.snapshot(operationId)
        if (snapshot == null) promise.reject("TRANSFER_NOT_FOUND", "Unknown transfer operation")
        else promise.resolve(snapshotMap(snapshot))
    }

    @ReactMethod
    fun cancelTransfer(operationId: String, promise: Promise) {
        promise.resolve(transferManager.cancel(operationId))
    }

    @ReactMethod
    fun listProjectMetadata(promise: Promise) {
        try {
            val result = Arguments.createArray()
            projectRegistry.list().forEach { result.pushMap(projectRecordMap(it)) }
            promise.resolve(result)
        } catch (error: Exception) {
            promise.reject("PROJECT_METADATA_ERROR", error.message, error)
        }
    }

    /** Backward-compatible full raw copy for the existing JS interface. */
    @ReactMethod
    fun importWorkspaceToPrivate(realPath: String, requestedName: String?, promise: Promise) {
        try {
            transferManager.beginImport(
                source = ProjectImportSource.RawPath(File(realPath), File(realPath).name),
                requestedName = requestedName,
                options = ProjectTransferOptions(
                    mode = ProjectTransferMode.FULL,
                    includeGit = true,
                    includeHidden = true,
                    includeSecrets = true,
                    conflictPolicy = ProjectConflictPolicy.UNIQUE
                )
            ) { result ->
                reactApplicationContext.runOnUiQueueThread {
                    result.fold(
                        onSuccess = { imported ->
                            promise.resolve(Arguments.createMap().apply {
                                putString("name", imported.project.projectName)
                                putString("path", imported.path)
                                putString("virtualPath", imported.virtualPath)
                                putBoolean("privateWorkspace", true)
                            })
                        },
                        onFailure = { error ->
                            promise.reject("WORKSPACE_IMPORT_ERROR", error.message, error)
                        }
                    )
                }
            }
        } catch (error: Exception) {
            promise.reject("WORKSPACE_IMPORT_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Double) = Unit

    private fun launchTreePicker(requestCode: Int, promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.reject("TREE_PICKER_UNAVAILABLE", "No foreground activity is available")
            return
        }
        synchronized(pickerLock) {
            if (pendingPickers.isNotEmpty()) {
                promise.reject("TREE_PICKER_BUSY", "A folder picker is already open")
                return
            }
            pendingPickers[requestCode] = promise
        }
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
            }
            activity.startActivityForResult(intent, requestCode)
        } catch (error: Exception) {
            synchronized(pickerLock) { pendingPickers.remove(requestCode) }
            promise.reject("TREE_PICKER_UNAVAILABLE", error.message, error)
        }
    }

    private fun parseImportSource(source: ReadableMap): ProjectImportSource {
        fun requiredString(name: String): String {
            if (!source.hasKey(name) || source.isNull(name)) {
                throw IllegalArgumentException("Import source $name is required")
            }
            return source.getString(name)?.takeIf(String::isNotBlank)
                ?: throw IllegalArgumentException("Import source $name is required")
        }
        val kind = requiredString("kind")
        val value = requiredString("value")
        val displayName = if (source.hasKey("displayName") && !source.isNull("displayName")) {
            source.getString("displayName")
        } else {
            null
        }
        return when (kind) {
            "rawPath" -> ProjectImportSource.RawPath(File(value), displayName)
            "treeUri" -> ProjectImportSource.TreeUri(Uri.parse(value), displayName)
            else -> throw IllegalArgumentException("Unsupported import source kind: $kind")
        }
    }

    private fun parseTransferOptions(options: ReadableMap?): ProjectTransferOptions {
        fun string(name: String, fallback: String): String =
            if (options?.hasKey(name) == true && !options.isNull(name)) options.getString(name) ?: fallback
            else fallback
        fun bool(name: String, fallback: Boolean): Boolean =
            if (options?.hasKey(name) == true && !options.isNull(name)) options.getBoolean(name)
            else fallback
        val mode = when (string("mode", "source").lowercase()) {
            "source" -> ProjectTransferMode.SOURCE
            "full" -> ProjectTransferMode.FULL
            else -> throw IllegalArgumentException("mode must be source or full")
        }
        val conflict = when (string("conflictPolicy", "unique").lowercase()) {
            "unique" -> ProjectConflictPolicy.UNIQUE
            "merge" -> ProjectConflictPolicy.MERGE
            "replace" -> ProjectConflictPolicy.REPLACE
            "cancel" -> ProjectConflictPolicy.CANCEL
            else -> throw IllegalArgumentException("Unsupported conflict policy")
        }
        return ProjectTransferOptions(
            mode = mode,
            includeGit = bool("includeGit", false),
            includeHidden = bool("includeHidden", true),
            includeSecrets = bool("includeSecrets", false),
            conflictPolicy = conflict
        )
    }

    private fun approvedExternalRoots(): List<File> {
        val roots = mutableListOf(
            Environment.getExternalStorageDirectory(),
            File("/storage/emulated/0"),
            File("/sdcard"),
            File("/storage/self/primary")
        )
        File("/storage").listFiles()
            ?.filter { it.name.matches(Regex("[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}")) }
            ?.let(roots::addAll)
        File("/mnt/media_rw").listFiles()
            ?.filter { it.name.matches(Regex("[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}")) }
            ?.let(roots::addAll)
        return roots
    }

    private fun snapshotMap(snapshot: ProjectTransferSnapshot): WritableMap = Arguments.createMap().apply {
        putString("operationId", snapshot.operationId)
        putString("direction", snapshot.direction.name.lowercase())
        putString(
            "status",
            when (snapshot.status) {
                com.mobileide.app.projects.ProjectTransferStatus.PLANNING -> "queued"
                com.mobileide.app.projects.ProjectTransferStatus.RUNNING,
                com.mobileide.app.projects.ProjectTransferStatus.FINALIZING -> "running"
                com.mobileide.app.projects.ProjectTransferStatus.COMPLETE -> "complete"
                com.mobileide.app.projects.ProjectTransferStatus.FAILED -> "error"
                com.mobileide.app.projects.ProjectTransferStatus.CANCELLED -> "cancelled"
            }
        )
        putString("phase", snapshot.phase)
        putDouble("filesCopied", snapshot.filesCopied.toDouble())
        putDouble("totalFiles", snapshot.totalFiles.toDouble())
        putDouble("bytesCopied", snapshot.bytesCopied.toDouble())
        putDouble("totalBytes", snapshot.totalBytes.toDouble())
        putDouble("skippedEntries", snapshot.skippedEntries.toDouble())
        snapshot.currentPath?.let { putString("currentPath", it) }
    }

    private fun transferResultMap(result: ProjectTransferResult): WritableMap = Arguments.createMap().apply {
        when (result) {
            is ProjectTransferResult.Import -> {
                putString("kind", "import")
                putString("path", result.path)
                putString("virtualPath", result.virtualPath)
                putMap("project", projectRecordMap(result.project))
            }
            is ProjectTransferResult.Export -> {
                putString("kind", "export")
                putString("destinationTreeUri", result.destinationTreeUri)
                putString("projectDocumentUri", result.projectDocumentUri)
                putString("exportedName", result.exportedName)
                putMap("project", projectRecordMap(result.project))
            }
        }
    }

    private fun projectRecordMap(record: ProjectRecord): WritableMap = Arguments.createMap().apply {
        putString("id", record.id)
        putString("workspacePath", record.workspacePath)
        putString("virtualPath", record.virtualPath)
        putString("projectName", record.projectName)
        putDouble("importedAt", record.importedAt.toDouble())
        putString("projectType", record.projectType)
        record.originalSourceKind?.let { putString("originalSourceKind", it) }
        record.originalImportedPath?.let { putString("originalImportedPath", it) }
        record.originalTreeUri?.let { putString("originalTreeUri", it) }
        record.lastExportUri?.let { putString("lastExportUri", it) }
        record.lastExportAt?.let { putDouble("lastExportAt", it.toDouble()) }
    }

    private fun sendEvent(eventName: String, params: WritableMap) {
        if (!reactApplicationContext.hasActiveReactInstance()) return
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    override fun invalidate() {
        synchronized(pickerLock) {
            pendingPickers.values.forEach {
                it.reject("TREE_PICKER_CANCELLED", "Storage module was invalidated")
            }
            pendingPickers.clear()
        }
        if (transferManagerDelegate.isInitialized()) transferManager.close()
        reactApplicationContext.removeActivityEventListener(activityListener)
        super.invalidate()
    }
}
