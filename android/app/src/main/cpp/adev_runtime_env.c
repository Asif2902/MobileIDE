#define _GNU_SOURCE

#include "adev_runtime_env.h"

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define ADEV_ENV_MAX_LINE 8192
#define ADEV_ENV_MAX_ENTRIES 4096

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

static const char *adev_block_value(char *const envp[], const char *name) {
    if (envp == NULL || name == NULL) return NULL;
    const size_t length = strlen(name);
    for (size_t index = 0; envp[index] != NULL; ++index) {
        if (strncmp(envp[index], name, length) == 0 && envp[index][length] == '=') {
            return envp[index] + length + 1;
        }
    }
    return NULL;
}

static bool adev_android_baseline_env(char *const envp[]) {
    const char *android_root = adev_block_value(envp, "ANDROID_ROOT");
    if (android_root != NULL && strcmp(android_root, "/system") == 0) return true;
    const char *path = adev_block_value(envp, "PATH");
    return path != NULL && strstr(path, "/apex/com.android.runtime/bin") != NULL &&
        strstr(path, "/system/bin") != NULL;
}

static bool adev_exec_env_needs_contract(char *const envp[], size_t count) {
    if (envp == NULL || count == 0) return false;
    const char *autofill = adev_block_value(envp, "ADEV_ENV_AUTOFILL");
    if (autofill != NULL && strcmp(autofill, "0") == 0) return false;
    if (autofill != NULL && strcmp(autofill, "1") == 0) return true;
    if (!adev_android_baseline_env(envp)) return false;

    /* A complete ADEV block needs no copy; Bun's sanitized block lacks these. */
    const char *path = adev_block_value(envp, "PATH");
    const char *shell = adev_block_value(envp, "SHELL");
    const char *python_shell = adev_block_value(envp, "ADEV_PYTHON_SHELL");
    return adev_block_value(envp, "PREFIX") == NULL ||
        adev_block_value(envp, "MOBILEIDE_NATIVE_LIB") == NULL ||
        adev_block_value(envp, "LD_PRELOAD") == NULL ||
        path == NULL || path[0] == '\0' ||
        shell == NULL || shell[0] == '\0' ||
        python_shell == NULL || python_shell[0] == '\0';
}

static size_t adev_block_find(char **values, size_t count, const char *name) {
    const size_t length = strlen(name);
    for (size_t index = 0; index < count; ++index) {
        if (strncmp(values[index], name, length) == 0 && values[index][length] == '=') {
            return index;
        }
    }
    return SIZE_MAX;
}

static bool adev_colon_contains(const char *value, const char *entry, size_t length) {
    const char *cursor = value;
    while (cursor != NULL) {
        const char *separator = strchr(cursor, ':');
        const size_t item_length = separator == NULL
            ? strlen(cursor)
            : (size_t)(separator - cursor);
        if (item_length == length && strncmp(cursor, entry, length) == 0) return true;
        cursor = separator == NULL ? NULL : separator + 1;
    }
    return false;
}

/* Contract entries lead, caller-only entries follow, duplicates are omitted. */
static char *adev_merge_colon_assignment(
    const char *name,
    const char *contract,
    const char *current
) {
    const size_t name_length = strlen(name);
    const size_t contract_length = strlen(contract);
    const size_t current_length = current == NULL ? 0 : strlen(current);
    const size_t capacity = name_length + 1 + contract_length + current_length + 2;
    char *result = malloc(capacity);
    if (result == NULL) return NULL;
    int written = snprintf(result, capacity, "%s=%s", name, contract);
    if (written < 0 || (size_t)written >= capacity) {
        free(result);
        errno = EOVERFLOW;
        return NULL;
    }

    size_t used = (size_t)written;
    const char *cursor = current;
    while (cursor != NULL && *cursor != '\0') {
        const char *separator = strchr(cursor, ':');
        const size_t length = separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
        if (length > 0 && !adev_colon_contains(contract, cursor, length)) {
            if (used + length + 2 > capacity) {
                free(result);
                errno = EOVERFLOW;
                return NULL;
            }
            result[used++] = ':';
            memcpy(result + used, cursor, length);
            used += length;
            result[used] = '\0';
        }
        cursor = separator == NULL ? NULL : separator + 1;
    }
    return result;
}

