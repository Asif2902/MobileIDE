#ifndef LIBTERMUX_CORE__NOS__C__UNIX_FILE_UTILS___H
#define LIBTERMUX_CORE__NOS__C__UNIX_FILE_UTILS___H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif



/**
 * Regex to match fd paths `/proc/self/fd/<num>` and `/proc/<pid>/fd/<num>`.
 */
#define REGEX__PROC_FD_PATH "^((/proc/(self|[0-9]+))|(/dev))/fd/[0-9]+$"





/**
 * Absolutize a unix path with the current working directory (`cwd`)
 * as prefix for the path if its not absolute.
 */
char* absolutizePath(const char *path, char *absolutePath, int bufferSize);





/**
 * Normalize a unix path. This won't normalize a windows path with
 * backslashes and other restrictions.
 *
 * - Replaces consecutive duplicate path separators `//` with a single
 *   path separator `/`.
 * - Removes trailing path separator `/` if `keepEndSeparator` is not
 *   `true`.
 * - Replaces `/./` with `/`.
 * - Removes `./` from start.
 * - Removes `/.` from end.
 * - Optionally removes `/../` and `/..` along with the parent
 *   directories equal to count of `..`.
 *
 * - If path is `null`, empty or equals `.`, then `null` will be
 *   returned.
 * - If path is empty after removals, then `null` will be returned.
 * - If double dots `..` need to be removed and no parent directory
 *   path components exist in the path that can be removed, then
 *   - If path is an absolute path, then path above rootfs will reset
 *     to `/` and any remaining path will be kept as well, like
 *     `/a/b/../../../c` will be resolved to `/c`.
 *     This behaviour is same as {@link #canonicalizePath(char*, char*, size_t)}
 *     and `realpath`.
 *     Note that [`org.apache.commons.io.FilenameUtils#normalize(String)`]
 *     will return `null`, but this implementation will not since it
 *     makes more sense to reset path to `/` for unix filesystems.
 *     See also `CVE-2021-29425` for a path traversal vulnerability
 *     for `//../foo` in `commons.io` that was fixed in `2.7`.
 *     - https://nvd.nist.gov/vuln/detail/cve-2021-29425
 *     - https://issues.apache.org/jira/browse/IO-556
 *     - https://issues.apache.org/jira/browse/IO-559
 *     - https://github.com/apache/commons-io/commit/2736b6fe
 *   - If path is relative like `../` or starts with `~/` or `~user/`,
 *     then `null` will be returned, as unknown path components cannot
 *     be removed from a path.
 * - The path separator `/` will not be added to home `~` and `~user`
 *   if it doesn't already exist like
 *   [`org.apache.commons.io.FilenameUtils#normalize(String)`] does.
 *   See also `getUnixPathPrefixLength(String)` in `FileUtils.java`.
 *
 * Following examples assume `keepEndSeparator` is `false` and
 * `removeDoubleDot` is `true`. Check `runNormalizeTests()` in
 * `FileUtilsTestsProvider.java` for more examples.
 *
 * ```
 * null -> null
 * `` -> null
 * `/` -> `/`
 *
 * `:` -> `:`
 * `1:/a/b/c.txt` -> `1:/a/b/c.txt`
 * `///a//b///c/d///` -> `/a/b/c/d`
 * `/foo//` -> `/foo`
 * `/foo/./` -> `/foo`
 * `//foo//./bar` -> `/foo/bar`
 * `~` -> `~`
 * `~/` -> `~`
 * `~user/` -> `~user`
 * `~user` -> `~user`
 * `~user/a` -> `~user/a`
 *
 * `.` -> null
 * `./` -> null
 * `/.` -> `/`
 * `/./` -> `/`
 * `././` -> null
 * `/./.` -> `/`
 * `/././a` -> `/a`
 * `/./b/./` -> `/b`
 * `././c/./` -> `c`
 *
 * `..` -> null
 * `../` -> null
 * `/..` -> `/`
 * `/../` -> `/`
 * `/../a` -> `/a`
 * `../a/.` -> null
 * `../a` -> null
 * `/a/b/..` -> `/a`
 * `/a/b/../..` -> `/`
 * `/a/b/../../..` -> `/`
 * `/a/b/../../../c` -> `/c`
 * `./../a` -> null
 * `././../a` -> null
 * `././.././a` -> null
 * `a/../../b` -> null
 * `a/./../b` -> `b`
 * `a/./.././b` -> `b`
 * `foo/../../bar` -> null
 * `/foo/../bar` -> `/bar`
 * `/foo/../bar/` -> `/bar`
 * `/foo/../bar/../baz` -> `/baz`
 * `foo/bar/..` -> `foo`
 * `foo/../bar` -> `bar`
 * `~/..` -> null
 * `~/../` -> null
 * `~/../a/.` -> null
 * `~/..` -> null
 * `~/foo/../bar/` -> `~/bar`
 * `C:/foo/../bar` -> `C:/bar`
 * `//server/foo/../bar` -> `/server/bar`
 * `//server/../bar` -> `/bar`
 * ```
 *
 * [`org.apache.commons.io.FilenameUtils#normalize(String)`]: https://commons.apache.org/proper/commons-io/apidocs/org/apache/commons/io/FilenameUtils.html#normalize-java.lang.String-
 *
 * @param path The `path` to normalize.
 * @param keepEndSeparator Whether to keep path separator `/` at end if it exists.
 * @param removeDoubleDot If set to `true`. then double dots `..` will
 *                        be removed along with the parent directory
 *                        for each `..` component.
 * @return Returns the `path` passed as `normalized path`.
 */
