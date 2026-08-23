#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <limits.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

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

}  // namespace

int main(int argc, char** argv) {
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
