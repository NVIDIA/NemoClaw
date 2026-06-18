# C++ Presentation And Render Loop

## OpenGL Texture Upload

Display `LdrColor` by copying mapped CPU pixels into an owned RGBA buffer and
uploading with `glTexSubImage2D()`.

```cpp
#include <GLFW/glfw3.h>
#include <algorithm>
#include <cstdint>
#include <vector>

struct TextureState {
    GLuint texture = 0;
    int width = 0;
    int height = 0;
    std::vector<std::uint8_t> rgba;
};

static void ensureTexture(TextureState& tex, int width, int height)
{
    if (tex.texture == 0) {
        glGenTextures(1, &tex.texture);
        glBindTexture(GL_TEXTURE_2D, tex.texture);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    }

    glBindTexture(GL_TEXTURE_2D, tex.texture);
    if (tex.width != width || tex.height != height) {
        tex.width = width;
        tex.height = height;
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0,
            GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    }
}

static bool copyBgraOrRgbaToTexture(TextureState& tex, const DLTensor& tensor, bool sourceIsBgra)
{
    if (!tensor.data || tensor.ndim != 3 || !tensor.shape) return false;
    if (tensor.dtype.code != static_cast<std::uint8_t>(kDLUInt) ||
        tensor.dtype.bits != 8 || tensor.shape[2] < 4) {
        return false;
    }

    const int height = static_cast<int>(tensor.shape[0]);
    const int width = static_cast<int>(tensor.shape[1]);
    if (width <= 0 || height <= 0) return false;

    const auto* base =
        static_cast<const std::uint8_t*>(tensor.data) + tensor.byte_offset;
    const int64_t rowStride = tensor.strides ? tensor.strides[0] : width * tensor.shape[2];
    const int64_t pixelStride = tensor.strides ? tensor.strides[1] : tensor.shape[2];
    const int64_t channelStride = tensor.strides ? tensor.strides[2] : 1;
    if (channelStride != 1 || pixelStride < 4) return false;

    tex.rgba.resize(static_cast<size_t>(width) * static_cast<size_t>(height) * 4);
    for (int y = 0; y < height; ++y) {
        const auto* srcRow = base + static_cast<size_t>(y) * static_cast<size_t>(rowStride);
        auto* dstRow = tex.rgba.data() + static_cast<size_t>(y) * static_cast<size_t>(width) * 4;
        for (int x = 0; x < width; ++x) {
            const auto* src = srcRow + static_cast<size_t>(x) * static_cast<size_t>(pixelStride);
            auto* dst = dstRow + static_cast<size_t>(x) * 4;
            dst[0] = sourceIsBgra ? src[2] : src[0];
            dst[1] = src[1];
            dst[2] = sourceIsBgra ? src[0] : src[2];
            dst[3] = src[3];
        }
    }

    ensureTexture(tex, width, height);
    glBindTexture(GL_TEXTURE_2D, tex.texture);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, width, height,
        GL_RGBA, GL_UNSIGNED_BYTE, tex.rgba.data());
    return true;
}
```

For GL display, normalize the mapped data to RGBA before upload. If your OVRTX
build maps `LdrColor` as BGRA, swap channels as above. Do not send BGRA data to
`ImGui::Image()` through a `GL_RGBA` upload.

## Render Loop

The core order is camera writes, animation writes, optional pick enqueue, step,
map display and pick outputs, then ImGui presentation.

```cpp
static bool sameString(ovx_string_t value, const char* literal)
{
    const std::string expected(literal);
    return value.ptr &&
        value.length == expected.size() &&
        std::char_traits<char>::compare(value.ptr, expected.data(), expected.size()) == 0;
}

static const DLTensor* firstTensor(const ovrtx_render_var_output_t& output)
{
    if (!output.tensors || output.num_tensors == 0) return nullptr;
    return output.tensors[0].dl;
}

static void stepRenderAndUpload(
    ovrtx_renderer_t* renderer,
    const std::string& renderProductPath,
    double deltaSeconds,
    TextureState& texture)
{
    const ovx_string_t productPath = toOvxString(renderProductPath);
    const ovrtx_render_product_set_t products = {&productPath, 1};

    ovrtx_step_result_handle_t stepHandle = OVRTX_INVALID_HANDLE;
    const ovrtx_enqueue_result_t step =
        ovrtx_step(renderer, products, deltaSeconds, &stepHandle);
    if (!ok(step) || stepHandle == OVRTX_INVALID_HANDLE) {
        printLastOvrtxError("Failed to step OVRTX");
        return;
    }

    ovrtx_render_product_set_outputs_t outputs = {};
    const ovrtx_result_t results =
        ovrtx_fetch_results(renderer, stepHandle, ovrtx_timeout_infinite, &outputs);
    if (!ok(results) || outputs.status == OVRTX_EVENT_FAILURE) {
        printLastOvrtxError("Failed to fetch OVRTX results");
        ovrtx_destroy_results(renderer, stepHandle);
        return;
    }

    for (size_t productIndex = 0; productIndex < outputs.output_count; ++productIndex) {
        const auto& product = outputs.outputs[productIndex];
        for (size_t frameIndex = 0; frameIndex < product.output_frame_count; ++frameIndex) {
            const auto& frame = product.output_frames[frameIndex];
            for (size_t varIndex = 0; varIndex < frame.render_var_count; ++varIndex) {
                const auto& var = frame.output_render_vars[varIndex];
                if (!sameString(var.render_var_name, "LdrColor")) continue;

                ovrtx_render_var_output_t mapped = {};
                const ovrtx_result_t map =
                    ovrtx_map_render_var_output(renderer, var.output_handle,
                        ovrtx_timeout_infinite, &mapped);
                if (ok(map) && mapped.status == OVRTX_EVENT_COMPLETED) {
                    if (const DLTensor* tensor = firstTensor(mapped)) {
                        copyBgraOrRgbaToTexture(texture, *tensor, true);
                    }
                }
                if (mapped.map_handle != OVRTX_INVALID_HANDLE) {
                    ovrtx_unmap_render_var_output(renderer, mapped.map_handle, {});
                }
            }
        }
    }

    ovrtx_destroy_results(renderer, stepHandle);
}
```

