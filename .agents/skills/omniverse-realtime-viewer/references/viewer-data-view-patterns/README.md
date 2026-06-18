# Viewer Data View Patterns

## Triggers

Use this skill for stage tree, outliner, hierarchy, asset browser, property inspector, JSON tree, metadata display, list/grid/canvas choice, selected object panel, or cross-panel selection state.

Use this with `stage-hierarchy`, `stage-queries`, `stage-attribute-reads`, `prim-info-display`, and `viewer-backend-interface`.

## Choose The Data View

| Data shape | View model |
|---|---|
| USD prim hierarchy, folders, nested objects | Tree View |
| Ordered results, logs, recent files, flat commands | List |
| Asset thumbnails, scene cards, visual browsing | Grid |
| Free-positioned graph/node layout | Canvas |
| Arbitrary nested object/array payload | JSON Tree |
| Selected object details | Property Inspector |

Do not force hierarchy into a flat list unless the user asked for search-only results. Do not use a tree for flat data; false nesting makes scan paths harder.

## Selection Contract

Selection is a shared application signal, not private tree state.

- Outliner/tree/list/grid views emit canonical prim paths or asset IDs.
- Viewport, property inspector, status surfaces, and backend selection/highlight subscribe to that signal.
- Single-select is the current default for viewer apps. If multi-select is added, every subscriber must explicitly support mixed values and multi-highlight.
- Clear dependent data when selection clears or stage changes. Never show stale properties from a previous stage.

With `ViewerBackend`, prefer:

```typescript
await backend.selectPrims(paths);
const props = await backend.getProperties(path);
const tree = await backend.getStageTree(rootPath);
```

## Stage Tree Pattern

Tree rows should include:

- Expand/collapse affordance for parents only.
- Type icon or compact type label for every row.
- Prim display name, with full path available through title/tooltip/details.
- Selection state with a visible row highlight.
- Optional badges for visibility, variant, unloaded, hidden, or error states when the backend provides them.

Indent by depth using a stable unit, typically 12-24 px depending on panel density. Leaf rows should not reserve chevron hit space unless the existing tree component requires it; the visual rhythm should still make parent/leaf differences clear.

For large stages:

- Lazy-load children when possible.
- Keep expansion state by prim path.
- Virtualize long flat sibling lists.
- Preserve expansion where paths still exist after reload.
- Debounce search/filter input and show match counts.

## Asset Lists And Grids

- Use grids for visual browsing with thumbnails or previews.
- Use lists/tables when names, paths, modified dates, or statuses matter more than thumbnails.
- Surface loading, missing preview, incompatible asset, and permission/error states per item with status tags or inline row messages.
- Selecting an asset should update preview/detail state; loading an asset into the viewer should be an explicit action unless the product brief says preview-on-select.

## Property Inspector Pattern

Use a two-column scan line for dense properties:

```text
[right-aligned label] | [left-aligned control/value]
```

- Use a 96 px label column for compact panels and 120 px for wider panels.
- Group dense fields by category: Transform, Material, Visibility, Variants, Bounds, Metadata.
- Show common groups expanded; advanced groups collapsed.
- Use compact tuple rows for XYZ, RGB/RGBA, UV, and similar fixed-arity values.
- Use read-only rows when the backend does not support editing a field.
- For mixed or unsupported values, show an explicit display state instead of an empty input.

No selection state should show a plain-language placeholder such as "Select an object to view its properties." Invalid selection after scene switch should clear the inspector.

## JSON And Metadata Display

Use JSON Tree only for arbitrary nested payloads such as raw metadata, message traces, diagnostics, or backend debug output. For known USD properties, prefer a typed inspector.

- Color/type-code JSON values with text labels or accessible semantics; do not rely on color alone.
- Collapse deeply nested objects by default.
- Cap or summarize large arrays and binary-like values before rendering.
- Keep copy-path or copy-value actions near the row when useful for debugging.

## Cross-Panel Tests

Validate these flows when you add or change data views:

- Selecting a tree row highlights the viewport object and updates the property inspector.
- Clicking empty viewport or clearing selection clears dependent panels.
- Switching scenes clears stale hierarchy, properties, and selection before loading new data.
- Search/filter does not change the canonical selection unless the user selects a filtered result.
- Loading/error/empty states are visible and do not collapse panel layout.

See also: `object-selection`, `selection-feedback`, `prim-info-display`, `stage-hierarchy`, `stage-attribute-reads`, `viewer-backend-interface`.
