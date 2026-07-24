package com.mobileide.app.modules

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * MobileIDE React Native Package
 * Registers all native modules with React Native
 */
class MobileIDEPackage : ReactPackage {

    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(
            MobileIDENativeModule(reactContext),
            PtyNativeModule(reactContext),
            FileSystemNativeModule(reactContext),
            ProcessNativeModule(reactContext),
            GitNativeModule(reactContext),
            StorageNativeModule(reactContext),
            ClipboardNativeModule(reactContext)
        )
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
