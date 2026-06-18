# Viewer Layout Patterns

## Triggers

Use this skill for app layout, viewport plus sidebar, outliner and properties, multi-panel workspace, drawer, inspector, responsive shell, panel sizing, or layout stability.

Use this with `viewer-ux-workflow` for UI-heavy viewer work and with the selected delivery skill for the viewport surface.

## Structural Vocabulary

Use consistent names so implementation and review stay aligned:

```text
Application
  Workspace
    Header | Body | Footer
      Panel
        Pane
          View
```

- Header: app title, workspace navigation, global actions, compact stream/status indicators.
- Body: the only place for working panels such as Viewport, Outliner, Properties, Asset Browser, and Render Settings.
- Footer: persistent status, low-priority diagnostics, coordinates, or operation progress when the app already has a footer.
- Panel: a named purpose area. Do not name panels by position alone.
- View: the functional component inside a panel, such as StageTree View or PropertyInspector View.

## Layout Archetypes

| App shape | Use when | Default layout |
|---|---|---|
| Viewport-dominant viewer | Viewing/inspecting a live or local render is the main activity | Viewport takes at least 60% horizontal space; tools stack on the side. |
| Multi-panel workspace | User needs scene structure, direct manipulation, and properties at once | Outliner left, Viewport center, Properties right, optional bottom timeline/log. |
| Asset browser plus preview | User browses scenes or media before loading | Fixed navigation/sidebar, asset grid/list, preview or viewport area. |
| Compact monitor | User mostly watches session health or render output | Viewport first, controls collapsed into header/drawer. |

The viewport is the product's visual anchor. Equal-width viewport/tool splits usually make a viewer feel like a configuration form; use them only when setup is more important than inspection.

## Panel Rules

- Viewport Panel is not scrollable. The video/canvas/image surface fills the panel exactly.
- Tool panels are scrollable internally: Outliner, Properties, Settings, logs, asset lists.
- Use `min-height: 0` and `overflow: hidden` on grid/flex containers so nested scroll areas do not push the viewport.
- Keep persistent panel state independent from stream state. The Properties Panel can show selected data while the stream reconnects; only the Viewport View is stream-dependent.
- Preserve user spatial memory. If panels can collapse, dock, or switch modes, restore the last known size/open state instead of reinitializing on every rerender.

## Responsive Behavior

| Width class | Recommended behavior |
|---|---|
| Wide desktop | Multi-panel layout with viewport center/left and persistent tool panels. |
| Medium desktop/tablet | Viewport plus one persistent tool column; secondary panels become tabs or drawers. |
| Narrow/mobile | Viewport remains primary; outliner/properties/settings move behind trigger buttons or bottom drawers. |

Do not hide essential status or leave controls unreachable at narrow widths. If a panel becomes a drawer, keep its selection and scroll state.

## Drawers And Inspectors

Choose the detail surface by permanence and context:

| Surface | Use when | Rules |
|---|---|---|
| Permanent Panel | The user needs the content constantly while working. | Always visible or explicitly collapsible; show a no-selection placeholder. |
| Drawer | Temporary list/table/detail work that should not block the viewer. | Singleton; right side on desktop, bottom on narrow screens; include title and close button. |
| Anchored Inspector | Object-relative detail near a viewport or canvas target. | Non-blocking, draggable, close button per instance; hide when anchor is invalid. |
| Dialog | The user must decide before continuing. | Blocking; use for destructive confirmations, import/export choices, or auth. |

Selection-driven drawers should prefer push mode when space allows: the list or tree remains interactive and selecting another row updates the drawer. Avoid backdrop-click dismissal for selection-driven overlays because it turns row changes into two-click interactions.

## Viewport Stability Checklist

- The viewport container has stable dimensions before the stream or frame arrives.
- Side panels use constrained overflow and cannot resize the viewport when content changes.
- Headers, banners, and status overlays do not cover critical controls or pointer targets.
- Overlays are positioned relative to the rendered image rect, not the window, when letterboxing is possible.
- The app handles no-stage, loading-stage, selected-prim, stream-offline, and reconnecting states.

See also: `streaming-client`, `viewport-resize`, `viewport-overlays`, `prim-info-display`, `viewer-backend-interface`.
