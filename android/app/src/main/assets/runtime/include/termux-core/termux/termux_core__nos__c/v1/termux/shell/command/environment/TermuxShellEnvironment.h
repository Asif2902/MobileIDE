#ifndef LIBTERMUX_CORE__NOS__C__TERMUX_SHELL_ENVIRONMENT___H
#define LIBTERMUX_CORE__NOS__C__TERMUX_SHELL_ENVIRONMENT___H

#ifdef __cplusplus
extern "C" {
#endif



/*
 * Environment for Termux.
 */

/**
 * Environment variable for the Termux app data directory path.
 *
 * Type: `string`
 * Default key: `TERMUX_APP__DATA_DIR`
 * Default value: null
 * Values:
 * - An absolute path with max length `TERMUX_APP__DATA_DIR___MAX_LEN` (`69`)
 *   including the null `\0` terminator.
 */
#define ENV__TERMUX_APP__DATA_DIR TERMUX_ENV__S_TERMUX_APP "DATA_DIR"

/**
 * Environment variable for the Termux legacy app data directory path.
 *
 * Type: `string`
 * Default key: `TERMUX_APP__LEGACY_DATA_DIR`
 * Default value: null
 * Values:
 * - An absolute path with max length `TERMUX_APP__DATA_DIR___MAX_LEN` (`69`)
 *   including the null `\0` terminator.
 */
#define ENV__TERMUX_APP__LEGACY_DATA_DIR TERMUX_ENV__S_TERMUX_APP "LEGACY_DATA_DIR"





/**
 * Environment variable for the Termux rootfs directory path.
 *
 * Type: `string`
 * Default key: `TERMUX__ROOTFS`
 * Default value: null
 * Values:
 * - An absolute path with max length `TERMUX__ROOTFS_DIR___MAX_LEN` (`85`)
 *   including the null `\0` terminator.
 */
#define ENV__TERMUX__ROOTFS TERMUX_ENV__S_TERMUX "ROOTFS"

/**
 * Environment variable for the Termux prefix directory path.
 *
 * Type: `string`
 * Default key: `TERMUX__PREFIX`
 * Default value: null
 * Values:
 * - An absolute path with max length `TERMUX__PREFIX_DIR___MAX_LEN` (`90`)
 *   including the null `\0` terminator.
 */
#define ENV__TERMUX__PREFIX TERMUX_ENV__S_TERMUX "PREFIX"





/**
 * Environment variable for the SeLinux process context of the Termux
 * app process and its child processes.
 *
 * Type: `string`
 * Default key: `TERMUX__SE_PROCESS_CONTEXT`
 * Default value: null
 * Values:
 * - A valid Android SeLinux process context that matches `REGEX__PROCESS_CONTEXT`.
 */
#define ENV__TERMUX__SE_PROCESS_CONTEXT TERMUX_ENV__S_TERMUX "SE_PROCESS_CONTEXT"





/**
 * Environment variable for the Termux rootfs package manager.
 *
 * Type: `string`
 * Default key: `TERMUX_ROOTFS__PACKAGE_MANAGER`
 * Default value: null
 * Values: `apt` or `pacman`
 */
#define ENV__TERMUX_ROOTFS__PACKAGE_MANAGER TERMUX_ENV__S_TERMUX_ROOTFS "PACKAGE_MANAGER"



#ifdef __cplusplus
}
#endif

#endif // LIBTERMUX_CORE__NOS__C__TERMUX_SHELL_ENVIRONMENT___H
