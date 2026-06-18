# Viewer Feedback And Status

## Triggers

Use this skill for loading state, stream status, connection health, offline, lagged, reconnecting, error banner, warning, toast, status tag, empty state, disabled controls, destructive warning, or operation progress.

Use this with `streaming-client`, `streaming-lifecycle`, `streaming-messages`, `stage-management`, and `viewer-control-patterns`.

## Feedback Scope

Choose feedback by the scope of the condition:

| Scope | Pattern | Examples |
|---|---|---|
| Workspace/global | Banner or header/footer status | Backend unavailable, auth required, active stream offline. |
| View/panel | Inline alert, placeholder, panel overlay | Stage tree failed, no assets, properties loading. |
| Item | Status tag or row message | Asset missing, prim hidden, upload failed. |
| Transient success | Toast or short-lived status | Settings saved, screenshot captured. |
| Blocking decision | Dialog | Delete, overwrite, reset, discard unsaved edits. |

Assign severity by consequence:

| Severity | Use when |
|---|---|
| Info | Context or neutral state; no action required. |
| Success | Operation completed. |
| Warning | The user can continue, but risk or degraded behavior exists. |
| Error | Something failed or must be corrected. |

Always pair color with text. Color-only status is not sufficient.

## Stream Health Model

Use one application-level stream status signal. Components subscribe to it; they do not poll independently.

| State | Meaning | User implication |
|---|---|---|
| Connecting | Session is starting or reconnecting. | Viewport may be blank; commands may queue or no-op. |
| Live | Frames are current and commands can be visually verified. | Normal operation. |
| Lagged | Connection exists but visual feedback is delayed. | Edits may apply before the user can see them. |
| Offline | Stream disconnected or no frames are arriving. | User is working without visual confirmation. |
| Failed | Connection or backend setup failed. | User needs corrective action or diagnostics. |

Suggested placements:

- Header or footer: compact persistent status visible from anywhere.
- Viewport overlay: local status in the surface affected by stream health.
- Panel-level alerts: only when the panel's own data operation failed.

Do not gate every tool panel on stream health. The outliner and inspector can remain useful if their data path is still available. Disable only actions that truly cannot complete.

## Loading States

| Situation | Pattern |
|---|---|
| Known progress, such as upload or staged import | Progress bar with label. |
| Unknown duration, such as reconnect or query | Spinner or skeleton in the affected panel. |
| Long renderer/shader warmup | Persistent status text with phase label and logs/diagnostics path when available. |
| Empty data set | Placeholder, not spinner. |

Clear stale content before loading replacement scene data if keeping it visible could mislead the user. For expensive stage reloads, show the previous scene only when the app explicitly labels it as stale or still-active.

## Destructive And Blind-Edit Warnings

Classify actions by consequence:

- Incremental/reversible: numeric settings, camera changes, selection, AOV changes. Do not interrupt; show status and allow reset/undo where available.
- Structural/destructive: delete prim, clear stage, reset settings, overwrite file, discard changes, disconnect active collaboration. Confirm with a dialog.

When stream state is Lagged or Offline, include current status in destructive confirmations so the user understands they may not visually verify the result immediately.

Dialog content should include:

- Action name.
- Plain-language consequence.
- Current stream/session status when relevant.
- Cancel action and confirm action.
- Destructive styling for irreversible confirm actions.

If a "do not warn again" option is added for degraded stream states, scope it to the current degraded state and clear it when the stream returns to Live.

## Disabled State Rules

- Disabled controls should have an understandable reason available nearby or on hover/focus.
- Prefer keeping controls enabled with recoverable error feedback when a command can be attempted safely.
- Never hide a control solely because a backend is temporarily disconnected if hiding it would make recovery harder.
- Re-enable controls from a single state transition path; avoid split flags such as `isLoading`, `isDisabled`, and `isOffline` fighting each other.

## Validation

Before finishing UI status work, test:

- Initial no-stage state.
- Connecting, Live, Lagged/Offline, and Failed stream/session states where supported.
- Stage-load progress and stage-load failure.
- Selection cleared and selected-object invalid after scene switch.
- Destructive confirmation with normal and degraded stream status.
- Narrow viewport layout with status text visible and not overlapping controls.

See also: `streaming-lifecycle`, `streaming-client`, `troubleshooting`, `viewer-control-patterns`, `stage-management`.
