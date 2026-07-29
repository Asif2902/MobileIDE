package com.mobileide.app.modules

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import com.facebook.react.bridge.*
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.UUID

/**
 * Storage Native Module
 * Exposes all-files (MANAGE_EXTERNAL_STORAGE) access management and enumeration
 * of real external storage roots so the IDE can open/edit real device folders.
 */
class StorageNativeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "StorageNative"
    }

    override fun getName(): String = NAME

    /**
     * Whether the app currently holds all-files access. On API < 30 legacy
     * storage applies and this returns true.
     */
    @ReactMethod
    fun hasAllFilesAccess(promise: Promise) {
        try {
            val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Environment.isExternalStorageManager()
            } else {
                true
            }
            promise.resolve(granted)
        } catch (e: Exception) {
            promise.reject("STORAGE_ERROR", e.message)
        }
    }

    /**
     * Launch the system settings screen where the user grants all-files access.
     */
    @ReactMethod
    fun requestAllFilesAccess(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                promise.resolve(true)
                return
            }
            val pkg = reactApplicationContext.packageName
            val intent = try {
                Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:$pkg")
                )
            } catch (e: Exception) {
                Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
            }

            val activity = reactApplicationContext.currentActivity
            if (activity != null) {
                activity.startActivity(intent)
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactApplicationContext.startActivity(intent)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            // Fall back to the generic all-files settings screen.
            try {
                val fallback = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactApplicationContext.startActivity(fallback)
                promise.resolve(true)
            } catch (e2: Exception) {
                promise.reject("STORAGE_ERROR", e2.message)
            }
        }
    }

    /**
     * Enumerate common external storage roots the user is likely to open.
     */
    @ReactMethod
    fun listExternalRoots(promise: Promise) {
        try {
            val result = Arguments.createArray()
            val primary = Environment.getExternalStorageDirectory() // /storage/emulated/0

            val roots = LinkedHashMap<String, String>()
            roots["Internal Storage"] = primary.absolutePath

            val commonSub = listOf("Download", "Documents", "Projects", "Git", "DCIM", "Desktop", "AndroidIDEProjects")
            commonSub.forEach { sub ->
                val f = File(primary, sub)
                if (f.isDirectory) roots[sub] = f.absolutePath
            }

            roots.forEach { (name, path) ->
                result.pushMap(Arguments.createMap().apply {
                    putString("name", name)
                    putString("path", path)
                })
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("STORAGE_ERROR", e.message)
        }
    }

    /**
     * Report whether a project can safely use native builds, executable modes,
     * case-sensitive names and symlinks in place. Shared/FUSE paths intentionally
     * return a guided private-import requirement.
     */
    @ReactMethod
    fun assessWorkspace(realPath: String, promise: Promise) {
        try {
            val source = File(realPath).canonicalFile
            if (!source.isDirectory) throw IOException("Workspace is not a directory")
            val privateRoot = reactApplicationContext.filesDir.canonicalFile
            val privateWorkspace = source.toPath().startsWith(privateRoot.toPath())
            promise.resolve(Arguments.createMap().apply {
                putString("path", source.absolutePath)
                putBoolean("privateWorkspace", privateWorkspace)
                putBoolean("nativeBuilds", privateWorkspace)
                putBoolean("executableModes", privateWorkspace)
                putBoolean("symlinks", privateWorkspace)
                putBoolean("caseSensitiveNames", privateWorkspace)
                putBoolean("requiresPrivateImport", !privateWorkspace)
                if (!privateWorkspace) {
                    putString(
                        "reason",
                        "Android shared storage cannot guarantee execution, symlinks, Unix modes, or case sensitivity."
                    )
                }
            })
        } catch (e: Exception) {
            promise.reject("WORKSPACE_ASSESS_ERROR", e.message, e)
        }
    }

    /**
     * Copy a shared-storage project into the app-private execution workspace.
     * Symbolic links are rejected instead of followed so an import cannot escape
     * its selected source tree.
     */
    @ReactMethod
    fun importWorkspaceToPrivate(realPath: String, requestedName: String?, promise: Promise) {
        Thread {
            var staging: File? = null
            try {
                val source = File(realPath).canonicalFile
                if (!source.isDirectory) throw IOException("Workspace is not a directory")
                val privateRoot = reactApplicationContext.filesDir.canonicalFile
                if (source.toPath().startsWith(privateRoot.toPath())) {
                    throw IOException("Workspace is already in app-private storage")
                }
                val safeName = (requestedName?.trim().takeUnless { it.isNullOrEmpty() } ?: source.name)
                    .replace(Regex("[^A-Za-z0-9._-]"), "-")
                    .trim('-', '.')
                    .take(64)
                    .ifEmpty { "imported-project" }
                val workspaceRoot =
                    File(reactApplicationContext.filesDir, "runtime/workspaces").canonicalFile
                if (!workspaceRoot.mkdirs() && !workspaceRoot.isDirectory) {
                    throw IOException("Cannot create the private workspace root")
                }
                var destination = File(workspaceRoot, safeName)
                var suffix = 2
                while (destination.exists()) {
                    destination = File(workspaceRoot, "$safeName-$suffix")
                    suffix += 1
                }
                val stagingDir = File(workspaceRoot, ".import-${UUID.randomUUID()}")
                staging = stagingDir
                if (!stagingDir.mkdirs()) throw IOException("Cannot stage private workspace import")
                val sourceRoot = source.toPath()
                source.walkTopDown().forEach { entry ->
                    if (Files.isSymbolicLink(entry.toPath())) {
                        throw IOException("Import stopped at symbolic link: ${entry.absolutePath}")
                    }
                    val canonical = entry.canonicalFile
                    if (!canonical.toPath().startsWith(sourceRoot)) {
                        throw IOException("Import path escaped the selected workspace")
                    }
                    val relative = sourceRoot.relativize(canonical.toPath()).toString()
                    val target =
                        if (relative.isEmpty()) stagingDir else File(stagingDir, relative)
                    if (entry.isDirectory) {
                        if (!target.mkdirs() && !target.isDirectory) {
                            throw IOException("Cannot create private directory: $relative")
                        }
                    } else {
                        target.parentFile?.mkdirs()
                        entry.inputStream().use { input ->
                            target.outputStream().use { output -> input.copyTo(output) }
                        }
                    }
                }
                if (!stagingDir.renameTo(destination)) {
                    throw IOException("Cannot finalize private workspace import")
                }
                staging = null
                promise.resolve(Arguments.createMap().apply {
                    putString("name", destination.name)
                    putString("path", destination.absolutePath)
                    putString("virtualPath", "/root/workspaces/${destination.name}")
                    putBoolean("privateWorkspace", true)
                })
            } catch (e: Exception) {
                staging?.deleteRecursively()
                promise.reject("WORKSPACE_IMPORT_ERROR", e.message, e)
            }
        }.apply {
            name = "adev-workspace-import"
            isDaemon = true
            start()
        }
    }
}
