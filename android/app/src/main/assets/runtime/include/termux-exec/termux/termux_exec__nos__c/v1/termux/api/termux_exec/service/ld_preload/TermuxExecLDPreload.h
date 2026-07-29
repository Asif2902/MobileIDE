#ifndef LIBTERMUX_EXEC__NOS__C__TERMUX_EXEC_LD_PRELOAD___H
#define LIBTERMUX_EXEC__NOS__C__TERMUX_EXEC_LD_PRELOAD___H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif



/** The path to android system linker. */
#if UINTPTR_MAX == 0xffffffff
#define SYSTEM_LINKER_PATH "/system/bin/linker";
#elif UINTPTR_MAX == 0xffffffffffffffff
#define SYSTEM_LINKER_PATH "/system/bin/linker64";
#endif


/**
 * Whether usage of `system_linker_exec` is to be enabled, like to
 * bypass app data file execute restrictions.
 *
 * A call is made to `termuxExec_systemLinkerExec_mode_get()` to
 * get the config for using `system_linker_exec`.
 *
 * If `disable` is set, then `system_linker_exec` should not be used
 * and the default `direct` execution type should be used.
 *
 * If `enable` is set, then `system_linker_exec` should only be used if:
 * - `system_linker_exec` is required to bypass app data file execute
 *   restrictions, i.e device is running on Android `>= 10`.
 * - Effective user does not equal root (`0`) and shell (`2000`) user (used for
 *   [`adb`](https://developer.android.com/tools/adb)).
 * - `TERMUX__SE_PROCESS_CONTEXT` or its fallback `/proc/self/attr/current`
 *    does not start with `PROCESS_CONTEXT_PREFIX__UNTRUSTED_APP_25` and
 *   `PROCESS_CONTEXT_PREFIX__UNTRUSTED_APP_27` for which restrictions
 *   are exempted.
 *
 * If `force` is set, then `system_linker_exec` should only be used if:
 * - `system_linker_exec` is supported, i.e device is running on Android `>= 10`.
 * This can be used if running in an untrusted app with `targetSdkVersion` `<= 28`.
 *
 * See also `shouldEnableSystemLinkerExecForFile()`.
 *
 * **IMPORTANT** The logic must be kept consistent with the
 * `termux_exec__system_linker_exec__enabled__run_command()` function
 * in `termux-exec-system-linker-exec`.
 *
 * @return Returns `0` if `system_linker_exec` is to be enabled, `1` if
 * `system_linker_exec` should not be used, otherwise `-1` on failures.
 */
int isSystemLinkerExecEnabled();

/**
 * Whether to use `system_linker_exec` for an executable file, like to
 * bypass app data file execute restrictions.
 *
 * A call is made to `isSystemLinkerExecEnabled()` to check if
 * `system_linker_exec` is to be enabled. If its enabled, then
 * `system_linker_exec` is only to be used if
 * `isPathUnderTermuxAppDataDir()` returns `true` for the
 * `executablePath`.
 *
 * The executable or interpreter paths are checked under
 * `TERMUX_APP__DATA_DIR` or `TERMUX_APP__LEGACY_DATA_DIR` instead of
 * `TERMUX__ROOTFS` as files could be executed from `TERMUX__APPS_DIR`
 * and `TERMUX__CACHE_DIR`, which are not under the Termux rootfs.
 * Additionally, Termux rootfs may not exist under app data directory
 * at all and could be under another directory under Android rootfs `/`,
 * like if compiling packages for `shell` user for the `com.android.shell`
 * package with the Termux rootfs under `/data/local/tmp` instead of
 * `/data/data/com.android.shell` (and using `force` mode) or
 * compiling packages for `/system` directory.
 *
 * See also `isSystemLinkerExecEnabled()`.
 *
 * @param executablePath The **normalized** executable or interpreter
 *                        path that will actually be executed.
 * @return Returns `0` if `system_linker_exec` is to be enabled for
 * the file, `1` if `system_linker_exec` is not to be enabled,
 * otherwise `-1` on failures.
 */
int shouldEnableSystemLinkerExecForFile(const char *executablePath);



#ifdef __cplusplus
}
#endif

#endif // LIBTERMUX_EXEC__NOS__C__TERMUX_EXEC_LD_PRELOAD___H
