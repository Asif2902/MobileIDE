#ifndef LIBTERMUX_CORE__NOS__C__ANDROID_SHELL_ENVIRONMENT___H
#define LIBTERMUX_CORE__NOS__C__ANDROID_SHELL_ENVIRONMENT___H

#ifdef __cplusplus
extern "C" {
#endif



/*
 * Environment for Android.
 */

/**
 * Android environment variables root scope.
 *
 * **Do not modify this!** This is considered a constant Android root
 * scope for Android execution environment.**
 *
 * Default value: `ANDROID_`
 */
#define ANDROID_ENV__S_ROOT "ANDROID_"



/**
 * Android environment variables Android sub scope for primary variables
 * or variables for currently running Android config.
 *
 * **Do not modify this!** This is considered a constant Android sub
 * scope for Android execution environment.**
 *
 * Default value: `_`
 */
#define ANDROID_ENV__SS_ANDROID "_"

/**
 * Android environment variables Android scope for primary variables or
 * variables for currently running Android config.
 *
 * **Do not modify this!**
 *
 * Default value: `ANDROID__`
 */
#define ANDROID_ENV__S_ANDROID ANDROID_ENV__S_ROOT ANDROID_ENV__SS_ANDROID



/**
 * Environment variable for the Android build SDK version currently
 * running on the device that is defined by `Build.VERSION#SDK_INT`
 * and `ro.build.version.sdk` system property.
 *
 * This is exported by the Termux app.
 *
 * - https://developer.android.com/reference/android/os/Build.VERSION#SDK_INT
 * - https://developer.android.com/reference/android/os/Build.VERSION_CODES
 *
 * Type: `int`
 * Default key: `ANDROID__BUILD_VERSION_SDK`
 * Values: Unsigned integer values defined by `Build.VERSION_CODES`.
 */
#define ENV__ANDROID__BUILD_VERSION_SDK ANDROID_ENV__S_ANDROID "BUILD_VERSION_SDK"





/**
 * Returns the cached Android build version sdk from the
 * `ENV__ANDROID__BUILD_VERSION_SDK` env variable, and if its not set,
 * then the value from the `android_get_device_api_level()` call
 * provided by `<android/api-level.h>` is returned.
 *
 * The `android_get_device_api_level()` function was added in
 * API 29 itself, but bionic provides an inline variant for backward
 * compatibility.
 *
 * Getting value from system properties should be slower than from the
 * environment variable.
 *
 * - https://cs.android.com/android/platform/superproject/+/android-14.0.0_r1:bionic/libc/include/android/api-level.h;l=191-209
 * - https://cs.android.com/android/_/android/platform/bionic/+/c0f46564528c7bec8d490e62633e962f2007b8f4
 *
 * @return Return the Android build version sdk.
 */
int android_buildVersionSdk_get();



#ifdef __cplusplus
}
#endif

#endif // LIBTERMUX_CORE__NOS__C__ANDROID_SHELL_ENVIRONMENT___H
