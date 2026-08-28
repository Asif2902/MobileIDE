#define _GNU_SOURCE

#include "adev_runtime_env.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define ADEV_MAX_SHEBANG_DEPTH 8
#define ADEV_MAX_INTERPRETER_ARG 1024
#define ADEV_MAX_ARGV 65536

typedef int (*adev_execve_fn)(const char *, char *const[], char *const[]);
typedef ssize_t (*adev_readlink_fn)(const char *, char *, size_t);
typedef ssize_t (*adev_readlinkat_fn)(int, const char *, char *, size_t);
typedef int (*adev_posix_spawn_fn)(
    pid_t *,
    const char *,
    const posix_spawn_file_actions_t *,
    const posix_spawnattr_t *,
    char *const[],
    char *const[]
);

typedef struct {
    char interpreter[PATH_MAX];
    char argument[ADEV_MAX_INTERPRETER_ARG];
    bool has_argument;
} adev_shebang;

static pthread_once_t adev_execve_once = PTHREAD_ONCE_INIT;
static adev_execve_fn adev_next_execve = NULL;
static adev_posix_spawn_fn adev_next_posix_spawn = NULL;
static pthread_once_t adev_readlink_once = PTHREAD_ONCE_INIT;
static adev_readlink_fn adev_next_readlink = NULL;
static adev_readlinkat_fn adev_next_readlinkat = NULL;
extern char **environ;

static bool adev_is_file(const char *path);

static void adev_resolve_next_execve(void) {
    adev_next_execve = (adev_execve_fn)dlsym(RTLD_NEXT, "execve");
    adev_next_posix_spawn = (adev_posix_spawn_fn)dlsym(RTLD_NEXT, "posix_spawn");
}

static void adev_resolve_next_readlink(void) {
    adev_next_readlink = (adev_readlink_fn)dlsym(RTLD_NEXT, "readlink");
    adev_next_readlinkat = (adev_readlinkat_fn)dlsym(RTLD_NEXT, "readlinkat");
}

/*
 * Android refuses execve() for app-writable ELF files. libtermux-exec enters
 * those Bionic binaries through /system/bin/linker64 and publishes the real
 * target as TERMUX_EXEC__PROC_SELF_EXE. Without this bridge, self-relative
 * launchers see the linker as /proc/self/exe and search for sibling payloads
 * under /apex/com.android.runtime/bin.
 *
 * Preserve normal readlink semantics (no trailing NUL, truncation allowed) and
 * affect only the exact self-exe pseudo-link. This is generic for every
 * writable Android CLI; no package name or payload layout is special-cased.
 */
static ssize_t adev_virtual_self_exe(
    const char *path,
    char *buffer,
    size_t size
) {
    if (path == NULL || buffer == NULL || size == 0 ||
        strcmp(path, "/proc/self/exe") != 0) {
        return -1;
    }
    const char *original = getenv("TERMUX_EXEC__PROC_SELF_EXE");
    if (original == NULL || original[0] != '/' || !adev_is_file(original)) return -1;
    const size_t original_length = strlen(original);
    const size_t copy_length = original_length < size ? original_length : size;
    memcpy(buffer, original, copy_length);
    return (ssize_t)copy_length;
}

ssize_t readlink(const char *path, char *buffer, size_t size) {
    const ssize_t virtual_result = adev_virtual_self_exe(path, buffer, size);
    if (virtual_result >= 0) return virtual_result;
    pthread_once(&adev_readlink_once, adev_resolve_next_readlink);
    if (adev_next_readlink == NULL) {
        errno = ENOSYS;
        return -1;
    }
    return adev_next_readlink(path, buffer, size);
}

ssize_t readlinkat(int directory, const char *path, char *buffer, size_t size) {
    if (directory == AT_FDCWD || (path != NULL && path[0] == '/')) {
        const ssize_t virtual_result = adev_virtual_self_exe(path, buffer, size);
        if (virtual_result >= 0) return virtual_result;
    }
    pthread_once(&adev_readlink_once, adev_resolve_next_readlink);
    if (adev_next_readlinkat == NULL) {
        errno = ENOSYS;
        return -1;
    }
    return adev_next_readlinkat(directory, path, buffer, size);
}

