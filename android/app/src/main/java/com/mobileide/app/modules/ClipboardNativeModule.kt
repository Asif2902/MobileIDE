package com.mobileide.app.modules

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * System clipboard access for terminal/editor copy-paste.
 * Android WebView clipboard APIs are unreliable without a user gesture and
 * often fail silently for file:// pages — RN must drive the system clipboard.
 */
class ClipboardNativeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "ClipboardNative"
    }

    override fun getName(): String = NAME

    private fun clipboard(): ClipboardManager =
        reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    @ReactMethod
    fun setString(text: String, promise: Promise) {
        try {
            clipboard().setPrimaryClip(ClipData.newPlainText("adev", text ?: ""))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CLIPBOARD_SET_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getString(promise: Promise) {
        try {
            val clip = clipboard().primaryClip
            if (clip != null && clip.itemCount > 0) {
                val item = clip.getItemAt(0)
                val text = item.coerceToText(reactApplicationContext)?.toString() ?: ""
                promise.resolve(text)
            } else {
                promise.resolve("")
            }
        } catch (e: Exception) {
            promise.reject("CLIPBOARD_GET_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun hasString(promise: Promise) {
        try {
            val clip = clipboard().primaryClip
            promise.resolve(clip != null && clip.itemCount > 0)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }
}
