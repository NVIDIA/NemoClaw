# Headless SHM CLI

## Triggers

Use this skill for headless CLI, SHM automation, `ovusd-shm`, viewer
automation, scripted interaction, CLI testing, non-interactive viewer,
screenshot capture, automated scene validation, scripted pick/select sequences,
or programmatic stage tree inspection.

Use this with an existing OVRTX server that exposes the ovstream shared-memory
transport. The CLI is a local automation client: it does not render USD, host a
UI, or replace the viewer server. It attaches to the named SHM stream, reads
frames, sends input and JSON viewer messages, and exits with deterministic
stdout/stderr behavior suitable for scripts and CI jobs.

## Purpose

Build a command-line client for automation, testing, CI pipelines, and scripted
interactions with a running OVRTX viewer server through ovstream SHM. Typical
uses include:

- capture a rendered frame as PNG, JPEG, or raw BGRA/RGBA bytes
- verify stream health and frame dimensions
- inspect the USD stage hierarchy and selected prim properties
- run scripted camera drags and pick/select workflows
- switch AOVs for validation frames
- pipe raw frames into video encoders or image-diff tools

## When To Use This

Choose the headless SHM CLI when:

- an automated test needs to drive a local viewer without opening Electron,
  Tauri, ovui, or a browser
- CI needs smoke tests against an OVRTX server with `--shm` enabled
- screenshots or raw frames must be captured from the same renderer path as the
  desktop viewer
- scene validation needs hierarchy, property, AOV, selection, or pick checks
- scripted interactions should reproduce user workflows such as click, drag,
  select, inspect, and capture
- Playwright or another e2e harness needs a stable backend for renderer state

Do not use this as a remote browser streaming client. For WebRTC browser
delivery, use `streaming-server`, `streaming-client`, `streaming-messages`, and
`streaming-lifecycle`. For an interactive local desktop UI, use
`electron-shm-viewer`, `tauri-local-viewer`, or `local-viewer`.

## Architecture

```text
Node.js CLI
  -> generated local SHM client module
  -> native Node addon built with node-gyp
  -> libovstream_shm_client.so
  -> libovstream.so
  -> POSIX shared memory frames and control messages
  -> Python OVRTX server started with --shm
```

The Python server remains the source of truth for USD, `ovrtx.Renderer`, stage
queries, camera state, picking, selection outlines, render settings, and AOVs.
The CLI is only a client:

- **Frames:** wait for the newest SHM frame and write PNG/JPEG/raw output.
- **Input:** send mouse move/button/wheel events to the server.
- **Viewer state:** send JSON `event_type`/`payload` requests over the SHM
  control channel and wait for matching responses.

Reference `electron-shm-viewer` for the server-side SHM lifecycle and
`streaming-messages` for message envelope names. Reference `object-selection`,
`stage-hierarchy`, `stage-attribute-reads`, and `aov-switching` when adding server
handlers that the CLI calls.

For ovstream SHM acquisition and runtime setup beyond this CLI pattern, read
`references/dependencies`. Keep the CLI client code local to the generated app.

## Prerequisites

- A Python OVRTX server is already running with SHM enabled, for example
  `--shm`.
- The CLI `--stream-name` matches the server `--shm-stream-name`.
- Node.js 18 or newer is available.
- `LD_LIBRARY_PATH` includes the directory containing `libovstream.so` and any
  dependent ovstream native libraries.
- A generated local SHM client module exists in the app workspace, for example
  `clients/shm-client/`.
- The native addon has been rebuilt for the active Node/Electron ABI with
  `node-gyp`.

Example environment:

```bash
export LD_LIBRARY_PATH=/path/to/.venv/lib/python3.10/site-packages/ovstream/lib:$LD_LIBRARY_PATH
export OV_SHM_STREAM_NAME=ovrtx-viewer
```

## Command Reference

Commands should be named after actions and produce script-friendly output.
Successful commands write the primary result to stdout unless `--output` is
provided. Diagnostics and errors go to stderr. Non-zero exit codes indicate
failure.

### `frame`

Capture one frame from SHM.

