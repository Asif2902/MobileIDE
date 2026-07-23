cmake_minimum_required(VERSION 3.22.1)

project("mobileide-pty")

# PTY native library
add_library(mobileide-pty SHARED
    pty.cpp
)

# Find and link required libraries
find_library(log-lib log)

target_link_libraries(mobileide-pty
    ${log-lib}
)

# C++17 standard
set_target_properties(mobileide-pty PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
)