/*
 * This library is preloaded into every ADEV process, which makes it the one
 * place that can repair an environment for a process nobody else configured.
 * Fill in the runtime contract before the program's own constructors run, so
 * that HOME, TMPDIR, the XDG directories and the TLS trust store are already
 * correct by the time a language runtime caches them.
 *
 * Only missing (or provably stale) values are written; `env -i` clears
 * LD_PRELOAD along with everything else, so a deliberately empty environment
 * never reaches this code at all.
 */
__attribute__((constructor)) static void adev_exec_compat_init(void) {
    adev_runtime_env_apply();
}

static const char *adev_env_value(char *const envp[], const char *name) {
    if (envp == NULL || name == NULL) return NULL;
    const size_t name_length = strlen(name);
    for (size_t index = 0; envp[index] != NULL; ++index) {
        if (strncmp(envp[index], name, name_length) == 0 &&
            envp[index][name_length] == '=') {
            return envp[index] + name_length + 1;
        }
    }
    return NULL;
}

static bool adev_copy_path(char destination[PATH_MAX], const char *source) {
    if (source == NULL) return false;
    const size_t length = strlen(source);
    if (length == 0 || length >= PATH_MAX) {
        errno = ENAMETOOLONG;
        return false;
    }
    memcpy(destination, source, length + 1);
    return true;
}

static bool adev_is_file(const char *path) {
    struct stat metadata;
    return path != NULL && stat(path, &metadata) == 0 && !S_ISDIR(metadata.st_mode);
}

/*
 * Android blocks direct execution from filesDir, even when that pathname is a
 * symlink whose final inode lives in the APK's executable nativeLibraryDir.
 * Resolve only real symlinks whose canonical target remains inside that exact
 * native directory. This keeps ordinary writable ELFs on the noexec boundary
 * while allowing stable runtime aliases (including the optional glibc loader)
 * to enter their genuine APK-native executable.
 */
static bool adev_resolve_apk_native_symlink(
    const char *path,
    char *const envp[],
    char destination[PATH_MAX]
) {
    if (path == NULL || destination == NULL) return false;
    struct stat link_metadata;
    if (lstat(path, &link_metadata) != 0 || !S_ISLNK(link_metadata.st_mode)) return false;

    const char *configured_native = adev_env_value(envp, "MOBILEIDE_NATIVE_LIB");
    if (configured_native == NULL || configured_native[0] == '\0') return false;

    char native_directory[PATH_MAX];
    if (realpath(configured_native, native_directory) == NULL ||
        realpath(path, destination) == NULL) {
        return false;
    }
    const size_t native_length = strlen(native_directory);
    if (native_length == 0 ||
        strncmp(destination, native_directory, native_length) != 0 ||
        destination[native_length] != '/' ||
        !adev_is_file(destination)) {
        return false;
    }
    return true;
}

static bool adev_is_stale_termux_shell(const char *path) {
    if (path == NULL) return false;
    return strcmp(path, "/data/data/com.termux/files/usr/bin/sh") == 0 ||
        strcmp(path, "/data/user/0/com.termux/files/usr/bin/sh") == 0;
}

static bool adev_is_virtual_shell(const char *path) {
    return path != NULL &&
        (adev_is_stale_termux_shell(path) ||
         strcmp(path, "/bin/sh") == 0 ||
         strcmp(path, "/usr/bin/sh") == 0);
}

static bool adev_is_virtual_env(const char *path) {
    return path != NULL &&
        (strcmp(path, "/usr/bin/env") == 0 || strcmp(path, "/bin/env") == 0);
}

/*
 * Never resolve a virtual /usr/bin/env through ordinary PATH order. ADEV puts
 * /system/bin first so Android tools remain reliable, but /system/bin/env is
 * Toybox and its child exec bypasses the app's recursive script resolver. That
 * turns every standard npm `#!/usr/bin/env node` CLI into EACCES at bin/node.
 */