static int adev_exec_env_apply_assignment(
    char ***values,
    size_t *count,
    size_t *capacity,
    char *line
) {
    char *separator = strchr(line, '=');
    if (separator == NULL) return 0;
    *separator = '\0';
    const char *name = line;
    const char *contract = separator + 1;
    if (name[0] == '\0' || contract[0] == '\0') return 0;

    const size_t found = adev_block_find(*values, *count, name);
    const char *current = found == SIZE_MAX ? NULL : strchr((*values)[found], '=') + 1;
    char *assignment = NULL;
    if (strcmp(name, "PATH") == 0 || strcmp(name, "LD_PRELOAD") == 0) {
        assignment = adev_merge_colon_assignment(
            name,
            contract,
            adev_is_stale(current) ? NULL : current
        );
    } else if (current == NULL || current[0] == '\0' || adev_is_stale(current)) {
        const size_t length = strlen(name) + strlen(contract) + 2;
        assignment = malloc(length);
        if (assignment != NULL) snprintf(assignment, length, "%s=%s", name, contract);
    } else {
        return 0;
    }
    if (assignment == NULL) return -1;

    if (found != SIZE_MAX) {
        free((*values)[found]);
        (*values)[found] = assignment;
        return 0;
    }
    if (*count + 1 >= *capacity) {
        size_t next_capacity = *capacity > 0 ? *capacity * 2 : 32;
        char **next = realloc(*values, next_capacity * sizeof(char *));
        if (next == NULL) {
            free(assignment);
            return -1;
        }
        *values = next;
        *capacity = next_capacity;
    }
    (*values)[(*count)++] = assignment;
    (*values)[*count] = NULL;
    return 0;
}

int adev_runtime_env_prepare_exec(
    char *const envp[],
    adev_runtime_exec_env *prepared
) {
    if (prepared == NULL) {
        errno = EINVAL;
        return -1;
    }
    prepared->values = (char **)envp;
    prepared->owned = 0;

    size_t count = 0;
    if (envp != NULL) {
        while (envp[count] != NULL && count < ADEV_ENV_MAX_ENTRIES) ++count;
        if (count == ADEV_ENV_MAX_ENTRIES) {
            errno = E2BIG;
            return -1;
        }
    }
    if (!adev_exec_env_needs_contract(envp, count)) return 0;

    char conf[PATH_MAX];
    if (!adev_locate_conf(conf)) return 0;
    size_t capacity = count + 32;
    char **values = calloc(capacity, sizeof(char *));
    if (values == NULL) return -1;
    for (size_t index = 0; index < count; ++index) {
        values[index] = strdup(envp[index]);
        if (values[index] == NULL) {
            adev_runtime_exec_env cleanup = {values, 1};
            adev_runtime_env_release_exec(&cleanup);
            return -1;
        }
    }
    values[count] = NULL;

    FILE *file = fopen(conf, "re");
    if (file == NULL) {
        adev_runtime_exec_env cleanup = {values, 1};
        adev_runtime_env_release_exec(&cleanup);
        return -1;
    }
    char line[ADEV_ENV_MAX_LINE];
    int result = 0;
    while (fgets(line, sizeof(line), file) != NULL) {
        size_t length = strlen(line);
        while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) {
            line[--length] = '\0';
        }
        if (length == 0 || line[0] == '#') continue;
        if (adev_exec_env_apply_assignment(&values, &count, &capacity, line) != 0) {
            result = -1;
            break;
        }
    }
    const int saved_errno = errno;
    fclose(file);
    if (result != 0) {
        adev_runtime_exec_env cleanup = {values, 1};
        adev_runtime_env_release_exec(&cleanup);
        errno = saved_errno;
        return -1;
    }
    prepared->values = values;
    prepared->owned = 1;
    return 0;
}

void adev_runtime_env_release_exec(adev_runtime_exec_env *prepared) {
    if (prepared == NULL || !prepared->owned || prepared->values == NULL) return;
    for (size_t index = 0; prepared->values[index] != NULL; ++index) {
        free(prepared->values[index]);
    }
    free(prepared->values);
    prepared->values = NULL;
    prepared->owned = 0;
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
