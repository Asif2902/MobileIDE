#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

extern char **environ;

#define ADEV_GLIBC_ROOT_FD 255

static const char *environment_value(const char *name) {
    const size_t length = strlen(name);
    for (size_t index = 0; environ[index] != NULL; ++index) {
        if (strncmp(environ[index], name, length) == 0 &&
            environ[index][length] == '=') {
            return environ[index] + length + 1;
        }
    }
    return NULL;
}

static bool is_regular_file(const char *path) {
    struct stat metadata;
    return path != NULL && stat(path, &metadata) == 0 && S_ISREG(metadata.st_mode);
}

static int resolve_real_loader(char destination[PATH_MAX]) {
    const char *native_directory = environment_value("MOBILEIDE_NATIVE_LIB");
    const char *configured_loader = environment_value("MOBILEIDE_GLIBC_LOADER");
    if (native_directory == NULL || native_directory[0] != '/') return ENOENT;

    char native_real[PATH_MAX];
    if (realpath(native_directory, native_real) == NULL) return errno;

    char candidate[PATH_MAX];
    if (configured_loader != NULL && configured_loader[0] == '/') {
        const size_t length = strlen(configured_loader);
        if (length >= sizeof(candidate)) return ENAMETOOLONG;
        memcpy(candidate, configured_loader, length + 1);
    } else {
        const int count = snprintf(
            candidate,
            sizeof(candidate),
            "%s/libbin_adev_glibc_ld.so",
            native_real
        );
        if (count <= 0 || count >= (int)sizeof(candidate)) return ENAMETOOLONG;
    }

    if (realpath(candidate, destination) == NULL) return errno;
    const size_t native_length = strlen(native_real);
    if (strncmp(destination, native_real, native_length) != 0 ||
        destination[native_length] != '/' ||
        strcmp(destination + native_length + 1, "libbin_adev_glibc_ld.so") != 0 ||
        !is_regular_file(destination)) {
        return EACCES;
    }
    return 0;
}

static bool remove_for_glibc(const char *entry) {
    return strncmp(entry, "LD_PRELOAD=", 11) == 0 ||
        strncmp(entry, "LD_AUDIT=", 9) == 0 ||
        strncmp(entry, "ADEV_ENV_AUTOFILL=", 18) == 0;
}

static int bind_runtime_root(void) {
    const char *configured_root = environment_value("ADEV_GLIBC_ROOT");
    if (configured_root == NULL || configured_root[0] != '/') return ENOENT;

    char root[PATH_MAX];
    if (realpath(configured_root, root) == NULL) return errno;
    char manifest[PATH_MAX];
    const int count = snprintf(manifest, sizeof(manifest), "%s/manifest.json", root);
    if (count <= 0 || count >= (int)sizeof(manifest) || !is_regular_file(manifest)) {
        return ENOENT;
    }

    const int directory = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (directory < 0) return errno;
    if (directory != ADEV_GLIBC_ROOT_FD && dup2(directory, ADEV_GLIBC_ROOT_FD) < 0) {
        const int error = errno;
        close(directory);
        return error;
    }
    if (directory != ADEV_GLIBC_ROOT_FD) close(directory);
    const int flags = fcntl(ADEV_GLIBC_ROOT_FD, F_GETFD);
    if (flags < 0 || fcntl(ADEV_GLIBC_ROOT_FD, F_SETFD, flags & ~FD_CLOEXEC) < 0) {
        const int error = errno;
        close(ADEV_GLIBC_ROOT_FD);
        return error;
    }
    return 0;
}

int main(int argc, char **argv) {
    (void)argc;
    char loader[PATH_MAX];
    const int loader_error = resolve_real_loader(loader);
    if (loader_error != 0) {
        dprintf(STDERR_FILENO, "ADEV glibc launcher: %s\n", strerror(loader_error));
        return loader_error == ENOENT ? 127 : 126;
    }

    const int root_error = bind_runtime_root();
    if (root_error != 0) {
        dprintf(STDERR_FILENO, "ADEV glibc launcher: runtime root: %s\n", strerror(root_error));
        return root_error == ENOENT ? 127 : 126;
    }

    size_t environment_count = 0;
    while (environ[environment_count] != NULL) ++environment_count;
    char **clean_environment = calloc(environment_count + 2, sizeof(char *));
    if (clean_environment == NULL) {
        dprintf(STDERR_FILENO, "ADEV glibc launcher: out of memory\n");
        return 126;
    }

    size_t output = 0;
    for (size_t index = 0; index < environment_count; ++index) {
        if (!remove_for_glibc(environ[index])) clean_environment[output++] = environ[index];
    }
    clean_environment[output++] = "ADEV_ENV_AUTOFILL=0";
    clean_environment[output] = NULL;

    /*
     * Call the kernel directly. The public loader path lives below filesDir
     * for Termux-style compatibility; letting another exec shim reclassify it
     * would incorrectly enter the genuine glibc loader through linker64.
     */
    syscall(__NR_execve, loader, argv, clean_environment);
    const int error = errno;
    free(clean_environment);
    dprintf(STDERR_FILENO, "ADEV glibc launcher: %s: %s\n", loader, strerror(error));
    return error == ENOENT ? 127 : 126;
}
