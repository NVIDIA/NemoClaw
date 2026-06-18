# Viewer UX Workflow

## Triggers

Use this skill for UI brief, UX, viewer UI workflow, viewer layout, app shell, panels, toolbar, inspector, form controls, status UI, redesign, React frontend, ovui UI, ovwidgets editor UI, Dear ImGui UI, or viewer interface routing.

Use this after delivery-path routing when the request changes the user-facing interface of an Omniverse Realtime Viewer. It complements `usd-viewer-app`, `viewer-backend-interface`, `streaming-client`, `tauri-local-viewer`, `electron-shm-viewer`, `ovui-local-viewer-recipe`, `cpp-native-viewer`, and `ovwidgets-editor-shell`.

## Ground Rules

- The user-facing UI does not render USD or 3D geometry. It displays an `ovrtx` output surface and manages UI around it.
- Favor the existing app's component system and styling conventions. If none exists in a web frontend, build plain React components with semantic HTML and predictable CSS before adding a new UI dependency. For native `ovui`, `ovwidgets`, or Dear ImGui apps, translate the same interaction intent into the toolkit's existing primitives.
- Treat the UI as part of the product, not a mockup. Implement reachable states, handlers, disabled/loading behavior, and validation evidence.
- Keep transport-specific code behind `ViewerBackend` or the selected delivery adapter. Panels should not call raw WebRTC, Tauri, Electron, or server APIs directly unless a narrower skill requires it.

## Workflow

1. Capture the user's goal before choosing components.
   - Identify the primary user activity: view, inspect, edit, browse assets, tune rendering, or monitor a session.
   - State the information hierarchy. In most viewer apps, the viewport is primary; outliner, inspector, settings, and status are supporting surfaces.
   - Record hard constraints from the prompt, such as desktop/mobile, compact/dense, named reference apps, or required controls.

2. Route to the focused references.

| Need | Read |
|---|---|
| Broad viewer implementation | `usd-viewer-app` |
| Delivery and transport | `streaming-vs-local`, then the chosen delivery skills |
| Shared React interfaces | `viewer-backend-interface` |
| App shell, panels, drawers, responsive layout | `viewer-layout-patterns` |
| Toolbars, actions, forms, sliders, confirmations | `viewer-control-patterns` |
| Stage tree, asset grid, property inspector, JSON display | `viewer-data-view-patterns` |
| Loading, errors, stream health, destructive-action warnings | `viewer-feedback-status` |

3. Declare the layout before writing component code.
   - Name regions by purpose: Viewport Panel, Outliner Panel, Properties Panel, Asset Browser, Render Settings.
   - Decide which surfaces are permanent panels, temporary drawers, anchored inspectors, or blocking dialogs.
   - Define which state each panel owns and which shared signals it observes: selected prim paths, stage-load state, stream status, active AOV, render settings.

4. Resolve component gaps conservatively.
   - First reuse existing components from the app or the generated local
     viewer UI module from `viewer-backend-interface`.
   - If a component is missing, compose from local primitives and promote it as a named component with a small prop contract.
   - Do not bake transport details into a promoted UI component. Pass data and callbacks through typed props or `ViewerBackend`.

5. Implement with stable spatial contracts.
   - Use CSS grid/flex tracks with `min-height: 0`, constrained overflow, and stable viewport dimensions.
   - Do not let tree expansion, inspector contents, or status banners resize the rendered surface unless the user explicitly asked for an adaptive layout.
   - Provide explicit empty states for selection-driven panels instead of showing stale data or blank panes.

6. Validate the actual interface.
   - Run the app's typecheck/build/tests where available.
   - For browser frontends, capture Playwright or equivalent screenshots at desktop and narrow widths.
   - Verify no text overlap, no panel overflow into the viewport, no blank video/canvas surface, and no broken disabled/loading states.

## Output Expectations

For non-trivial UI work, leave the generated app with:

- Named components, widgets, or functions for major views and panels.
- A small state model, context, or adapter surface that exposes selection, stream status, loading, and settings.
- Clear adapter boundaries between UI components and transport/backend calls.
- Validation notes or artifacts showing the main layout, a selected object, a loading/error state, and a narrow viewport.

See also: `viewer-layout-patterns`, `viewer-control-patterns`, `viewer-data-view-patterns`, `viewer-feedback-status`, `viewer-backend-interface`, `streaming-client`.