static bool adev_env_fallback(
    char *const envp[],
    char destination[PATH_MAX]
) {
    const char *configured = adev_env_value(envp, "MOBILEIDE_ENV");
    if (configured != NULL && adev_is_file(configured)) {
        return adev_copy_path(destination, configured);
    }

    const char *native_library = adev_env_value(envp, "MOBILEIDE_NATIVE_LIB");
    if (native_library != NULL && native_library[0] != '\0') {
        const int count = snprintf(
            destination,
            PATH_MAX,
            "%s/libbin_adev_env.so",
            native_library
        );
        if (count > 0 && count < PATH_MAX && adev_is_file(destination)) return true;
    }
    errno = ENOENT;
    return false;
}

static bool adev_find_on_path(
    const char *command,
    char *const envp[],
    char destination[PATH_MAX]
) {
    if (command == NULL || command[0] == '\0' || strchr(command, '/') != NULL) {
        return false;
    }

    const char *path = adev_env_value(envp, "PATH");
    if (path == NULL) path = "/system/bin";

    const char *component = path;
    while (true) {
        const char *separator = strchr(component, ':');
        const size_t component_length = separator == NULL
            ? strlen(component)
            : (size_t)(separator - component);
        const char *directory = component_length == 0 ? "." : component;
        const size_t directory_length = component_length == 0 ? 1 : component_length;
        const size_t command_length = strlen(command);

        if (directory_length + 1 + command_length < PATH_MAX) {
            memcpy(destination, directory, directory_length);
            destination[directory_length] = '/';
            memcpy(destination + directory_length + 1, command, command_length + 1);
            if (adev_is_file(destination)) return true;
        }

        if (separator == NULL) break;
        component = separator + 1;
    }
    return false;
}

static bool adev_shell_fallback(
    char *const envp[],
    char destination[PATH_MAX]
) {
    const char *candidates[] = {
        /* A lifecycle/npm dispatcher is not a /bin/sh implementation. */
        "/system/bin/sh",
        adev_env_value(envp, "MOBILEIDE_BASH"),
    };
    for (size_t index = 0; index < sizeof(candidates) / sizeof(candidates[0]); ++index) {
        if (candidates[index] != NULL &&
            !adev_is_stale_termux_shell(candidates[index]) &&
            adev_is_file(candidates[index]) &&
            adev_copy_path(destination, candidates[index])) {
            return true;
        }
    }
    errno = ENOENT;
    return false;
}

static bool adev_resolve_interpreter(
    const char *interpreter,
    char *const envp[],
    char destination[PATH_MAX]
) {
    if (interpreter == NULL || interpreter[0] == '\0') {
        errno = ENOEXEC;
        return false;
    }

    if (adev_is_virtual_shell(interpreter)) {
        return adev_shell_fallback(envp, destination);
    }
    if (adev_is_virtual_env(interpreter)) {
        return adev_env_fallback(envp, destination);
    }

    if (adev_is_file(interpreter)) return adev_copy_path(destination, interpreter);

    const char *basename = interpreter;
    if (strncmp(interpreter, "/usr/bin/", 9) == 0) {
        basename = interpreter + 9;
    } else if (strncmp(interpreter, "/bin/", 5) == 0) {
        basename = interpreter + 5;
    } else if (strchr(interpreter, '/') != NULL) {
        return adev_copy_path(destination, interpreter);
    }

    if (adev_find_on_path(basename, envp, destination)) return true;
    return adev_copy_path(destination, interpreter);
}

/*
 * Return 1 for a shebang, 0 for a non-script, and -1 for a read/format error.
 * Linux treats everything after the interpreter as one optional argument; we
 * preserve that behavior instead of tokenizing it like a shell command line.
 */
