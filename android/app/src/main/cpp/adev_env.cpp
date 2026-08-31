#include "adev_runtime_env.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

extern char** environ;

namespace {

bool valid_name(const char* value, size_t length) {
    if (value == nullptr || length == 0 ||
        !((value[0] >= 'A' && value[0] <= 'Z') ||
          (value[0] >= 'a' && value[0] <= 'z') || value[0] == '_')) {
        return false;
    }
    for (size_t index = 1; index < length; ++index) {
        const unsigned char ch = static_cast<unsigned char>(value[index]);
        if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
              (ch >= '0' && ch <= '9') || ch == '_')) {
            return false;
        }
    }
    return true;
}

bool apply_assignment(const char* value) {
    const char* separator = value == nullptr ? nullptr : std::strchr(value, '=');
    if (separator == nullptr || !valid_name(value, static_cast<size_t>(separator - value))) {
        return false;
    }
    const std::string name(value, static_cast<size_t>(separator - value));
    return setenv(name.c_str(), separator + 1, 1) == 0;
}

bool regular_file(const char* path) {
    struct stat value {};
    return path != nullptr && path[0] != '\0' && stat(path, &value) == 0 &&
           S_ISREG(value.st_mode);
}

std::string native_library_dir() {
    char executable[PATH_MAX];
    const ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (length <= 0) return {};
    executable[length] = '\0';
    char* slash = std::strrchr(executable, '/');
    if (slash == nullptr) return {};
    *slash = '\0';
    return executable;
}

std::string sibling(const char* name) {
    const std::string directory = native_library_dir();
    if (directory.empty()) return {};
    const std::string candidate = directory + "/" + name;
    return regular_file(candidate.c_str()) ? candidate : std::string();
}

std::string sibling_with_prefix(const char* prefix) {
    const std::string directory = native_library_dir();
    if (directory.empty()) return {};
    DIR* entries = opendir(directory.c_str());
    if (entries == nullptr) return {};
    std::string result;
    const size_t prefix_length = std::strlen(prefix);
    while (dirent* entry = readdir(entries)) {
        const char* name = entry->d_name;
        const size_t name_length = std::strlen(name);
        if (name_length > prefix_length + 3 &&
            std::strncmp(name, prefix, prefix_length) == 0 &&
            std::strcmp(name + name_length - 3, ".so") == 0) {
            const std::string candidate = directory + "/" + name;
            if (regular_file(candidate.c_str())) {
                result = candidate;
                break;
            }
        }
    }
    closedir(entries);
    return result;
}

std::string verified_env_path(const char* name) {
    const char* value = std::getenv(name);
    return regular_file(value) ? std::string(value) : std::string();
}

const char* path_basename(const char* path) {
    if (path == nullptr) return "";
    const char* slash = std::strrchr(path, '/');
    return slash == nullptr ? path : slash + 1;
}

std::string runtime_file(const char* relative) {
    const char* prefix = std::getenv("PREFIX");
    if (prefix == nullptr || prefix[0] != '/' || relative == nullptr) return {};
    const std::string candidate = std::string(prefix) + "/" + relative;
    return regular_file(candidate.c_str()) ? candidate : std::string();
}

bool launcher_alias(const char* path) {
    if (path == nullptr || std::strchr(path, '/') == nullptr) return false;
    char executable[PATH_MAX];
    char candidate[PATH_MAX];
    const ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (length <= 0) return false;
    executable[length] = '\0';
    return realpath(path, candidate) != nullptr && std::strcmp(candidate, executable) == 0;
}

[[noreturn]] void exec_arguments(
    const std::string& executable,
    std::vector<std::string> arguments,
    const char* display_name
) {
    std::vector<char*> values;
    values.reserve(arguments.size() + 1);
    for (std::string& argument : arguments) values.push_back(argument.data());
    values.push_back(nullptr);

    if (std::strchr(executable.c_str(), '/') == nullptr) {
        execvp(executable.c_str(), values.data());
    } else {
        execv(executable.c_str(), values.data());
    }
    const int error = errno == 0 ? EIO : errno;
    std::fprintf(
        stderr,
        "adev-env: exec %s via %s: %s\n",
        display_name,
        executable.c_str(),
        std::strerror(error)
    );
    _exit(error == EACCES ? 126 : 127);
}

/**
 * Resolve the logical ADEV commands whose public paths live below filesDir.
 * Unknown commands deliberately stay generic: the exec compatibility code
 * compiled into this launcher performs PATH lookup and bounded recursive
 * shebang resolution for global npm/Python/shell CLIs.
 */
