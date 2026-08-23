#include "adev_runtime_env.h"

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
    // Restore the ADEV runtime contract when this tool was reached without one.
    adev_runtime_env_apply();
    const std::string native_dir = executable_directory();
    if (native_dir.empty()) {
        std::fprintf(stderr, "busybox: cannot resolve APK native library directory: %s\n",
                     std::strerror(errno));
        return 71;
    }

    const std::string runtime = native_dir + "/libbin_busybox.so";
    if (access(runtime.c_str(), X_OK) != 0) {
        std::fprintf(stderr, "busybox: Android runtime payload is unavailable: %s\n",
                     std::strerror(errno));
        return 69;
    }

    // This Termux-derived BusyBox dispatches from argv[0]. AGP must rename the
    // ELF to libbin_busybox.so, so invoking it as `libbin_busybox.so vi` makes
    // it search for a nonexistent applet named "libbin_busybox.so". Accept the
    // requested applet as argv[1], then exec the payload with that applet as
    // argv[0]. For `busybox`, `busybox --help`, and `busybox --list`, retain
    // argv[0]="busybox" so BusyBox's own multicall control interface works.
    const bool control_mode =
        argc < 2 || argv[1] == nullptr || argv[1][0] == '\0' || argv[1][0] == '-';
    const bool android_w = !control_mode && std::strcmp(argv[1], "w") == 0;
    if (android_w && argc > 2) {
        std::fputs(
            "w: options are unavailable in the Android compatibility view; run ps or uptime directly.\n",
            stderr);
        return 64;
    }
    if (android_w) {
        // Android app UIDs cannot read the utmp login database used by a full
        // Linux `w`. Keep the familiar command useful and deterministic by
        // exposing the part Android can provide, with an explicit boundary.
        std::fputs(
            "w: Android does not expose system login sessions to app UIDs; showing uptime.\n",
            stderr);
    }

    std::vector<char*> forwarded;
    forwarded.reserve(static_cast<size_t>(argc) + 1);
    forwarded.push_back(
        const_cast<char*>(control_mode ? "busybox" : (android_w ? "uptime" : argv[1])));
    for (int index = control_mode ? 1 : 2; index < argc; ++index) {
        forwarded.push_back(argv[index]);
    }
    forwarded.push_back(nullptr);

    execv(runtime.c_str(), forwarded.data());
    std::fprintf(stderr, "busybox: failed to launch applet '%s': %s\n",
                 control_mode ? "busybox" : (android_w ? "uptime" : argv[1]),
                 std::strerror(errno));
    return errno == EACCES ? 126 : 71;
}