Ownership rule: map, copy, and unmap render var outputs before calling
`ovrtx_destroy_results()`. Do not hold mapped references across step boundaries.

ImGui presentation is normal OpenGL backend usage:

```cpp
ImGui_ImplOpenGL3_NewFrame();
ImGui_ImplGlfw_NewFrame();
ImGui::NewFrame();

ImGui::Begin("Viewport");
ImVec2 available = ImGui::GetContentRegionAvail();
if (texture.texture != 0) {
    ImGui::Image(
        reinterpret_cast<ImTextureID>(static_cast<intptr_t>(texture.texture)),
        available,
        ImVec2(0.0f, 0.0f),
        ImVec2(1.0f, 1.0f));
}
ImGui::End();

ImGui::Render();
glViewport(0, 0, framebufferWidth, framebufferHeight);
glClear(GL_COLOR_BUFFER_BIT);
ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
glfwSwapBuffers(window);
```

For picking, compute the actual image rect inside the viewport if you preserve
aspect ratio or crop. Convert mouse coordinates to render product pixels before
enqueuing the pick query.

## Main Loop Skeleton

This is the minimal control flow. Keep details such as sidebars and property
panels outside the OVRTX frame path.

```cpp
int main(int argc, char** argv)
{
    if (argc < 2) return EXIT_FAILURE;

#if defined(_WIN32)
    _putenv_s("OVRTX_SKIP_USD_CHECK", "1");
#else
    setenv("OVRTX_SKIP_USD_CHECK", "1", 0);
#endif

    const int renderWidth = 1280;
    const int renderHeight = 720;
    GLFWwindow* window = createGlfwWindow(renderWidth, renderHeight);
    initDearImGui(window);

    ovrtx_renderer_t* renderer = createRenderer(renderWidth, renderHeight);
    if (!renderer) return EXIT_FAILURE;
    if (!loadStage(renderer, argv[1], renderWidth, renderHeight)) {
        ovrtx_destroy_renderer(renderer);
        return EXIT_FAILURE;
    }

    OrbitCamera camera;
    TextureState texture;
    PendingPick pendingPick;
    std::string selectedPath;
    std::vector<PrimAnimation> animations;

    auto lastTime = std::chrono::steady_clock::now();
    while (!glfwWindowShouldClose(window)) {
        glfwPollEvents();

        const auto now = std::chrono::steady_clock::now();
        const double dt = std::chrono::duration<double>(now - lastTime).count();
        lastTime = now;

        writeMat4Attribute(renderer, "/OVCamera", "omni:xform", camera.cameraToWorld());
        updateSelectionAnimation(renderer, animations, dt);

        const bool pickQueued = enqueuePick(renderer, "/OVRenderProduct", pendingPick);
        stepRenderAndUpload(renderer, "/OVRenderProduct", dt, texture);
        // If pickQueued, decode OVRTX_RENDER_VAR_PICK_HIT from the same step
        // and call selectPrim(renderer, selectedPath, animations, pickedPath).

        drawDearImGuiUi(texture, selectedPath, pendingPick);
    }

    if (texture.texture) glDeleteTextures(1, &texture.texture);
    ovrtx_destroy_renderer(renderer);
    shutdownDearImGuiAndGlfw(window);
    return EXIT_SUCCESS;
}
```

The pick decode belongs inside the same result iteration that maps `LdrColor`.
Do not step once for display and a second time for the pick unless the UI is
designed for one-frame-later selection.
