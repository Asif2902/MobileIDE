#define _GNU_SOURCE

#include "adev_runtime_env.h"

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define ADEV_ENV_MAX_LINE 8192

/*
 * Recovery layer for the runtime environment contract.
 *
 * Most ADEV processes inherit a complete environment from the app. Some do not:
 * a tool re-exec'd by an Android system binary, a payload that rebuilt its own
 * environment, or anything started before the shell bootstrap ran. Those
 * processes used to continue with no HOME, no TMPDIR, no XDG directories and no
 * TLS trust store, which is where the Termux-era defaults compiled into the
 * bundled tools started leaking through.
 *
 * This module gives every such process the same contract the app hands out,
 * without overriding a caller that knew what it was doing.
 */

static bool adev_is_directory(const char *path) {
    struct stat info;
    return path != NULL && path[0] != '\0' && stat(path, &info) == 0 &&
        S_ISDIR(info.st_mode);
}

/* Create `path` and any missing parents, app-private. */
static void adev_mkdir_p(const char *path) {
    char buffer[PATH_MAX];
    const size_t length = strlen(path);
    if (length == 0 || length >= sizeof(buffer)) return;
    memcpy(buffer, path, length + 1);
    for (size_t index = 1; index <= length; ++index) {
        if (buffer[index] != '/' && buffer[index] != '\0') continue;
        const char saved = buffer[index];
        buffer[index] = '\0';
        if (mkdir(buffer, 0700) != 0 && errno != EEXIST) {
            return;
        }
        buffer[index] = saved;
    }
}

static bool adev_is_file(const char *path) {
    struct stat info;
    return path != NULL && path[0] != '\0' && stat(path, &info) == 0 &&
        S_ISREG(info.st_mode);
}

static bool adev_conf_in(const char *root, char out[PATH_MAX]) {
    if (root == NULL || root[0] != '/') return false;
    const int written = snprintf(out, PATH_MAX, "%s/etc/adev-env.conf", root);
    return written > 0 && written < PATH_MAX && adev_is_file(out);
}

/*
 * Derive the runtime root from this executable's own path.
 *
 * ADEV's native tools live in the application's nativeLibraryDir, which Android
 * lays out as `/data/app/<install-id>/<package>-<install-id>/lib/<abi>`. Both
 * install identifiers change on every reinstall, so nothing may be hard-coded;
 * the package name, however, is a Java identifier and therefore never contains
 * a hyphen, which makes it recoverable from that directory name.
 */
static bool adev_conf_from_executable(char out[PATH_MAX]) {
    char executable[PATH_MAX];
    const ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (length <= 0) return false;
    executable[length] = '\0';

    /* .../<package>-<install-id>/lib/<abi>/<file> -> strip file, abi, lib */
    for (int level = 0; level < 3; ++level) {
        char *slash = strrchr(executable, '/');
        if (slash == NULL || slash == executable) return false;
        *slash = '\0';
    }
    const char *package_dir = strrchr(executable, '/');
    if (package_dir == NULL) return false;
    ++package_dir;

    char package[PATH_MAX];
    const size_t package_length = strcspn(package_dir, "-");
    if (package_length == 0 || package_length >= sizeof(package)) return false;
    memcpy(package, package_dir, package_length);
    package[package_length] = '\0';
    /* A package name is dotted; reject anything that clearly is not one. */
    if (strchr(package, '.') == NULL) return false;

    static const char *const data_roots[] = {"/data/user/0", "/data/data"};
    for (size_t index = 0; index < sizeof(data_roots) / sizeof(data_roots[0]); ++index) {
        char root[PATH_MAX];
        const int written = snprintf(
            root, sizeof(root), "%s/%s/files/runtime", data_roots[index], package);
        if (written > 0 && written < (int)sizeof(root) && adev_conf_in(root, out)) {
            return true;
        }
    }
    return false;
}

static bool adev_locate_conf(char out[PATH_MAX]) {
    static const char *const roots[] = {
        "ADEV_RUNTIME", "PREFIX", "MOBILEIDE_ROOT", "TERMUX__ROOTFS"
    };
    for (size_t index = 0; index < sizeof(roots) / sizeof(roots[0]); ++index) {
        if (adev_conf_in(getenv(roots[index]), out)) return true;
    }
    /* HOME is `<runtime>/home`; TMPDIR is `<runtime>/tmp`. */
    static const char *const children[] = {"HOME", "TMPDIR"};
    for (size_t index = 0; index < sizeof(children) / sizeof(children[0]); ++index) {
        const char *value = getenv(children[index]);
        if (value == NULL || value[0] != '/') continue;
        char root[PATH_MAX];
        const size_t length = strlen(value);
        if (length >= sizeof(root)) continue;
        memcpy(root, value, length + 1);
        char *slash = strrchr(root, '/');
        if (slash == NULL || slash == root) continue;
        *slash = '\0';
        if (adev_conf_in(root, out)) return true;
    }
    return adev_conf_from_executable(out);
}

/* A value that names the Termux packages cannot be valid in this app. */
static bool adev_is_stale(const char *value) {
    return value != NULL && strstr(value, "/com.termux/") != NULL;
}

