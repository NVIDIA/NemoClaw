# Viewer Control Patterns

## Triggers

Use this skill for buttons, links, toolbar, action groups, camera tools, render settings forms, dropdowns, segmented controls, sliders, steppers, toggles, accordions, confirmations, destructive actions, or control semantics.

Use this with `viewer-layout-patterns` and the feature skill that owns the backend behavior, such as `camera-controls`, `render-settings`, `aov-switching`, or `stage-management`.

This guidance is client-agnostic. Apply the control intent and state rules to
the selected UI toolkit: React components, Tauri/Electron web UI, lightweight
`ovui` widgets, full-editor `ovwidgets`, or Dear ImGui controls. Transport- and
toolkit-specific skills still own event APIs, lifecycle, and rendering.

## Intent To Control

Choose the control by user intent before styling it:

| User intent | Control |
|---|---|
| Execute a command or mutate state | Button or icon button |
| Navigate to another route/resource | Link |
| Choose one of 2-3 modes | Segmented control or radio group |
| Choose one value from 4+ options | Select/dropdown |
| Search and choose from a long list | Combobox |
| Toggle an immediate preference | Switch |
| Toggle a tool mode in a toolbar | Toggle button |
| Provide a numeric value with bounded steps | Number input, stepper, or slider |
| Provide text | Text input or textarea |
| Reveal optional content | Disclosure, collapsible group, accordion, or trigger button |
| Confirm a high-risk action | Dialog with grouped actions |

Semantic rule: if it changes application state, it is a button. If it moves the user to a location, it is a link. Visual style does not change semantics.

## Toolbar Rules

- Viewport tools belong near or over the Viewport Panel, not buried in a settings panel.
- Keep the primary visible set small: orbit/pan/zoom, fit, reset camera, selection mode, screenshot if supported.
- Put secondary tools behind overflow rather than shrinking icons below readable hit targets.
- Use icon buttons for familiar tools and include accessible labels/tooltips.
- Group related tools with separators or button groups; do not scatter Save/Cancel/Apply across unrelated regions.

Camera vocabulary matters:

| Term | Meaning |
|---|---|
| Orbit | Camera rotates around a target point. |
| Pan | Camera translates laterally in the view plane. |
| Dolly | Camera moves forward/back along depth. |
| Zoom | Magnification/focal change; not the same as dolly. |
| Fit | Reposition camera to frame the selected prim or full stage. |

Match labels and implementation to the actual camera operation from `camera-controls`.

## Action Priority

Each action group should have at most one primary action.

| Priority | Use for |
|---|---|
| Primary | The intended next step: Apply, Load, Save, Connect. |
| Secondary | Alternatives: Cancel, Reset view, Close. |
| Destructive | Delete, clear, overwrite, reset stage, or other high-risk actions. |

Standard footer order is cancel/dismiss on the left and affirmative action on the right. If the affirmative action is destructive, keep it on the right but style it as destructive.

## Form And Settings Controls

- Every form control has a visible label. Placeholder text is a hint, not a label.
- Store control state in application state. Controls render the value they are given and emit changes.
- Use sliders for fast approximate tuning; pair with numeric input when exact values matter.
- Use switches for immediate viewer preferences, checkboxes for submitted forms, and toggle buttons for active tools.
- For render settings, render only backend-advertised capabilities. Clamp values before sending them to the backend and display the effective value, apply status, and reload requirement returned by the backend.
- Disable controls only when the action cannot be performed. Prefer explanatory inline text or tooltip over silently disabled controls.

## Disclosure And Menus

| Pattern | Use when |
|---|---|
| Disclosure icon | You only need an open/closed affordance; caller owns content. |
| Collapsible group | One custom section reveals arbitrary content. |
| Accordion | Multiple related sections, such as Transform/Material/Lighting categories. |
| Dropdown menu | A trigger reveals commands or navigation choices. |
| Select/combobox | The user is choosing a value for a form field. |

Do not put interactive controls inside a tooltip. Use a popover/overlay, drawer, or panel.

## Confirmation Rules

Use confirmation dialogs for irreversible or structurally significant actions: deleting prims, clearing scene state, overwriting settings, disconnecting active work, or switching scenes with unsaved edits.

Do not confirm every small property edit. For incremental, reversible changes, show status and provide undo/reset where possible.

See also: `viewer-feedback-status`, `render-settings`, `stage-management`, `camera-controls`, `aov-switching`.
