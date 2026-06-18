# C++ Interaction Features

## Orbit Camera Control

Use an orbit camera with azimuth, elevation, distance, and target. Mouse input
updates camera state; the render loop writes the camera transform to
`omni:xform` before `ovrtx_step()`.

```cpp
#include <algorithm>
#include <array>
#include <cmath>

struct OrbitCamera {
    using Mat4 = std::array<double, 16>;

    double azimuth = -1.5707963267948966;
    double elevation = 0.2912652529540066;
    double distance = 500.0;
    std::array<double, 3> target = {-74.5, 103.0, -22.5};
    double lastX = 0.0;
    double lastY = 0.0;
    int dragButton = -1;  // 0 orbit, 1 pan, 2 dolly

    void beginDrag(int button, double x, double y)
    {
        dragButton = button;
        lastX = x;
        lastY = y;
    }

    void drag(double x, double y)
    {
        const double dx = x - lastX;
        const double dy = y - lastY;
        lastX = x;
        lastY = y;

        if (dragButton == 0) {
            azimuth += dx * 0.006;
            elevation = std::clamp(elevation + dy * 0.006, -1.45, 1.45);
        } else if (dragButton == 2) {
            distance = std::max(1.0, distance * std::exp(dy * 0.01));
        }
    }

    void scroll(double yoffset)
    {
        distance = std::max(1.0, distance * std::exp(-yoffset * 0.08));
    }

    Mat4 cameraToWorld() const
    {
        const double ce = std::cos(elevation);
        const std::array<double, 3> eye = {
            target[0] + distance * ce * std::cos(azimuth),
            target[1] + distance * std::sin(elevation),
            target[2] + distance * ce * std::sin(azimuth),
        };

        auto normalize = [](std::array<double, 3> v) {
            const double len = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
            return std::array<double, 3>{v[0] / len, v[1] / len, v[2] / len};
        };
        auto cross = [](std::array<double, 3> a, std::array<double, 3> b) {
            return std::array<double, 3>{
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            };
        };

        const std::array<double, 3> forward = normalize({
            target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]});
        const std::array<double, 3> worldUp = {0.0, 1.0, 0.0};
        const std::array<double, 3> right = normalize(cross(forward, worldUp));
        const std::array<double, 3> up = cross(right, forward);

        return {
            right[0], right[1], right[2], 0.0,
            up[0], up[1], up[2], 0.0,
            -forward[0], -forward[1], -forward[2], 0.0,
            eye[0], eye[1], eye[2], 1.0,
        };
    }
};
```

Write the camera matrix with `OVRTX_SEMANTIC_XFORM_MAT4x4`:

```cpp
static bool writeMat4Attribute(
    ovrtx_renderer_t* renderer,
    const std::string& primPath,
    const char* attributeName,
    const OrbitCamera::Mat4& matrix)
{
    int64_t shape[] = {1};
    int64_t strides[] = {1};

    DLTensor tensor = {};
    tensor.data = const_cast<double*>(matrix.data());
    tensor.device = {kDLCPU, 0};
    tensor.ndim = 1;
    tensor.dtype = {static_cast<std::uint8_t>(kDLFloat), 64, 16};
    tensor.shape = shape;
    tensor.strides = strides;

    ovrtx_input_buffer_t input = {};
    input.tensors = &tensor;
    input.tensor_count = 1;

    const ovx_string_t path = toOvxString(primPath);
    const ovx_string_t paths[] = {path};

    ovrtx_binding_desc_or_handle_t binding = {};
    binding.binding_desc.prim_list = {paths, 1};
    binding.binding_desc.attribute_name = {0, literal_to_ovx_string(attributeName)};
    binding.binding_desc.attribute_type = {
        {static_cast<std::uint8_t>(kDLFloat), 64, 16},
        false,
        OVRTX_SEMANTIC_XFORM_MAT4x4,
    };
    binding.binding_desc.prim_mode = OVRTX_BINDING_PRIM_MODE_CREATE_NEW;

    const ovrtx_enqueue_result_t write =
        ovrtx_write_attribute(renderer, &binding, &input, OVRTX_DATA_ACCESS_SYNC);
    return ok(write);
}

writeMat4Attribute(renderer, "/OVCamera", "omni:xform", camera.cameraToWorld());
```

