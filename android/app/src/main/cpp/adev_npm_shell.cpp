/*
 * adev-npm-shell — npm/lifecycle script shell for Android noexec app data.
 *
 * npm runs lifecycle as:  $script_shell -c "<command>"
 * Under Android 10+ filesDir is noexec, so `sh -c node-gyp-build` dies with
 * "Permission denied" when sh tries to exec the JS shim in node_modules/.bin.
 *
 * This helper:
 *  1. Parses simple -c commands
 *  2. If the first token is a JS CLI (shebang node / .js/.mjs/.cjs), runs it
 *     via the bundled `node` ELF (which lives in the exec-permitted jniLibs dir)
 *  3. Dispatches node-gyp through npm's real JS entrypoint
 *  4. Dispatches Next.js through the Android WASM/webpack launcher
 *  5. Otherwise falls back to bundled bash (or /system/bin/sh)
 *
 * Also usable as a general "run this PATH command via node if needed" shell.
 */

#include <android/log.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define LOG_TAG "adev-npm-shell"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

static char g_node_path[PATH_MAX];

static int file_exists(const char *p) {
    struct stat st;
    return p && p[0] && stat(p, &st) == 0 && S_ISREG(st.st_mode);
}

/** Resolve node: prefer nativeLibraryDir ELF (exec-safe on Android 10+). */
static void resolve_node() {
    g_node_path[0] = '\0';
    // 1) Explicit native lib dir (always exec-permitted)
    const char *nlib = getenv("MOBILEIDE_NATIVE_LIB");
    if (nlib && nlib[0]) {
        snprintf(g_node_path, sizeof(g_node_path), "%s/libbin_node.so", nlib);
        if (file_exists(g_node_path)) return;
    }
    // 2) LD_LIBRARY_PATH entries (often includes nativeLibraryDir)
    const char *ld = getenv("LD_LIBRARY_PATH");
    if (ld) {
        char buf[PATH_MAX * 2];
        strncpy(buf, ld, sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = '\0';
        for (char *tok = strtok(buf, ":"); tok; tok = strtok(nullptr, ":")) {
            snprintf(g_node_path, sizeof(g_node_path), "%s/libbin_node.so", tok);
            if (file_exists(g_node_path)) return;
        }
    }
    // 3) PREFIX/bin/node symlink (may be noexec — last resort for non-Android)
    const char *prefix = getenv("PREFIX");
    if (prefix && prefix[0]) {
        snprintf(g_node_path, sizeof(g_node_path), "%s/bin/node", prefix);
        if (file_exists(g_node_path)) return;
    }
    strncpy(g_node_path, "node", sizeof(g_node_path) - 1);
}

static int looks_like_js_file(const char *path) {
    size_t n = strlen(path);
    if (n > 3 && strcmp(path + n - 3, ".js") == 0) return 1;
    if (n > 4 && strcmp(path + n - 4, ".mjs") == 0) return 1;
    if (n > 4 && strcmp(path + n - 4, ".cjs") == 0) return 1;
    // Shebang check
    int fd = open(path, O_RDONLY);
    if (fd < 0) return 0;
    char head[128];
    ssize_t r = read(fd, head, sizeof(head) - 1);
    close(fd);
    if (r < 2 || head[0] != '#' || head[1] != '!') return 0;
    head[r] = '\0';
    // #!/usr/bin/env node  or  #!/path/node
    if (strstr(head, "node") != nullptr) return 1;
    return 0;
}

/** Find command in PATH; writes into out (PATH_MAX). Returns 1 if found. */
static int which(const char *cmd, char *out, size_t outsz) {
    if (!cmd || !cmd[0]) return 0;
    if (strchr(cmd, '/')) {
        if (file_exists(cmd)) {
            strncpy(out, cmd, outsz - 1);
            out[outsz - 1] = '\0';
            return 1;
        }
        return 0;
    }
    const char *path = getenv("PATH");
    if (!path) return 0;
    char buf[PATH_MAX * 4];
    strncpy(buf, path, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';
    for (char *tok = strtok(buf, ":"); tok; tok = strtok(nullptr, ":")) {
        snprintf(out, outsz, "%s/%s", tok, cmd);
        if (file_exists(out)) return 1;
    }
    return 0;
}

/**
 * Split a simple command into argv-like parts (max ~64 tokens).
 * Handles basic quotes "..." and '...'
 */
static int tokenize(char *cmd, char **argv, int maxv) {
    int n = 0;
    char *p = cmd;
    while (*p && n < maxv - 1) {
        while (*p && isspace((unsigned char)*p)) p++;
        if (!*p) break;
        if (*p == '"' || *p == '\'') {
            char q = *p++;
            argv[n++] = p;
            while (*p && *p != q) p++;
            if (*p) *p++ = '\0';
        } else {
            argv[n++] = p;
            while (*p && !isspace((unsigned char)*p)) p++;
            if (*p) *p++ = '\0';
        }
    }
    argv[n] = nullptr;
    return n;
}

/** Try to run argv via node if first arg is a JS CLI. Returns if exec succeeds (never returns). */
static void try_node_exec(char **argv) {
    if (!argv[0]) return;
    char resolved[PATH_MAX];
    const char *script = argv[0];
    if (!strchr(script, '/')) {
        if (!which(script, resolved, sizeof(resolved))) return;
        script = resolved;
    } else if (!file_exists(script)) {
        return;
    }
    if (!looks_like_js_file(script)) return;

    resolve_node();
    // Build new argv: node script rest...
    char *nargv[64];
    int i = 0;
    nargv[i++] = g_node_path;
    nargv[i++] = (char *)script;
    for (int j = 1; argv[j] && i < 62; j++) {
        nargv[i++] = argv[j];
    }
    nargv[i] = nullptr;
    LOGI("node-exec: %s %s", g_node_path, script);
    execv(g_node_path, nargv);
    // If relative name
    execvp(g_node_path, nargv);
    LOGE("exec node failed: %s", strerror(errno));
}

/**
 * For commands like:  node ./postinstall.mjs
 * already starts with node — run via resolved node path (filesDir node is a symlink).
 */
static void try_direct_node(char **argv) {
    if (!argv[0]) return;
    const char *base = strrchr(argv[0], '/');
    base = base ? base + 1 : argv[0];
    if (strcmp(base, "node") != 0) return;
    resolve_node();
    argv[0] = g_node_path;
    execv(g_node_path, argv);
    execvp("node", argv);
}

/**
 * npm and node-pre-gyp intentionally spawn a command named `node-gyp`.
 * npm puts a POSIX shell shim in PATH, which Android refuses to exec from the
 * writable app-data directory. Dispatch the command to npm's real JS entrypoint
 * through the native Node ELF. This is node-gyp-wide, not package-specific.
 */
static void try_node_gyp_exec(char **argv) {
    if (!argv[0]) return;
    const char *base = strrchr(argv[0], '/');
    base = base ? base + 1 : argv[0];
    if (strcmp(base, "node-gyp") != 0 && strcmp(base, "node-gyp.js") != 0) return;

    const char *node_gyp = getenv("npm_config_node_gyp");
    if (!node_gyp || !node_gyp[0]) node_gyp = getenv("NPM_CONFIG_NODE_GYP");

    char fallback[PATH_MAX];
    if ((!node_gyp || !node_gyp[0])) {
        const char *prefix = getenv("PREFIX");
        if (prefix && prefix[0]) {
            snprintf(
                fallback,
                sizeof(fallback),
                "%s/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js",
                prefix
            );
            if (file_exists(fallback)) node_gyp = fallback;
        }
    }
    if (!node_gyp || !node_gyp[0] || !file_exists(node_gyp)) return;

    resolve_node();
    char *nargv[64];
    int i = 0;
    nargv[i++] = g_node_path;
    nargv[i++] = (char *)node_gyp;
    for (int j = 1; argv[j] && i < 62; j++) nargv[i++] = argv[j];
    nargv[i] = nullptr;

    LOGI("node-gyp dispatch: %s %s", g_node_path, node_gyp);
    execv(g_node_path, nargv);
    execvp(g_node_path, nargv);
    LOGE("exec node-gyp failed: %s", strerror(errno));
}

/**
 * npm normally resolves `next` to node_modules/.bin/next before project PATH.
 * Route that command through the platform launcher without changing the user's
 * package.json, lockfile, or node_modules.
 */
static void try_next_exec(char **argv) {
    if (!argv[0]) return;
    const char *base = strrchr(argv[0], '/');
    base = base ? base + 1 : argv[0];
    if (strcmp(base, "next") != 0) return;

    const char *launcher = getenv("ADEV_NEXT_LAUNCHER");
    if (!launcher || !launcher[0] || !file_exists(launcher)) return;

    resolve_node();
    char *nargv[64];
    int i = 0;
    nargv[i++] = g_node_path;
    nargv[i++] = (char *)launcher;
    for (int j = 1; argv[j] && i < 62; j++) nargv[i++] = argv[j];
    nargv[i] = nullptr;

    LOGI("next dispatch: %s %s", g_node_path, launcher);
    execv(g_node_path, nargv);
    execvp(g_node_path, nargv);
    LOGE("exec next launcher failed: %s", strerror(errno));
}

static void run_system_sh(const char *command) {
    // Prefer bundled bash: BASH_ENV loads the platform wrappers (including
    // node-gyp) for compound lifecycle commands such as `prebuild || node-gyp`.
    const char *sh = getenv("MOBILEIDE_BASH");
    if (!sh || !sh[0] || !file_exists(sh)) sh = "/system/bin/sh";
    char *const argv[] = {(char *)sh, (char *)"-c", (char *)command, nullptr};
    execv(sh, argv);
    execl("/system/bin/sh", "/system/bin/sh", "-c", command, (char *)nullptr);
    LOGE("fallback sh failed: %s", strerror(errno));
    _exit(127);
}

/**
 * Handle compound commands with && by rewriting simple leading JS bins.
 * Strategy: if command has no shell metacharacters except simple args, tokenize
 * and try node. Otherwise rewrite PATH-leading simple name: use a subshell
 * with a function — too hard. For metacharacters, prepend a helper:
 *   command  →  still use sh, but export a shell function wrapper via env? no.
 *
 * For "node-gyp-build" simple command — node path works.
 * For "node ./postinstall.mjs" — try_direct_node works.
 * For "cd x && node-gyp-build" — fall back to sh; user still hits noexec.
 *
 * Mitigate: replace bare bin names in simple `cmd args` only; for `&&` split
 * and wrap each simple stage is too fragile. Instead install BASH_ENV style
 * is for bash. For npm, lifecycle scripts are usually simple single commands.
 */
static int has_shell_meta(const char *s) {
    // Keep it conservative: if complex, use system sh (termux-exec may help).
    return strpbrk(s, "&|;<>(){}`$") != nullptr;
}

int main(int argc, char **argv) {
    // Support: adev-npm-shell -c "cmd"   OR   adev-npm-shell cmd args...
    const char *command = nullptr;
    char *owned = nullptr;

    if (argc >= 3 && strcmp(argv[1], "-c") == 0) {
        command = argv[2];
    } else if (argc >= 2) {
        // Join remaining args into a command string for tokenization path
        size_t len = 0;
        for (int i = 1; i < argc; i++) len += strlen(argv[i]) + 1;
        owned = (char *)malloc(len + 1);
        owned[0] = '\0';
        for (int i = 1; i < argc; i++) {
            if (i > 1) strcat(owned, " ");
            strcat(owned, argv[i]);
        }
        command = owned;
    } else {
        fprintf(stderr, "usage: adev-npm-shell -c <command>\n");
        return 2;
    }

    if (!command || !command[0]) {
        free(owned);
        return 0;
    }

    // Always try to resolve node early for MOBILEIDE_NATIVE_LIB from env.
    const char *nlib = getenv("LD_LIBRARY_PATH");
    (void)nlib;

    if (!has_shell_meta(command)) {
        char *copy = strdup(command);
        char *v[64];
        int n = tokenize(copy, v, 64);
        if (n > 0) {
            try_node_gyp_exec(v);
            try_next_exec(v);
            try_direct_node(v);
            try_node_exec(v);
        }
        free(copy);
    } else {
        // For compound scripts, try to rewrite leading "node " to absolute node
        // so postinstall `node ./postinstall.mjs` works under noexec shims.
        if (strncmp(command, "node ", 5) == 0 || strncmp(command, "node\t", 5) == 0) {
            resolve_node();
            char *copy = strdup(command);
            char *v[64];
            int n = tokenize(copy, v, 64);
            if (n > 0) {
                v[0] = g_node_path;
                execv(g_node_path, v);
            }
            free(copy);
        }
    }

    // Fallback: system shell (with LD_PRELOAD=termux-exec from parent env if set)
    run_system_sh(command);
    free(owned);
    return 127;
}