char* normalizePath(char* path, bool keepEndSeparator, bool removeDoubleDot);



/**
 * Remove consecutive duplicate path separators `//` and the trailing
 * path separator if not rootfs `/`.
 *
 * @param path The `path` to remove from.
 * @param keepEndSeparator Whether to keep path separator `/` at end if it exists.
 * @return Returns the path with consecutive duplicate path separators removed.
 */
char* removeDupSeparator(char* path, bool keepEndSeparator);





/** Whether `path` is a path to an fd matching the `REGEX__PROC_FD_PATH` regex. */
bool isFdPath(const char *path);

/**
 * Get the real path of an fd `path`.
 *
 * **The `path` passed must match `REGEX__PROC_FD_PATH`, as no checks
 * are done by this function for whether path is for a fd path. If
 * an integer is set to the path basename, then it is assumed to be the
 * fd number, even if it is for a valid fd to be checked or not.**
 *
 * - https://stackoverflow.com/questions/1188757/retrieve-filename-from-file-descriptor-in-c
 */
char* getRegularFileFdRealPath(const char* logTag, const char *path, char *realPath,
    size_t bufferSize);





/**
 * Check whether the `path` is in `dirPath`.
 *
 * @param label The label for errors.
 * @param path The `path` to check.
 * @param dirPath The `directory path` to check in. This must be an
 *                 absolute path.
 * @param ensureUnder If set to `true`, then it will be ensured that
 *                    `path` is under the directory and does not
 *                    equal it. If set to `false`, it can either
 *                    equal the directory path or be under it.
 * @return Returns `0` if `path` is in `dirPath`, `1` if `path` is
 * not in `dirPath`, otherwise `-1` on other failures.
 */
bool isPathInDirPath(const char* label, const char* path, const char* dirPath, bool ensureUnder);

/**
 * Check whether the `path` or a fd path is in `dirPath`.
 *
 * If path is a fd path matched by `REGEX__PROC_FD_PATH`, then the
 * real path of the fd returned by `getRegularFileFdRealPath()` will
 * be checked instead.
 *
 * This is a wrapper for `isPathInDirPath(const char*, const char*, const char*, bool)`
 *
 * @param logTag The log tag to use for logging.
 * @param label The label for errors.
 * @param path The `path` to check.
 * @param dirPath The `directory path` to check in. This must be an
 *                absolute path.
 * @param ensureUnder If set to `true`, then it will be ensured that
 *                    `path` is under the directory and does not
 *                    equal it. If set to `false`, it can either
 *                    equal the directory path or be under it.
 * @return Returns `0` if `path` is in `dirPath`, `1` if `path` is
 * not in `dirPath`, otherwise `-1` on other failures.
 */
int isPathOrFdPathInDirPath(const char* logTag, const char* label,
    const char *path, const char *dirPath, bool ensureUnder);





/**
 * Log an error message for an invalid path.
 *
 * @Beta
 */
void logInvalidPathError(int errorLogLevel, const char* logTag, const char* label,
    bool ensureAbsolute, size_t envPathMaxLength);