```bash
ovusd-shm frame --output frame.png
ovusd-shm frame --output frame.jpg --format jpeg
ovusd-shm frame --format raw > frame.bgra
```

Options:

- `--output <path>` writes to a file instead of stdout.
- `--format png|jpeg|raw` controls encoding. Infer `png` or `jpeg` from
  `--output` extension when possible.

Raw output is tightly packed frame data in the native SHM format unless the
package explicitly converts it. Include width, height, format, and pitch in
`info` output so raw consumers can decode it correctly.

### `info`

Print stream and latest-frame metadata as JSON.

```bash
ovusd-shm info
```

Include at least stream name, producer liveness, width, height, pixel format,
pitch bytes, and sequence number.

### `tree`

Query stage hierarchy rows from the server.

```bash
ovusd-shm tree --root /World
ovusd-shm tree --root /World --json
```

Options:

- `--root <path>` selects the root prim path. Default to `/World` only when the
  server has no loaded root-prim state to report.
- `--json` prints the raw tree response for machine checks. Without `--json`,
  print a readable indented tree with prim paths and types.

### `click`

Send a viewport click using fractional viewport coordinates.

```bash
ovusd-shm click 0.40 0.45
ovusd-shm click 0.40 0.45 --wait-select
```

Arguments are `x y` in normalized viewport space, clamped to `0..1`.
`--wait-select` waits for a selection change and prints the selected prim path
or `null`.

### `pick`

Run a raw pick query without changing selection.

```bash
ovusd-shm pick 0.40 0.45
```

Print the picked prim path or `null`. Use `pickRequest`/`pickResult` on the
control channel so the server can distinguish raw pick queries from selection
clicks.

### `drag`

Send a scripted viewport drag for orbit or pan behavior.

```bash
ovusd-shm drag 0.45 0.50 0.65 0.40 --steps 20 --duration 500
```

Arguments are `x1 y1 x2 y2` in normalized viewport space. Options:

- `--steps <n>` controls the number of move events.
- `--duration <ms>` spreads the drag over the given duration.

Default to left-button drag for orbit unless the CLI adds an explicit button or
mode option that maps to the server's camera controls.

### `select`

Select a prim by absolute USD path.

```bash
ovusd-shm select /World/Cube
```

Send `selectPrimsRequest {paths:[path]}` and wait for
`stageSelectionChanged`. Print the confirmed path or resulting selected paths.

### `props`

Print properties for a prim.

```bash
ovusd-shm props /World/Cube
ovusd-shm props /World/Cube --json
```

Without `--json`, print tab-separated `name`, `type`, and `value` rows. With
`--json`, print the server response as structured JSON. Cap large payloads on
the server and preserve any `truncated` flag.

### `aov`

List or switch render AOVs.

```bash
ovusd-shm aov --list
ovusd-shm aov --set LdrColor
```

Options:

- `--list` prints available AOV names, one per line.
- `--set <name>` sends `changeAOVRequest` and prints the resulting active AOV
  state as JSON.

Expose only render vars that map to real full-resolution image data.

### `stream`

Continuously write frames to stdout for video capture or external tools.

```bash
ovusd-shm stream --format raw > frames.bgra
ovusd-shm stream --format png > frames.pngstream
```

Default to raw output for predictable throughput. Handle `SIGINT` and
`SIGTERM` by closing the SHM client cleanly.

## Common Options

All commands accept:

- `--stream-name <name>`: SHM stream name. Default to `OV_SHM_STREAM_NAME` or
  the app default such as `ovrtx-viewer`.
- `--timeout <ms>`: operation timeout in milliseconds. Default to `15000`.

Timeouts should apply to stream attachment, frame waits, request/response
round-trips, and `--wait-select` unless the command documents a shorter
selection-specific timeout.

## Building From Source

Build the generated SHM client module before building the CLI. Keep the native
addon in that local module so Electron apps, Playwright tests, and the headless
CLI can share the same client implementation.

```bash
export LD_LIBRARY_PATH=/path/to/ovstream/lib:$LD_LIBRARY_PATH

cd clients/shm-client
npm install
npm run native:rebuild
npm run build

cd ../../headless-client
npm install
npm run build
```

