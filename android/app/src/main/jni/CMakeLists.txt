cmake_minimum_required(VERSION 3.22.1)

# React Native's New Architecture requires an app-level native entrypoint.
# Keep this as the top-level CMake project so ReactNative-application.cmake
# creates libappmodules.so and links every generated/autolinked component.
project(appmodules)

# Generated React Native component sources can create paths beyond Ninja's
# Windows MAX_PATH limit. Ask CMake to hash object paths before that boundary.
set(CMAKE_OBJECT_PATH_MAX 220)

include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

target_link_options(appmodules PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
)

# MobileIDE's PTY and executable helper targets remain independent native
# outputs, but are built inside the same AGP/React Native CMake graph.
add_subdirectory("${CMAKE_CURRENT_SOURCE_DIR}/../cpp" adev_runtime_helpers)
