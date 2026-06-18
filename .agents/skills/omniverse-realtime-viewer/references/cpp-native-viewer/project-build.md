# C++ Native Project And Build

## When To Use This vs Other Paths

| You want... | Use... |
|---|---|
| Native C++ binary, Dear ImGui UI, no Python, no React | This skill |
| Small Python desktop viewer with ovui widgets | `local-viewer` |
| Native desktop app with React WebView and Rust FFI | `tauri-local-viewer` |
| Electron/React UI with a separate Python OVRTX process and SHM pixels | `electron-shm-viewer` |
| Browser client or remote GPU host | `streaming-server` + `streaming-client` |
| Architecture routing before choosing local vs remote | `streaming-vs-local` |

Choose C++/ImGui when the app runs on the GPU workstation, should ship as a
native executable, and does not need web UI reuse. Choose Tauri when React UI
reuse matters. Choose Electron + SHM when an existing Python OVRTX server should
stay isolated from the desktop shell. Choose streaming when the client is remote.

## Architecture Overview

One thread owns all mutable OVRTX state:

```text
main thread
  -> GLFW event callbacks update OrbitCamera and pending pick requests
  -> ImGui builds controls and viewport
  -> write camera omni:xform
  -> write selection animation omni:xform
  -> enqueue native pick query, when a click happened
  -> ovrtx_step()
  -> ovrtx_fetch_results()
  -> ovrtx_map_render_var_output("LdrColor")
  -> BGRA/RGBA normalize into owned CPU buffer
  -> glTexSubImage2D()
  -> ImGui::Image()
```

Keep `renderer`, stage load/reset, pick query enqueue, result mapping, and
`ovrtx_write_attribute()` calls on this same owner thread. UI callbacks should
only update app state that the render loop consumes.

## Project Skeleton

Use this shape for a minimal standalone viewer:

```text
cpp-imgui-viewer/
  CMakeLists.txt
  src/
    main.cpp
    camera.h
    camera.cpp
    session_layer.h
    ovrtx_helpers.h
```

`main.cpp` owns GLFW, ImGui, OVRTX lifecycle, texture upload, picking, selection,
and the render loop. Keep the first version simple; add richer panels only after
the frame path and input path are correct.

## Build System

Use CMake with `OVRTX_DIR` pointing at the OVRTX SDK root. Fetch Dear ImGui and
GLFW when local copies are not provided.