Do not write `xformOp:transform` for live camera movement. OVRTX consumes the
Fabric `omni:xform` attribute for live transforms.

## Native Picking

For click selection, enqueue a native pick query before the step that should
produce the pick result. Read `OVRTX_RENDER_VAR_PICK_HIT` after that same step.

```cpp
struct PendingPick {
    bool pending = false;
    int left = 0;
    int top = 0;
    int right = 0;
    int bottom = 0;
};

static bool enqueuePick(
    ovrtx_renderer_t* renderer,
    const std::string& renderProductPath,
    PendingPick& pendingPick)
{
    if (!pendingPick.pending) return false;

    const ovrtx_pick_query_desc_t desc = {
        toOvxString(renderProductPath),
        pendingPick.left,
        pendingPick.top,
        pendingPick.right,
        pendingPick.bottom,
        0,
    };
    pendingPick = {};

    const ovrtx_enqueue_result_t pick = ovrtx_enqueue_pick_query(renderer, &desc);
    if (!ok(pick)) {
        printLastOvrtxError("Failed to enqueue pick query");
        return false;
    }
    return true;
}
```

Decode the pick-hit output by checking params and resolving `primPath` IDs
through the path dictionary.

```cpp
#include <ovx/path_dictionary/path_dictionary.h>
#include <ovx/path_dictionary/path_dictionary_helper.h>
#include <ovx/path_dictionary/path_dictionary_utils.h>

#include <algorithm>
#include <cstring>
#include <vector>

static const DLTensor* findTensor(const ovrtx_render_var_output_t& output, const char* name)
{
    for (size_t i = 0; output.tensors && i < output.num_tensors; ++i) {
        if (output.tensors[i].name &&
            sameString(*output.tensors[i].name, name)) {
            return output.tensors[i].dl;
        }
    }
    return nullptr;
}

static const DLTensor* findParam(const ovrtx_render_var_output_t& output, const char* name)
{
    for (size_t i = 0; output.params && i < output.num_params; ++i) {
        if (sameString(output.params[i].name, name)) return &output.params[i].dl;
    }
    return nullptr;
}

static bool readU64(const DLTensor& tensor, size_t index, std::uint64_t& value)
{
    if (!tensor.data || tensor.dtype.lanes != 1) return false;
    const auto* base = static_cast<const std::uint8_t*>(tensor.data) + tensor.byte_offset;
    const size_t bytes = tensor.dtype.bits / 8;
    const int64_t stride = tensor.strides ? tensor.strides[0] : 1;
    const auto* ptr = base + index * static_cast<size_t>(stride) * bytes;

    value = 0;
    if (tensor.dtype.code == static_cast<std::uint8_t>(kDLUInt)) {
        std::memcpy(&value, ptr, std::min(bytes, sizeof(value)));
        return true;
    }
    return false;
}

static std::string resolvePrimPathId(ovrtx_renderer_t* renderer, ovx_primpath_t pathId)
{
    path_dictionary_instance_t dictionary = {};
    if (!ok(ovrtx_get_path_dictionary(renderer, &dictionary))) {
        printLastOvrtxError("Failed to get OVRTX path dictionary");
        return {};
    }

    std::vector<ovx_token_t> tokenBuffer(256);
    ovx_token_t* tokensPerPath[] = {nullptr};
    size_t tokenCounts[] = {0};
    size_t pathsProcessed = 0;

    ovx_api_result_t tokenResult = path_dictionary_get_tokens_from_paths(
        &dictionary,
        &pathId,
        1,
        tokenBuffer.data(),
        tokenBuffer.size(),
        tokensPerPath,
        tokenCounts,
        &pathsProcessed);
    if (tokenResult.status != OVX_API_SUCCESS || pathsProcessed != 1 || !tokensPerPath[0]) {
        return {};
    }

    std::vector<ovx_string_t> tokenStrings(tokenCounts[0]);
    ovx_api_result_t stringResult = path_dictionary_get_strings_from_tokens(
        &dictionary,
        tokensPerPath[0],
        tokenCounts[0],
        tokenStrings.data());
    if (stringResult.status != OVX_API_SUCCESS) {
        return {};
    }

    std::string path;
    for (ovx_string_t token : tokenStrings) {
        std::string segment = fromOvxString(token);
        if (segment.empty()) continue;
        if (segment.front() != '/') path.push_back('/');
        path += segment;
    }
    return path.empty() ? "/" : path;
}

static std::vector<std::string> decodePickPaths(
    ovrtx_renderer_t* renderer,
    const ovrtx_render_var_output_t& pickOutput)
{
    std::uint64_t magic = 0;
    std::uint64_t version = 0;
    std::uint64_t hitCount = 0;
    const DLTensor* magicParam = findParam(pickOutput, "magic");
    const DLTensor* versionParam = findParam(pickOutput, "version");
    const DLTensor* hitCountParam = findParam(pickOutput, "hitCount");
    if (!magicParam || !versionParam || !hitCountParam ||
        !readU64(*magicParam, 0, magic) ||
        !readU64(*versionParam, 0, version) ||
        !readU64(*hitCountParam, 0, hitCount)) {
        return {};
    }
    if (magic != OVRTX_PICK_HIT_MAGIC || version != OVRTX_PICK_HIT_VERSION) {
        return {};
    }

    const DLTensor* primPathTensor = findTensor(pickOutput, "primPath");
    if (!primPathTensor || !primPathTensor->shape) return {};

    const size_t count =
        std::min(static_cast<size_t>(hitCount), static_cast<size_t>(primPathTensor->shape[0]));

    std::vector<std::string> paths;
    for (size_t i = 0; i < count; ++i) {
        std::uint64_t id = 0;
        if (!readU64(*primPathTensor, i, id) || id == 0) continue;
        std::string path = resolvePrimPathId(renderer, static_cast<ovx_primpath_t>(id));
        if (!path.empty() && std::find(paths.begin(), paths.end(), path) == paths.end()) {
            paths.push_back(path);
        }
    }
    return paths;
}
```

