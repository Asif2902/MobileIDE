#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define ADEV_MAX_SHEBANG_DEPTH 8
#define ADEV_MAX_INTERPRETER_ARG 1024
#define ADEV_MAX_ARGV 65536

typedef int (*adev_execve_fn)(const char *, char *const[], char *const[]);

typedef struct {
    char interpreter[PATH_MAX];
    char argument[ADEV_MAX_INTERPRETER_ARG];
    bool has_argument;
} adev_shebang;

static pthread_once_t adev_execve_once = PTHREAD_ONCE_INIT;
static adev_execve_fn adev_next_execve = NULL;
extern char **environ;

static void adev_resolve_next_execve(void) {
    adev_next_execve = (adev_execve_fn)dlsym(RTLD_NEXT, "execve");
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

static bool adev_is_stale_termux_shell(const char *path) {
    if (path == NULL) return false;
    return strcmp(path, "/data/data/com.termux/files/usr/bin/sh") == 0 ||
        strcmp(path, "/data/user/0/com.termux/files/usr/bin/sh") == 0;
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
    if (path == NULL || path[0] == '\0') path = "/system/bin";

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
        adev_env_value(envp, "ADEV_PYTHON_SHELL"),
        adev_env_value(envp, "MOBILEIDE_BASH"),
        adev_env_value(envp, "SHELL"),
        "/system/bin/sh",
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

    if (adev_is_stale_termux_shell(interpreter) ||
        strcmp(interpreter, "/bin/sh") == 0 ||
        strcmp(interpreter, "/usr/bin/sh") == 0) {
        return adev_shell_fallback(envp, destination);
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

    char resolved_paths[ADEV_MAX_SHEBANG_DEPTH][PATH_MAX];
    adev_shebang shebangs[ADEV_MAX_SHEBANG_DEPTH];
    char **allocated_argv[ADEV_MAX_SHEBANG_DEPTH] = {0};
    const char *seen[ADEV_MAX_SHEBANG_DEPTH + 1] = {filename};
    size_t seen_count = 1;
    const char *current_path = filename;
    char *const *current_argv = argv;
    int result = -1;

    for (size_t depth = 0; depth < ADEV_MAX_SHEBANG_DEPTH; ++depth) {
        const int script = adev_read_shebang(current_path, &shebangs[depth]);
        if (script <= 0) {
            result = adev_next_execve(current_path, (char *const *)current_argv, envp);
            goto cleanup;
        }

        if (!adev_resolve_interpreter(
                shebangs[depth].interpreter,
                envp,
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

    const char *path = adev_env_value(envp, "PATH");
    if (path == NULL || path[0] == '\0') path = "/system/bin";
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
            return -1;
        }
        memcpy(candidate, directory, directory_length);
        candidate[directory_length] = '/';
        memcpy(candidate + directory_length + 1, file, file_length + 1);

        adev_recursive_execve(candidate, argv, envp);
        if (errno == EACCES) {
            saw_permission_error = true;
        } else if (errno != ENOENT && errno != ENOTDIR) {
            return -1;
        }

        if (separator == NULL) break;
        component = separator + 1;
    }
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
