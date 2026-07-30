#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
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

}  // namespace

int main(int argc, char** argv) {
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

    setenv("ANDROID_ROOT", "/system", 0);
    setenv("TERMUX_VERSION", "adev-opencode", 0);
    setenv("OPENCODE_DISABLE_TUI_AUDIO", "1", 0);
    setenv("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER", "true", 0);
    setenv("OPENTUI_LIB_PATH", opentui.c_str(), 1);

    // Android has no writable FHS /tmp. Bun uses BUN_TMPDIR for its native
    // startup/cache path; setting only TMPDIR is insufficient for this port.
    const char* inherited_tmp = std::getenv("TMPDIR");
    if (inherited_tmp == nullptr || inherited_tmp[0] == '\0') {
        inherited_tmp = std::getenv("TERMUX__PREFIX__TMP_DIR");
    }
    if (inherited_tmp == nullptr || inherited_tmp[0] == '\0' ||
        access(inherited_tmp, W_OK) != 0) {
        return unavailable("a writable app-private temporary directory is unavailable.");
    }
    setenv("BUN_TMPDIR", inherited_tmp, 1);
    setenv("SQLITE_TMPDIR", inherited_tmp, 1);
    setenv("TMPDIR", inherited_tmp, 1);
    setenv("TMP", inherited_tmp, 1);
    setenv("TEMP", inherited_tmp, 1);

    prepend_environment("LD_LIBRARY_PATH", native_dir);
    prepend_environment("LD_PRELOAD", tagfix);

    std::vector<char*> forwarded;
    forwarded.reserve(static_cast<size_t>(argc) + 1);
    forwarded.push_back(const_cast<char*>(runtime.c_str()));
    for (int index = 1; index < argc; ++index) {
        forwarded.push_back(argv[index]);
    }
    forwarded.push_back(nullptr);

    execv(runtime.c_str(), forwarded.data());
    std::fprintf(stderr, "opencode: failed to launch Android runtime: %s\n", std::strerror(errno));
    return errno == EACCES ? 126 : 71;
}
