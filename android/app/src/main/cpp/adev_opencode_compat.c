#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/*
 * The pinned Android OpenCode/Bun payload still performs a literal mkdir("/tmp")
 * during startup. Android's root filesystem is read-only and does not provide a
 * writable FHS /tmp, even though the surrounding JavaScript correctly receives
 * TMPDIR. Keep this compatibility boundary scoped to the OpenCode process: the
 * native launcher sets ADEV_OPENCODE_TMPDIR to a canonical app-private directory
 * and preloads this library only for the child payload.
 */
int adev_opencode_map_tmp_path(const char *path, char *output, size_t output_size) {
    if (path == NULL || output == NULL || output_size == 0) {
        errno = EINVAL;
        return -1;
    }
    if (strncmp(path, "/tmp", 4) != 0 || (path[4] != '\0' && path[4] != '/')) {
        return 0;
    }

    const char *private_tmp = getenv("ADEV_OPENCODE_TMPDIR");
    if (private_tmp == NULL || private_tmp[0] != '/' || strcmp(private_tmp, "/tmp") == 0) {
        errno = EPERM;
        return -1;
    }

    /* Never let a virtual /tmp/../ path escape the launcher's validated root. */
    const char *segment = path + 4;
    while (*segment != '\0') {
        while (*segment == '/') {
            ++segment;
        }
        const char *end = segment;
        while (*end != '\0' && *end != '/') {
            ++end;
        }
        if ((end - segment) == 2 && segment[0] == '.' && segment[1] == '.') {
            errno = EPERM;
            return -1;
        }
        segment = end;
    }

    const size_t root_length = strlen(private_tmp);
    const char *suffix = path + 4;
    const int root_has_slash = root_length > 0 && private_tmp[root_length - 1] == '/';
    if (root_has_slash && suffix[0] == '/') {
        ++suffix;
    }
    const size_t suffix_length = strlen(suffix);
    if (root_length + suffix_length + 1 > output_size) {
        errno = ENAMETOOLONG;
        return -1;
    }
    memcpy(output, private_tmp, root_length);
    memcpy(output + root_length, suffix, suffix_length + 1);
    return 1;
}

#ifdef ADEV_OPENCODE_COMPAT_MAP_TEST

int main(int argc, char **argv) {
    for (int index = 1; index < argc; ++index) {
        char mapped[PATH_MAX];
        errno = 0;
        const int result = adev_opencode_map_tmp_path(argv[index], mapped, sizeof(mapped));
        printf("%d|%s|%d\n", result, result == 1 ? mapped : argv[index], errno);
    }
    return 0;
}

#else

#include <dirent.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <malloc.h>
#include <pthread.h>
#include <stdarg.h>
#include <sys/stat.h>
#include <unistd.h>

static pthread_once_t adev_symbols_once = PTHREAD_ONCE_INIT;

static int (*adev_real_mkdir)(const char *, mode_t);
static int (*adev_real_mkdirat)(int, const char *, mode_t);
static int (*adev_real_open)(const char *, int, ...);
static int (*adev_real_openat)(int, const char *, int, ...);
static int (*adev_real_access)(const char *, int);
static int (*adev_real_stat)(const char *, struct stat *);
static int (*adev_real_lstat)(const char *, struct stat *);
static int (*adev_real_fstatat)(int, const char *, struct stat *, int);
static ssize_t (*adev_real_readlink)(const char *, char *, size_t);
static int (*adev_real_unlink)(const char *);
static int (*adev_real_unlinkat)(int, const char *, int);
static int (*adev_real_rmdir)(const char *);
static int (*adev_real_rename)(const char *, const char *);
static int (*adev_real_renameat)(int, const char *, int, const char *);
static char *(*adev_real_realpath)(const char *, char *);
static DIR *(*adev_real_opendir)(const char *);