/**
 * Get a path from an environment variable if its set to a valid
 * absolute path, optionally with max length `envPathMaxLength`.
 *
 * If `envPathMaxLength` is `<= 0`, then max length check is ignored,
 * but path length must still be `<= bufferSize` including the null
 * `\0` terminator.
 *
 * @param errorLogLevel The log level for invalid path errors passed
 * to `logErrorForLogLevel()`.
 * @param logTag The log tag to use for logging.
 * @param label The label for errors.
 * @param envVariableName The environment variable name from which
 *                          to read the path.
 * @param ensureAbsolute Ensure path is an absolute path starting
 * with a `/`.
 * @param envPathMaxLength The max length for the path.
 * @param normalize Normalize the path by calling `normalizePath()`.
 *                  Paths may become null if `ensureAbsolute()` is
 *                  not passed, like if paths start with `../` or `~/`.
 * @param removeDoubleDot If set to `true`. then double dots `..` will
 *                        be removed along with the parent directory
 *                        for each `..` component.
 * @param buffer The output path buffer.
 * @param bufferSize The output path buffer size.
 * @return Returns `0` if a valid path is found and copied to the
 * buffer, `1` if valid path is not found, otherwise `-1` on other
 * failures.
 *
 * @Beta isPathValid(IsPathValidArg arg)) and do not normalize as
 * `ensureCanonical` should check for it.
 */
int getPathFromEnv(int errorLogLevel, const char* logTag,
    const char* label, const char * envVariableName,
    bool ensureAbsolute, size_t envPathMaxLength,
    bool normalize, bool removeDoubleDot,
    char *buffer, size_t bufferSize);

/**
 * Get a path from an environment variable by calling
 * `getPathFromEnv()`, otherwise if it fails, then return
 * `defaultPath` passed.
 *
 * @param logTag The log tag to use for logging.
 * @param label The label for errors.
 * @param envVariableName The environment variable name from which
 *                          to read the path.
 * @param envPathMaxLength The max length for the path.
 * @param normalize Normalize the path by calling `normalizePath()`.
 *                  Paths may become null if `ensureAbsolute()` is
 *                  not passed, like if paths start with `../` or `~/`.
 * @param removeDoubleDot If set to `true`. then double dots `..` will
 *                        be removed along with the parent directory
 *                        for each `..` component.
 * @param defaultPath The default path to return if reading it from
 *                     the environment variable fails.
 * @param defaultPathAccessCheckType The optional `access()`
 *                     system call check to perform if default path
 *                     is to be returned. Valid values are:
 *                     - `0`: `F_OK`
 *                     - `1`: `R_OK`
 *                     - `2`: `R_OK | W_OK`
 *                     - `3`: `R_OK | X_OK`
 *                     - `4`: `R_OK | W_OK | X_OK`
 * @param buffer The output path buffer.
 * @param bufferSize The output path buffer size.
 * @return Returns the `char *` to path on success, otherwise `NULL`.
 *
 * @Beta isPathValid(IsPathValidArg arg) and do not normalize as
 * `ensureCanonical` should check for it.
 */
const char* getPathFromEnvOrDefault(int errorLogLevel, const char* logTag,
    const char* label, const char * envVariableName,
    bool ensureAbsolute, size_t envPathMaxLength,
    bool normalize, bool removeDoubleDot,
    const char* defaultPath, int defaultPathAccessCheckType,
    char *buffer, size_t bufferSize);





/**
 * Create a directory file at pat, including any missing parent directories.
 *
 * THIS FUNCTION IS NOT THREAD SAFE. It will also modify `umask` of
 * process, so using in a thread can result in nondeterministic
 * behavior.
 *
 * FIXME: Fork to make function thread safe due to use of `umask(0)`
 * that sets no permissions at directory creation and manually sets
 * them later with `chmod()` to prevent security issues.
 *
 * - https://github.com/bminor/bash/blob/bash-5.2/examples/loadables/mkdir.c#L51
 */
int createDirectoryFile(const char* logTag, const char *path, bool userMode, int mode);





/**
 * Close an fd.
 *
 * @param logTag The log tag to use for logging.
 * @param label The label for errors.
 * @param fd The fd to close.
 * @return Returns `0` if successfully closed fd,, otherwise `-1` on
 * other failures.
 */
int closeFD(const char* logTag, const char* label, int fd);





/**
 * Redirect standard fd to `/dev/null`.
 *
 * @param do_stdin Redirect stdin.
 * @param do_stdout Redirect stdout.
 * @param do_stderr Redirect stderr.
 * @return Returns `0` if redirection was successful for all fd,
 * otherwise `-1` on other failures.
 */
int redirectStdFdToDevNull(bool do_stdin, bool do_stdout, bool do_stderr);



#ifdef __cplusplus
}
#endif

#endif // LIBTERMUX_CORE__NOS__C__UNIX_FILE_UTILS___H