In the render loop, handle pick output beside `LdrColor`:

```cpp
const bool pickQueued = enqueuePick(renderer, renderProductPath, pendingPick);

// After ovrtx_step() and ovrtx_fetch_results():
if (pickQueued && sameString(var.render_var_name, OVRTX_RENDER_VAR_PICK_HIT)) {
    ovrtx_render_var_output_t mapped = {};
    if (ok(ovrtx_map_render_var_output(renderer, var.output_handle,
            ovrtx_timeout_infinite, &mapped)) &&
        mapped.status == OVRTX_EVENT_COMPLETED) {
        std::vector<std::string> picked = decodePickPaths(renderer, mapped);
        setSelectedPrim(picked.empty() ? std::string{} : picked.front());
    }
    if (mapped.map_handle != OVRTX_INVALID_HANDLE) {
        ovrtx_unmap_render_var_output(renderer, mapped.map_handle, {});
    }
}
```

Treat `left` and `top` as inclusive, `right` and `bottom` as exclusive. A single
click is a `1x1` rectangle: `{x, y, x + 1, y + 1}`.

## Selection Outline

Enable outlines in renderer config, then write
`omni:selectionOutlineGroup`/`OVRTX_ATTR_NAME_SELECTION_OUTLINE_GROUP` on selected
prims. Group `0` clears the outline; group `1` is primary selection.

```cpp
static bool writeU8Attribute(
    ovrtx_renderer_t* renderer,
    const std::string& primPath,
    const char* attributeName,
    std::uint8_t value)
{
    int64_t shape[] = {1};
    int64_t strides[] = {1};

    DLTensor tensor = {};
    tensor.data = &value;
    tensor.device = {kDLCPU, 0};
    tensor.ndim = 1;
    tensor.dtype = {static_cast<std::uint8_t>(kDLUInt), 8, 1};
    tensor.shape = shape;
    tensor.strides = strides;

    ovrtx_input_buffer_t input = {};
    input.tensors = &tensor;
    input.tensor_count = 1;

    const ovx_string_t path = toOvxString(primPath);
    const ovx_string_t paths[] = {path};

    ovrtx_binding_desc_or_handle_t binding = {};
    binding.binding_desc.prim_list = {paths, 1};
    binding.binding_desc.attribute_name = {0, literal_to_ovx_string(attributeName)};
    binding.binding_desc.attribute_type = {
        {static_cast<std::uint8_t>(kDLUInt), 8, 1},
        false,
        OVRTX_SEMANTIC_NONE,
    };
    binding.binding_desc.prim_mode = OVRTX_BINDING_PRIM_MODE_CREATE_NEW;

    const ovrtx_enqueue_result_t write =
        ovrtx_write_attribute(renderer, &binding, &input, OVRTX_DATA_ACCESS_SYNC);
    return ok(write);
}

static void setSelectionOutline(
    ovrtx_renderer_t* renderer,
    const std::string& previousPath,
    const std::string& nextPath)
{
    if (!previousPath.empty()) {
        writeU8Attribute(renderer, previousPath,
            OVRTX_ATTR_NAME_SELECTION_OUTLINE_GROUP, 0);
    }
    if (!nextPath.empty()) {
        writeU8Attribute(renderer, nextPath,
            OVRTX_ATTR_NAME_SELECTION_OUTLINE_GROUP, 1);
    }
}
```

