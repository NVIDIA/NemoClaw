# OvWidgets Full Editor

## Triggers

Use this skill for complete standalone editor path, omni.ui docking, RTX viewport, stage browser, property inspector, transform manipulators, undo/redo, themes, settings, content browser, layer stack, or full-featured OvGear USD editor/viewer.

Use OvGear (`ovwidgets`) when the request is for the complete USD editor/viewer:
docked panels, editor lifecycle, selection synchronization, undoable edits, and
RTX rendering. For a minimal single-window viewer, use the `local-viewer` skill
instead; `ovwidgets.app.Application` intentionally starts the heavy editor shell.

When customizing editor controls, property editors, toolbar tools, settings, or
confirmation dialogs, read `viewer-control-patterns` and apply its
client-agnostic control guidance to `omni.ui`/`ovwidgets` primitives.

For ovwidgets package behavior, editor-shell behavior, or widget APIs beyond
this summary, read `references/dependencies` for acquisition guidance and
supplemental dependency documentation.

## Quick Start

Launch the full editor and optionally open a USD stage after the UI is built:

```python
from ovwidgets.app.application import Application

Application().run(usd_path="path/to/stage.usd")
```

Equivalent launch paths are the `ovwidgets` console script and
`python -m ovwidgets.app`. The CLI accepts an optional USD path.

## What OvGear Provides

OvGear is a Kit-free standalone `omni.ui` application rendered through `ovrtx`.
It provides:

- RTX viewport with camera controls, frame loop, HUD, pick gesture plumbing,
  selection outline, and transform manipulator integration.
- Stage Browser with hierarchy, type badges, visibility controls, filtering,
  rename, and drag/drop reparenting.
- Property Inspector with type-dispatched attribute editors and multi-selection
  ambiguity handling.
- Undo/redo command stack for editor mutations.
- Runtime themes and JSON-backed settings.
- Content Browser for local files, bookmarks, recent files, and open-file wiring.
- Layer Stack panel backed by `LayerStackAdapter` for USD layer inspection and
  editing.

## Key Widgets

- `Application` (`ovwidgets.app.application.Application`): use for the full
  editor. It owns `Settings`, `UndoManager`, `SelectionBus`, global styles,
  dock layout, shortcuts, frame loop, status bar, content browser, layer panel,
  property panel, stage browser, and viewport.
- `ViewportWidget` (`ovwidgets.viewport.viewport_widget.ViewportWidget`): use
  when embedding the RTX viewport into an existing `omni.ui` app. It hosts the
  rendered image, `SceneView` camera gestures, toolbar tools, transform gizmos,
  selection outline, drag/drop, and renderer adapter integration.
- `StageWidget` (`ovwidgets.stage.widget.stage_widget.StageWidget`): use for an
  embeddable prim hierarchy browser inside any active `ui.VStack`/`ui.Frame`
  context. Use `StageWindow` when you want the dockable window shell.
- `PropertyWindow` (`ovwidgets.property.window.PropertyWindow`): use for the
  USD property inspector. It rebuilds from a `PropertyAdapter`, dispatches
  widgets by scheme/type, and should be wired to a stage adapter plus
  `UndoManager` for editor behavior.
- `ContentBrowserWindow` (`ovwidgets.content.ContentBrowserWindow`): use for
  file navigation, bookmarks, recent files, and explicit `open_file_fn` wiring.
- `LayerWindow` (`ovwidgets.layers.LayerWindow`): use for the Layers panel.
  Back it with `UsdLayerStackAdapter` or another `LayerStackAdapter`.

## Adapter Pattern

Keep UI code behind the ABCs in `ovwidgets.common.adapters`:

- `RendererAdapter`: implement this for custom renderers. Required surface:
  `load_stage`, `render_frame`, `set_resolution`, `pick`, `cancel_pick`,
  `pick_rect`, `set_selection_highlight`, and `shutdown`.
- `OvRtxRendererAdapter` (`ovwidgets.viewport.ovrtx_renderer_adapter`): built-in
  `ovrtx` renderer adapter. It composes the user stage with an OvGear session
  layer for camera/render-product data and pushes camera/transform updates into
  `ovrtx`.
- `StageAdapter`: hierarchy, display, visibility, rename, reparent, filtering,
  change notifications, and undo grouping. `UsdStageAdapter` is the USD-backed
  implementation.
- `TransformAdapter`: local/world transform read/write used by the transform
  manipulator. `UsdTransformAdapter` is the USD-backed implementation.
- `PropertyAdapter` and `LayerStackAdapter`: use these to back property and
  layer UI without coupling those panels directly to `pxr`.

