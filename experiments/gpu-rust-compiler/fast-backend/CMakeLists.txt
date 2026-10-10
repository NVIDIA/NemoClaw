# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.25)
project(nemoclaw_fast_backend LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# This bridge exchanges serialized IR and object bytes, never LLVM object pointers with rustc.
find_package(LLVM 22.1.8 EXACT REQUIRED CONFIG)
# Keep the standalone bridge's required LLVM subset inside its small executable;
# a second complete shared LLVM would count against the compiler asset budget.
set(TPDE_LINK_LLVM_STATIC ON CACHE BOOL "Link LLVM component archives" FORCE)
set(NEMO_TPDE_REVISION "9779acf4ada3736e779391da1e4b3369dba08024")
include(FetchContent)
set(TPDE_INCLUDE_TESTS OFF CACHE BOOL "" FORCE)
set(TPDE_BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(TPDE_ENABLE_ASAN OFF CACHE BOOL "" FORCE)
set(TPDE_ENABLE_LLVM_PLUGIN OFF CACHE BOOL "" FORCE)
set(TPDE_ENABLE_ASSERTIONS ON CACHE BOOL "" FORCE)
FetchContent_Declare(tpde
    GIT_REPOSITORY https://github.com/tpde2/tpde.git
    GIT_TAG ${NEMO_TPDE_REVISION}
    GIT_SUBMODULES deps/args deps/spdlog deps/fadec deps/disarm
    GIT_SUBMODULES_RECURSE ON)
FetchContent_MakeAvailable(tpde)

add_executable(tpde-rust-bridge bridge.cpp leaf_export.cpp)
target_link_libraries(tpde-rust-bridge PRIVATE tpde::tpde_llvm)
target_compile_definitions(tpde-rust-bridge PRIVATE NEMO_TPDE_REVISION="${NEMO_TPDE_REVISION}")
if(NOT LLVM_ENABLE_RTTI)
    target_compile_options(tpde-rust-bridge PRIVATE -fno-rtti)
endif()