/*
 * Android 10 and 11 expose heap-tag control through the Bionic-private
 * android_mallopt() entry point. The public mallopt(-204, NONE) API used by
 * the upstream OpenCode tagfix did not arrive until API 31, so that preload is
 * a no-op on our API 29/30 baseline. Bun's bundled HTTP client masks pointers
 * to 48 bits before freeing them; API 30's default TBI heap tag consequently
 * aborts with "Pointer tag ... was truncated".
 *
 * Run this during single-threaded process startup, which is the contract of
 * the API-30 M_SET_HEAP_TAGGING_LEVEL operation. Resolve it dynamically so the
 * compatibility preload remains loadable on newer Android releases where the
 * public mallopt operation is the supported interface.
 */
static int adev_disable_heap_pointer_tagging(void) {
    typedef int (*adev_android_mallopt_fn)(int, void *, size_t);
    enum {
        ADEV_M_SET_HEAP_TAGGING_LEVEL = 8,
        ADEV_M_HEAP_TAGGING_LEVEL_NONE = 0,
        ADEV_M_BIONIC_SET_HEAP_TAGGING_LEVEL = -204,
    };

    void *symbol = dlsym(RTLD_DEFAULT, "android_mallopt");
    if (symbol != NULL) {
        adev_android_mallopt_fn android_mallopt_fn;
        memcpy(&android_mallopt_fn, &symbol, sizeof(android_mallopt_fn));
        int level = ADEV_M_HEAP_TAGGING_LEVEL_NONE;
        if (android_mallopt_fn(
                ADEV_M_SET_HEAP_TAGGING_LEVEL, &level, sizeof(level)) != 0) {
            return 1;
        }
    }

    return mallopt(
        ADEV_M_BIONIC_SET_HEAP_TAGGING_LEVEL,
        ADEV_M_HEAP_TAGGING_LEVEL_NONE);
}

__attribute__((constructor)) static void adev_opencode_compat_loaded(void) {
    const int heap_tagging_disabled = adev_disable_heap_pointer_tagging();
    const char *trace = getenv("ADEV_OPENCODE_TRACE");
    if (trace == NULL || strcmp(trace, "1") != 0) return;
    const char *message = heap_tagging_disabled
        ? "adev-opencode: API-compatible heap tag disable active; private /tmp preload active\n"
        : "adev-opencode: failed to disable heap pointer tagging; private /tmp preload active\n";
    (void)write(STDERR_FILENO, message, strlen(message));
}

static void adev_resolve_symbols(void) {
    adev_real_mkdir = dlsym(RTLD_NEXT, "mkdir");
    adev_real_mkdirat = dlsym(RTLD_NEXT, "mkdirat");
    adev_real_open = dlsym(RTLD_NEXT, "open");
    adev_real_openat = dlsym(RTLD_NEXT, "openat");
    adev_real_access = dlsym(RTLD_NEXT, "access");
    adev_real_stat = dlsym(RTLD_NEXT, "stat");
    adev_real_lstat = dlsym(RTLD_NEXT, "lstat");
    adev_real_fstatat = dlsym(RTLD_NEXT, "fstatat");
    adev_real_readlink = dlsym(RTLD_NEXT, "readlink");
    adev_real_unlink = dlsym(RTLD_NEXT, "unlink");
    adev_real_unlinkat = dlsym(RTLD_NEXT, "unlinkat");
    adev_real_rmdir = dlsym(RTLD_NEXT, "rmdir");
    adev_real_rename = dlsym(RTLD_NEXT, "rename");
    adev_real_renameat = dlsym(RTLD_NEXT, "renameat");
    adev_real_realpath = dlsym(RTLD_NEXT, "realpath");
    adev_real_opendir = dlsym(RTLD_NEXT, "opendir");
}

static const char *adev_mapped(const char *path, char output[PATH_MAX]) {
    const int result = adev_opencode_map_tmp_path(path, output, PATH_MAX);
    return result < 0 ? NULL : (result == 1 ? output : path);
}

#define ADEV_RESOLVE_OR_FAIL(symbol)                    \
    do {                                                \
        pthread_once(&adev_symbols_once, adev_resolve_symbols); \
        if ((symbol) == NULL) {                         \
            errno = ENOSYS;                             \
            return -1;                                  \
        }                                               \
    } while (0)