static int adev_read_shebang(const char *path, adev_shebang *result) {
    char header[4096];
    const int descriptor = open(path, O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) return -1;
    const ssize_t count = read(descriptor, header, sizeof(header) - 1);
    const int saved_errno = errno;
    close(descriptor);
    errno = saved_errno;
    if (count < 0) return -1;
    if (count < 2 || header[0] != '#' || header[1] != '!') return 0;
    header[count] = '\0';

    char *cursor = header + 2;
    while (*cursor == ' ' || *cursor == '\t') ++cursor;
    char *interpreter_end = cursor;
    while (*interpreter_end != '\0' && *interpreter_end != ' ' &&
           *interpreter_end != '\t' && *interpreter_end != '\r' &&
           *interpreter_end != '\n') {
        ++interpreter_end;
    }
    const size_t interpreter_length = (size_t)(interpreter_end - cursor);
    if (interpreter_length == 0 || interpreter_length >= PATH_MAX) {
        errno = ENOEXEC;
        return -1;
    }
    memcpy(result->interpreter, cursor, interpreter_length);
    result->interpreter[interpreter_length] = '\0';

    cursor = interpreter_end;
    while (*cursor == ' ' || *cursor == '\t') ++cursor;
    char *argument_end = cursor;
    while (*argument_end != '\0' && *argument_end != '\r' && *argument_end != '\n') {
        ++argument_end;
    }
    while (argument_end > cursor &&
           (argument_end[-1] == ' ' || argument_end[-1] == '\t')) {
        --argument_end;
    }
    const size_t argument_length = (size_t)(argument_end - cursor);
    if (argument_length >= ADEV_MAX_INTERPRETER_ARG) {
        errno = ENOEXEC;
        return -1;
    }
    result->has_argument = argument_length > 0;
    if (result->has_argument) memcpy(result->argument, cursor, argument_length);
    result->argument[argument_length] = '\0';
    return 1;
}

static size_t adev_argv_count(char *const argv[]) {
    if (argv == NULL) return 0;
    size_t count = 0;
    while (argv[count] != NULL && count < ADEV_MAX_ARGV) ++count;
    if (count == ADEV_MAX_ARGV) {
        errno = E2BIG;
        return SIZE_MAX;
    }
    return count;
}

static bool adev_spawn_broker_path(
    char *const envp[],
    char destination[PATH_MAX]
) {
    const char *configured = adev_env_value(envp, "MOBILEIDE_ENV");
    char candidate[PATH_MAX];
    if (configured != NULL && adev_copy_path(candidate, configured) &&
        realpath(candidate, destination) != NULL &&
        strncmp(destination, "/data/app/", 10) == 0 && adev_is_file(destination)) {
        return true;
    }

    const char *native_library = adev_env_value(envp, "MOBILEIDE_NATIVE_LIB");
    if (native_library != NULL) {
        const int count = snprintf(
            candidate,
            sizeof(candidate),
            "%s/libbin_adev_env.so",
            native_library
        );
        if (count > 0 && count < (int)sizeof(candidate) &&
            realpath(candidate, destination) != NULL &&
            strncmp(destination, "/data/app/", 10) == 0 && adev_is_file(destination)) {
            return true;
        }
    }
    errno = ENOENT;
    return false;
}

static int adev_spawn_wait_for_broker(
    pid_t child,
    int error_descriptor
) {
    int child_error = 0;
    unsigned char *cursor = (unsigned char *)&child_error;
    size_t remaining = sizeof(child_error);
    while (remaining > 0) {
        const ssize_t count = read(error_descriptor, cursor, remaining);
        if (count > 0) {
            cursor += count;
            remaining -= (size_t)count;
            continue;
        }
        if (count == 0) break;
        if (errno == EINTR) continue;
        const int error = errno;
        kill(child, SIGKILL);
        while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
        return error;
    }
    if (remaining == sizeof(child_error)) return 0; /* CLOEXEC: target entered. */
    if (remaining == 0) {
        while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
        return child_error == 0 ? EIO : child_error;
    }
    kill(child, SIGKILL);
    while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
    return EIO;
}

