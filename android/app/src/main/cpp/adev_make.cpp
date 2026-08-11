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

}  // namespace

int main(int argc, char** argv) {
    const std::string native_dir = executable_directory();
    if (native_dir.empty()) {
        std::fprintf(stderr, "make: cannot resolve APK native library directory: %s\n",
                     std::strerror(errno));
        return 71;
    }

    const std::string runtime = native_dir + "/libbin_make.so";
    if (access(runtime.c_str(), X_OK) != 0) {
        std::fprintf(stderr, "make: Android runtime payload is unavailable: %s\n",
                     std::strerror(errno));
        return 69;
    }

    // Termux GNU Make has /data/data/com.termux/files/usr/bin/sh compiled as
    // its default shell. Do not point SHELL at libbin_bash.so here:
    //
    //  * GNU Make only recognizes exact Bourne-shell basenames (sh, bash,
    //    dash, ...), so "libbin_bash.so" takes its non-POSIX slow path.
    //  * Android APK install directories contain '=' characters. Make's slow
    //    command parser treats an '=' in the first word as an assignment and
    //    eventually falls back to its compiled Termux default shell.
    //
    // /system/bin/sh is an Android-native POSIX shell with a recognized
    // basename. A command-line assignment has higher precedence than the
    // compiled default and propagates to recursive $(MAKE) invocations.
    // Append it after caller arguments so another SHELL= value cannot
    // reintroduce an inaccessible Linux/Termux path.
    constexpr const char* shell = "/system/bin/sh";
    const std::string shell_assignment = std::string("SHELL=") + shell;
    setenv("SHELL", shell, 1);
    setenv("CONFIG_SHELL", shell, 1);

    std::vector<char*> forwarded;
    forwarded.reserve(static_cast<size_t>(argc) + 2);
    forwarded.push_back(const_cast<char*>(runtime.c_str()));
    for (int index = 1; index < argc; ++index) {
        forwarded.push_back(argv[index]);
    }
    forwarded.push_back(const_cast<char*>(shell_assignment.c_str()));
    forwarded.push_back(nullptr);

    execv(runtime.c_str(), forwarded.data());
    std::fprintf(stderr, "make: failed to launch Android runtime: %s\n", std::strerror(errno));
    return errno == EACCES ? 126 : 71;
}
