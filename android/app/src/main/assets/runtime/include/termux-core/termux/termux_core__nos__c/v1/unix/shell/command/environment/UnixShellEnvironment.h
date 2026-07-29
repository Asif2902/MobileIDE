#ifndef LIBTERMUX_CORE__NOS__C__UNIX_SHELL_ENVIRONMENT___H
#define LIBTERMUX_CORE__NOS__C__UNIX_SHELL_ENVIRONMENT___H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif



/*
 * Environment for Unix-like systems.
 *
 * - https://manpages.debian.org/testing/manpages/environ.7.en.html
 * - https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap08.html
 */

/**
 * Environment variable for the list of directory paths separated with
 * colons `:` that certain functions and utilities use in searching
 * for an executable file known only by a file `basename`. The list
 * of directory paths is searched from beginning to end, by checking
 * the path formed by concatenating a directory path, a path
 * separator `/`, and the executable file `basename`, and the first
 * file found, if any, with execute permission is executed.
 *
 * - https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap08.html
 * - https://manpages.debian.org/testing/manpages/environ.7.en.html#PATH
 * - https://manpages.debian.org/testing/manpages-dev/basename.3.en.html
 *
 * Type: `string`
 */
#define ENV__PATH "PATH"
#define ENV_PREFIX__PATH ENV__PATH "="

/**
 * Environment variable for the list of directory paths separated with
 * colons `:` that should be searched for dynamic/shared library
 * files that are dependencies of executables or libraries to be
 * linked against. The list of directory paths is searched from
 * beginning to end, by checking the path formed by concatenating a
 * directory path, a path separator `/`, and the library file
 * `basename`, and the first file found, if any, with read permission
 * is opened.
 *
 * - https://manpages.debian.org/testing/manpages/ld.so.8.en.html#LD_LIBRARY_PATH
 *
 * Type: `string`
 */
#define ENV__LD_LIBRARY_PATH "LD_LIBRARY_PATH"
#define ENV_PREFIX__LD_LIBRARY_PATH ENV__LD_LIBRARY_PATH "="

/**
 * Environment variable for the list of ELF shared object paths
 * separated with colons `:` to be loaded before all others. This
 * feature can be used to selectively override functions in other
 * shared objects.
 *
 * - https://manpages.debian.org/testing/manpages/ld.so.8.en.html#LD_PRELOAD
 *
 * Type: `string`
 */
#define ENV__LD_PRELOAD "LD_PRELOAD"
#define ENV_PREFIX__LD_PRELOAD ENV__LD_PRELOAD "="

/**
 * Environment variable for a path of a directory made available for
 * programs that need a place to create temporary files.
 *
 * - https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap08.html
 * - https://manpages.debian.org/testing/manpages/environ.7.en.html
 * - https://manpages.debian.org/testing/manpages-dev/tempnam.3.en.html
 *
 * Type: `string`
 */
#define ENV__TMPDIR "TMPDIR"
#define ENV_PREFIX__TMPDIR ENV__TMPDIR "="





/**
 * Get an environment variable value as a `bool`.
 *
 * The following values are parsed as `true`: `1`, `true`, `on`, `yes`, `y`
 * The following values are parsed as `false`: `0`, `false`, `off`, `no`, `n`
 * For any other value, the `def` value will be returned.
 * Comparisons are case-sensitive.
 *
 * The purpose of this function is to have a single canonical parser for yes-or-no indications
 * throughout the system.
 *
 * - https://cs.android.com/android/platform/superproject/+/android-13.0.0_r18:frameworks/base/core/java/android/os/SystemProperties.java;l=198
 * - https://cs.android.com/android/platform/superproject/+/android-13.0.0_r18:frameworks/base/core/jni/android_os_SystemProperties.cpp;l=123
 * - https://cs.android.com/android/platform/superproject/+/android-13.0.0_r18:system/libbase/include/android-base/parsebool.h
 * - https://cs.android.com/android/platform/superproject/+/android-13.0.0_r18:system/libbase/parsebool.cpp
 *
 * @param value The value to parse as a `bool`.
 * @param def The default value.
 * @return Return the parsed `bool` value.
 */
bool getBoolEnvValue(const char *name, bool def);



/**
 * Check if a env variable in `vars` exists in the `envp` where `n` is
 * number of elements in `vars` to search starting from the first element.
 *
 * Each value in vars must be in the format `<name>=`, like `PATH=`.
 *
 * @return Returns `true` if even a single variable is found, otherwise
 * `false`.
 */
bool areVarsInEnv(char *const *envp, const char *vars[], int n);

/**
 * Check if a env variable in `vars` exists in the `envp` with an
 * empty value where `n` is number of elements in `vars` to search
 * starting from the first element.
 *
 * Each value in vars must be in the format `<name>=`, like `PATH=`.
 *
 * @return Returns `true` if even a single variable is found as empty,
 * otherwise `false`.
 */
bool areEmptyVarsInEnv(char *const *envp, const char *vars[], int n);



#ifdef __cplusplus
}
#endif

#endif // LIBTERMUX_CORE__NOS__C__UNIX_SHELL_ENVIRONMENT___H
