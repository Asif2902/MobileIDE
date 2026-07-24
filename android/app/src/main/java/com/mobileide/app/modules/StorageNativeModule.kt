package com.mobileide.app.modules

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import com.facebook.react.bridge.*
import java.io.File

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

            val activity = currentActivity
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
}
