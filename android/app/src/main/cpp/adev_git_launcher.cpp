/*
 * APK-native Git entrypoint for foreign processes.
 *
 * Interactive ADEV shells run Git through a shell function and a guarded
 * trampoline under <runtime>/bin. Both live on Android's noexec app storage,
 * so an external executable that resolves `git` through PATH — GitHub CLI,
 * any Go program doing fork/exec without a shell — fails with EACCES before
 * a shebang is ever considered.
 *
 * This launcher is packaged as libbin_adev_git_launcher.so inside the APK
 * library directory (the only exec-permitted app location) and symlinked into
 * the shim directory that leads PATH. It applies the same shared-storage
 * workspace guard as the interactive shells, restores the runtime contract if
 * the parent process lost it, then execs the bundled Git ELF in place.
 */

#include "adev_runtime_env.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unistd.h>
#include <vector>

namespace {

constexpr const char* kGitPayload = "/libbin_git.so";

/* Same physical prefixes the shell guard treats as Android shared storage. */
bool is_shared_storage(const std::string& directory) {
    static const char* prefixes[] = {
        "/storage/", "/sdcard/", "/mnt/media_rw/", "/mnt/runtime/"
    };
    for (const char* prefix : prefixes) {
        const size_t length = std::strlen(prefix);
        if (directory.compare(0, length, prefix) == 0) return true;
    }
    return false;
}

bool is_diagnostic_argument(const char* argument) {
    return std::strcmp(argument, "--help") == 0 ||
        std::strcmp(argument, "-h") == 0 ||
        std::strcmp(argument, "--version") == 0 ||
        std::strcmp(argument, "-v") == 0;
}

bool consumes_a_value(const char* option) {
    return std::strcmp(option, "--prefix") == 0 ||
        std::strcmp(option, "--workspace") == 0 ||
        std::strcmp(option, "--registry") == 0 ||
        std::strcmp(option, "--cache") == 0 ||
        std::strcmp(option, "--userconfig") == 0 ||
        std::strcmp(option, "--filter") == 0 ||
        std::strcmp(option, "--dir") == 0 ||
        std::strcmp(option, "--cwd") == 0 ||
        std::strcmp(option, "-c") == 0 ||
        std::strcmp(option, "-C") == 0 ||
        std::strcmp(option, "-w") == 0;
}

/*
 * First non-option argument, mirroring adev_guard_first_command(): options
 * that take a value swallow it, "--" is skipped as a separator, every other
 * option is ignored, and an empty result means "no subcommand".
 */
std::string first_subcommand(char** arguments, int count) {
    bool skip_next = false;
    for (int index = 1; index < count; ++index) {
        const char* argument = arguments[index];
        if (skip_next) {
            skip_next = false;
            continue;
        }
        if (std::strcmp(argument, "--") == 0) continue;
        if (argument[0] == '-') {
            skip_next = consumes_a_value(argument);
            continue;
        }
        return std::string(argument);
    }
    return {};
}

bool is_read_only_git_subcommand(const std::string& subcommand) {
    return subcommand.empty() ||
        subcommand == "help" || subcommand == "status" || subcommand == "log" ||
        subcommand == "diff" || subcommand == "show" ||
        subcommand == "rev-parse" || subcommand == "describe" ||
        subcommand == "ls-files" || subcommand == "ls-tree" ||
        subcommand == "grep" || subcommand == "blame" ||
        subcommand == "shortlog";
}

std::string executable_directory() {
    std::vector<char> buffer(4096);
    const ssize_t length = readlink("/proc/self/exe", buffer.data(), buffer.size() - 1);
    if (length <= 0) return {};
    buffer[static_cast<size_t>(length)] = '\0';
    std::string path(buffer.data());
    const auto separator = path.find_last_of('/');
    return separator == std::string::npos ? std::string{} : path.substr(0, separator);
}

}  // namespace

int main(int argc, char** argv) {
    // Foreign parents may hand down a sanitized environment. Restore the
    // published contract first so Git sees HOME/PREFIX/TLS/credential config.
    adev_runtime_env_apply();

    std::string working_directory;
    std::vector<char> cwd(4096);
    if (getcwd(cwd.data(), cwd.size()) != nullptr) {
        working_directory = cwd.data();
    }

    bool diagnostic = false;
    for (int index = 1; index < argc; ++index) {
        if (is_diagnostic_argument(argv[index])) diagnostic = true;
    }

    if (!diagnostic && is_shared_storage(working_directory)) {
        const std::string subcommand = first_subcommand(argv, argc);
        if (!is_read_only_git_subcommand(subcommand)) {
            std::fprintf(
                stderr,
                "This project is stored on Android shared storage. Some "
                "development tools require filesystem features that are "
                "unavailable here, including symbolic links. Import this "
                "project into the ADEV workspace to continue.\n"
            );
            return 73;
        }
    }

    std::string git_payload = executable_directory() + kGitPayload;
    if (access(git_payload.c_str(), X_OK) != 0) {
        const char* fallback = std::getenv("MOBILEIDE_GIT");
        if (fallback != nullptr && access(fallback, X_OK) == 0) {
            git_payload = fallback;
        } else {
            std::fprintf(stderr, "git: Android runtime payload is unavailable\n");
            return 69;
        }
    }

    // argv[0] parity with the shell trampoline (`exec "$git" "$@"`).
    std::vector<char*> forwarded;
    forwarded.reserve(static_cast<size_t>(argc));
    forwarded.push_back(const_cast<char*>(git_payload.c_str()));
    for (int index = 1; index < argc; ++index) {
        forwarded.push_back(argv[index]);
    }
    forwarded.push_back(nullptr);

    execv(git_payload.c_str(), forwarded.data());
    std::fprintf(stderr, "git: failed to launch Android runtime: %s\n", std::strerror(errno));
    return errno == EACCES ? 126 : 71;
}
