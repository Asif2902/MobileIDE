#include "adev_opencode_version.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
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
#include <unistd.h>
#define ADEV_ACCESS access
#define ADEV_EXEC_ACCESS X_OK
#define ADEV_WRITABLE_DIRECTORY_MODE (W_OK | X_OK)
#define ADEV_REALPATH(path, output) realpath(path, output)
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

int launch_payload(int argc, char** argv) {
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
    if (ADEV_ACCESS(runtime.c_str(), ADEV_EXEC_ACCESS) != 0) {
        return unavailable("the Android runtime payload is not installed for this ABI.");
    }
    if (ADEV_ACCESS(tagfix.c_str(), 4) != 0 || ADEV_ACCESS(compat.c_str(), 4) != 0 ||
        ADEV_ACCESS(opentui.c_str(), 4) != 0) {
        return unavailable("one or more required Android compatibility libraries are missing.");
    }

    const char* home_value = std::getenv("HOME");
    const std::string home = absolute_path(home_value)
        ? canonical_private_directory(home_value)
        : std::string{};
    const std::string private_tmp = select_private_tmp();
    if (home.empty() || private_tmp.empty()) {
        return unavailable("HOME or the temporary directory is not writable app-private storage.");
    }

    const std::vector<std::pair<const char*, std::string>> environment = {
        {"ANDROID_ROOT", "/system"},
        {"TERMUX_VERSION", "adev-opencode"},
        {"OPENCODE_DISABLE_TUI_AUDIO", "1"},
        {"OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER", "true"},
        {"OPENTUI_LIB_PATH", opentui},
        {"ADEV_OPENCODE_TMPDIR", private_tmp},
        {"BUN_TMPDIR", private_tmp},
        {"SQLITE_TMPDIR", private_tmp},
        {"TMPDIR", private_tmp},
        {"TMP", private_tmp},
        {"TEMP", private_tmp},
        {"XDG_RUNTIME_DIR", private_tmp},
        {"XDG_DATA_HOME", join_path(home, ".local/share")},
        {"XDG_CONFIG_HOME", join_path(home, ".config")},
        {"XDG_CACHE_HOME", join_path(home, ".cache")},
        {"XDG_STATE_HOME", join_path(home, ".local/state")},
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
    if (!prepend_environment("LD_LIBRARY_PATH", {native_dir}) ||
        !prepend_environment("LD_PRELOAD", {tagfix, compat})) {
        std::fprintf(stderr, "opencode: cannot configure Android dynamic libraries: %s\n",
                     std::strerror(errno));
        return 71;
    }

    if (launcher_doctor_requested(argc, argv)) {
        std::printf(
            "launcher_version=%s\n"
            "payload=%s\n"
            "opentui=%s\n"
            "tagfix=%s\n"
            "compat=%s\n"
            "temp=%s\n"
            "home=%s\n",
            ADEV_OPENCODE_VERSION, runtime.c_str(), opentui.c_str(), tagfix.c_str(),
            compat.c_str(), private_tmp.c_str(), home.c_str());
        return 0;
    }

    std::vector<char*> forwarded;
    forwarded.reserve(static_cast<size_t>(argc) + 1);
    forwarded.push_back(const_cast<char*>(runtime.c_str()));
    for (int index = 1; index < argc; ++index) forwarded.push_back(argv[index]);
    forwarded.push_back(nullptr);

#ifdef _WIN32
    const intptr_t result = _spawnv(_P_WAIT, runtime.c_str(), forwarded.data());
    if (result >= 0) return static_cast<int>(result);
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
