<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Kit Discovery

Use this reference for setup Step 1 and Step 1.5. The setup skill body owns
the routing decision; this file owns the detailed discovery and selection
procedure.

## Discovery Order

1. If the user named a Kit / USD Composer / Isaac Sim path, classify that path
   and treat it as the single candidate.
2. Add paths from `KIT_PATH`, `OMNI_KIT_ROOT`, and
   `SCENE_OPTIMIZER_KIT_ROOT` when present.
3. If no candidate exists, ask before scanning. Do not launch a broad
   filesystem scan silently.

## Ask Before Scanning

Use the runtime-context prompt from `runtime-context-header.md` and offer:

- Provide an absolute Kit / USD Composer path.
- Auto-find Kit installs.
- Use standalone libraries instead.
- Install Kit now.

Only run auto-enumeration when the user chooses it. If auto-enumeration returns
zero candidates, re-prompt without the scan option.

## Classify A Path

A classic Kit root qualifies when it has:

- `kit.exe` or `kit`
- `python.bat`, `python.sh`, or `python`
- `kit_app.py`
- a nearby `kit-app.toml` or `*.kit`

A venv Kit runtime qualifies when it has `pyvenv.cfg` plus
`Scripts/python.exe` or `bin/python`.

Do not pre-check `exts/`, `extscache/`, or extension folders. The Python probe
in `runtime-probe.md` is the authoritative Scene Optimizer and Asset Validator
availability test.

## Auto-Enumeration

Windows PowerShell:

```powershell
Get-ChildItem -Path "$env:LOCALAPPDATA\ov\pkg\*\kit" -Directory -ErrorAction SilentlyContinue
Get-ChildItem -Path "C:\build\*\*\*\kit","D:\build\*\*\*\kit","E:\build\*\*\*\kit" -Directory -ErrorAction SilentlyContinue
Get-ChildItem -Path "C:\build\*\*\kit","D:\build\*\*\kit","E:\build\*\*\kit" -Directory -ErrorAction SilentlyContinue
```

Linux:

```bash
ls -d ~/.local/share/ov/pkg/*/kit 2>/dev/null
ls -d /opt/nvidia/omniverse/*/kit 2>/dev/null
ls -d ~/build/*/*/kit /build/*/*/kit 2>/dev/null
```

## Candidate Record

Record candidates under `kit.candidates[]` in `<output_path>/setup-preflight.json`:

```json
{
  "application": "USD Composer",
  "version": "110.1.0",
  "build": "110.1.0+main.10181.f4b28ef2.gl.windows-x86_64.release",
  "path": "D:\\build\\...\\kit",
  "launcher": "python.bat"
}
```

Derive the application from known install names when possible. Derive version
and build from the path first, then `kit-app.toml` / `kit_app.py` when the path
does not encode them. Sort candidates by semantic version descending.

## User Selection

The enumerated `kit.candidates[]` are the raw discovery source. The selected
candidate becomes the canonical runtime: copy its `application`, `version`,
`path`, and `build` into the `runtime_context.kit` object (the block the header
prints and downstream skills consume). Do not keep a separate `kit.chosen`
copy — `runtime_context.kit` is the single source of truth.

If one candidate exists, write it to `runtime_context.kit` and continue.

If multiple candidates exist, always ask. Pre-select the newest candidate, add
`Use standalone libraries instead` as the final option, and record:

- `runtime_context.kit.chosen_by: "user"` for interactive selection.
- `runtime_context.kit.chosen_by: "unattended_default"` when no user input
  channel exists and the newest candidate is automatically selected.
