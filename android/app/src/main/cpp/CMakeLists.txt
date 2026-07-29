cmake_minimum_required(VERSION 3.22.1)

project("mobileide-pty")

# ---------------------------------------------------------------------------
# PTY native library (JNI)
# ---------------------------------------------------------------------------
add_library(mobileide-pty SHARED
    pty.cpp
)

find_library(log-lib log)

target_link_libraries(mobileide-pty
    ${log-lib}
)

target_link_options(mobileide-pty PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
)

set_target_properties(mobileide-pty PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
)

# ---------------------------------------------------------------------------
# adev-npm-shell — executable packaged as libbin_adev_npm_shell.so so AGP
# installs it into nativeLibraryDir (the only exec-permitted app location).
# RuntimeManager symlinks bin/adev-npm-shell -> this ELF.
# ---------------------------------------------------------------------------
add_executable(adev_npm_shell adev_npm_shell.cpp)

target_link_libraries(adev_npm_shell
    ${log-lib}
)

target_link_options(adev_npm_shell PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
)

set_target_properties(adev_npm_shell PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    # Name must look like a JNI lib so the packaging pipeline keeps it.
    OUTPUT_NAME "bin_adev_npm_shell"
    PREFIX "lib"
    SUFFIX ".so"
)

# Native Git credential helper. Keeping the broker response out of JavaScript
# is part of the credential-reference API guarantee.
add_executable(adev_git_credential adev_git_credential.cpp)

target_link_options(adev_git_credential PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
)

set_target_properties(adev_git_credential PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    OUTPUT_NAME "bin_adev_git_credential"
    PREFIX "lib"
    SUFFIX ".so"
)
