#include "adev_opencode_version.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits.h>
#include <string>
#include <sys/stat.h>
#include <vector>

#ifdef _WIN32
#include <direct.h>
#include <io.h>
#ifndef PATH_MAX
#define PATH_MAX 4096
#endif
#define ADEV_ACCESS _access
#define ADEV_WRITABLE_DIRECTORY_MODE 2
#define ADEV_REALPATH(path, output) _fullpath(output, path, PATH_MAX)
#else
#include <unistd.h>
#define ADEV_ACCESS access
#define ADEV_WRITABLE_DIRECTORY_MODE (W_OK | X_OK)
#define ADEV_REALPATH(path, output) realpath(path, output)
#endif

namespace {

bool equals(const char* value, const char* expected) {
    return value != nullptr && std::strcmp(value, expected) == 0;
}

bool requested_help(int argc, char** argv) {
    if (argc == 1) {
        return false;
    }
    for (int index = 1; index < argc; ++index) {
        if (equals(argv[index], "--help") || equals(argv[index], "-h") ||
            equals(argv[index], "help")) {
            return true;
        }
    }
    return false;
}

bool requested_version(int argc, char** argv) {
    return argc == 2 && (equals(argv[1], "--version") || equals(argv[1], "-v"));
}

bool requested_debug_paths(int argc, char** argv) {
    return argc == 3 && equals(argv[1], "debug") && equals(argv[2], "paths");
}

int print_android_help() {
    std::fputs(
        "OpenCode for A Dev Studio (Android/Bionic capability build)\n\n"
        "Native diagnostics:\n"
        "  opencode --version  (or: opencode -v)\n"
        "  opencode --help\n"
        "  opencode debug paths\n\n"
        "Interactive, agent, run, serve, web, attach, provider, and tool modes are "
        "disabled on this build because the available upstream Android "
        "Bun/OpenTUI payloads abort in Bionic native code on a real ARM64 device.\n",
        stdout);
    return 0;
}

int print_version() {
    std::fputs(ADEV_OPENCODE_VERSION "\n", stdout);
    return 0;
}

int unsupported_mode() {
    std::fputs(
        "opencode: this mode is unavailable on the verified Android/Bionic runtime.\n"
        "The available upstream Android Bun/OpenTUI payloads abort in native code "
        "during interactive, agent, run, serve, and web startup. A Dev Studio blocks "
        "those crash paths. A Linux/glibc binary will not be substituted.\n"
        "Available native diagnostics: opencode --version, opencode --help, and "
        "opencode debug paths.\n",
        stderr);
    return 69;
}

bool writable_directory(const std::string& path) {
    if (path.empty() || path == "/tmp") {
        return false;
    }
    struct stat status {};
    return stat(path.c_str(), &status) == 0 && S_ISDIR(status.st_mode) &&
           ADEV_ACCESS(path.c_str(), ADEV_WRITABLE_DIRECTORY_MODE) == 0;
}

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
    // This branch exists only in the host-compiled launcher contract test. It
    // lets the same production path-validation code run under a temporary root.
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

std::string canonical_private_directory(const std::string& path) {
    if (!writable_directory(path)) {
        return {};
    }
    char resolved[PATH_MAX] = {};
    if (ADEV_REALPATH(path.c_str(), resolved) == nullptr) {
        return {};
    }
    const std::string canonical(resolved);
    // Android app-private credential-encrypted storage lives under one of
    // these UID-isolated roots. Reject shared/FUSE and /data/local/tmp even if
    // a caller injects a writable TMP or XDG variable.
    return is_android_private_path(canonical) ? canonical : std::string{};
}

bool absolute_path(const char* value) {
    if (value == nullptr || value[0] == '\0') {
        return false;
    }
#ifdef _WIN32
    return value[0] == '/' || value[0] == '\\' ||
           (std::strlen(value) > 2 && value[1] == ':');
#else
    return value[0] == '/';
#endif
}

void add_environment_candidate(std::vector<std::string>& candidates, const char* name) {
    const char* value = std::getenv(name);
    if (absolute_path(value)) {
        candidates.emplace_back(value);
    }
}

std::string join_path(const std::string& root, const char* suffix) {
    return root + (root.empty() || root.back() == '/' || root.back() == '\\' ? "" : "/") + suffix;
}

std::string select_private_tmp() {
    // Prefer paths from the Android runtime contract over generic TMPDIR. A
    // parent shell or third-party tool may reset TMPDIR to the FHS default
    // /tmp, which does not exist on Android and must never win here.
    std::vector<std::string> candidates;
    candidates.reserve(6);

    const char* prefix = std::getenv("PREFIX");
    if (absolute_path(prefix)) {
        candidates.emplace_back(join_path(prefix, "tmp"));
    }

    const char* data_dir = std::getenv("TERMUX_APP__DATA_DIR");
    if (absolute_path(data_dir)) {
        candidates.emplace_back(join_path(data_dir, "files/runtime/tmp"));
    }

    add_environment_candidate(candidates, "TERMUX__PREFIX__TMP_DIR");
    add_environment_candidate(candidates, "TMPDIR");
    add_environment_candidate(candidates, "BUN_TMPDIR");

    for (const std::string& candidate : candidates) {
        const std::string canonical = canonical_private_directory(candidate);
        if (!canonical.empty()) {
            return canonical;
        }
    }
    return {};
}

std::string private_xdg_path(const char* environment_name,
                             const std::string& canonical_home,
                             const char* default_suffix) {
    const char* configured = std::getenv(environment_name);
    if (absolute_path(configured)) {
        const std::string canonical = canonical_private_directory(configured);
        if (!canonical.empty()) {
            return canonical;
        }
    }
    return join_path(canonical_home, default_suffix);
}

int print_debug_paths() {
    const char* home = std::getenv("HOME");
    const std::string canonical_home = absolute_path(home)
        ? canonical_private_directory(home)
        : std::string{};
    if (canonical_home.empty()) {
        std::fputs(
            "opencode: HOME is not a writable Android app-private directory.\n",
            stderr);
        return 69;
    }

    const std::string private_tmp = select_private_tmp();
    if (private_tmp.empty()) {
        std::fputs(
            "opencode: no writable Android app-private temporary directory is available.\n",
            stderr);
        return 69;
    }

    const std::string data = private_xdg_path("XDG_DATA_HOME", canonical_home, ".local/share");
    const std::string config = private_xdg_path("XDG_CONFIG_HOME", canonical_home, ".config");
    const std::string cache = private_xdg_path("XDG_CACHE_HOME", canonical_home, ".cache");
    const std::string state = private_xdg_path("XDG_STATE_HOME", canonical_home, ".local/state");
    const std::string runtime = private_xdg_path("XDG_RUNTIME_DIR", canonical_home, ".runtime");

    std::printf(
        "home=%s\n"
        "xdg_data_home=%s\n"
        "xdg_config_home=%s\n"
        "xdg_cache_home=%s\n"
        "xdg_state_home=%s\n"
        "xdg_runtime_dir=%s\n"
        "temp=%s\n",
        canonical_home.c_str(), data.c_str(), config.c_str(), cache.c_str(), state.c_str(),
        runtime.c_str(), private_tmp.c_str());
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    // All supported diagnostics terminate in this launcher. They do not touch
    // the Bun/OpenCode payload and therefore cannot fall back to read-only /tmp.
    if (requested_help(argc, argv)) {
        return print_android_help();
    }
    if (requested_version(argc, argv)) {
        return print_version();
    }
    if (requested_debug_paths(argc, argv)) {
        return print_debug_paths();
    }
    return unsupported_mode();
}