If the installed SDK provides `ovrtx_set_selection_outline_group()`, prefer that
helper for bulk updates. The attribute write above is the explicit fallback and
is useful when combining outline state with other per-prim writes.

## EffectLayer Prim-Pick Effects

EffectLayer faders are optional material effects, not the baseline selection
signal. Keep native outlines enabled for all selected prims, then write
`inputs:Fader` only for known material EffectLayer targets.

```cpp
static std::string effectLayerPathForPrim(const std::string& primPath)
{
    if (primPath == "/World/Cone") {
        return "/World/Misc/Looks/Steel_Stainless/EffectLayer";
    }
    if (primPath == "/World/Cube") {
        return "/World/Misc/Looks/Concrete_Rough/EffectLayer";
    }
    if (primPath == "/World/Sphere") {
        return "/World/Misc/Looks/MetallicGreen_OmniPbr/EffectLayer";
    }
    return {};
}

static bool writeFloatAttribute(
    ovrtx_renderer_t* renderer,
    const std::string& primPath,
    const char* attributeName,
    float value,
    ovrtx_binding_prim_mode_t primMode)
{
    int64_t shape[] = {1};
    int64_t strides[] = {1};

    DLTensor tensor = {};
    tensor.data = &value;
    tensor.device = {kDLCPU, 0};
    tensor.ndim = 1;
    tensor.dtype = {static_cast<std::uint8_t>(kDLFloat), 32, 1};
    tensor.shape = shape;
    tensor.strides = strides;

    ovrtx_input_buffer_t input = {};
    input.tensors = &tensor;
    input.tensor_count = 1;

    const ovx_string_t path = toOvxString(primPath);
    const ovx_string_t paths[] = {path};

    ovrtx_binding_desc_or_handle_t binding = {};
    binding.binding_desc.prim_list = {paths, 1};
    binding.binding_desc.attribute_name = {0, literal_to_ovx_string(attributeName)};
    binding.binding_desc.attribute_type = {
        {static_cast<std::uint8_t>(kDLFloat), 32, 1},
        false,
        OVRTX_SEMANTIC_NONE,
    };
    binding.binding_desc.prim_mode = primMode;

    const ovrtx_enqueue_result_t write =
        ovrtx_write_attribute(renderer, &binding, &input, OVRTX_DATA_ACCESS_SYNC);
    return ok(write);
}

static void setEffectLayerFader(
    ovrtx_renderer_t* renderer,
    const std::string& primPath,
    float fader)
{
    const std::string effectPath = effectLayerPathForPrim(primPath);
    if (effectPath.empty()) return;

    writeFloatAttribute(renderer, effectPath, "inputs:Fader", fader,
        OVRTX_BINDING_PRIM_MODE_EXISTING_ONLY);
}
```

For shared materials, compute active EffectLayer targets from the complete
selected set. Do not turn off a shared material fader just because one of
several selected prims was deselected.

Author neutral startup values in the session layer when a sample material
defaults to visible glow:

```usda
over "World"
{
    over "Misc"
    {
        over "Looks"
        {
            over "Concrete_Rough"
            {
                over "EffectLayer"
                {
                    float inputs:Fader = 0
                }
            }
        }
    }
}
```

Use `CREATE_NEW` for load-time resets authored by the viewer. Use
`EXISTING_ONLY` for runtime toggles when the target shader input must already
exist.