[[noreturn]] void run_adev_command(
    const char* requested,
    char* const* tail,
    bool force_logical
) {
    if (requested == nullptr || requested[0] == '\0') {
        std::fputs("adev-env: empty command\n", stderr);
        _exit(127);
    }
    adev_runtime_env_apply();

    const char* base = path_basename(requested);
    const bool logical = force_logical || std::strchr(requested, '/') == nullptr ||
        launcher_alias(requested);
    std::string executable;
    std::vector<std::string> arguments;

    if (logical && std::strcmp(base, "node") == 0) {
        executable = sibling("libbin_node.so");
    } else if (logical &&
               (std::strcmp(base, "python") == 0 || std::strcmp(base, "python3") == 0)) {
        executable = sibling_with_prefix("libbin_python");
    } else if (logical && std::strcmp(base, "bash") == 0) {
        executable = sibling("libbin_bash.so");
    } else if (logical && std::strcmp(base, "sh") == 0) {
        executable = "/system/bin/sh";
    } else if (logical && std::strcmp(base, "git") == 0) {
        executable = sibling("libbin_adev_git_launcher.so");
        if (executable.empty()) executable = sibling("libbin_git.so");
    } else if (logical && std::strcmp(base, "opencode") == 0) {
        executable = sibling("libbin_opencode.so");
    } else if (logical && std::strcmp(base, "curl") == 0) {
        executable = sibling("libbin_curl.so");
    } else if (logical && std::strcmp(base, "nano") == 0) {
        executable = sibling("libbin_nano.so");
    } else if (logical && (std::strcmp(base, "rg") == 0 || std::strcmp(base, "ripgrep") == 0)) {
        executable = sibling("libbin_rg.so");
    } else if (logical && std::strcmp(base, "make") == 0) {
        executable = sibling("libbin_adev_make.so");
    } else if (logical && std::strcmp(base, "xdg-open") == 0) {
        executable = sibling("libbin_adev_xdg_open.so");
    } else if (logical && std::strcmp(base, "busybox") == 0) {
        executable = sibling("libbin_adev_busybox.so");
    }

    const bool npm = logical && std::strcmp(base, "npm") == 0;
    const bool npx = logical && std::strcmp(base, "npx") == 0;
    const bool node_gyp = logical && std::strcmp(base, "node-gyp") == 0;
    const bool next = logical &&
        (std::strcmp(base, "next") == 0 || std::strcmp(base, "adev-next") == 0);
    const bool package_manager = logical &&
        (std::strcmp(base, "corepack") == 0 || std::strcmp(base, "yarn") == 0 ||
         std::strcmp(base, "yarnpkg") == 0 || std::strcmp(base, "pnpm") == 0 ||
         std::strcmp(base, "pnpx") == 0);

    if (npm || npx || node_gyp || next || package_manager) {
        executable = sibling("libbin_node.so");
        std::string entrypoint;
        if (npm) {
            entrypoint = runtime_file("lib/node_modules/npm/bin/npm-cli.js");
        } else if (npx) {
            entrypoint = runtime_file("lib/node_modules/npm/bin/npx-cli.js");
        } else if (node_gyp) {
            entrypoint = runtime_file(
                "lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
            );
        } else if (next) {
            entrypoint = runtime_file("lib/adev-next.js");
        } else {
            entrypoint = runtime_file("lib/adev-package-manager.js");
        }
        if (executable.empty() || entrypoint.empty()) {
            std::fprintf(stderr, "adev-env: %s runtime entrypoint is missing\n", base);
            _exit(127);
        }
        arguments.push_back(executable);
        arguments.push_back(entrypoint);
        if (package_manager) {
            if (std::strcmp(base, "yarnpkg") == 0) {
                arguments.emplace_back("yarn");
            } else if (std::strcmp(base, "pnpx") == 0) {
                arguments.emplace_back("pnpm");
                arguments.emplace_back("dlx");
            } else {
                arguments.emplace_back(base);
            }
        }
    } else {
        if (executable.empty()) executable = requested;
        arguments.emplace_back(logical ? base : requested);
    }

    for (size_t index = 0; tail != nullptr && tail[index] != nullptr; ++index) {
        arguments.emplace_back(tail[index]);
    }
    exec_arguments(executable, std::move(arguments), requested);
}