int mkdir(const char *path, mode_t mode) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_mkdir);
    return adev_real_mkdir(actual, mode);
}

int mkdirat(int directory_fd, const char *path, mode_t mode) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_mkdirat);
    return adev_real_mkdirat(directory_fd, actual, mode);
}

static int adev_open_has_mode(int flags) {
    if ((flags & O_CREAT) != 0) return 1;
#ifdef O_TMPFILE
    if ((flags & O_TMPFILE) == O_TMPFILE) return 1;
#endif
    return 0;
}

int open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (adev_open_has_mode(flags)) {
        va_list arguments;
        va_start(arguments, flags);
        mode = (mode_t)va_arg(arguments, int);
        va_end(arguments);
    }
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_open);
    return adev_open_has_mode(flags)
        ? adev_real_open(actual, flags, mode)
        : adev_real_open(actual, flags);
}

int openat(int directory_fd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (adev_open_has_mode(flags)) {
        va_list arguments;
        va_start(arguments, flags);
        mode = (mode_t)va_arg(arguments, int);
        va_end(arguments);
    }
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_openat);
    return adev_open_has_mode(flags)
        ? adev_real_openat(directory_fd, actual, flags, mode)
        : adev_real_openat(directory_fd, actual, flags);
}

int access(const char *path, int mode) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_access);
    return adev_real_access(actual, mode);
}

int stat(const char *path, struct stat *status) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_stat);
    return adev_real_stat(actual, status);
}

int lstat(const char *path, struct stat *status) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_lstat);
    return adev_real_lstat(actual, status);
}

int fstatat(int directory_fd, const char *path, struct stat *status, int flags) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_fstatat);
    return adev_real_fstatat(directory_fd, actual, status, flags);
}

ssize_t readlink(const char *path, char *buffer, size_t size) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    pthread_once(&adev_symbols_once, adev_resolve_symbols);
    if (adev_real_readlink == NULL) {
        errno = ENOSYS;
        return -1;
    }
    return adev_real_readlink(actual, buffer, size);
}

int unlink(const char *path) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_unlink);
    return adev_real_unlink(actual);
}

int unlinkat(int directory_fd, const char *path, int flags) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_unlinkat);
    return adev_real_unlinkat(directory_fd, actual, flags);
}

int rmdir(const char *path) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_rmdir);
    return adev_real_rmdir(actual);
}

int rename(const char *old_path, const char *new_path) {
    char old_mapped[PATH_MAX];
    char new_mapped[PATH_MAX];
    const char *actual_old = adev_mapped(old_path, old_mapped);
    const char *actual_new = adev_mapped(new_path, new_mapped);
    if (actual_old == NULL || actual_new == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_rename);
    return adev_real_rename(actual_old, actual_new);
}

int renameat(int old_directory_fd, const char *old_path,
             int new_directory_fd, const char *new_path) {
    char old_mapped[PATH_MAX];
    char new_mapped[PATH_MAX];
    const char *actual_old = adev_mapped(old_path, old_mapped);
    const char *actual_new = adev_mapped(new_path, new_mapped);
    if (actual_old == NULL || actual_new == NULL) return -1;
    ADEV_RESOLVE_OR_FAIL(adev_real_renameat);
    return adev_real_renameat(old_directory_fd, actual_old, new_directory_fd, actual_new);
}

char *realpath(const char *path, char *resolved) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return NULL;
    pthread_once(&adev_symbols_once, adev_resolve_symbols);
    if (adev_real_realpath == NULL) {
        errno = ENOSYS;
        return NULL;
    }
    return adev_real_realpath(actual, resolved);
}

DIR *opendir(const char *path) {
    char mapped[PATH_MAX];
    const char *actual = adev_mapped(path, mapped);
    if (actual == NULL) return NULL;
    pthread_once(&adev_symbols_once, adev_resolve_symbols);
    if (adev_real_opendir == NULL) {
        errno = ENOSYS;
        return NULL;
    }
    return adev_real_opendir(actual);
}

#endif