## Selection Animation

Selection animation is just another live `omni:xform` write. Store the selected
prim's base transform, then write an app-defined reversible offset every frame
before `ovrtx_step()`. Choose the motion direction, magnitude, and timing from
the product brief, stage units, asset scale, and coordinate system.

```cpp
enum class AnimationPhase {
    Idle,
    Rising,
    Hovering,
    Falling,
};

struct PrimAnimation {
    std::string path;
    OrbitCamera::Mat4 baseTransform;
    AnimationPhase phase = AnimationPhase::Idle;
    double t = 0.0;
    double offset = 0.0;
    double hoverTime = 0.0;
    double fallStartOffset = 0.0;
};

static double clamp01(double value)
{
    return std::clamp(value, 0.0, 1.0);
}

static double easeOutQuint(double t)
{
    const double inv = 1.0 - clamp01(t);
    return 1.0 - inv * inv * inv * inv * inv;
}

static OrbitCamera::Mat4 offsetTransform(
    const PrimAnimation& animation,
    int translationIndex)
{
    OrbitCamera::Mat4 transform = animation.baseTransform;
    transform[translationIndex] += animation.offset;
    return transform;
}

static void updateSelectionAnimation(
    ovrtx_renderer_t* renderer,
    std::vector<PrimAnimation>& animations,
    double deltaSeconds)
{
    constexpr int kTranslationIndex = 13;       // app-defined axis in row-major matrix
    constexpr double kBaseOffset = 0.05;        // stage units; choose from asset scale
    constexpr double kRiseDuration = 0.25;
    constexpr double kFallDuration = 0.25;
    constexpr double kHoverAmplitude = 0.0;     // optional additional stage-unit offset
    constexpr double kHoverFrequency = 1.5;
    constexpr double kPi = 3.14159265358979323846;

    deltaSeconds = std::clamp(deltaSeconds, 1.0 / 240.0, 0.1);

    for (PrimAnimation& animation : animations) {
        if (animation.phase == AnimationPhase::Idle) continue;

        if (animation.phase == AnimationPhase::Rising) {
            animation.t += deltaSeconds / kRiseDuration;
            animation.offset = kBaseOffset * easeOutQuint(animation.t);
            if (animation.t >= 1.0) {
                animation.phase = AnimationPhase::Hovering;
                animation.hoverTime = 0.0;
            }
        } else if (animation.phase == AnimationPhase::Hovering) {
            animation.hoverTime += deltaSeconds;
            animation.offset = kBaseOffset +
                kHoverAmplitude * std::sin(2.0 * kPi * kHoverFrequency * animation.hoverTime);
        } else if (animation.phase == AnimationPhase::Falling) {
            animation.t += deltaSeconds / kFallDuration;
            const double s = clamp01(animation.t);
            animation.offset = animation.fallStartOffset * (1.0 - s);
            if (s >= 1.0) {
                animation.offset = 0.0;
                animation.phase = AnimationPhase::Idle;
            }
        }

        writeMat4Attribute(renderer, animation.path, "omni:xform",
            offsetTransform(animation, kTranslationIndex));
    }
}
```

On selection change:

```cpp
static void selectPrim(
    ovrtx_renderer_t* renderer,
    std::string& selectedPath,
    std::vector<PrimAnimation>& animations,
    const std::string& nextPath)
{
    if (selectedPath == nextPath) return;

    constexpr double kBaseOffset = 0.05;        // keep in sync with animation config

    for (PrimAnimation& animation : animations) {
        if (animation.path == selectedPath) {
            animation.phase = AnimationPhase::Falling;
            animation.t = 0.0;
            animation.fallStartOffset = animation.offset;
        }
        if (animation.path == nextPath) {
            animation.phase = AnimationPhase::Rising;
            animation.t = animation.offset > 0.0 ? clamp01(animation.offset / kBaseOffset) : 0.0;
        }
    }

    setSelectionOutline(renderer, selectedPath, nextPath);
    // Update optional material effects in a separate manager when enabled.
    selectedPath = nextPath;
}
```

Only animate prims whose base transforms are known. For arbitrary scenes, query
or initialize base `omni:xform` values first; do not overwrite unknown authored
transforms with identity.
