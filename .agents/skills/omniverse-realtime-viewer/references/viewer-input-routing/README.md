# Viewer Input Routing

## Triggers

Use this skill when implementing or debugging viewport controls, input
callbacks, WebRTC `on_input`, SHM/native input, ovui mouse handlers, camera
drag, wheel zoom, click picking, drag selection, DOM panel input gating, or
wrong/no selection after a click.

This skill owns transport input normalization and dispatch. Camera math stays in
`camera-controls`; native pick query decode stays in `native-picking-selection`
and `object-selection`; React UI state and DOM layout stay in
`streaming-client`.

## First Rules

- Use native transport input for pointer/key/wheel traffic. WebRTC apps receive
  `ovstream.InputEvent` structs through `server.on_input`; SHM clients send the
  same native structs. Do not send continuous mouse movement as JSON
  `mouseInput`.
- Normalize every transport's button ids before calling shared camera or
  selection helpers.
- Treat left click as selection only on button release and only when movement
  stayed under the drag threshold.
- Keep input callbacks fast. Enqueue camera writes, pick queries, and selection
  changes for the renderer owner thread; do not call `renderer.step()`, scene
  load/reset, or live attribute writes directly from input callbacks.
- During scene load/reset, cancel active drags and ignore or defer input. Clear
  pending picks when the stage changes.

## Button Conventions

Use one app-internal camera helper convention:

| Helper button | Meaning |
|---|---|
| `0` | left / orbit / click-select |
| `1` | middle / pan |
| `2` | right / dolly or fly-look |

Normalize transport ids into that convention:

```python
def camera_button_from_ovui(button: int) -> int | None:
    # ovui: 0=left, 1=right, 2=middle
    return {0: 0, 2: 1, 1: 2}.get(button)
```

```python
def camera_button_from_ovstream(raw_button, ovstream) -> int | None:
    # ovstream.MouseButton: NONE=0, LEFT=1, MIDDLE=2, RIGHT=3
    try:
        button = raw_button if isinstance(raw_button, ovstream.MouseButton) else ovstream.MouseButton(raw_button)
    except Exception:
        return None
    if button == ovstream.MouseButton.LEFT:
        return 0
    if button == ovstream.MouseButton.MIDDLE:
        return 1
    if button == ovstream.MouseButton.RIGHT:
        return 2
    return None
```

Do not compare `mouse.data` to DOM button ids. For wheel events, prefer
`mouse.scroll_y` when the binding exposes it and fall back to `mouse.data` only
for older builds.

```python
def wheel_delta(mouse) -> float:
    delta = getattr(mouse, "scroll_y", 0) or getattr(mouse, "data", 0)
    return float(delta)
```

## WebRTC Viewport Ownership

Browser DOM controls can sit beside or above the stream, but raw native input
still reaches the server. Maintain an app-level viewport ownership flag:

- Server default should be `viewport_input_active = True` when the only native
  input source is the stream surface.
- DOM panels, trees, inspectors, menus, and toolbars send
  `setViewportInputActive {active:false}` on pointer enter/down/wheel.
- The viewport surface sends `active:true` on pointer enter/down and
  `active:false` on pointer leave.
- When the server receives `active:false`, cancel the current camera gesture and
  suppress picking until re-enabled.

Starting inactive creates a first-click race: the mouse-down can arrive through
native input before the React activation message arrives through the data
channel, so the release has no matching press and selection never queues.

## Input Router Skeleton

```python
DRAG_THRESHOLD_PX = 4.0


class InputRouter:
    def __init__(self, commands, render_width: int, render_height: int):
        self.commands = commands
        self.render_width = render_width
        self.render_height = render_height
        self.viewport_input_active = True
        self._active_button: int | None = None
        self._press_pos: tuple[float, float] | None = None
        self._dragged = False

    def set_viewport_input_active(self, active: bool) -> None:
        self.viewport_input_active = bool(active)
        if not self.viewport_input_active:
            self.commands.enqueue_cancel_interaction()
            self._active_button = None
            self._press_pos = None
            self._dragged = False

    def on_input(self, event, ovstream) -> None:
        if not self.viewport_input_active:
            self.commands.enqueue_cancel_interaction()
            return
        if event.type != ovstream.InputEventType.MOUSE:
            return

        mouse = event.mouse
        if mouse.type == ovstream.MouseEventType.MOVE:
            x, y = float(mouse.x), float(mouse.y)
            if self._press_pos is not None:
                dx = x - self._press_pos[0]
                dy = y - self._press_pos[1]
                if abs(dx) > DRAG_THRESHOLD_PX or abs(dy) > DRAG_THRESHOLD_PX:
                    self._dragged = True
            self.commands.enqueue_camera_move(x, y, mouse.modifiers)
            return

        if mouse.type == ovstream.MouseEventType.WHEEL:
            self.commands.enqueue_camera_scroll(wheel_delta(mouse), float(mouse.x), float(mouse.y))
            return

        if mouse.type != ovstream.MouseEventType.BUTTON:
            return

        button = camera_button_from_ovstream(mouse.data, ovstream)
        if button is None:
            return

        is_down = mouse.button_state == ovstream.KeyState.DOWN
        if is_down:
            self._active_button = button
            self._press_pos = (float(mouse.x), float(mouse.y))
            self._dragged = False
            self.commands.enqueue_camera_button_down(float(mouse.x), float(mouse.y), button)
            return

        was_click = button == self._active_button and not self._dragged
        self.commands.enqueue_camera_button_up(float(mouse.x), float(mouse.y), button)
        if button == 0 and was_click:
            self.commands.enqueue_pick(float(mouse.x), float(mouse.y))
        self._active_button = None
        self._press_pos = None
        self._dragged = False
```

`commands` must execute on the renderer owner thread or be drained by that
thread before `renderer.step()`.

## Coordinate Ownership

For WebRTC native input, NVST maps stream-surface coordinates for the fixed
stream resolution. For app-owned DOM math, measure the visible video rectangle,
reject letterboxed areas, and convert to RenderProduct pixels before camera or
pick dispatch.

Keep the RenderProduct size fixed for the session. Do not resize the server
renderer because the browser CSS viewport changed.

## Scene And Render Loop Coordination

- Render loop owns native pick enqueue/result decode, selection outline writes,
  and camera `omni:xform` writes.
- Input callbacks enqueue intent: `camera_move`, `camera_button`, `scroll`,
  `pick_at`, `cancel_interaction`, or `set_viewport_input_active`.
- Scene load/reset holds the same renderer mutation lock used by the render
  loop. While loading, discard pending picks and cancel drags.
- Log pick state transitions during validation: `Queueing viewport pick` when a
  click queues a pick, and `Selection changed` after decoded pick paths update
  selection.

## Validation Checklist

- [ ] First left click after page load queues a pick and selects a prim.
- [ ] Left drag orbits without selecting on release.
- [ ] Middle drag pans, right drag dollies or fly-looks, and wheel zooms.
- [ ] Sidebar/tree/inspector clicks and wheels do not move the camera or pick.
- [ ] Selection stays synchronized between viewport, tree, and property panel.
- [ ] Scene switch cancels active drag and clears stale pending picks.
- [ ] Server logs show queued pick and selection-changed events for click tests.
- [ ] No app protocol sends continuous pointer movement as JSON `mouseInput`.

See also: `streaming-server`, `streaming-client`, `streaming-messages`,
`camera-controls`, `native-picking-selection`, `object-selection`,
`selection-feedback`, `local-viewer`, and `webgl-shm-transport`.
