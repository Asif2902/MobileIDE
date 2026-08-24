#include "adev_opencode_version.h"

#ifndef ADEV_OPENCODE_HOST_TEST
#include "adev_runtime_env.h"
#endif

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <limits.h>
#include <string>
#include <sys/stat.h>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <direct.h>
#include <io.h>
#include <process.h>
#ifndef PATH_MAX
#define PATH_MAX 4096
#endif
#define ADEV_ACCESS _access
#define ADEV_EXEC_ACCESS 4
#define ADEV_WRITABLE_DIRECTORY_MODE 2
#define ADEV_REALPATH(path, output) _fullpath(output, path, PATH_MAX)
#else
#include <sys/syscall.h>
#include <unistd.h>
#define ADEV_ACCESS access
#define ADEV_EXEC_ACCESS X_OK
#define ADEV_WRITABLE_DIRECTORY_MODE (W_OK | X_OK)
#define ADEV_REALPATH(path, output) realpath(path, output)

extern char** environ;
#endif

namespace {

bool path_within(const std::string& path, const std::string& root) {
    if (root.empty() || path.size() < root.size() || path.compare(0, root.size(), root) != 0) {
        return false;
    }
    return path.size() == root.size() || path[root.size()] == '/' || path[root.size()] == '\\';
}

bool is_android_private_path(const std::string& canonical) {
    if (canonical.rfind("/data/user/", 0) == 0 || canonical.rfind("/data/data/", 0) == 0) {
        return true;
    }
#ifdef ADEV_OPENCODE_HOST_TEST
    const char* test_root = std::getenv("ADEV_OPENCODE_TEST_PRIVATE_ROOT");
    if (test_root != nullptr && test_root[0] != '\0') {
        char resolved[PATH_MAX] = {};
        if (ADEV_REALPATH(test_root, resolved) != nullptr && path_within(canonical, resolved)) {
            return true;
        }
    }
#endif
    return false;
}

bool writable_directory(const std::string& path) {
    if (path.empty() || path == "/tmp") return false;
    struct stat status {};
    return stat(path.c_str(), &status) == 0 && S_ISDIR(status.st_mode) &&
           ADEV_ACCESS(path.c_str(), ADEV_WRITABLE_DIRECTORY_MODE) == 0;
}

std::string canonical_private_directory(const std::string& path) {
    if (!writable_directory(path)) return {};
    char resolved[PATH_MAX] = {};
    if (ADEV_REALPATH(path.c_str(), resolved) == nullptr) return {};
    const std::string canonical(resolved);
    return is_android_private_path(canonical) ? canonical : std::string{};
}

bool absolute_path(const char* value) {
    if (value == nullptr || value[0] == '\0') return false;
#ifdef _WIN32
    return value[0] == '/' || value[0] == '\\' ||
           (std::strlen(value) > 2 && value[1] == ':');
#else
    return value[0] == '/';
#endif
}

std::string join_path(const std::string& root, const char* suffix) {
    return root + (root.empty() || root.back() == '/' || root.back() == '\\' ? "" : "/") + suffix;
}

void add_environment_candidate(std::vector<std::string>& candidates, const char* name) {
    const char* value = std::getenv(name);
    if (absolute_path(value)) candidates.emplace_back(value);
}

std::string select_private_tmp() {
    std::vector<std::string> candidates;
    candidates.reserve(6);
    const char* prefix = std::getenv("PREFIX");
    if (absolute_path(prefix)) candidates.emplace_back(join_path(prefix, "tmp"));
    const char* data_dir = std::getenv("TERMUX_APP__DATA_DIR");
    if (absolute_path(data_dir)) {
        candidates.emplace_back(join_path(data_dir, "files/runtime/tmp"));
    }
    add_environment_candidate(candidates, "TERMUX__PREFIX__TMP_DIR");
    add_environment_candidate(candidates, "TMPDIR");
    add_environment_candidate(candidates, "BUN_TMPDIR");
    for (const std::string& candidate : candidates) {
        const std::string canonical = canonical_private_directory(candidate);
        if (!canonical.empty()) return canonical;
    }
    return {};
}

std::string executable_directory() {
#ifdef ADEV_OPENCODE_HOST_TEST
    const char* override_path = std::getenv("ADEV_OPENCODE_TEST_NATIVE_DIR");
    if (absolute_path(override_path)) return override_path;
#endif
#ifdef _WIN32
    return {};
#else
    std::vector<char> buffer(4096);
    const ssize_t length = readlink("/proc/self/exe", buffer.data(), buffer.size() - 1);
    if (length <= 0) return {};
    buffer[static_cast<size_t>(length)] = '\0';
    std::string path(buffer.data());
    const auto separator = path.find_last_of('/');
    return separator == std::string::npos ? std::string{} : path.substr(0, separator);
#endif
}

bool set_environment(const char* name, const std::string& value) {
#ifdef _WIN32
    return _putenv_s(name, value.c_str()) == 0;
#else
    return setenv(name, value.c_str(), 1) == 0;
#endif
}

bool prepend_environment(const char* name, const std::vector<std::string>& values) {
    std::string combined;
    for (const std::string& value : values) {
        if (value.empty()) continue;
        if (!combined.empty()) combined.push_back(':');
        combined.append(value);
    }
    const char* existing = std::getenv(name);
    if (existing != nullptr && existing[0] != '\0') {
        if (!combined.empty()) combined.push_back(':');
        combined.append(existing);
    }
    return set_environment(name, combined);
}

int unavailable(const std::string& detail) {
    std::fprintf(
        stderr,
        "opencode: %s\n"
        "This build requires the pinned ARM64 Android/Bionic OpenCode payload; "
        "a Linux/glibc binary will not be substituted.\n",
        detail.c_str());
    return 69;
}

bool launcher_doctor_requested(int argc, char** argv) {
    return argc == 2 && std::strcmp(argv[1], "--adev-launcher-doctor") == 0;
}

bool runtime_environment_test_requested(int argc, char** argv) {
    if (argc < 2 || argc > 3 ||
        std::strcmp(argv[1], "--adev-runtime-env-test") != 0) {
        return false;
    }
    return argc == 2 || std::strcmp(argv[2], "--network") == 0;
}

int launch_payload(int argc, char** argv) {
#ifndef ADEV_OPENCODE_HOST_TEST
    // Restore the shared runtime environment contract first: HOME, PATH,
    // PREFIX, TMPDIR, the XDG base directories and the TLS trust store all come
    // from one place, and only the OpenCode-specific overrides below are set
    // here. Anything the launcher already inherited is left untouched.
    adev_runtime_env_apply();
#endif
    const std::string native_dir = executable_directory();
    if (native_dir.empty()) {
        std::fprintf(stderr, "opencode: cannot resolve APK native library directory: %s\n",
                     std::strerror(errno));
        return 71;
    }

    const std::string runtime = join_path(native_dir, "libbin_opencode_runtime.so");
    const std::string tagfix = join_path(native_dir, "liblib_opencode_tagfix.so");
    const std::string compat = join_path(native_dir, "liblib_adev_opencode_compat.so");
    const std::string opentui = join_path(native_dir, "liblib_opencode_opentui.so");
    const std::string ripgrep = join_path(native_dir, "libbin_rg.so");
    const std::string xdg_open = join_path(native_dir, "libbin_adev_xdg_open.so");
    const std::string shell_broker = join_path(native_dir, "libbin_adev_env.so");
    if (ADEV_ACCESS(runtime.c_str(), ADEV_EXEC_ACCESS) != 0) {
        return unavailable("the Android runtime payload is not installed for this ABI.");
    }
    if (ADEV_ACCESS(tagfix.c_str(), 4) != 0 || ADEV_ACCESS(compat.c_str(), 4) != 0 ||
        ADEV_ACCESS(opentui.c_str(), 4) != 0 || ADEV_ACCESS(ripgrep.c_str(), 4) != 0 ||
        ADEV_ACCESS(xdg_open.c_str(), ADEV_EXEC_ACCESS) != 0 ||
        ADEV_ACCESS(shell_broker.c_str(), ADEV_EXEC_ACCESS) != 0) {
        return unavailable("one or more required Android compatibility libraries are missing.");
    }

    const char* config_home_value = std::getenv("ADEV_CONFIG_HOME");
    if (!absolute_path(config_home_value)) config_home_value = std::getenv("HOME");
    const std::string config_home = absolute_path(config_home_value)
        ? canonical_private_directory(config_home_value)
        : std::string{};
    const char* workspace_home_value = std::getenv("MOBILEIDE_WORKSPACES");
    const std::string workspace_home = absolute_path(workspace_home_value)
        ? canonical_private_directory(workspace_home_value)
        : std::string{};
    const std::string private_tmp = select_private_tmp();
    // Capture the URL broker capability before setenv() grows/reallocates the
    // inherited environment. The Android Bun standalone only exposed values
    // explicitly refreshed by this launcher on affected devices, even though
    // the same inherited values were visible to the launcher and ADEV shell.
    // Copying first avoids retaining pointers that setenv() may invalidate.
    const char* url_opener_port_value = std::getenv("ADEV_URL_OPENER_PORT");
    const char* url_opener_session_value = std::getenv("ADEV_URL_OPENER_SESSION");
    const std::string url_opener_port =
        url_opener_port_value == nullptr ? std::string{} : url_opener_port_value;
    const std::string url_opener_session =
        url_opener_session_value == nullptr ? std::string{} : url_opener_session_value;
    if (config_home.empty() || workspace_home.empty() || private_tmp.empty()) {
        return unavailable(
            "the configuration home, workspace root, or temporary directory is not "
            "writable app-private storage.");
    }
    const std::vector<std::pair<const char*, std::string>> environment = {
        {"ANDROID_ROOT", "/system"},
        {"TERMUX_VERSION", "adev-opencode"},
        /*
         * OpenCode's web directory picker always starts from os.homedir() and
         * intentionally excludes directory symlinks. Report ADEV's canonical
         * private workspace root as the OpenCode process home so "Open project"
         * shows real projects. Keep configuration and caches rooted in ADEV's
         * separate configuration home through explicit variables below.
         */
        {"HOME", workspace_home},
        {"ADEV_CONFIG_HOME", config_home},
        {"GIT_CONFIG_GLOBAL", join_path(config_home, ".gitconfig")},
        /*
         * Keep shell identity separate from npm lifecycle dispatch. The native
         * spawn broker restores the ADEV contract before this Android shell
         * starts, and the inherited resolver handles writable CLI shebangs.
         */
        {"SHELL", "/system/bin/sh"},
        {"ADEV_PYTHON_SHELL", "/system/bin/sh"},
        {"ADEV_OPENCODE_SHELL", shell_broker},
        {"ADEV_OPENCODE_RG", ripgrep},
        {"ADEV_OPENCODE_XDG_OPEN", xdg_open},
        {"OPENCODE_DISABLE_TUI_AUDIO", "1"},
        {"OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER", "true"},
        {"OPENTUI_LIB_PATH", opentui},
        {"ADEV_OPENCODE_TMPDIR", private_tmp},
        {"BUN_TMPDIR", private_tmp},
        {"SQLITE_TMPDIR", private_tmp},
        {"TMPDIR", private_tmp},
        {"TMP", private_tmp},
        {"TEMP", private_tmp},
        /*
         * XDG_CACHE_HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME and
         * XDG_RUNTIME_DIR are deliberately absent: they belong to the shared
         * runtime environment contract (AdevEnvironment / adev-env.conf), which
         * adev_runtime_env_apply() has already restored above. Re-deriving them
         * here is what made OpenCode's children disagree with the terminal's
         * about where caches and configuration live.
         */
        {"BUN_SELF_EXE", runtime},
        {"TERMUX_EXEC__PROC_SELF_EXE", runtime},
    };
    for (const auto& entry : environment) {
        if (!set_environment(entry.first, entry.second)) {
            std::fprintf(stderr, "opencode: cannot set %s: %s\n", entry.first,
                         std::strerror(errno));
            return 71;
        }
    }
    if ((!url_opener_port.empty() &&
         !set_environment("ADEV_URL_OPENER_PORT", url_opener_port)) ||
        (!url_opener_session.empty() &&
         !set_environment("ADEV_URL_OPENER_SESSION", url_opener_session))) {
        std::fprintf(stderr, "opencode: cannot preserve Android URL broker capability: %s\n",
                     std::strerror(errno));
        return 71;
    }
    // Ensure the recursive shebang + termux-exec chain is present even if the
    // contract file is from an older install. The authoritative LD_PRELOAD is
    // now part of the shared runtime contract, but a just-upgraded payload may
    // still be launched with an old file on disk.
    std::vector<std::string> ldPreloadValues;
    ldPreloadValues.reserve(4);
    ldPreloadValues.push_back(tagfix);
    ldPreloadValues.push_back(compat);
    {
        std::string execCompat = join_path(native_dir, "liblib_adev_exec_compat.so");
        if (ADEV_ACCESS(execCompat.c_str(), 4) == 0) ldPreloadValues.push_back(execCompat);
        std::vector<std::string> termuxCandidates = {
            join_path(native_dir, "liblib_libtermux_exec_linker_ld_preload_so.so"),
            join_path(native_dir, "liblib_libtermux_exec_direct_ld_preload_so.so")
        };
        for (auto &c : termuxCandidates) if (ADEV_ACCESS(c.c_str(), 4) == 0) { ldPreloadValues.push_back(c); break; }
    }
    if (!prepend_environment("LD_LIBRARY_PATH", {native_dir}) ||
        !prepend_environment("LD_PRELOAD", ldPreloadValues)) {
        std::fprintf(stderr, "opencode: cannot configure Android dynamic libraries: %s\n",
                     std::strerror(errno));
        return 71;
    }
    // Fallback for upgrades where the contract file has not yet been rewritten
    // to include the Python toolchain. New installs are already covered by
    // adev_runtime_env_apply from the updated adev-env.conf.
    if (std::getenv("PYTHON") == nullptr || std::getenv("PYTHONHOME") == nullptr) {
        std::string runtimeRoot;
        if (!workspace_home.empty() && workspace_home.size() > 11 &&
            workspace_home.compare(workspace_home.size() - 11, 11, "/workspaces") == 0) {
            runtimeRoot = workspace_home.substr(0, workspace_home.size() - 11);
        } else if (!config_home.empty()) {
            // config_home is <runtime>/home/.config -> strip /home/.config
            const std::string suffix = "/home/.config";
            if (config_home.size() > suffix.size() &&
                config_home.compare(config_home.size() - suffix.size(), suffix.size(), suffix) == 0) {
                runtimeRoot = config_home.substr(0, config_home.size() - suffix.size());
            } else {
                size_t pos = config_home.find("/home");
                if (pos != std::string::npos) runtimeRoot = config_home.substr(0, pos);
            }
        }
        if (!runtimeRoot.empty()) {
            DIR* dir = opendir(native_dir.c_str());
            std::string pythonSo;
            if (dir != nullptr) {
                struct dirent* entry;
                while ((entry = readdir(dir)) != nullptr) {
                    std::string name(entry->d_name);
                    if (name.rfind("libbin_python", 0) == 0 && name.size() > 3 && name.substr(name.size() - 3) == ".so") {
                        if (pythonSo.empty() || name < pythonSo) pythonSo = name;
                    }
                }
                closedir(dir);
            }
            if (!pythonSo.empty()) {
                std::string pythonPath = join_path(native_dir, pythonSo.c_str());
                if (ADEV_ACCESS(pythonPath.c_str(), ADEV_EXEC_ACCESS) == 0) {
                    if (std::getenv("PYTHON") == nullptr) set_environment("PYTHON", pythonPath);
                    if (std::getenv("NODE_GYP_FORCE_PYTHON") == nullptr) set_environment("NODE_GYP_FORCE_PYTHON", pythonPath);
                    if (std::getenv("npm_package_config_node_gyp_python") == nullptr) set_environment("npm_package_config_node_gyp_python", pythonPath);
                    if (std::getenv("PYTHONHOME") == nullptr) set_environment("PYTHONHOME", runtimeRoot);
                    // best-effort PYTHONPATH: runtime/lib/python3.x
                    std::string libDir = join_path(runtimeRoot.c_str(), "lib");
                    DIR* lib = opendir(libDir.c_str());
                    std::string best;
                    if (lib != nullptr) {
                        struct dirent* e;
                        while ((e = readdir(lib)) != nullptr) {
                            std::string n(e->d_name);
                            if (n.rfind("python", 0) == 0) {
                                struct stat st{};
                                std::string cand = join_path(libDir.c_str(), n.c_str());
                                if (stat(cand.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {
                                    if (best.empty() || n > best) best = n;
                                }
                            }
                        }
                        closedir(lib);
                    }
                    if (!best.empty() && std::getenv("PYTHONPATH") == nullptr) {
                        set_environment("PYTHONPATH", join_path(libDir.c_str(), best.c_str()));
                    }
                }
            }
        }
    }

    if (launcher_doctor_requested(argc, argv)) {
        std::printf(
            "launcher_version=%s\n"
            "payload=%s\n"
            "opentui=%s\n"
            "tagfix=%s\n"
            "compat=%s\n"
            "ripgrep=%s\n"
            "xdg_open=%s\n"
            "shell_broker=%s\n"
            "url_opener_port=%s\n"
            "url_opener_session=%s\n"
            "temp=%s\n"
            "home=%s\n"
            "config_home=%s\n"
            "workspace_home=%s\n",
            ADEV_OPENCODE_VERSION, runtime.c_str(), opentui.c_str(), tagfix.c_str(),
            compat.c_str(), ripgrep.c_str(), xdg_open.c_str(), shell_broker.c_str(),
            url_opener_port.empty() ? "missing" : url_opener_port.c_str(),
            url_opener_session.empty() ? "missing" : "present", private_tmp.c_str(),
            workspace_home.c_str(), config_home.c_str(), workspace_home.c_str());
        return 0;
    }

    /*
     * Run the shipped contract suite after constructing the exact OpenCode
     * environment and preload order. This is intentionally a launcher
     * diagnostic rather than a second implementation of the contract: the
     * suite enters the packaged Node ELF with the same HOME, PATH, XDG, TLS,
     * Python and LD_PRELOAD values that the Bun/OpenCode payload hands to its
     * tools. It gives instrumentation and developers a provider-independent
     * way to certify raw child_process behaviour.
     */
    if (runtime_environment_test_requested(argc, argv)) {
        const char* runtime_root_value = std::getenv("ADEV_RUNTIME");
        if (!absolute_path(runtime_root_value)) runtime_root_value = std::getenv("PREFIX");
        const std::string runtime_root = absolute_path(runtime_root_value)
            ? canonical_private_directory(runtime_root_value)
            : std::string{};
        const std::string node = join_path(native_dir, "libbin_node.so");
        const std::string suite = join_path(runtime_root, "lib/adev-runtime-env-test.js");
        if (runtime_root.empty() || ADEV_ACCESS(node.c_str(), ADEV_EXEC_ACCESS) != 0 ||
            ADEV_ACCESS(suite.c_str(), 4) != 0) {
            return unavailable("the runtime environment test dependencies are missing.");
        }
        std::vector<char*> test_arguments = {
            const_cast<char*>(node.c_str()),
            const_cast<char*>(suite.c_str()),
        };
        if (argc == 3) test_arguments.push_back(argv[2]);
        test_arguments.push_back(nullptr);
#ifdef _WIN32
        const intptr_t result = _spawnv(_P_WAIT, node.c_str(), test_arguments.data());
        if (result >= 0) return static_cast<int>(result);
#elif defined(__ANDROID__) && defined(SYS_execve)
        syscall(SYS_execve, node.c_str(), test_arguments.data(), environ);
#else
        execv(node.c_str(), test_arguments.data());
#endif
        std::fprintf(stderr, "opencode: failed to launch runtime environment suite: %s\n",
                     std::strerror(errno));
        return errno == EACCES ? 126 : 71;
    }

    std::vector<char*> forwarded;
    forwarded.reserve(static_cast<size_t>(argc) + 1);
    forwarded.push_back(const_cast<char*>(runtime.c_str()));
    for (int index = 1; index < argc; ++index) forwarded.push_back(argv[index]);
    forwarded.push_back(nullptr);

#ifdef _WIN32
    const intptr_t result = _spawnv(_P_WAIT, runtime.c_str(), forwarded.data());
    if (result >= 0) return static_cast<int>(result);
#elif defined(__ANDROID__) && defined(SYS_execve)
    /*
     * The launcher itself inherits ADEV's generic exec compatibility preloads.
     * Calling execv() here lets that generic layer rewrite the already-valid
     * APK-native OpenCode PIE. On affected Android builds the rewrite reaches
     * Bun but drops the launcher-added OpenCode preload, so Bun's literal
     * mkdir("/tmp") bypasses our private-temp mapping. This payload is a pinned,
     * verified Android/Bionic executable in the APK native-library directory;
     * enter it directly and let the fresh Android linker load the complete
     * LD_PRELOAD value assembled above.
     */
    syscall(SYS_execve, runtime.c_str(), forwarded.data(), environ);
#else
    execv(runtime.c_str(), forwarded.data());
#endif
    std::fprintf(stderr, "opencode: failed to launch Android runtime: %s\n", std::strerror(errno));
    return errno == EACCES ? 126 : 71;
}

}  // namespace

int main(int argc, char** argv) {
    return launch_payload(argc, argv);
}
