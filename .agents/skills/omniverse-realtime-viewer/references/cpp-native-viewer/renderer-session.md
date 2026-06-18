# C++ Renderer And Session Setup

## Renderer Setup

Create the renderer once with sync mode and native selection outlines enabled.
The C API uses typed `ovrtx_config_entry_t` arrays, not JSON strings.

```cpp
#include <ovrtx/ovrtx.h>
#include <ovrtx/ovrtx_config.h>

static ovrtx_renderer_t* createRenderer()
{
    const ovrtx_config_entry_t configEntries[] = {
        ovrtx_config_entry_sync_mode(true),
        ovrtx_config_entry_active_cuda_gpus(literal_to_ovx_string("0")),
        ovrtx_config_entry_selection_outline_enabled(true),
    };
    const ovrtx_config_t config = {
        configEntries,
        sizeof(configEntries) / sizeof(configEntries[0]),
    };

    ovrtx_renderer_t* renderer = nullptr;
    const ovrtx_result_t result = ovrtx_create_renderer(&config, &renderer);
    if (!ok(result) || !renderer) {
        printLastOvrtxError("Failed to create OVRTX renderer");
        return nullptr;
    }
    return renderer;
}
```

Available config entries include `ovrtx_config_entry_sync_mode(true)`,
`ovrtx_config_entry_active_cuda_gpus(...)`,
`ovrtx_config_entry_selection_outline_enabled(true)`, and
`ovrtx_create_renderer(...)`.

## Session Layer Pattern

Load an inline root USDA with the user stage as a sublayer plus viewer-owned
camera, render product, render vars, and render settings. The render var names
must map to real OVRTX source names. `LdrColor` drives display, and
`ovrtx_pick_hit` is consumed only after a pick query.

```cpp
#include <sstream>
#include <string>

struct SessionLayerDesc {
    std::string stagePath;
    std::string cameraPath = "/OVCamera";
    std::string renderProductPath = "/OVRenderProduct";
    int width = 1280;
    int height = 720;
};

static std::string buildCompositeLayer(const SessionLayerDesc& desc)
{
    const int width = desc.width > 0 ? desc.width : 1;
    const int height = desc.height > 0 ? desc.height : 1;
    const double horizontalAperture = 20.955;
    const double verticalAperture =
        horizontalAperture * static_cast<double>(height) / static_cast<double>(width);

    std::ostringstream usda;
    usda
        << "#usda 1.0\n"
        << "(\n"
        << "    subLayers = [@" << desc.stagePath << "@]\n"
        << ")\n\n"
        << "def Camera \"OVCamera\"\n"
        << "{\n"
        << "    float2 clippingRange = (1, 100000)\n"
        << "    float focalLength = 18.15\n"
        << "    float horizontalAperture = " << horizontalAperture << "\n"
        << "    float verticalAperture = " << verticalAperture << "\n"
        << "    token projection = \"perspective\"\n"
        << "    matrix4d xformOp:transform = ("
        << "(1, 0, 0, 0), "
        << "(0, 1, 0, 0), "
        << "(0, 0, 1, 0), "
        << "(0, 0, 0, 1))\n"
        << "    uniform token[] xformOpOrder = [\"xformOp:transform\"]\n"
        << "}\n\n"
        << "def RenderProduct \"OVRenderProduct\"\n"
        << "{\n"
        << "    rel camera = <" << desc.cameraPath << ">\n"
        << "    int2 resolution = (" << width << ", " << height << ")\n"
        << "    uint[] deviceIds = [0]\n"
        << "    token productType = \"raster\"\n"
        << "    rel orderedVars = [\n"
        << "        <" << desc.renderProductPath << "/LdrColor>,\n"
        << "        <" << desc.renderProductPath << "/ovrtx_pick_hit>\n"
        << "    ]\n\n"
        << "    def RenderVar \"LdrColor\"\n"
        << "    {\n"
        << "        uniform string sourceName = \"LdrColor\"\n"
        << "    }\n\n"
        << "    def RenderVar \"ovrtx_pick_hit\"\n"
        << "    {\n"
        << "        uniform string sourceName = \"ovrtx_pick_hit\"\n"
        << "    }\n"
        << "}\n\n"
        << "def RenderSettings \"OVRenderSettings\"\n"
        << "{\n"
        << "    rel products = [<" << desc.renderProductPath << ">]\n"
        << "}\n";
    return usda.str();
}
```

Open the generated layer directly:

```cpp
static bool loadStage(
    ovrtx_renderer_t* renderer,
    const std::string& stagePath,
    int width,
    int height)
{
    SessionLayerDesc session;
    session.stagePath = stagePath;
    session.width = width;
    session.height = height;

    const std::string compositeUsda = buildCompositeLayer(session);
    const ovrtx_enqueue_result_t load =
        ovrtx_open_usd_from_string(renderer, toOvxString(compositeUsda));
    return waitForOperation(renderer, load, "Failed to load inline composite stage");
}
```

On scene switch, stop rendering, call `ovrtx_reset_stage()` or replace the root
with `ovrtx_open_usd_from_string()`, clear selection state, rebuild scene UI
state, and write the first camera transform before stepping.