std::string direct_interpreter(const char* command) {
    if (command == nullptr || std::strchr(command, '/') != nullptr) return {};
    // The shebang compatibility layer may invoke env before shell bootstrap
    // variables exist. Resolve APK siblings from /proc/self/exe first so a
    // standard `#!/usr/bin/env node` never falls back to the noexec bin script.
    if (std::strcmp(command, "node") == 0) {
        std::string path = sibling("libbin_node.so");
        return path.empty() ? verified_env_path("MOBILEIDE_NODE") : path;
    }
    if (std::strcmp(command, "python") == 0 || std::strcmp(command, "python3") == 0) {
        std::string path = sibling_with_prefix("libbin_python");
        return path.empty() ? verified_env_path("PYTHON") : path;
    }
    if (std::strcmp(command, "sh") == 0) return "/system/bin/sh";
    if (std::strcmp(command, "bash") == 0) {
        std::string path = sibling("libbin_bash.so");
        return path.empty() ? verified_env_path("MOBILEIDE_BASH") : path;
    }
    return {};
}

void print_usage() {
    std::fputs("usage: env [-i] [-u NAME] [NAME=VALUE]... [COMMAND [ARG]...]\n", stderr);
}

bool virtual_shell(const char* path) {
    return path != nullptr &&
        (std::strcmp(path, "/bin/sh") == 0 ||
         std::strcmp(path, "/usr/bin/sh") == 0 ||
         std::strcmp(path, "/data/data/com.termux/files/usr/bin/sh") == 0 ||
         std::strcmp(path, "/data/user/0/com.termux/files/usr/bin/sh") == 0);
}

bool virtual_env(const char* path) {
    return path != nullptr &&
        (std::strcmp(path, "/usr/bin/env") == 0 || std::strcmp(path, "/bin/env") == 0);
}

int broker_error_descriptor() {
    const char* value = std::getenv("ADEV_SPAWN_ERROR_FD");
    if (value == nullptr || value[0] == '\0') return -1;
    char* end = nullptr;
    errno = 0;
    const long descriptor = std::strtol(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' || descriptor < 0 || descriptor > INT_MAX) {
        return -1;
    }
    return static_cast<int>(descriptor);
}

[[noreturn]] void broker_fail(int descriptor, int error) {
    if (descriptor >= 0) {
        const unsigned char* cursor = reinterpret_cast<const unsigned char*>(&error);
        size_t remaining = sizeof(error);
        while (remaining > 0) {
            const ssize_t count = write(descriptor, cursor, remaining);
            if (count > 0) {
                cursor += count;
                remaining -= static_cast<size_t>(count);
                continue;
            }
            if (count < 0 && errno == EINTR) continue;
            break;
        }
        close(descriptor);
    }
    _exit(127);
}

[[noreturn]] void run_spawn_broker(int argc, char** argv) {
    const int error_descriptor = broker_error_descriptor();
    unsetenv("ADEV_SPAWN_ERROR_FD");
    if (error_descriptor < 0 ||
        fcntl(error_descriptor, F_SETFD, FD_CLOEXEC) != 0) {
        broker_fail(error_descriptor, EBADF);
    }
    if (argc < 6 || std::strcmp(argv[1], "--adev-spawn-v1") != 0 ||
        std::strcmp(argv[4], "--") != 0 || argv[3][0] == '\0') {
        broker_fail(error_descriptor, EINVAL);
    }

    adev_runtime_env_apply();
    const char* mode = argv[2];
    const char* target = argv[3];
    char** original_argv = argv + 5;
    if (original_argv[0] == nullptr) broker_fail(error_descriptor, EINVAL);

    if (std::strcmp(mode, "path") == 0) {
        execvp(target, original_argv);
    } else if (std::strcmp(mode, "direct") == 0) {
        if (virtual_shell(target)) {
            // OpenCode's lifecycle/npm shell is not a /bin/sh identity. Enter
            // Android's real shell with the repaired contract and original
            // argv[0] after Bionic has applied spawn-time cwd/file actions.
            execv("/system/bin/sh", original_argv);
        } else if (virtual_env(target)) {
            // Re-enter this APK-native env binary in its public mode. argv[0]
            // intentionally remains the caller's /usr/bin/env identity.
            execv(argv[0], original_argv);
        } else {
            execv(target, original_argv);
        }
    } else {
        broker_fail(error_descriptor, EINVAL);
    }
    broker_fail(error_descriptor, errno == 0 ? EIO : errno);
}

