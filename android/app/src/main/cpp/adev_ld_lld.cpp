#include <cerrno>
#include <cstdio>
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

}  // namespace

int main(int argc, char** argv) {
    const std::string native_dir = executable_directory();
    if (native_dir.empty()) {
        std::fprintf(stderr, "ld.lld: cannot resolve APK native library directory: %s\n",
                     std::strerror(errno));
        return 71;
    }

    const std::string runtime = native_dir + "/libbin_lld.so";
    if (access(runtime.c_str(), X_OK) != 0) {
        std::fprintf(stderr, "ld.lld: Android LLD payload is unavailable: %s\n",
                     std::strerror(errno));
        return 69;
    }

    // The Termux package stores LLVM's multi-call driver as `lld`. Android APK
    // native libraries cannot retain its `ld.lld` symlink name, and the generic
    // driver refuses to choose a linker personality from `libbin_lld.so`.
    // Supply the Unix personality through argv[0], exactly as the upstream
    // ld.lld symlink would, while keeping both executables in nativeLibraryDir.
    std::vector<char*> forwarded;
    forwarded.reserve(static_cast<size_t>(argc) + 1);
    forwarded.push_back(const_cast<char*>("ld.lld"));
    for (int index = 1; index < argc; ++index) {
        forwarded.push_back(argv[index]);
    }
    forwarded.push_back(nullptr);

    execv(runtime.c_str(), forwarded.data());
    std::fprintf(stderr, "ld.lld: failed to launch Android runtime: %s\n",
                 std::strerror(errno));
    return errno == EACCES ? 126 : 71;
}