```cmake
cmake_minimum_required(VERSION 3.20)

project(cpp_imgui_ovrtx_viewer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

find_package(OpenGL REQUIRED)
find_package(glfw3 CONFIG QUIET)

if(NOT glfw3_FOUND)
    set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
    set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(
        glfw
        GIT_REPOSITORY https://github.com/glfw/glfw.git
        GIT_TAG 3.4
    )
    FetchContent_MakeAvailable(glfw)
endif()

if(TARGET glfw)
    set(GLFW_TARGET glfw)
elseif(TARGET glfw3)
    set(GLFW_TARGET glfw3)
else()
    message(FATAL_ERROR "GLFW target was not found")
endif()

if(NOT DEFINED IMGUI_DIR AND DEFINED ENV{IMGUI_DIR})
    set(IMGUI_DIR "$ENV{IMGUI_DIR}")
endif()

if(IMGUI_DIR)
    set(imgui_SOURCE_DIR "${IMGUI_DIR}")
else()
    FetchContent_Declare(
        imgui
        GIT_REPOSITORY https://github.com/ocornut/imgui.git
        GIT_TAG v1.91.9b
    )
    FetchContent_MakeAvailable(imgui)
endif()

add_library(imgui STATIC
    "${imgui_SOURCE_DIR}/imgui.cpp"
    "${imgui_SOURCE_DIR}/imgui_draw.cpp"
    "${imgui_SOURCE_DIR}/imgui_tables.cpp"
    "${imgui_SOURCE_DIR}/imgui_widgets.cpp"
    "${imgui_SOURCE_DIR}/backends/imgui_impl_glfw.cpp"
    "${imgui_SOURCE_DIR}/backends/imgui_impl_opengl3.cpp"
)
target_include_directories(imgui PUBLIC
    "${imgui_SOURCE_DIR}"
    "${imgui_SOURCE_DIR}/backends"
)
target_link_libraries(imgui PUBLIC ${GLFW_TARGET} OpenGL::GL)

if(NOT DEFINED OVRTX_DIR AND DEFINED ENV{OVRTX_DIR})
    set(OVRTX_DIR "$ENV{OVRTX_DIR}")
endif()
if(NOT OVRTX_DIR)
    message(FATAL_ERROR "Set OVRTX_DIR to the OVRTX SDK root")
endif()

set(OVRTX_INCLUDE_DIR "${OVRTX_DIR}/include" CACHE PATH "OVRTX include directory")
find_library(OVRTX_LIBRARY
    NAMES ovrtx libovrtx
    PATHS "${OVRTX_DIR}/lib" "${OVRTX_DIR}/lib64" "${OVRTX_DIR}/bin"
    NO_DEFAULT_PATH
)
if(NOT OVRTX_LIBRARY)
    message(FATAL_ERROR "Could not find ovrtx under ${OVRTX_DIR}")
endif()

add_library(OVRTX::ovrtx UNKNOWN IMPORTED)
set_target_properties(OVRTX::ovrtx PROPERTIES
    IMPORTED_LOCATION "${OVRTX_LIBRARY}"
    INTERFACE_INCLUDE_DIRECTORIES "${OVRTX_INCLUDE_DIR}"
)

add_executable(cpp_imgui_ovrtx_viewer
    src/main.cpp
    src/camera.cpp
    src/camera.h
    src/session_layer.h
    src/ovrtx_helpers.h
)

target_link_libraries(cpp_imgui_ovrtx_viewer PRIVATE
    OVRTX::ovrtx
    imgui
    ${GLFW_TARGET}
    OpenGL::GL
)
```

Run with the OVRTX runtime libraries visible:

```bash
cmake -S . -B build -DOVRTX_DIR="$OVRTX_DIR"
cmake --build build -j
LD_LIBRARY_PATH="$OVRTX_DIR/lib:$OVRTX_DIR/lib64:$LD_LIBRARY_PATH" \
  ./build/cpp_imgui_ovrtx_viewer /absolute/path/to/scene.usd
```

On Windows, add the OVRTX `bin` directory to `PATH` before launching.

## Common C API Helpers

Keep small helpers for string conversion, result checks, and operation waits.

```cpp
#include <ovrtx/ovrtx.h>
#include <ovrtx/ovrtx_attributes.h>
#include <ovrtx/ovrtx_config.h>
#include <ovrtx/ovrtx_types.h>

#include <cstdlib>
#include <iostream>
#include <string>

static ovx_string_t toOvxString(const std::string& value)
{
    return {value.c_str(), value.size()};
}

static std::string fromOvxString(ovx_string_t value)
{
    if (!value.ptr || value.length == 0) return {};
    return {value.ptr, value.length};
}

static bool ok(ovrtx_result_t result)
{
    return result.status == OVRTX_API_SUCCESS;
}

static bool ok(ovrtx_enqueue_result_t result)
{
    return result.status == OVRTX_API_SUCCESS;
}

static void printLastOvrtxError(const char* context)
{
    std::cerr << context;
    const std::string message = fromOvxString(ovrtx_get_last_error());
    if (!message.empty()) std::cerr << ": " << message;
    std::cerr << "\n";
}

static bool waitForOperation(
    ovrtx_renderer_t* renderer,
    ovrtx_enqueue_result_t op,
    const char* context)
{
    if (!ok(op)) {
        printLastOvrtxError(context);
        return false;
    }
    if (op.op_index == OVRTX_INVALID_HANDLE) {
        return true;
    }

    ovrtx_op_wait_result_t waitResult = {};
    const ovrtx_result_t wait =
        ovrtx_wait_op(renderer, op.op_index, ovrtx_timeout_infinite, &waitResult);
    if (!ok(wait) || waitResult.num_error_ops > 0) {
        printLastOvrtxError(context);
        return false;
    }
    return true;
}
```