`Application.open_file()` wires the standard USD path: it preconstructs
`OvRtxRendererAdapter`, opens the USD stage, creates `UsdStageAdapter`,
`UsdPropertyAdapter`, `UsdTransformAdapter`, and `UsdLayerStackAdapter`, then
hands those adapters to the panels.

## Embedding Widgets Without Application

When embedding individual widgets, initialize and run `omni.ui` yourself, create
the selection/undo/settings services you need, and pass adapters explicitly.

Stage browser only:

```python
import omni.ui as ui

from ovwidgets.common.selection import SelectionBus
from ovwidgets.stage.usd_stage_adapter import UsdStageAdapter
from ovwidgets.stage.widget.stage_widget import StageWidget

selection_bus = SelectionBus()
adapter = UsdStageAdapter(stage)

with ui.VStack():
    widget = StageWidget(adapter, selection_bus)
```

Viewport with the built-in renderer:

```python
from pxr import Usd  # import pxr before ovrtx is imported lazily

from ovwidgets.viewport.ovrtx_renderer_adapter import OvRtxRendererAdapter
from ovwidgets.viewport.viewport_widget import ViewportWidget

renderer = OvRtxRendererAdapter()  # construct before Usd.Stage.Open(...)
stage = Usd.Stage.Open("path/to/stage.usd")
renderer.load_stage(stage)

viewport = ViewportWidget(renderer=renderer)
```

For dockable panel shells, use `StageWindow`, `PropertyWindow`,
`ContentBrowserWindow`, and `LayerWindow`; they are late-bound and expose
`set_adapter`/setup methods so callers can construct the UI before the USD stage
is loaded.

## Environment Requirements

- Python version must match the selected `ovrtx`/`ovui` package set. Read
  `references/dependencies` for the current supported Python version and artifact
  set.
- `ovrtx`, `omni.ui`, and `omni.ui_scene` importable in the active environment.
- NVIDIA GPU and driver with a Vulkan ICD.
- A real `DISPLAY` for desktop use, or headless Vulkan:

```bash
export OMNIUI_HEADLESS=1
export OMNIUI_BACKEND=vulkan
```

Use the custom USD runtime paths expected by the OvGear build:

```bash
export OVRTX_SKIP_USD_CHECK=1
export PYTHONPATH="$HOME/dev/usd-build/install/lib/python:$PYTHONPATH"
export LD_LIBRARY_PATH="$HOME/dev/usd-build/install/lib:$LD_LIBRARY_PATH"
```

Set `OMNIUI_HEADLESS` and `OMNIUI_BACKEND` before importing `omni.ui`.
Set `OVRTX_SKIP_USD_CHECK` before constructing the renderer.

Read `references/dependencies` for the current `ovui` PyPI package guidance and
supplemental dependency documentation.
Install `ovui`, `ovui-data-adapters`, and `ovwidgets` from the same
package set. Stale data adapters can make even lightweight imports such as
`ovwidgets.viewport.image_bridge.ImageBridge` fail if `ovwidgets.viewport.__init__`
eagerly imports `ViewportWidget`.

## Gotchas

- Import `pxr` before `ovrtx`, but construct `OvRtxRendererAdapter` before the
  first `Usd.Stage.Open(...)`. This primes the `ovrtx` MDL cache while avoiding
  duplicate USD debug-symbol registration. `Application.open_file()` already
  enforces this; embedders must do it manually.
- Do not import `ovrtx` directly before `pxr`. Let `OvRtxRendererAdapter` import
  it lazily after `pxr` is available.
- Use `ui.Window(..., fill_app_window=True)` for full-app overlay/status windows
  that must resize with the application window.
- `Application` is a singleton. A second `Application()` in the same process
  asserts; reuse the instance pattern or start a new process.
- `omni.ui.Frame` builds lazily on the first render frame. State needed by
  `attach_stage`, `set_adapter`, or selection callbacks should exist in
  `__init__`; only actual UI widget construction belongs in frame build methods.
- For custom sliders, toggles, menus, and property-editor controls, follow
  `viewer-control-patterns`: label controls visibly, keep state in adapters or
  app models, clamp before backend writes, and show effective values when
  renderer support adjusts the requested value.
- `ovrtx` availability depends on GPU/driver/runtime setup. If renderer
  construction fails, keep the stage/property/layer adapters usable and surface
  the viewport failure separately.
- If install fails with missing `pyproject.toml` under `ovui-data-adapters`, use
  a package set that includes matching package metadata.
- If `ovwidgets` install reports `Multiple top-level packages discovered`, use a
  compatible package set with explicit packaging metadata.
