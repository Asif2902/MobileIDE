#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace {

std::string executable_directory() {
    std::vector<char> buffer(4096);
    const ssize_t length = readlink("/proc/self/exe", buffer.data(), buffer.size() - 1);
    if (length <= 0) {
        return {};
    }
    buffer[static_cast<size_t>(length)] = '\0';
    std::string path(buffer.data());
    const auto separator = path.find_last_of('/');
    return separator == std::string::npos ? std::string{} : path.substr(0, separator);
}

void prepend_environment(const char* name, const std::string& value) {
    const char* existing = std::getenv(name);
    std::string combined = value;
    if (existing != nullptr && existing[0] != '\0') {
        combined.append(":").append(existing);
    }
    setenv(name, combined.c_str(), 1);
}

int unavailable(const std::string& detail) {
    std::fprintf(
        stderr,
        "opencode: %s\n"
        "This build requires the verified ARM64 Android/Bionic OpenCode payload. "
        "A Linux/glibc binary will not be substituted.\n",
        detail.c_str());
    return 69;
}

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
        "Verified commands:\n"
        "  opencode --version  (or: opencode -v)\n"
        "  opencode --help\n"
        "  opencode debug paths\n\n"
        "Interactive, agent, run, serve, web, and attach modes are disabled on this "
        "build because the available upstream Android Bun/OpenTUI payloads abort in "
        "Bionic native code on a real ARM64 device.\n",
        stdout);
    return 0;
}

int unsupported_mode() {
    std::fputs(
        "opencode: this mode is unavailable on the verified Android/Bionic runtime.\n"
        "The available upstream Android Bun/OpenTUI payloads abort in native code "
        "during interactive, agent, run, serve, and web startup. A Dev Studio blocks "
        "those crash paths instead of installing an incompatible Linux/glibc binary.\n"
        "Available diagnostics: opencode --version, opencode --help, and "
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
           access(path.c_str(), W_OK | X_OK) == 0;
}

std::string canonical_private_directory(const std::string& path) {
    if (!writable_directory(path)) {
        return {};
    }
    char resolved[PATH_MAX] = {};
    if (realpath(path.c_str(), resolved) == nullptr) {
        return {};
    }
    const std::string canonical(resolved);
    // Android app-private credential-encrypted storage lives under one of
    // these UID-isolated roots. Reject shared/FUSE and /data/local/tmp even if
    // a caller injects a writable TERMUX__/TMP variable.
    if (canonical.rfind("/data/user/", 0) != 0 &&
        canonical.rfind("/data/data/", 0) != 0) {
        return {};
    }
    return canonical;
}

void add_environment_candidate(std::vector<std::string>& candidates, const char* name) {
    const char* value = std::getenv(name);
    if (value != nullptr && value[0] == '/') {
        candidates.emplace_back(value);
    }
}

std::string select_private_tmp() {
    // Prefer paths from the Android runtime contract over generic TMPDIR. A
    // parent shell or third-party tool may reset TMPDIR to the FHS default
    // /tmp, which does not exist on Android and must never win here.
    std::vector<std::string> candidates;
    candidates.reserve(6);

    const char* prefix = std::getenv("PREFIX");
    if (prefix != nullptr && prefix[0] == '/') {
        candidates.emplace_back(std::string(prefix) + "/tmp");
    }

    const char* data_dir = std::getenv("TERMUX_APP__DATA_DIR");
    if (data_dir != nullptr && data_dir[0] == '/') {
        candidates.emplace_back(std::string(data_dir) + "/files/runtime/tmp");
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

}  // namespace

int main(int argc, char** argv) {
    if (requested_help(argc, argv)) {
        return print_android_help();
    }
    if (!requested_version(argc, argv) && !requested_debug_paths(argc, argv)) {
        return unsupported_mode();
    }

    const std::string native_dir = executable_directory();
    if (native_dir.empty()) {
        std::fprintf(stderr, "opencode: cannot resolve APK native library directory: %s\n",
                     std::strerror(errno));
        return 71;
    }

    const std::string runtime = native_dir + "/libbin_opencode_runtime.so";
    const std::string tagfix = native_dir + "/liblib_opencode_tagfix.so";
    const std::string opentui = native_dir + "/liblib_opencode_opentui.so";

    if (access(runtime.c_str(), X_OK) != 0) {
        return unavailable("Android runtime payload is not installed for this ABI.");
    }
    if (access(tagfix.c_str(), R_OK) != 0 || access(opentui.c_str(), R_OK) != 0) {
        return unavailable("required Android native libraries are missing.");
    }

    // These values are Android runtime invariants. Overwrite inherited empty
    // or Linux-host values instead of allowing them to poison Bun's platform
    // and path detection.
    setenv("ANDROID_ROOT", "/system", 1);
    setenv("TERMUX_VERSION", "adev-opencode", 1);
    setenv("OPENCODE_DISABLE_TUI_AUDIO", "1", 0);
    setenv("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER", "true", 0);
    setenv("OPENTUI_LIB_PATH", opentui.c_str(), 1);

    // Bun's node:os implementation resolves TMPDIR/TMP/TEMP and otherwise
    // falls back to /tmp. The Android Bun port also consumes BUN_TMPDIR. Set
    // every spelling before exec so native Bun startup and bundled OpenCode
    // JavaScript resolve the same writable app-private directory.
    const std::string private_tmp = select_private_tmp();
    if (private_tmp.empty()) {
        return unavailable("a writable app-private temporary directory is unavailable.");
    }
    setenv("BUN_TMPDIR", private_tmp.c_str(), 1);
    setenv("SQLITE_TMPDIR", private_tmp.c_str(), 1);
    setenv("TMPDIR", private_tmp.c_str(), 1);
    setenv("TMP", private_tmp.c_str(), 1);
    setenv("TEMP", private_tmp.c_str(), 1);
    setenv("XDG_RUNTIME_DIR", private_tmp.c_str(), 1);

    // The Android Bun standalone loader cannot rely on /proc/self/exe: launch
    // layers may execute the payload through /system/bin/linker64, in which
    // case /proc/self/exe identifies the linker and the embedded OpenCode
    // module graph is not found. The pinned Android payload recognizes both
    // explicit real-executable contracts.
    setenv("BUN_SELF_EXE", runtime.c_str(), 1);
    setenv("TERMUX_EXEC__PROC_SELF_EXE", runtime.c_str(), 1);

    prepend_environment("LD_LIBRARY_PATH", native_dir);
    prepend_environment("LD_PRELOAD", tagfix);

    std::vector<char*> forwarded;
    forwarded.reserve(static_cast<size_t>(argc) + 1);
    forwarded.push_back(const_cast<char*>(runtime.c_str()));
    for (int index = 1; index < argc; ++index) {
        // The Android payload verifies `--version` without initializing the
        // unsupported TUI stack. Its upstream short `-v` parsing enters full
        // startup first and falls back to read-only /tmp. Normalize the alias
        // at the native capability boundary instead of exposing that crash.
        if (index == 1 && requested_version(argc, argv) && equals(argv[index], "-v")) {
            forwarded.push_back(const_cast<char*>("--version"));
        } else {
            forwarded.push_back(argv[index]);
        }
    }
    forwarded.push_back(nullptr);

    execv(runtime.c_str(), forwarded.data());
    std::fprintf(stderr, "opencode: failed to launch Android runtime: %s\n", std::strerror(errno));
    return errno == EACCES ? 126 : 71;
}