The generated local SHM client module should provide:

- TypeScript types for frames, prim nodes, prim properties, input events, AOV
  state, and request options
- a `ShmViewerClient` class with one active native connection per process
- PNG encoding without requiring browser APIs
- optional JPEG encoding through a Node dependency such as `sharp`
- native addon loading from installed and source-tree locations
- a clear error when `libovstream.so` or `libovstream_shm_client.so` cannot be
  loaded

The native addon should:

- wrap `libovstream_shm_client.so`
- build with `node-gyp`
- expose blocking frame waits through a safe JS API for CLI use
- validate frame dimensions, pitch, format, and byte lengths
- close native handles on process exit or thrown errors
- avoid exposing raw pointers or file descriptors to JavaScript

## Playwright And E2E Testing

Use the headless CLI as the renderer/test backend when Playwright is responsible
for UI checks or orchestration:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const run = promisify(execFile);
const streamName = process.env.OV_SHM_STREAM_NAME ?? 'ovrtx-viewer';

test('selects a prim through the OVRTX backend', async () => {
  await run('ovusd-shm', ['frame', '--output', 'before.png', '--stream-name', streamName]);
  const { stdout } = await run('ovusd-shm', [
    'click', '0.50', '0.50', '--wait-select', '--stream-name', streamName,
  ]);
  expect(stdout.trim()).toMatch(/^\/World\//);
  await run('ovusd-shm', ['frame', '--output', 'after.png', '--stream-name', streamName]);
});
```

Testing guidance:

- start the Python server as a fixture and wait for `shmReady` before running
  CLI commands
- use unique stream names per parallel worker
- treat the CLI as the source of renderer truth for frame capture, selection,
  hierarchy, properties, and AOV state
- keep browser DOM assertions separate from renderer-state assertions
- preserve captured frames as test artifacts on failure

## Example Automation Script

```bash
#!/usr/bin/env bash
set -euo pipefail

STREAM_NAME="${OV_SHM_STREAM_NAME:-ovrtx-viewer}"
TARGET="${1:-/World/Cube}"

ovusd-shm info --stream-name "$STREAM_NAME"
ovusd-shm frame --stream-name "$STREAM_NAME" --output before.png

picked="$(ovusd-shm pick --stream-name "$STREAM_NAME" 0.50 0.50)"
echo "picked=${picked}"

ovusd-shm select --stream-name "$STREAM_NAME" "$TARGET"
selected="$(ovusd-shm click --stream-name "$STREAM_NAME" 0.50 0.50 --wait-select)"
test -n "$selected"
test "$selected" != "null"

ovusd-shm props --stream-name "$STREAM_NAME" "$selected" --json > selected-props.json
ovusd-shm frame --stream-name "$STREAM_NAME" --output after.png
```

This pattern captures a baseline frame, performs a pick/select interaction,
verifies that selection state is observable, records selected prim properties,
and captures a post-selection frame for visual diffing.

## Gotchas

- `LD_LIBRARY_PATH` must be set before Node starts. Changing it inside the
  process is too late for native dynamic loading.
- `--stream-name` must exactly match the server `--shm-stream-name`.
- Coordinates are `0..1` fractional viewport coordinates, not CSS pixels. The
  client converts them to render-product pixels after reading a frame.
- Use the fixed server render resolution for input mapping. Do not use browser
  DOM size or Electron window size in the CLI.
- Only one active `ShmViewerClient` instance per Node process is a safer default
  because native SHM clients often own process-global callbacks.
- Wait for at least one frame before sending fractional input so width and
  height are known.
- Keep JSON control messages small. Do not send frame bytes through JSON.
- Server callbacks should enqueue work; only the server render owner should
  call `renderer.step()`, reset/load scenes, or write live attributes.
- Raw frame streams need out-of-band width, height, format, and pitch metadata.
  Capture `info` alongside raw artifacts.
- In CI, use unique stream names and clean up stale POSIX SHM segments owned by
  the current test run only.