static int adev_spawn_via_broker(
    pid_t *pid,
    const char *target,
    bool search_path,
    const posix_spawn_file_actions_t *file_actions,
    const posix_spawnattr_t *attributes,
    char *const argv[],
    char *const envp[]
) {
    if (pid == NULL || target == NULL) return EINVAL;
    pthread_once(&adev_execve_once, adev_resolve_next_execve);
    if (adev_next_posix_spawn == NULL) return ENOSYS;

    char broker[PATH_MAX];
    if (!adev_spawn_broker_path(envp, broker)) return errno == 0 ? ENOENT : errno;
    const size_t argument_count = adev_argv_count(argv);
    if (argument_count == SIZE_MAX || argument_count + 6 >= ADEV_MAX_ARGV) return E2BIG;

    int pipe_descriptors[2];
    if (pipe(pipe_descriptors) != 0) return errno;
    (void)fcntl(pipe_descriptors[0], F_SETFD, FD_CLOEXEC);
    const int broker_error_fd = fcntl(pipe_descriptors[1], F_DUPFD, 64);
    const int duplicate_errno = errno;
    close(pipe_descriptors[1]);
    if (broker_error_fd < 0) {
        close(pipe_descriptors[0]);
        return duplicate_errno;
    }

    char error_assignment[64];
    snprintf(
        error_assignment,
        sizeof(error_assignment),
        "ADEV_SPAWN_ERROR_FD=%d",
        broker_error_fd
    );
    const size_t environment_count = adev_argv_count(envp);
    if (environment_count == SIZE_MAX || environment_count + 2 >= ADEV_MAX_ARGV) {
        close(pipe_descriptors[0]);
        close(broker_error_fd);
        return E2BIG;
    }
    char **broker_environment = calloc(environment_count + 2, sizeof(char *));
    char **broker_argv = calloc(argument_count + 6, sizeof(char *));
    if (broker_environment == NULL || broker_argv == NULL) {
        close(pipe_descriptors[0]);
        close(broker_error_fd);
        free(broker_environment);
        free(broker_argv);
        return ENOMEM;
    }
    size_t broker_environment_count = 0;
    static const char error_name[] = "ADEV_SPAWN_ERROR_FD=";
    for (size_t index = 0; index < environment_count; ++index) {
        /* The broker channel is internal; never trust or duplicate a caller's value. */
        if (strncmp(envp[index], error_name, sizeof(error_name) - 1) == 0) continue;
        broker_environment[broker_environment_count++] = envp[index];
    }
    broker_environment[broker_environment_count++] = error_assignment;
    broker_environment[broker_environment_count] = NULL;
    broker_argv[0] = broker;
    broker_argv[1] = "--adev-spawn-v1";
    broker_argv[2] = search_path ? "path" : "direct";
    broker_argv[3] = (char *)target;
    broker_argv[4] = "--";
    for (size_t index = 0; index < argument_count; ++index) {
        broker_argv[index + 5] = argv[index];
    }
    broker_argv[argument_count + 5] = NULL;

    pid_t child = -1;
    const int result = adev_next_posix_spawn(
        &child,
        broker,
        file_actions,
        attributes,
        broker_argv,
        broker_environment
    );
    close(broker_error_fd);
    free(broker_environment);
    free(broker_argv);
    if (result != 0) {
        close(pipe_descriptors[0]);
        return result;
    }

    const int broker_result = adev_spawn_wait_for_broker(child, pipe_descriptors[0]);
    close(pipe_descriptors[0]);
    if (broker_result != 0) return broker_result;
    *pid = child;
    return 0;
}

static int adev_posix_spawn_common(
    pid_t *pid,
    const char *target,
    bool search_path,
    const posix_spawn_file_actions_t *file_actions,
    const posix_spawnattr_t *attributes,
    char *const argv[],
    char *const envp[]
) {
    adev_runtime_exec_env prepared_environment;
    if (adev_runtime_env_prepare_exec(envp, &prepared_environment) != 0) {
        return errno == 0 ? ENOMEM : errno;
    }
    const int result = adev_spawn_via_broker(
        pid,
        target,
        search_path,
        file_actions,
        attributes,
        argv,
        prepared_environment.values
    );
    adev_runtime_env_release_exec(&prepared_environment);
    return result;
}

int posix_spawn(
    pid_t *pid,
    const char *path,
    const posix_spawn_file_actions_t *file_actions,
    const posix_spawnattr_t *attributes,
    char *const argv[],
    char *const envp[]
) {
    return adev_posix_spawn_common(
        pid, path, false, file_actions, attributes, argv, envp
    );
}

int posix_spawnp(
    pid_t *pid,
    const char *file,
    const posix_spawn_file_actions_t *file_actions,
    const posix_spawnattr_t *attributes,
    char *const argv[],
    char *const envp[]
) {
    return adev_posix_spawn_common(
        pid, file, true, file_actions, attributes, argv, envp
    );
}