[[noreturn]] void run_opencode_shell_broker(int argc, char** argv) {
    if (argc != 4 || std::strcmp(argv[1], "--adev-opencode-shell-v1") != 0 ||
        std::strcmp(argv[2], "--") != 0) {
        std::fputs("adev-env: invalid OpenCode shell broker invocation\n", stderr);
        _exit(125);
    }

    // Bun's Effect subprocess path can start children with Android's sanitized
    // baseline environment. Restore ADEV's signed runtime contract inside an
    // APK-native executable, then hand the original command to Android's real
    // POSIX shell as one untouched argv element.
    adev_runtime_env_apply();
    char* shell_argv[] = {
        const_cast<char*>("/system/bin/sh"),
        const_cast<char*>("-c"),
        argv[3],
        nullptr,
    };
    execv("/system/bin/sh", shell_argv);
    std::fprintf(stderr, "adev-env: exec /system/bin/sh: %s\n", std::strerror(errno));
    _exit(errno == EACCES ? 126 : 127);
}

}  // namespace

int main(int argc, char** argv) {
    if (argc >= 2 && std::strcmp(argv[1], "--adev-spawn-v1") == 0) {
        run_spawn_broker(argc, argv);
    }
    if (argc >= 2 && std::strcmp(argv[1], "--adev-opencode-shell-v1") == 0) {
        run_opencode_shell_broker(argc, argv);
    }
    if (argc >= 4 && std::strcmp(argv[1], "--adev-run-v1") == 0) {
        if (std::strcmp(argv[3], "--") != 0) {
            std::fputs("adev-env: invalid command launcher invocation\n", stderr);
            return 125;
        }
        run_adev_command(argv[2], argv + 4, false);
    }

    // Public aliases in $PREFIX/bin and bin/adev-shims all point at this real
    // APK-native executable.  Dispatch by argv[0] so a foreign agent can call
    // `$PREFIX/bin/bash` directly without touching a noexec script.
    const char* invoked_as = path_basename(argv[0]);
    static const char* const aliases[] = {
        "bash", "sh", "node", "npm", "npx", "node-gyp", "python", "python3",
        "git", "opencode", "curl", "nano", "rg", "ripgrep", "make", "xdg-open",
        "busybox", "corepack", "yarn", "yarnpkg", "pnpm", "pnpx", "next", "adev-next"
    };
    for (const char* alias : aliases) {
        if (std::strcmp(invoked_as, alias) == 0) {
            run_adev_command(alias, argv + 1, true);
        }
    }
    int index = 1;
    while (index < argc) {
        const char* argument = argv[index];
        if (std::strcmp(argument, "--") == 0) {
            ++index;
            break;
        }
        if (std::strcmp(argument, "-i") == 0 ||
            std::strcmp(argument, "--ignore-environment") == 0) {
            if (clearenv() != 0) {
                std::fprintf(stderr, "env: clear environment: %s\n", std::strerror(errno));
                return 125;
            }
            // The preloaded exec resolver repairs Bun's Android-baseline
            // environment. Mark this deliberately clean block so `env -i`
            // remains clean even when the caller adds PATH or another value.
            if (setenv("ADEV_ENV_AUTOFILL", "0", 1) != 0) {
                std::fprintf(stderr, "env: mark clean environment: %s\n", std::strerror(errno));
                return 125;
            }
            ++index;
            continue;
        }
        if (std::strcmp(argument, "-u") == 0) {
            if (++index >= argc || !valid_name(argv[index], std::strlen(argv[index]))) {
                print_usage();
                return 125;
            }
            unsetenv(argv[index++]);
            continue;
        }
        if (std::strncmp(argument, "--unset=", 8) == 0) {
            const char* name = argument + 8;
            if (!valid_name(name, std::strlen(name))) {
                print_usage();
                return 125;
            }
            unsetenv(name);
            ++index;
            continue;
        }
        if (argument[0] == '-' && argument[1] != '\0') {
            std::fprintf(stderr, "env: unsupported option: %s\n", argument);
            return 125;
        }
        if (std::strchr(argument, '=') != nullptr) {
            if (!apply_assignment(argument)) {
                std::fprintf(stderr, "env: invalid assignment: %s\n", argument);
                return 125;
            }
            ++index;
            continue;
        }
        break;
    }

    if (index >= argc) {
        for (char** entry = environ; entry != nullptr && *entry != nullptr; ++entry) {
            std::puts(*entry);
        }
        return 0;
    }

    char** command_argv = argv + index;
    const std::string direct = direct_interpreter(command_argv[0]);
    if (!direct.empty()) {
        execv(direct.c_str(), command_argv);
    } else {
        execvp(command_argv[0], command_argv);
    }
    if (!direct.empty()) {
        std::fprintf(
            stderr,
            "env: exec %s via %s: %s\n",
            command_argv[0],
            direct.c_str(),
            std::strerror(errno)
        );
    } else {
        std::fprintf(stderr, "env: exec %s: %s\n", command_argv[0], std::strerror(errno));
    }
    return errno == EACCES ? 126 : 127;
}
