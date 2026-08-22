cmake_minimum_required(VERSION 3.22.1)

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
    INTERPROCEDURAL_OPTIMIZATION FALSE
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
    "-Wl,--strip-all"
)

target_compile_options(adev_npm_shell PRIVATE "-O2" "-g0")
target_compile_definitions(adev_npm_shell PRIVATE NDEBUG)

set_target_properties(adev_npm_shell PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    INTERPROCEDURAL_OPTIMIZATION FALSE
    # Name must look like a JNI lib so the packaging pipeline keeps it.
    OUTPUT_NAME "bin_adev_npm_shell"
    PREFIX "lib"
    SUFFIX ".so"
)

# BusyBox argv[0] dispatcher. The payload is renamed to libbin_busybox.so by
# Android packaging, but that BusyBox build chooses its applet from argv[0].
# This APK-native bridge restores normal `busybox <applet>` semantics for all
# shell wrappers without copying executables into Android's noexec filesDir.
add_executable(adev_busybox adev_busybox.cpp)

target_link_options(adev_busybox PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
    "-Wl,--strip-all"
)

target_compile_options(adev_busybox PRIVATE "-O2" "-g0")
target_compile_definitions(adev_busybox PRIVATE NDEBUG)

set_target_properties(adev_busybox PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    INTERPROCEDURAL_OPTIMIZATION FALSE
    OUTPUT_NAME "bin_adev_busybox"
    PREFIX "lib"
    SUFFIX ".so"
)

# Android-native GNU Make entrypoint. The Termux Make ELF has its original
# package's shell path compiled in; this launcher supplies the app's APK-native
# Bash as a command-line SHELL override for node-gyp and direct Make builds.
add_executable(adev_make adev_make.cpp)

target_link_options(adev_make PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
    "-Wl,--strip-all"
)

target_compile_options(adev_make PRIVATE "-O2" "-g0")
target_compile_definitions(adev_make PRIVATE NDEBUG)

set_target_properties(adev_make PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    INTERPROCEDURAL_OPTIMIZATION FALSE
    OUTPUT_NAME "bin_adev_make"
    PREFIX "lib"
    SUFFIX ".so"
)

# APK-native Unix LLD personality launcher. LLVM's packaged multi-call binary
# is named libbin_lld.so after Android relocation, so it cannot infer the
# ld.lld/ELF driver from argv[0] without this executable bridge.
add_executable(adev_ld_lld adev_ld_lld.cpp)

target_link_options(adev_ld_lld PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
    "-Wl,--strip-all"
)

target_compile_options(adev_ld_lld PRIVATE "-O2" "-g0")
target_compile_definitions(adev_ld_lld PRIVATE NDEBUG)

set_target_properties(adev_ld_lld PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    INTERPROCEDURAL_OPTIMIZATION FALSE
    OUTPUT_NAME "bin_adev_ld_lld"
    PREFIX "lib"
    SUFFIX ".so"
)

# Native Git credential helper. Keeping the broker response out of JavaScript
# is part of the credential-reference API guarantee.
add_executable(adev_git_credential adev_git_credential.cpp)

target_link_options(adev_git_credential PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
    "-Wl,--strip-all"
)

target_compile_options(adev_git_credential PRIVATE "-O2" "-g0")
target_compile_definitions(adev_git_credential PRIVATE NDEBUG)

set_target_properties(adev_git_credential PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    INTERPROCEDURAL_OPTIMIZATION FALSE
    OUTPUT_NAME "bin_adev_git_credential"
    PREFIX "lib"
    SUFFIX ".so"
)

# Android-native OpenCode entrypoint. The launcher is built for every app ABI;
# the large, source-pinned Bionic runtime is currently delivered for ARM64.
if(NOT DEFINED ADEV_OPENCODE_VERSION OR ADEV_OPENCODE_VERSION STREQUAL "")
    message(FATAL_ERROR "ADEV_OPENCODE_VERSION must come from adev-opencode.json")
endif()

configure_file(
    adev_opencode_version.h.in
    "${CMAKE_CURRENT_BINARY_DIR}/adev_opencode_version.h"
    @ONLY
)

add_executable(adev_opencode adev_opencode.cpp)

add_library(adev_opencode_compat SHARED adev_opencode_compat.c)

target_include_directories(adev_opencode PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")

target_link_options(adev_opencode PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
    "-Wl,--strip-all"
)

target_compile_options(adev_opencode PRIVATE "-O2" "-g0")
target_compile_definitions(adev_opencode PRIVATE NDEBUG)

target_link_libraries(adev_opencode_compat PRIVATE dl)
target_link_options(adev_opencode_compat PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
    "-Wl,--strip-all"
)
target_compile_options(adev_opencode_compat PRIVATE "-O2" "-g0")
target_compile_definitions(adev_opencode_compat PRIVATE NDEBUG)

set_target_properties(adev_opencode PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    INTERPROCEDURAL_OPTIMIZATION FALSE
    OUTPUT_NAME "bin_opencode"
    PREFIX "lib"
    SUFFIX ".so"
)

set_target_properties(adev_opencode_compat PROPERTIES
    C_STANDARD 17
    C_STANDARD_REQUIRED ON
    INTERPROCEDURAL_OPTIMIZATION FALSE
    OUTPUT_NAME "lib_adev_opencode_compat"
    PREFIX "lib"
    SUFFIX ".so"
)