static int adev_recursive_execve(
    const char *filename,
    char *const argv[],
    char *const envp[]
) {
    pthread_once(&adev_execve_once, adev_resolve_next_execve);
    if (adev_next_execve == NULL) {
        errno = ENOSYS;
        return -1;
    }
    if (filename == NULL) {
        errno = EFAULT;
        return -1;
    }

    adev_runtime_exec_env prepared_environment;
    if (adev_runtime_env_prepare_exec(envp, &prepared_environment) != 0) return -1;
    char *const *effective_envp = prepared_environment.values;

    char resolved_paths[ADEV_MAX_SHEBANG_DEPTH][PATH_MAX];
    adev_shebang shebangs[ADEV_MAX_SHEBANG_DEPTH];
    char **allocated_argv[ADEV_MAX_SHEBANG_DEPTH] = {0};
    char direct_shell_path[PATH_MAX];
    const char *initial_path = filename;
    if (adev_is_virtual_shell(filename)) {
        if (!adev_shell_fallback((char *const *)effective_envp, direct_shell_path)) {
            adev_runtime_env_release_exec(&prepared_environment);
            return -1;
        }
        initial_path = direct_shell_path;
    }
    const char *seen[ADEV_MAX_SHEBANG_DEPTH + 1] = {initial_path};
    size_t seen_count = 1;
    const char *current_path = initial_path;
    char *const *current_argv = argv;
    int result = -1;

    for (size_t depth = 0; depth < ADEV_MAX_SHEBANG_DEPTH; ++depth) {
        const int script = adev_read_shebang(current_path, &shebangs[depth]);
        if (script <= 0) {
            char native_target[PATH_MAX];
            const char *executable_path = current_path;
            if (script == 0 && adev_resolve_apk_native_symlink(
                    current_path,
                    (char *const *)effective_envp,
                    native_target)) {
                executable_path = native_target;
            }
            result = adev_next_execve(
                executable_path,
                (char *const *)current_argv,
                (char *const *)effective_envp
            );
            goto cleanup;
        }

        if (!adev_resolve_interpreter(
                shebangs[depth].interpreter,
                (char *const *)effective_envp,
                resolved_paths[depth])) {
            goto cleanup;
        }
        for (size_t index = 0; index < seen_count; ++index) {
            if (strcmp(seen[index], resolved_paths[depth]) == 0) {
                errno = ELOOP;
                goto cleanup;
            }
        }
        seen[seen_count++] = resolved_paths[depth];

        const size_t old_count = adev_argv_count((char *const *)current_argv);
        if (old_count == SIZE_MAX) goto cleanup;
        const size_t tail_count = old_count > 0 ? old_count - 1 : 0;
        const size_t new_count = 2 + (shebangs[depth].has_argument ? 1 : 0) + tail_count;
        if (new_count >= ADEV_MAX_ARGV) {
            errno = E2BIG;
            goto cleanup;
        }
        char **next_argv = calloc(new_count + 1, sizeof(char *));
        if (next_argv == NULL) goto cleanup;
        allocated_argv[depth] = next_argv;

        size_t output = 0;
        next_argv[output++] = resolved_paths[depth];
        if (shebangs[depth].has_argument) {
            next_argv[output++] = shebangs[depth].argument;
        }
        next_argv[output++] = (char *)current_path;
        for (size_t index = 1; index < old_count; ++index) {
            next_argv[output++] = current_argv[index];
        }
        next_argv[output] = NULL;
        current_path = resolved_paths[depth];
        current_argv = next_argv;
    }

    errno = ELOOP;

cleanup: {
        const int saved_errno = errno;
        for (size_t index = 0; index < ADEV_MAX_SHEBANG_DEPTH; ++index) {
            free(allocated_argv[index]);
        }
        adev_runtime_env_release_exec(&prepared_environment);
        errno = saved_errno;
    }
    return result;
}

int execve(const char *filename, char *const argv[], char *const envp[]) {
    return adev_recursive_execve(filename, argv, envp);
}

int execv(const char *path, char *const argv[]) {
    return adev_recursive_execve(path, argv, environ);
}