/*
 * Merge the contract's PATH entries into the caller's PATH.
 *
 * Replacing PATH outright would drop directories a caller legitimately added —
 * npm prepends `node_modules/.bin` before running a package script, for one —
 * so missing entries are prepended in contract order and existing ones are left
 * exactly where they are.
 */
static void adev_merge_path(const char *contract_path) {
    const char *current = getenv("PATH");
    if (current == NULL || current[0] == '\0' || adev_is_stale(current)) {
        setenv("PATH", contract_path, 1);
        return;
    }

    char merged[ADEV_ENV_MAX_LINE];
    if (strlen(current) >= sizeof(merged)) return;
    strcpy(merged, current);

    /* Walk the contract in reverse so its first entry ends up first. */
    const size_t contract_length = strlen(contract_path);
    size_t end = contract_length;
    while (end > 0) {
        size_t start = end;
        while (start > 0 && contract_path[start - 1] != ':') --start;
        const size_t entry_length = end - start;
        if (entry_length > 0) {
            char entry[PATH_MAX];
            if (entry_length < sizeof(entry)) {
                memcpy(entry, contract_path + start, entry_length);
                entry[entry_length] = '\0';

                char needle[PATH_MAX + 2];
                snprintf(needle, sizeof(needle), ":%s:", entry);
                char haystack[ADEV_ENV_MAX_LINE + 2];
                snprintf(haystack, sizeof(haystack), ":%s:", merged);
                if (strstr(haystack, needle) == NULL &&
                    strlen(merged) + entry_length + 2 < sizeof(merged)) {
                    char updated[ADEV_ENV_MAX_LINE];
                    snprintf(updated, sizeof(updated), "%s:%s", entry, merged);
                    strcpy(merged, updated);
                }
            }
        }
        end = start > 0 ? start - 1 : 0;
        if (start == 0) break;
    }
    setenv("PATH", merged, 1);
}

static void adev_merge_preload(const char *contract_preload) {
    const char *current = getenv("LD_PRELOAD");
    if (current == NULL || current[0] == '\0' || adev_is_stale(current)) {
        setenv("LD_PRELOAD", contract_preload, 1);
        return;
    }
    char merged[ADEV_ENV_MAX_LINE];
    if (strlen(current) >= sizeof(merged)) return;
    strcpy(merged, current);
    const size_t contract_length = strlen(contract_preload);
    size_t end = contract_length;
    while (end > 0) {
        size_t start = end;
        while (start > 0 && contract_preload[start - 1] != ':') --start;
        const size_t entry_length = end - start;
        if (entry_length > 0) {
            char entry[PATH_MAX];
            if (entry_length < sizeof(entry)) {
                memcpy(entry, contract_preload + start, entry_length);
                entry[entry_length] = '\0';
                char needle[PATH_MAX + 2];
                snprintf(needle, sizeof(needle), ":%s:", entry);
                char haystack[ADEV_ENV_MAX_LINE + 2];
                snprintf(haystack, sizeof(haystack), ":%s:", merged);
                if (strstr(haystack, needle) == NULL &&
                    strlen(merged) + entry_length + 2 < sizeof(merged)) {
                    char updated[ADEV_ENV_MAX_LINE];
                    snprintf(updated, sizeof(updated), "%s:%s", entry, merged);
                    strcpy(merged, updated);
                }
            }
        }
        end = start > 0 ? start - 1 : 0;
        if (start == 0) break;
    }
    setenv("LD_PRELOAD", merged, 1);
}

static void adev_apply_assignment(char *line) {
    char *separator = strchr(line, '=');
    if (separator == NULL) return;
    *separator = '\0';
    const char *name = line;
    const char *value = separator + 1;
    if (name[0] == '\0' || value[0] == '\0') return;

    if (strcmp(name, "PATH") == 0) {
        adev_merge_path(value);
        return;
    }
    if (strcmp(name, "LD_PRELOAD") == 0) {
        adev_merge_preload(value);
        return;
    }
    const char *existing = getenv(name);
    if (existing == NULL || existing[0] == '\0' || adev_is_stale(existing)) {
        setenv(name, value, 1);
    }
}

void adev_runtime_env_apply(void) {
    static bool applied = false;
    if (applied) return;
    applied = true;

    const char *disabled = getenv("ADEV_ENV_AUTOFILL");
    if (disabled != NULL && strcmp(disabled, "0") == 0) return;

    char conf[PATH_MAX];
    if (!adev_locate_conf(conf)) return;

    FILE *file = fopen(conf, "re");
    if (file == NULL) return;
    char line[ADEV_ENV_MAX_LINE];
    while (fgets(line, sizeof(line), file) != NULL) {
        size_t length = strlen(line);
        while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) {
            line[--length] = '\0';
        }
        if (length == 0 || line[0] == '#') continue;
        adev_apply_assignment(line);
    }
    fclose(file);

    /*
     * The directories the contract promises are created by the app, but a
     * process may be the first to need them after a manual cleanup. Creating
     * them here costs nothing and keeps `Unsupported platform: android` style
     * probes — which only test for existence — from failing.
     */
    static const char *const required[] = {
        "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"
    };
    for (size_t index = 0; index < sizeof(required) / sizeof(required[0]); ++index) {
        const char *value = getenv(required[index]);
        if (value != NULL && value[0] == '/' && !adev_is_directory(value)) {
            adev_mkdir_p(value);
        }
    }
}