static int adev_path_exec(
    const char *file,
    char *const argv[],
    char *const envp[]
) {
    if (file == NULL) {
        errno = EFAULT;
        return -1;
    }
    if (strchr(file, '/') != NULL) return adev_recursive_execve(file, argv, envp);

    adev_runtime_exec_env prepared_environment;
    if (adev_runtime_env_prepare_exec(envp, &prepared_environment) != 0) return -1;
    char *const *effective_envp = prepared_environment.values;

    const char *path = adev_env_value((char *const *)effective_envp, "PATH");
    if (path == NULL) path = "/system/bin";
    bool saw_permission_error = false;
    char candidate[PATH_MAX];
    const char *component = path;
    while (true) {
        const char *separator = strchr(component, ':');
        const size_t component_length = separator == NULL
            ? strlen(component)
            : (size_t)(separator - component);
        const char *directory = component_length == 0 ? "." : component;
        const size_t directory_length = component_length == 0 ? 1 : component_length;
        const size_t file_length = strlen(file);
        if (directory_length + 1 + file_length >= PATH_MAX) {
            errno = ENAMETOOLONG;
            adev_runtime_env_release_exec(&prepared_environment);
            return -1;
        }
        memcpy(candidate, directory, directory_length);
        candidate[directory_length] = '/';
        memcpy(candidate + directory_length + 1, file, file_length + 1);

        adev_recursive_execve(candidate, argv, (char *const *)effective_envp);
        if (errno == EACCES) {
            saw_permission_error = true;
        } else if (errno != ENOENT && errno != ENOTDIR) {
            adev_runtime_env_release_exec(&prepared_environment);
            return -1;
        }

        if (separator == NULL) break;
        component = separator + 1;
    }
    adev_runtime_env_release_exec(&prepared_environment);
    errno = saw_permission_error ? EACCES : ENOENT;
    return -1;
}

int execvp(const char *file, char *const argv[]) {
    return adev_path_exec(file, argv, environ);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
    return adev_path_exec(file, argv, envp);
}

static char **adev_collect_varargs(
    const char *first,
    va_list *arguments,
    bool includes_environment,
    char *const **environment
) {
    size_t count = first == NULL ? 0 : 1;
    va_list counter;
    va_copy(counter, *arguments);
    if (first != NULL) {
        while (va_arg(counter, char *) != NULL) {
            if (++count >= ADEV_MAX_ARGV) {
                va_end(counter);
                errno = E2BIG;
                return NULL;
            }
        }
    }
    if (includes_environment) {
        *environment = va_arg(counter, char *const *);
    }
    va_end(counter);

    char **argv = calloc(count + 1, sizeof(char *));
    if (argv == NULL) return NULL;
    if (count > 0) {
        argv[0] = (char *)first;
        for (size_t index = 1; index < count; ++index) {
            argv[index] = va_arg(*arguments, char *);
        }
        (void)va_arg(*arguments, char *);
    }
    if (includes_environment) {
        *environment = va_arg(*arguments, char *const *);
    }
    return argv;
}

int execl(const char *path, const char *arg, ...) {
    va_list arguments;
    va_start(arguments, arg);
    char *const *unused_environment = NULL;
    char **argv = adev_collect_varargs(
        arg,
        &arguments,
        false,
        &unused_environment
    );
    va_end(arguments);
    if (argv == NULL) return -1;
    const int result = adev_recursive_execve(path, argv, environ);
    const int saved_errno = errno;
    free(argv);
    errno = saved_errno;
    return result;
}

int execlp(const char *file, const char *arg, ...) {
    va_list arguments;
    va_start(arguments, arg);
    char *const *unused_environment = NULL;
    char **argv = adev_collect_varargs(
        arg,
        &arguments,
        false,
        &unused_environment
    );
    va_end(arguments);
    if (argv == NULL) return -1;
    const int result = adev_path_exec(file, argv, environ);
    const int saved_errno = errno;
    free(argv);
    errno = saved_errno;
    return result;
}

int execle(const char *path, const char *arg, ...) {
    va_list arguments;
    va_start(arguments, arg);
    char *const *environment = NULL;
    char **argv = adev_collect_varargs(arg, &arguments, true, &environment);
    va_end(arguments);
    if (argv == NULL) return -1;
    const int result = adev_recursive_execve(
        path,
        argv,
        (char *const *)environment
    );
    const int saved_errno = errno;
    free(argv);
    errno = saved_errno;
    return result;
}
